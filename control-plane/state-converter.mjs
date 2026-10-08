// Personal AI OS 0.3.0 Wave 5 — versioned state converter for control-plane & goals.
//
// This module generalises the memory converter's discipline
// (services/memory/migration.py) to the two JSON state stores whose *versioned
// transition* the P5/P6 readiness map flagged as missing: "副本转换两次一致——
// 仅记忆有" (p5-p6-readiness-r1.md:24). It converts a *private copy* of a state
// FILE into the current contract shape and proves the conversion conserves the
// source, without ever touching a production path.
//
// It is a converter, NOT a snapshotter (that is control-plane/snapshot-orchestrator.mjs)
// and NOT a renderer: it consumes the same file a snapshot would capture.
//
// SCOPE / HARD BOUNDARIES (identical spirit to services/memory/migration.py:12-31
// and control-plane/snapshot-orchestrator.mjs:10-18)
//   * It only reads the `sourceFile` a caller explicitly hands it and only writes
//     the NEW `targetDir` a caller explicitly hands it, under an explicit
//     `allowRoot`. It never reads or writes ~/.local/state/personal-ai-os/,
//     ~/.wechat-acp/ or any other production/launchd-owned state. It makes no
//     network calls and reads no environment. The clock is injected via `now`.
//   * Validation runs BEFORE any write/chmod/mkdir, so a refused conversion leaves
//     the tree's entries, bytes and modes exactly as they were.
//
// THE CONVERTER CONTRACT (mirrors the memory converter)
//   1. Source provenance first: the source must exist, be a regular file (never a
//      symlink, never a directory), parse as JSON and match its kind's top-level
//      shape — all checked before anything is written.
//   2. Per-record validation and disposition: every record is run through its
//      collection's validator (control-plane: the contracts in contracts.mjs;
//      goals: the goal-store record shape). Each record lands in the manifest as
//      `kept` (verbatim), `migrated` (fields the validator must *supplement* are
//      listed) or `rejected` (with a truthful reason). ANY rejected record fails
//      the whole conversion — fail-closed, nothing is written, no data is silently
//      dropped.
//   3. Conservation: the manifest carries each collection's source/target counts
//      and a per-record identity digest; kept+migrated+rejected must equal the
//      source record count, and the output identity set must equal the source's.
//   4. Two dry-runs identical: `dryRun:true` returns the full plan without writing;
//      two consecutive dry-runs are byte-identical (stable ordering, timestamps
//      taken only from the injected clock). A real conversion recomputes the plan
//      twice internally and records `twoDryRunsIdentical`.
//   5. Atomic write: the target is written tmp+rename (+fsync) and the manifest
//      records the converter version, source sha256, target sha256, per-record
//      dispositions and the two-dry-run declaration.
//
// NEVER FABRICATE, BUT STAMP EXPLICITLY
//   Optional fields that a record simply lacks are NOT fabricated: a 0.2.2 record
//   missing a newer *optional* field is a legitimate `kept`, not a `migrated`. Only
//   fields the validator *unconditionally* emits (the contractVersion/type stamps
//   and array scaffolds) are supplemented, and those are listed as addedFields. A
//   source `contractVersion` is preserved verbatim and its observed values are
//   recorded in the manifest.
//
// Dependencies: node:crypto, node:fs, node:path — plus the existing contracts.mjs
// and goal-store.mjs validators (no new dependency).

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";

import {
	CONTRACT_VERSION,
	createApproval,
	createEvidence,
	createExecution,
	createTask,
} from "./contracts.mjs";
import { goalSpecDigest, validateGoalSpec } from "./goal-store.mjs";

/** On-disk manifest schema understood by this module. */
export const SCHEMA_VERSION = 1;
export const CONVERTER_VERSION = "state-converter-v1";
export const MANIFEST_NAME = "manifest.json";

/** The two state kinds this converter understands. */
export const SUPPORTED_KINDS = Object.freeze(["control-plane", "goals"]);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Goal-record lifecycle statuses (goal-store.mjs state machine). */
const GOAL_STATUSES = Object.freeze([
	"draft",
	"ready",
	"running",
	"paused",
	"waiting",
	"complete",
	"cancelled",
]);

/** A redacted converter failure. Never carries raw record content. */
export class StateConverterError extends Error {
	constructor(code, message, { plan } = {}) {
		super(message ?? code);
		this.name = "StateConverterError";
		this.code = code;
		if (plan !== undefined) this.plan = plan;
	}
}

// ---------------------------------------------------------------------------
// stable serialisation / digests (mirrors store.mjs stable()/fingerprint())
// ---------------------------------------------------------------------------
function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function fingerprint(value) {
	return createHash("sha256").update(stable(value)).digest("hex");
}

/** A record/collection digest in the same `sha256:<hex>` shape the stores use. */
function digestOf(value) {
	return `sha256:${fingerprint(value)}`;
}

function sha256Bytes(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function pruneUndefined(record) {
	const out = {};
	for (const [key, value] of Object.entries(record)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

// ---------------------------------------------------------------------------
// path guards (mirrors snapshot-orchestrator.mjs / migration.py)
// ---------------------------------------------------------------------------
const ROOT_SYSTEM_ALIASES = new Map([
	["/var", "/private/var"],
	["/tmp", "/private/tmp"],
	["/etc", "/private/etc"],
]);

function isRootSystemAlias(path) {
	if (dirname(path) !== sep) return false;
	const expected = ROOT_SYSTEM_ALIASES.get(path);
	if (expected === undefined) return false;
	try {
		if (realpathSync(path) !== realpathSync(expected)) return false;
		return lstatSync(path).uid === 0;
	} catch {
		return false;
	}
}

/** Symlink components (self + ancestors), excluding verified root system aliases. */
function symlinkComponents(path) {
	const found = [];
	let current = resolvePath(path);
	for (;;) {
		const parent = dirname(current);
		if (parent === current) break;
		try {
			if (lstatSync(current).isSymbolicLink() && !isRootSystemAlias(current)) {
				found.push(current);
			}
		} catch {
			// A missing component is reported as a missing source/target elsewhere.
		}
		current = parent;
	}
	return found;
}

function isWithin(child, parent) {
	if (child === parent) return true;
	const base = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(base);
}

/**
 * Resolve a (not-yet-existing) absolute path to its canonical location by
 * realpath-ing the nearest existing ancestor and re-appending the missing tail.
 * This lets containment be judged for a target directory that must be new.
 */
function realpathOfNewPath(absPath) {
	const parts = [];
	let current = absPath;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) {
			throw new StateConverterError("target-unresolvable", "target path has no existing ancestor");
		}
		parts.unshift(basename(current));
		current = parent;
	}
	const base = realpathSync(current);
	return parts.length === 0 ? base : join(base, ...parts);
}

// ---------------------------------------------------------------------------
// record validators for the auxiliary (non-contract) collections
// ---------------------------------------------------------------------------
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

function requireObject(value, what) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new StateConverterError("invalid-record", `${what} must be an object`);
	}
	return value;
}

function requireFields(record, fields, what) {
	for (const field of fields) {
		if (!isNonEmptyString(record[field])) {
			throw new StateConverterError("invalid-record", `${what}.${field} must be a non-empty string`);
		}
	}
}

function validateIdempotencyEntry(entry) {
	requireObject(entry, "idempotency entry");
	requireFields(entry, ["operation", "fingerprint", "at"], "idempotency entry");
	return entry;
}

function validateLockEntry(entry) {
	requireObject(entry, "lock entry");
	requireFields(entry, ["sessionRefId", "owner", "token", "acquiredAt", "expiresAt"], "lock entry");
	return entry;
}

function validateEventEntry(entry) {
	requireObject(entry, "event entry");
	requireFields(entry, ["id", "type", "entityType", "entityId", "at"], "event entry");
	return entry;
}

function validateRequestEntry(entry) {
	requireObject(entry, "request entry");
	requireFields(entry, ["id", "digest"], "request entry");
	return entry;
}

function validateGoalEventEntry(entry) {
	requireObject(entry, "goal event entry");
	requireFields(entry, ["goalId", "type", "at"], "goal event entry");
	return entry;
}

/**
 * Validate one goal record against the goal-store record shape. The spec is
 * validated with the store's own `validateGoalSpec` and the stored `specDigest`
 * must re-derive from that spec — a forged/drifted goal fails closed. Optional
 * fields are type-checked only when present and never fabricated.
 */
function validateGoalRecord(entry) {
	requireObject(entry, "goal record");
	requireFields(entry, ["id", "owner", "workspaceDir", "createdAt"], "goal record");
	if (!Number.isInteger(entry.generation) || entry.generation < 1) {
		throw new StateConverterError("invalid-record", "goal record.generation must be a positive integer");
	}
	if (!GOAL_STATUSES.includes(entry.status)) {
		throw new StateConverterError("invalid-record", `goal record.status must be one of: ${GOAL_STATUSES.join(", ")}`);
	}
	for (const field of ["iterations", "tokensUsed", "noProgress"]) {
		if (!Number.isInteger(entry[field]) || entry[field] < 0) {
			throw new StateConverterError("invalid-record", `goal record.${field} must be a non-negative integer`);
		}
	}
	if (!Array.isArray(entry.history)) {
		throw new StateConverterError("invalid-record", "goal record.history must be an array");
	}
	requireObject(entry.spec, "goal record.spec");
	let normalizedSpec;
	try {
		normalizedSpec = validateGoalSpec(entry.spec);
	} catch (error) {
		const code = error && error.code ? `${error.code}: ` : "";
		throw new StateConverterError("invalid-record", `goal record.spec is invalid (${code}${error.message})`);
	}
	if (!isNonEmptyString(entry.specDigest) || entry.specDigest !== goalSpecDigest(normalizedSpec)) {
		throw new StateConverterError("invalid-record", "goal record.specDigest does not match its spec");
	}
	if (entry.grant !== undefined) requireObject(entry.grant, "goal record.grant");
	if (entry.lease !== undefined) requireObject(entry.lease, "goal record.lease");
	if (entry.nextWakeAt !== undefined && typeof entry.nextWakeAt !== "number") {
		throw new StateConverterError("invalid-record", "goal record.nextWakeAt must be a number");
	}
	return entry;
}

// ---------------------------------------------------------------------------
// collection descriptors
// ---------------------------------------------------------------------------
// `shape`   : 'map' (object of id -> record) or 'array' (list of records)
// `identity`: how a record's conservation identity is derived
//             'record-id' -> the record's `id` (must equal the map key in maps)
//             'key'       -> the map key itself (optionally echoed by `keyField`)
//             'index'     -> positional (for id-less arrays)
// `validator`: (record, ctx) -> canonical record; throws to reject. `ctx.isoNow`
//              is the injected clock, used only to stamp fields the contract
//              would otherwise default to the real wall clock (determinism).
const CONTROL_PLANE_COLLECTIONS = Object.freeze([
	{
		name: "tasks",
		shape: "map",
		identity: "record-id",
		validator: (record, ctx) => createTask({
			...record,
			createdAt: record.createdAt ?? ctx.isoNow,
			updatedAt: record.updatedAt ?? ctx.isoNow,
		}),
		contract: true,
	},
	{
		name: "executions",
		shape: "map",
		identity: "record-id",
		validator: (record) => createExecution(record),
		contract: true,
	},
	{
		name: "evidence",
		shape: "map",
		identity: "record-id",
		validator: (record, ctx) => createEvidence({ ...record, capturedAt: record.capturedAt ?? ctx.isoNow }),
		contract: true,
	},
	{
		name: "approvals",
		shape: "map",
		identity: "record-id",
		validator: (record, ctx) => createApproval({ ...record, createdAt: record.createdAt ?? ctx.isoNow }),
		contract: true,
	},
	{ name: "idempotency", shape: "map", identity: "key", validator: validateIdempotencyEntry },
	{ name: "locks", shape: "map", identity: "key", keyField: "sessionRefId", validator: validateLockEntry },
	{ name: "events", shape: "array", identity: "record-id", validator: validateEventEntry },
]);

const GOAL_COLLECTIONS = Object.freeze([
	{ name: "goals", shape: "map", identity: "record-id", validator: validateGoalRecord },
	{ name: "requests", shape: "map", identity: "key", validator: validateRequestEntry },
	{ name: "events", shape: "array", identity: "index", validator: validateGoalEventEntry },
]);

const KIND_DESCRIPTORS = Object.freeze({
	"control-plane": { collections: CONTROL_PLANE_COLLECTIONS, version: 1 },
	goals: { collections: GOAL_COLLECTIONS, version: 1 },
});

function emptyCollection(descriptor) {
	return descriptor.shape === "map" ? {} : [];
}

function isCollectionShape(value, descriptor) {
	if (descriptor.shape === "map") {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}
	return Array.isArray(value);
}

/** The ordered [key, record] entries of a collection container. */
function entriesOf(descriptor, container) {
	if (descriptor.shape === "map") {
		return Object.keys(container)
			.sort()
			.map((key) => [key, container[key]]);
	}
	return container.map((record, index) => [String(index), record]);
}

function identityOf(descriptor, key, record, index) {
	if (descriptor.identity === "index") return String(index);
	if (descriptor.identity === "key") {
		if (descriptor.keyField !== undefined && record && record[descriptor.keyField] !== key) {
			throw new StateConverterError(
				"identity-key-mismatch",
				`${descriptor.name} record ${descriptor.keyField} does not match its key`,
			);
		}
		return key;
	}
	if (!isNonEmptyString(record && record.id)) {
		throw new StateConverterError("invalid-record", `${descriptor.name} record is missing a string id`);
	}
	if (descriptor.shape === "map" && record.id !== key) {
		throw new StateConverterError(
			"identity-key-mismatch",
			`${descriptor.name} record id does not match its key`,
		);
	}
	return record.id;
}

function collectionDigest(entries) {
	const hasher = createHash("sha256");
	for (const entry of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		hasher.update(entry.id);
		hasher.update("\0");
		hasher.update(entry.digest);
		hasher.update("\n");
	}
	return `sha256:${hasher.digest("hex")}`;
}

function recordReason(error) {
	if (error && typeof error.message === "string" && error.message) {
		const code = error.code ? `${error.code}: ` : "";
		return `${code}${error.message}`.slice(0, 300);
	}
	return "invalid-record";
}

// ---------------------------------------------------------------------------
// shape validation
// ---------------------------------------------------------------------------
function validateShape(state, kind) {
	if (!state || typeof state !== "object" || Array.isArray(state)) {
		throw new StateConverterError("invalid-shape", `${kind} state must be a JSON object`);
	}
	const { collections, version } = KIND_DESCRIPTORS[kind];
	if (state.version !== version) {
		throw new StateConverterError("unsupported-version", `${kind} state version ${JSON.stringify(state.version)} is not supported`);
	}
	if (kind === "goals") {
		// Mirror goal-store.mjs read(): goals/requests objects and events array are required.
		for (const name of ["goals", "requests", "events"]) {
			const descriptor = collections.find((entry) => entry.name === name);
			if (!Object.hasOwn(state, name) || !isCollectionShape(state[name], descriptor)) {
				throw new StateConverterError("invalid-shape", `goals state.${name} is missing or has the wrong shape`);
			}
		}
		return;
	}
	// control-plane: any present collection must have the right shape; a missing
	// collection is a legitimate empty scaffold the converter supplies (recorded
	// in addedCollections), never a silent drop.
	for (const descriptor of collections) {
		if (Object.hasOwn(state, descriptor.name) && !isCollectionShape(state[descriptor.name], descriptor)) {
			throw new StateConverterError("invalid-shape", `${kind} state.${descriptor.name} has the wrong shape`);
		}
	}
}

// ---------------------------------------------------------------------------
// plan builder
// ---------------------------------------------------------------------------
function buildPlan(state, kind, { dryRun, startedAt, isoNow }) {
	const { collections } = KIND_DESCRIPTORS[kind];
	const targetState = { ...state };
	const planCollections = [];
	const addedCollections = [];
	const observedContractVersions = new Set();
	let kept = 0;
	let migrated = 0;
	let rejected = 0;

	for (const descriptor of collections) {
		const present = Object.hasOwn(state, descriptor.name);
		const container = present ? state[descriptor.name] : emptyCollection(descriptor);
		if (!present) addedCollections.push(descriptor.name);
		const targetContainer = descriptor.shape === "map" ? {} : [];

		const records = [];
		const identities = new Set();
		for (const [key, record] of entriesOf(descriptor, container)) {
			const index = descriptor.shape === "array" ? Number(key) : undefined;
			const identity = identityOf(descriptor, key, record, index);
			if (identities.has(identity)) {
				throw new StateConverterError("duplicate-identity", `${descriptor.name} repeats identity ${identity}`);
			}
			identities.add(identity);

			if (descriptor.contract && record && typeof record === "object" && "contractVersion" in record) {
				observedContractVersions.add(record.contractVersion);
			}

			let canonical;
			try {
				canonical = descriptor.validator(record, { isoNow });
			} catch (error) {
				records.push({ id: identity, disposition: "rejected", reason: recordReason(error) });
				rejected += 1;
				continue;
			}
			// Supplement only: the source record always wins; the validator can only
			// add fields it unconditionally emits (stamps / array scaffolds).
			const converted = pruneUndefined({ ...canonical, ...record });
			const addedFields = Object.keys(converted).filter((field) => !(field in record)).sort();
			const digest = digestOf(converted);
			if (addedFields.length === 0) {
				records.push({ id: identity, digest, disposition: "kept" });
				kept += 1;
			} else {
				records.push({ id: identity, digest, disposition: "migrated", addedFields });
				migrated += 1;
			}
			if (descriptor.shape === "map") targetContainer[key] = converted;
			else targetContainer.push(converted);
		}

		targetState[descriptor.name] = targetContainer;

		planCollections.push({
			name: descriptor.name,
			shape: descriptor.shape,
			sourceCount: entriesOf(descriptor, container).length,
			targetCount: descriptor.shape === "map" ? Object.keys(targetContainer).length : targetContainer.length,
			sha256: collectionDigest(records.filter((record) => record.disposition !== "rejected")),
			records,
		});
	}

	const plan = {
		schemaVersion: SCHEMA_VERSION,
		converterVersion: CONVERTER_VERSION,
		kind,
		dryRun: Boolean(dryRun),
		startedAt,
		contractVersion: CONTRACT_VERSION,
		sourceVersion: state.version,
		sourceContractVersions: [...observedContractVersions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		addedCollections: addedCollections.sort(),
		collections: planCollections,
		conservation: {
			ok: rejected === 0,
			sourceRecords: kept + migrated + rejected,
			targetRecords: kept + migrated,
			kept,
			migrated,
			rejected,
		},
		network_calls: 0,
	};
	return { plan, targetState, rejected };
}

/**
 * Assert the converted state conserves the source: per collection the identity
 * sets are equal and every source field survives with an unchanged value.
 */
function assertConservation(sourceState, targetState, kind) {
	const { collections } = KIND_DESCRIPTORS[kind];
	for (const descriptor of collections) {
		const source = Object.hasOwn(sourceState, descriptor.name)
			? sourceState[descriptor.name]
			: emptyCollection(descriptor);
		const target = targetState[descriptor.name];
		const sourceEntries = new Map();
		for (const [key, record] of entriesOf(descriptor, source)) {
			const index = descriptor.shape === "array" ? Number(key) : undefined;
			sourceEntries.set(identityOf(descriptor, key, record, index), record);
		}
		const targetEntries = new Map();
		for (const [key, record] of entriesOf(descriptor, target)) {
			const index = descriptor.shape === "array" ? Number(key) : undefined;
			targetEntries.set(identityOf(descriptor, key, record, index), record);
		}
		if (sourceEntries.size !== targetEntries.size) {
			throw new StateConverterError("conservation-violation", `${descriptor.name} identity set changed`);
		}
		for (const [identity, sourceRecord] of sourceEntries) {
			const targetRecord = targetEntries.get(identity);
			if (!targetRecord) {
				throw new StateConverterError("conservation-violation", `${descriptor.name} lost ${identity}`);
			}
			// No source field may be dropped or mutated (only supplemented).
			for (const [field, value] of Object.entries(sourceRecord)) {
				if (!Object.hasOwn(targetRecord, field) || fingerprint(targetRecord[field]) !== fingerprint(value)) {
					throw new StateConverterError("conservation-violation", `${descriptor.name}.${identity}.${field} changed`);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// atomic writes
// ---------------------------------------------------------------------------
function fsyncPath(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is not portable; a failure never invalidates the write.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeFileAtomic(dir, name, contents) {
	const target = join(dir, name);
	const tmp = join(dir, `.${name}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
	writeFileSync(tmp, contents, { mode: FILE_MODE });
	fsyncPath(tmp);
	renameSync(tmp, target);
	fsyncPath(dir);
	return target;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
function makeClock(now) {
	if (now !== undefined && typeof now !== "function") {
		throw new StateConverterError("invalid-config", "now must be a function when provided");
	}
	return now ?? Date.now;
}

/**
 * Convert a private copy of a control-plane / goals state file into the current
 * contract shape.
 *
 * @param {object} options
 * @param {string} options.sourceFile absolute path to the JSON state file.
 * @param {string} options.targetDir  absolute NEW directory under `allowRoot`.
 * @param {"control-plane"|"goals"} options.kind
 * @param {string} options.allowRoot  REQUIRED absolute root `targetDir` must live under.
 * @param {boolean} [options.dryRun]  plan only; write nothing.
 * @param {() => number} [options.now] injected clock (defaults to Date.now).
 */
export function convertState({ sourceFile, targetDir, kind, allowRoot, dryRun = false, now } = {}) {
	// --- 1. config (fail closed, before any filesystem access) -------------
	if (typeof kind !== "string" || !SUPPORTED_KINDS.includes(kind)) {
		throw new StateConverterError("invalid-config", `kind must be one of: ${SUPPORTED_KINDS.join(", ")}`);
	}
	if (typeof allowRoot !== "string" || allowRoot.length === 0 || !isAbsolute(allowRoot)) {
		throw new StateConverterError("invalid-config", "allowRoot is required and must be an absolute path");
	}
	if (typeof sourceFile !== "string" || sourceFile.length === 0 || !isAbsolute(sourceFile)) {
		throw new StateConverterError("invalid-config", "sourceFile is required and must be an absolute path");
	}
	if (typeof targetDir !== "string" || targetDir.length === 0 || !isAbsolute(targetDir)) {
		throw new StateConverterError("invalid-config", "targetDir is required and must be an absolute path");
	}
	if (basename(sourceFile) === MANIFEST_NAME) {
		throw new StateConverterError("invalid-config", `sourceFile must not be named ${MANIFEST_NAME}`);
	}
	const clock = makeClock(now);

	// --- 2. allowRoot must exist -------------------------------------------
	let realAllow;
	try {
		realAllow = realpathSync(resolvePath(allowRoot));
	} catch {
		throw new StateConverterError("allow-root-missing", "allowRoot does not exist");
	}
	if (!statSync(realAllow).isDirectory()) {
		throw new StateConverterError("allow-root-missing", "allowRoot is not a directory");
	}

	// --- 3. target containment + freshness (read-only) ---------------------
	const absTarget = resolvePath(targetDir);
	if (existsSync(absTarget)) {
		throw new StateConverterError("target-exists", `target directory already exists: ${absTarget}`);
	}
	const realTarget = realpathOfNewPath(absTarget);
	if (!isWithin(realTarget, realAllow)) {
		throw new StateConverterError("target-outside-allow-root", "targetDir resolves outside allowRoot");
	}

	// --- 4. source provenance (read-only) ----------------------------------
	const absSource = resolvePath(sourceFile);
	let sourceStats;
	try {
		sourceStats = lstatSync(absSource);
	} catch {
		throw new StateConverterError("source-missing", "sourceFile does not exist");
	}
	if (sourceStats.isSymbolicLink()) {
		throw new StateConverterError("source-symlink", "sourceFile is a symlink");
	}
	if (!sourceStats.isFile()) {
		throw new StateConverterError("source-not-regular", "sourceFile is not a regular file");
	}
	if (symlinkComponents(absSource).length > 0) {
		throw new StateConverterError("source-symlink", "sourceFile sits under a symlink");
	}
	let sourceBuffer;
	try {
		sourceBuffer = readFileSync(absSource);
	} catch {
		throw new StateConverterError("source-read-failed", "sourceFile could not be read");
	}
	const sourceSha256 = sha256Bytes(sourceBuffer);

	// --- 5. parse + shape (still before any write) -------------------------
	let sourceState;
	try {
		sourceState = JSON.parse(sourceBuffer.toString("utf8"));
	} catch {
		throw new StateConverterError("invalid-json", "sourceFile is not valid JSON");
	}
	validateShape(sourceState, kind);

	// --- 6. per-record conversion, twice; determinism enforced -------------
	const startedAt = clock();
	const isoNow = new Date(startedAt).toISOString();
	const first = buildPlan(sourceState, kind, { dryRun, startedAt, isoNow });
	const second = buildPlan(sourceState, kind, { dryRun, startedAt, isoNow });
	if (JSON.stringify(first.plan) !== JSON.stringify(second.plan)) {
		throw new StateConverterError("nondeterministic", "two conversion passes disagree");
	}
	if (first.rejected > 0) {
		throw new StateConverterError("record-rejected", `${first.rejected} record(s) rejected; nothing written`, { plan: first.plan });
	}
	assertConservation(sourceState, first.targetState, kind);

	const plan = first.plan;
	const targetFile = basename(absSource);

	// --- 7. dry-run stops here (nothing written) ---------------------------
	if (dryRun) {
		return {
			ok: true,
			dryRun: true,
			written: false,
			kind,
			source: { path: absSource, sha256: sourceSha256 },
			target: null,
			plan,
		};
	}

	// --- 8. atomic write of the target state + manifest --------------------
	mkdirSync(absTarget, { recursive: true, mode: DIR_MODE });
	let stateSha256;
	try {
		const stateBytes = Buffer.from(`${JSON.stringify(first.targetState, null, 2)}`, "utf8");
		writeFileAtomic(absTarget, targetFile, stateBytes);
		stateSha256 = sha256Bytes(readFileSync(join(absTarget, targetFile)));
	} catch (error) {
		throw new StateConverterError("write-failed", `target state could not be written: ${error.message}`);
	}

	const manifest = {
		...plan,
		dryRun: false,
		twoDryRunsIdentical: true,
		source: { path: absSource, sha256: sourceSha256 },
		target: { dir: absTarget, file: targetFile, sha256: stateSha256 },
	};
	let manifestPath;
	try {
		manifestPath = writeFileAtomic(absTarget, MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);
	} catch (error) {
		throw new StateConverterError("write-failed", `manifest could not be written: ${error.message}`);
	}

	return {
		ok: true,
		dryRun: false,
		written: true,
		kind,
		source: { path: absSource, sha256: sourceSha256 },
		target: { dir: absTarget, file: targetFile, sha256: stateSha256 },
		plan,
		manifest,
		manifestPath,
	};
}

/**
 * Re-verify a produced conversion from its own target directory: the manifest's
 * target sha256 must match the written bytes and every collection's counts and
 * per-record digests must re-derive from the target state. Throws on any drift.
 */
export function verifyConversion({ targetDir } = {}) {
	if (typeof targetDir !== "string" || targetDir.length === 0 || !isAbsolute(targetDir)) {
		throw new StateConverterError("invalid-config", "targetDir is required and must be an absolute path");
	}
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(targetDir, MANIFEST_NAME), "utf8"));
	} catch {
		throw new StateConverterError("verify-failed", "manifest.json is missing or unreadable");
	}
	if (manifest.converterVersion !== CONVERTER_VERSION) {
		throw new StateConverterError("verify-failed", "manifest converterVersion does not match");
	}
	if (!manifest.target || typeof manifest.target.file !== "string") {
		throw new StateConverterError("verify-failed", "manifest is missing its target file");
	}
	const targetBytes = readFileSync(join(targetDir, manifest.target.file));
	if (sha256Bytes(targetBytes) !== manifest.target.sha256) {
		throw new StateConverterError("verify-failed", "target sha256 does not match the written bytes");
	}
	const state = JSON.parse(targetBytes.toString("utf8"));
	const { collections } = KIND_DESCRIPTORS[manifest.kind];

	for (const entry of manifest.collections) {
		const descriptor = collections.find((candidate) => candidate.name === entry.name);
		if (!descriptor || !Object.hasOwn(state, entry.name)) {
			throw new StateConverterError("verify-failed", `manifest collection ${entry.name} is missing from the target`);
		}
		const records = [];
		for (const [key, record] of entriesOf(descriptor, state[entry.name])) {
			const index = descriptor.shape === "array" ? Number(key) : undefined;
			records.push({ id: identityOf(descriptor, key, record, index), digest: digestOf(record) });
		}
		if (records.length !== entry.targetCount || records.length !== entry.sourceCount) {
			throw new StateConverterError("verify-failed", `${entry.name} count drifted from the manifest`);
		}
		const byId = new Map(records.map((record) => [record.id, record.digest]));
		for (const recorded of entry.records) {
			if (recorded.disposition === "rejected") {
				throw new StateConverterError("verify-failed", `${entry.name} manifest records a rejected record`);
			}
			if (byId.get(recorded.id) !== recorded.digest) {
				throw new StateConverterError("verify-failed", `${entry.name}.${recorded.id} digest drifted`);
			}
		}
		if (collectionDigest(records) !== entry.sha256) {
			throw new StateConverterError("verify-failed", `${entry.name} collection digest drifted`);
		}
	}
	return { ok: true, kind: manifest.kind, collections: manifest.collections.length, source: manifest.source, target: manifest.target };
}
