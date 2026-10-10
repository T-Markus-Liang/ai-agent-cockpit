// Personal AI OS 0.3.0 Wave 5/S04b — cross-store freeze coordinator & guarded rollback.
//
// This module is the coordination half the P5/P6 readiness map flagged alongside
// the snapshot orchestrator: "全系统一致性停写快照编排（零）" is only half
// answered by a per-store snapshotter. A single-database online backup is NOT a
// cross-store freeze point: store B may admit a new write while store A is being
// copied, so the two snapshot directories do not describe one instant of the
// system. This coordinator closes that gap for ANY set of stores fronted by an
// injected quiesce adapter, WITHOUT performing any conversion (that is
// control-plane/state-converter.mjs) and WITHOUT claiming any cross-store
// atomic commit (see BOUNDARIES below).
//
// SCOPE
//   * freezeAndSnapshot — fixed-lock-order freeze (stop admission, drain
//     in-flight, record the COMMON freeze watermark, snapshot) driving the
//     existing snapshot-orchestrator via each store's injected adapter.
//   * resumeFrozen — explicit, owner/fence-authorized recovery of an
//     interrupted or needs-review freeze scene (NEVER a blind resume).
//   * planRollback / executeRollback — the test-prototype restore path of
//     tests/migration-rollback-drill.test.mjs converged into a guarded
//     production shape: read-only preflight of every target and the manifest,
//     watermark-drift refusal, post-restore watermark invariant.
//
// HARD BOUNDARIES (identical spirit to snapshot-orchestrator.mjs:10-18 and
// state-converter.mjs:13-21)
//   * This module touches only the paths a caller explicitly hands it. It never
//     reads or writes ~/.local/state/personal-ai-os/, ~/.wechat-acp/ or any
//     other production/launchd-owned state. It makes no network calls and reads
//     no environment. The clock is injected via `now`.
//   * NO CROSS-STORE ATOMIC COMMIT IS CLAIMED. Each store's snapshot/restore is
//     atomic on its own (tmp + fsync + rename, per store adapter); what the
//     coordinator adds is (a) a FIXED lock order — registration order, declared
//     here — so freeze acquisition cannot deadlock, (b) admission stopped and
//     in-flight drained before any snapshot starts, so every store's copy is
//     taken against a quiet store, and (c) one common freeze watermark recorded
//     for all stores, so rollback guards can prove no store drifted across the
//     freeze point. Per-file rename atomicity is never advertised as a
//     cross-store transaction.
//   * Rollback ONLY switches future routing back to the frozen bytes. It never
//     replays an old execution: there is no replay entry point in this module
//     and none is exported; an unknown/stale execution is a human-review
//     subject, not something this code re-drives.
//   * Rollback requires the explicit conditional-restore-v1 adapter contract:
//     restoreFrozenConditional(target, { expectedWatermark, protectAfter })
//     atomically checks expectedWatermark at the restore commit, excludes
//     concurrent writes for the entire restore (including awaits), and returns
//     { applied: true } or { applied: false } with NO mutation on refusal.
//     No post-watermark comparison proves byte conservation; adapters must
//     actually enforce this contract. Legacy restoreFrozen alone is refused.
//   * The manifest, journal and freeze-record hold only names, kinds, states,
//     deterministic operation ids, sha256 digests, byte counts, watermarks and
//     timestamps — never the store's raw content and never adapter error text.
//
// QUIESCE ADAPTER PROTOCOL (injected per store; the snapshot half is the SAME
// three-method shape snapshot-orchestrator.mjs already consumes, so the same
// object can be handed to the orchestrator unchanged):
//   stopAdmission(ctx)     -> stop NEW admissions; returns { stoppedAt, inFlight }
//   resumeAdmission(ctx)   -> undo stopAdmission() (idempotent; explicit only —
//                             the coordinator never resumes blindly after a
//                             drain failure). ctx carries owner, fence and
//                             operationId; adapters must scope the gate to this
//                             owner/fence and refuse to release another gate.
//   drain({ timeoutMs, now }) -> wait for / verify in-flight writes; on timeout
//                             or unverifiable in-flight throws an error whose
//                             `code` is "freeze-timeout" and which may carry a
//                             `watermark` of what it DID confirm
//   watermark()            -> the store's CURRENT deterministic watermark: a
//                             logical admission sequence (max event_id / LSN /
//                             timestamp+counter composite), NOT a content hash.
//                             Numbers compare numerically, strings
//                             codepoint-wise; anything else must compare equal
//                             or the coordinator refuses to order it
//                             (fail-closed, code watermark-incomparable).
//   snapshotAdapter()      -> { quiesce(ctx), snapshotTo(targetDir, ctx),
//                             resume(ctx) } for the orchestrator
//   restoreFrozen(targetDir, { protectAfter }) -> legacy adapter shape used by
//                             read-only plan validation; insufficient to execute.
//   rollbackContract       -> "conditional-restore-v1", explicitly declared
//   restoreFrozenConditional(targetDir, { expectedWatermark, protectAfter })
//                          -> async { applied }; atomic compare/restore and
//                             exclusion across awaits, as specified above.
//
// LOCK ORDER (fixed, declared): the caller's registration order is the lock
// order. Admission is stopped store-by-store in that order, drained in that
// order, and recovery resumes admission in REVERSE order (mirror of the
// orchestrator's resume convention).
//
// COORDINATION RECORD
//   `rootDir/.freeze-coordination/<runId>/freeze-record.json` (fresh directory,
//   atomic write tmp+fsync+rename+fsync dir, mode 0600). The snapshot artifacts
//   themselves stay in the orchestrator's own `rootDir/<runId>/` run directory;
//   the coordination record references that run by runId and carries, per
//   store: watermark, admission/drain state, owner, fence and the deterministic
//   `<runId>:<store>:<quiesce|snapshot|resume>` operationId map. Its `digest`
//   covers ONLY deterministic content (schema, version, store names/kinds,
//   frozen watermarks) — never runId, owner, fence token or timestamps — so two
//   freeze runs over identical inputs with the same injected clock/owner are
//   provably identical modulo those fields (the double dry-run contract).
//
// THREE-STATE HONESTY (mirrors the orchestrator)
//   freezeAndSnapshot returns status "success" (every store stopped, drained,
//   watermark-frozen and snapshotted), "failed" (the snapshot run itself
//   failed) or "needs-review" (a drain timed out / was unverifiable, or the
//   orchestrator run ended needs-review). A needs-review scene keeps admission
//   STOPPED for every store in the scene; the ONLY way back is an explicit
//   resumeFrozen() by the recorded owner inside the recorded fence. The
//   coordination record never whitewashes a bad outcome.
//
// Dependencies: node:crypto, node:fs, node:path — plus the existing
// snapshot-orchestrator (no new dependency).

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

import {
	createSnapshotOrchestrator,
	inspectRun,
	recoverRun,
	JOURNAL_NAME,
	MANIFEST_NAME,
} from "./snapshot-orchestrator.mjs";

/** On-disk freeze-record schema understood by this module. */
export const RECORD_SCHEMA_VERSION = 1;
export const COORDINATION_VERSION = "freeze-coordinator-v1";
/** Name of the coordination namespace inside the snapshot root. */
export const COORDINATION_DIR = ".freeze-coordination";
/** Name of the per-run coordination record file. */
export const FREEZE_RECORD_NAME = "freeze-record.json";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SEGMENT_LENGTH = 255;
const DEFAULT_FENCE_TTL_MS = 3_600_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

const ERROR_CODES = new Set([
	"invalid-config", "invalid-store", "invalid-run-id", "duplicate-store", "root-missing",
	"root-outside-allow-root", "target-exists", "freeze-record-missing", "freeze-record-invalid",
	"freeze-record-inconsistent", "snapshot-file-missing", "snapshot-hash-mismatch",
	"snapshot-size-mismatch", "snapshot-file-unexpected", "snapshot-digest-mismatch",
	"manifest-missing", "freeze-partial", "freeze-timeout", "stop-admission-failed", "drain-failed",
	"recovery-not-authorized", "fence-expired", "rollback-refused", "rollback-invariant",
	"rollback-store-failed", "restore-failed", "snapshot-verify-failed", "freeze-not-successful",
	"snapshot-not-successful", "no-rollback-target", "snapshot-dir-missing", "not-in-snapshot",
	"watermark-incomparable", "watermark-regressed", "new-data-since-freeze",
	"rollback-contract-required", "freeze-record-write-failed", "freeze-adapter-failed",
]);

function adapterErrorCode(error, stageCode) {
	// Adapter codes are stage-specific, even for our exported Error subclass.
	const candidate = error instanceof FreezeCoordinatorError ? error.code : null;
	return candidate === stageCode ? candidate : stageCode;
}

/** Names that would collide with the orchestrator's or our own bookkeeping. */
const RESERVED_SEGMENTS = new Set([
	MANIFEST_NAME,
	`${MANIFEST_NAME}.tmp`,
	JOURNAL_NAME,
	`${JOURNAL_NAME}.tmp`,
	FREEZE_RECORD_NAME,
	`${FREEZE_RECORD_NAME}.tmp`,
]);

/** A redacted coordinator failure. Never carries store content. */
export class FreezeCoordinatorError extends Error {
	constructor(code, message, { details } = {}) {
		const safeCode = ERROR_CODES.has(code) ? code : "freeze-adapter-failed";
		super(message ?? safeCode);
		this.name = "FreezeCoordinatorError";
		this.code = safeCode;
		if (details !== undefined) this.details = details;
	}
}

// ---------------------------------------------------------------------------
// stable serialisation / digests (mirrors state-converter.mjs stable())
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

/** A record digest in the same `sha256:<hex>` shape the stores use. */
function digestOf(value) {
	return `sha256:${fingerprint(value)}`;
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir, acc = []) {
	for (const name of readdirSync(dir).sort()) {
		const child = join(dir, name);
		const stats = lstatSync(child);
		if (stats.isDirectory()) walkFiles(child, acc);
		else if (stats.isFile()) acc.push(child);
	}
	return acc;
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The orchestrator's combined per-store digest: sorted `path\0sha256\n` lines. */
function combinedDigest(files) {
	const hasher = createHash("sha256");
	for (const file of [...files].sort(byPath)) {
		hasher.update(file.path);
		hasher.update("\0");
		hasher.update(file.sha256);
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// path guards (mirrors snapshot-orchestrator.mjs / state-converter.mjs)
// ---------------------------------------------------------------------------

/** True when `child` is `parent` itself or lives below it (both absolute). */
function isWithin(child, parent) {
	if (child === parent) return true;
	const base = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(base);
}

/** True when any directory entry (file, dir or symlink) exists at `path`. */
function entryExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function fsyncPath(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is not portable; a failure here never invalidates the
		// record (the file write itself is already durable enough for our needs).
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Atomically write + fsync a JSON file (temp file, fsync, rename, fsync dir). */
function writeAtomicJsonSync(dir, name, value) {
	const target = join(dir, name);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
	fsyncPath(tmp);
	renameSync(tmp, target);
	fsyncPath(dir);
	return target;
}

/**
 * Resolve + authorize the snapshot root against an explicit allowed root, with
 * the same containment boundary the orchestrator applies, so the coordination
 * records can never be written outside the tree the snapshots live in. Pure
 * read-only (realpath + stat); throws closed on a missing root, a
 * non-directory root or an out-of-bounds root.
 */
function resolveRoots({ rootDir, allowRoot }) {
	if (typeof rootDir !== "string" || rootDir.length === 0) {
		throw new FreezeCoordinatorError("invalid-config", "rootDir must be a non-empty string");
	}
	if (typeof allowRoot !== "string" || allowRoot.length === 0) {
		throw new FreezeCoordinatorError("invalid-config", "allowRoot is required and must be a non-empty string");
	}
	if (!isAbsolute(allowRoot)) {
		throw new FreezeCoordinatorError("invalid-config", "allowRoot must be an absolute path");
	}
	const absRoot = resolvePath(rootDir);
	const absAllow = resolvePath(allowRoot);

	let realRoot;
	try {
		realRoot = realpathSync(absRoot);
	} catch {
		throw new FreezeCoordinatorError("root-missing", "rootDir does not exist");
	}
	let realAllow;
	try {
		realAllow = realpathSync(absAllow);
	} catch {
		throw new FreezeCoordinatorError("root-missing", "allowRoot does not exist");
	}
	if (!statSync(realRoot).isDirectory()) {
		throw new FreezeCoordinatorError("root-missing", "rootDir is not a directory");
	}
	if (!isWithin(realRoot, realAllow)) {
		throw new FreezeCoordinatorError("root-outside-allow-root", "rootDir resolves outside the allowed root");
	}
	return { realRoot, realAllow };
}

/**
 * Assert `value` is a safe single path segment usable as a coordination
 * directory name: non-empty, at most 255 chars, not `.`/`..`, no path
 * separator (POSIX or Windows) and no NUL, not a reserved bookkeeping name,
 * and not a staging suffix (`*.stage`). Throws `code` on any violation.
 */
function assertSafeSegment(value, code, what) {
	if (typeof value !== "string" || value.length === 0) {
		throw new FreezeCoordinatorError(code, `${what} must be a non-empty string`);
	}
	if (value.length > MAX_SEGMENT_LENGTH) {
		throw new FreezeCoordinatorError(code, `${what} must be at most ${MAX_SEGMENT_LENGTH} characters`);
	}
	if (value === "." || value === "..") {
		throw new FreezeCoordinatorError(code, `${what} must not be "." or ".."`);
	}
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
		throw new FreezeCoordinatorError(code, `${what} must be a single path segment`);
	}
	if (RESERVED_SEGMENTS.has(value)) {
		throw new FreezeCoordinatorError(code, `${what} must not use a reserved name`);
	}
	if (value.endsWith(".stage")) {
		throw new FreezeCoordinatorError(code, `${what} must not end with ".stage"`);
	}
	return value;
}

function makeClock(now) {
	if (now !== undefined && typeof now !== "function") {
		throw new FreezeCoordinatorError("invalid-config", "now must be a function when provided");
	}
	return now ?? Date.now;
}

/**
 * Validate one injected quiesce adapter BEFORE anything is touched: the freeze
 * half (stopAdmission/resumeAdmission/drain/watermark), the orchestrator half
 * (snapshotAdapter returning a three-method adapter) and the rollback half
 * (restoreFrozen, validated only where demanded). Fails closed.
 */
function validateQuiesceAdapter(store, { requireRestore } = {}) {
	const label = `store ${store.name}`;
	const adapter = store.adapter;
	if (adapter === null || typeof adapter !== "object") {
		throw new FreezeCoordinatorError("invalid-store", `${label} adapter must be an object`);
	}
	for (const method of ["stopAdmission", "resumeAdmission", "drain", "watermark", "snapshotAdapter"]) {
		if (typeof adapter[method] !== "function") {
			throw new FreezeCoordinatorError("invalid-store", `${label} adapter must implement ${method}()`);
		}
	}
	const snapshot = adapter.snapshotAdapter();
	if (
		snapshot === null ||
		typeof snapshot !== "object" ||
		typeof snapshot.quiesce !== "function" ||
		typeof snapshot.snapshotTo !== "function" ||
		typeof snapshot.resume !== "function"
	) {
		throw new FreezeCoordinatorError(
			"invalid-store",
			`${label} snapshotAdapter() must return { quiesce, snapshotTo, resume }`,
		);
	}
	if (requireRestore && typeof adapter.restoreFrozen !== "function" && typeof adapter.restoreFrozenConditional !== "function") {
		throw new FreezeCoordinatorError("invalid-store", `${label} adapter must implement a restore method`);
	}
	return { quiesceAdapter: adapter, snapshotAdapter: snapshot };
}

/**
 * A content-free, path-free failure record for the coordination layer: only a
 * fixed code plus the store's validated logical name — never error text, so a
 * leaked credential in an adapter message can never reach the freeze-record.
 */
function failureRecord(code, store, extra = {}) {
	const record = { code, ...extra };
	if (store !== undefined) record.store = store;
	return record;
}

// ---------------------------------------------------------------------------
// watermark ordering
// ---------------------------------------------------------------------------
//
// Watermarks are LOGICAL admission sequences chosen by the store (max event_id,
// LSN, …). Numbers order numerically, strings codepoint-wise (zero-pad fixed-
// width composites). Mixed or non-primitive shapes have no coordinator-defined
// order: unless they compare exactly equal the coordinator refuses to order
// them (fail-closed). Returns -1/0/1, or null when no order is definable.
function compareWatermarks(a, b) {
	if ((typeof a === "number" && !Number.isFinite(a)) || (typeof b === "number" && !Number.isFinite(b))) return null;
	if (typeof a === "number" && typeof b === "number") {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (typeof a === "string" && typeof b === "string") {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (fingerprint(a) === fingerprint(b)) return 0;
	return null;
}

// ---------------------------------------------------------------------------
// coordination record persistence
// ---------------------------------------------------------------------------

function coordinationDirFor(realRoot, runId) {
	return join(realRoot, COORDINATION_DIR, runId);
}

/**
 * The deterministic digest of a freeze-record: schema, version, store
 * names/kinds and the frozen per-store watermarks ONLY. runId, owner, fence
 * token and every timestamp are excluded so the double dry-run contract
 * ("same inputs + same injected clock/owner ⇒ identical record modulo
 * runId/time") is checkable by comparing digests.
 */
function freezeRecordDigest(record) {
	return digestOf({
		schemaVersion: record.schemaVersion,
		coordinationVersion: record.coordinationVersion,
		stores: record.stores.map((store) => ({ name: store.name, kind: store.kind, watermark: store.watermark })),
		freezeWatermark: { perStore: record.freezeWatermark.perStore },
	});
}

/**
 * Read + minimally shape-check a coordination record. Throws
 * freeze-record-missing / freeze-record-invalid; never tolerates a
 * half-written file silently (our own writes are atomic, so a torn file is an
 * external fault and must surface).
 */
function readFreezeRecord(coordDir) {
	const recordPath = join(coordDir, FREEZE_RECORD_NAME);
	if (!existsSync(recordPath)) {
		throw new FreezeCoordinatorError("freeze-record-missing", "no freeze record for this run");
	}
	let record;
	try {
		record = JSON.parse(readFileSync(recordPath, "utf8"));
	} catch {
		throw new FreezeCoordinatorError("freeze-record-invalid", "freeze record is not valid JSON");
	}
	if (
		!record ||
		typeof record !== "object" ||
		record.schemaVersion !== RECORD_SCHEMA_VERSION ||
		typeof record.runId !== "string" ||
		typeof record.owner !== "string" ||
		record.owner.length === 0 ||
		!record.fence ||
		typeof record.fence.token !== "string" ||
		record.fence.token.length === 0 ||
		!Number.isFinite(record.fence.expiresAt) ||
		!Array.isArray(record.stores) ||
		!record.freezeWatermark ||
		typeof record.freezeWatermark !== "object"
	) {
		throw new FreezeCoordinatorError("freeze-record-invalid", "freeze record has an invalid shape");
	}
	return record;
}

/** Persist the coordination record atomically and refresh its digest. */
function persistFreezeRecord(coordDir, record) {
	record.digest = freezeRecordDigest(record);
	try {
		return writeAtomicJsonSync(coordDir, FREEZE_RECORD_NAME, record);
	} catch {
		throw new FreezeCoordinatorError("freeze-record-write-failed", "freeze record persistence failed");
	}
}

// ---------------------------------------------------------------------------
// manifest evidence verification (mirrors the drill's two-phase philosophy)
// ---------------------------------------------------------------------------

/** Recompute one store's snapshot evidence from the bytes on disk. */
function recomputeEvidence(snapshotDir) {
	const files = walkFiles(snapshotDir)
		.map((absolute) => ({
			path: relative(snapshotDir, absolute),
			sha256: sha256File(absolute),
			bytes: statSync(absolute).size,
		}))
		.sort(byPath);
	return { files, sha256: combinedDigest(files), bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/**
 * Verify one store's snapshot directory against its manifest entry, read-only.
 * Throws FreezeCoordinatorError with a drill-compatible code on any drift so a
 * partially-trusted snapshot can never be half-restored into a live store.
 */
function verifyStoreEvidence(snapshotDir, store) {
	const onDisk = recomputeEvidence(snapshotDir).files;
	const recorded = [...store.files].sort(byPath);
	const recordedPaths = new Set(recorded.map((file) => file.path));
	const onDiskPaths = new Set(onDisk.map((file) => file.path));

	for (const file of recorded) {
		if (!onDiskPaths.has(file.path)) {
			throw new FreezeCoordinatorError("snapshot-file-missing", `snapshot is missing ${store.name}/${file.path}`);
		}
	}
	for (const file of onDisk) {
		if (!recordedPaths.has(file.path)) {
			throw new FreezeCoordinatorError(
				"snapshot-file-unexpected",
				`snapshot has an unaccounted file ${store.name}/${file.path}`,
			);
		}
	}
	for (const file of onDisk) {
		const rec = recorded.find((candidate) => candidate.path === file.path);
		if (file.sha256 !== rec.sha256) {
			throw new FreezeCoordinatorError(
				"snapshot-hash-mismatch",
				`${store.name}/${file.path} sha256 does not match the snapshot manifest`,
			);
		}
		if (file.bytes !== rec.bytes) {
			throw new FreezeCoordinatorError(
				"snapshot-size-mismatch",
				`${store.name}/${file.path} byte count does not match the snapshot manifest`,
			);
		}
	}
	if (recomputeEvidence(snapshotDir).sha256 !== store.sha256) {
		throw new FreezeCoordinatorError(
			"snapshot-digest-mismatch",
			`${store.name} combined digest drifted from the snapshot manifest`,
		);
	}
	return onDisk;
}

// ---------------------------------------------------------------------------
// shared option validation
// ---------------------------------------------------------------------------

function validateStoreList(stores) {
	if (!Array.isArray(stores) || stores.length === 0) {
		throw new FreezeCoordinatorError("invalid-config", "stores must be a non-empty array");
	}
	const names = new Set();
	const prepared = [];
	for (const store of stores) {
		if (!store || typeof store !== "object") {
			throw new FreezeCoordinatorError("invalid-store", "each store must be an object");
		}
		assertSafeSegment(store.name, "invalid-store", "store name");
		if (names.has(store.name)) {
			throw new FreezeCoordinatorError("duplicate-store", `store already registered: ${store.name}`);
		}
		names.add(store.name);
		const kind = typeof store.kind === "string" && store.kind.length > 0 ? store.kind : "custom";
		prepared.push({ name: store.name, kind, adapter: store.adapter, path: store.path });
	}
	return prepared;
}

/**
 * Read the freeze record + orchestrator manifest for a run, verifying the two
 * agree on the runId and that both are successful. Read-only. Returns
 * { record, manifest, runDir, coordDir }.
 */
function loadRunArtifacts({ rootDir, allowRoot, runId }) {
	const { realRoot } = resolveRoots({ rootDir, allowRoot });
	assertSafeSegment(runId, "invalid-run-id", "runId");
	const runDir = join(realRoot, runId);
	if (!isWithin(runDir, realRoot) || runDir === realRoot) {
		throw new FreezeCoordinatorError("invalid-run-id", "runId escapes the snapshot root");
	}
	const coordDir = coordinationDirFor(realRoot, runId);
	const record = readFreezeRecord(coordDir);

	const manifestPath = join(runDir, MANIFEST_NAME);
	if (!existsSync(manifestPath)) {
		throw new FreezeCoordinatorError("manifest-missing", "snapshot manifest is missing for this run");
	}
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		throw new FreezeCoordinatorError("manifest-missing", "snapshot manifest is unreadable");
	}
	if (manifest.runId !== runId || manifest.runId !== record.runId) {
		throw new FreezeCoordinatorError("freeze-record-inconsistent", "manifest and freeze record disagree on runId");
	}
	return { realRoot, runDir, coordDir, record, manifest };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Freeze a set of stores at one common watermark and snapshot them.
 *
 * Fixed lock order = registration order:
 *   1. validate EVERYTHING read-only first (config, names, adapter shapes,
 *      path stores, fresh coordination dir, fresh orchestrator run dir), so a
 *      refused configuration stops no admission and writes nothing;
 *   2. stopAdmission() each store in lock order — any failure resumes the
 *      confirmed stores in reverse order and throws `freeze-partial`.
 *      Pre-call owner/fence intent survives; the throwing store stays unknown
 *      until explicit authorized recovery, even before a snapshot exists;
 *   3. drain() each store in lock order with `perStoreTimeoutMs` — a timeout
 *      or unverifiable in-flight record is persisted and reported as
 *      `needs-review`; admission stays STOPPED for every store in the scene
 *      and is only restored by an explicit resumeFrozen();
 *   4. all drained: take every store's watermark(), build the common freeze
 *      watermark `{ perStore, takenAt }` and persist the coordination record
 *      (status `frozen`, atomic, mode 0600);
 *   5. register each store's snapshotAdapter() into a fresh
 *      snapshot-orchestrator (same `owner`, `fenceTtlMs`, clock) and run() it.
 *      The run's outcome is reported verbatim — success, failed or
 *      needs-review are never whitewashed — and the terminal record carries
 *      the journal's owner/fence plus the deterministic operationId map.
 *
 * @param {object} options
 * @param {string} options.rootDir   snapshot root; must exist, be a directory
 *                                   and resolve under `allowRoot`.
 * @param {string} options.allowRoot REQUIRED absolute allowed root.
 * @param {{name: string, kind?: string, adapter: object, path?: string}[]} options.stores
 *                                   stores in lock (registration) order.
 * @param {() => number} [options.now] injected clock (defaults to Date.now).
 * @param {string} [options.owner]   identity recorded in the freeze record and
 *                                   required to authorize resumeFrozen
 *                                   (defaults to a fresh random UUID).
 * @param {number} [options.fenceTtlMs] coordination fence TTL (default 1h).
 * @param {number} [options.perStoreTimeoutMs] drain timeout per store
 *                                   (default 30s; must be a positive finite).
 * @param {string} [options.runId]   run id (default `freeze-<clock>-<seq>`);
 *                                   a safe single segment, fresh in rootDir.
 */
export async function freezeAndSnapshot({
	rootDir,
	allowRoot,
	stores,
	now,
	owner,
	fenceTtlMs,
	perStoreTimeoutMs,
	runId,
} = {}) {
	const clock = makeClock(now);
	const { realRoot } = resolveRoots({ rootDir, allowRoot });
	const prepared = validateStoreList(stores);

	let coordinationOwner;
	if (owner === undefined) {
		coordinationOwner = randomUUID();
	} else if (typeof owner !== "string" || owner.length === 0) {
		throw new FreezeCoordinatorError("invalid-config", "owner must be a non-empty string when provided");
	} else {
		coordinationOwner = owner;
	}
	const ttl = fenceTtlMs === undefined ? DEFAULT_FENCE_TTL_MS : fenceTtlMs;
	if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
		throw new FreezeCoordinatorError("invalid-config", "fenceTtlMs must be a positive finite number");
	}
	const drainTimeout =
		perStoreTimeoutMs === undefined ? DEFAULT_DRAIN_TIMEOUT_MS : perStoreTimeoutMs;
	if (typeof drainTimeout !== "number" || !Number.isFinite(drainTimeout) || drainTimeout <= 0) {
		throw new FreezeCoordinatorError("invalid-config", "perStoreTimeoutMs must be a positive finite number");
	}

	// 1. Validate every store + the fresh directories BEFORE any store is
	//    paused and before any write. A throw here leaves the tree exactly as
	//    it was and stops no admission.
	const adapters = new Map();
	for (const store of prepared) {
		adapters.set(store.name, validateQuiesceAdapter(store));
	}
	const resolvedRunId = runId ?? `freeze-${clock()}-${randomUUID().slice(0, 8)}`;
	assertSafeSegment(resolvedRunId, "invalid-run-id", "runId");
	const runDir = join(realRoot, resolvedRunId);
	if (!isWithin(runDir, realRoot) || runDir === realRoot) {
		throw new FreezeCoordinatorError("invalid-run-id", "runId escapes the snapshot root");
	}
	if (entryExists(runDir)) {
		throw new FreezeCoordinatorError("target-exists", "run directory already exists");
	}
	const coordDir = coordinationDirFor(realRoot, resolvedRunId);
	if (entryExists(coordDir)) {
		throw new FreezeCoordinatorError("target-exists", "coordination directory already exists");
	}

	const startedAt = clock();
	const fence = { token: randomUUID(), issuedAt: startedAt, expiresAt: startedAt + ttl };
	const baseRecord = () => ({
		schemaVersion: RECORD_SCHEMA_VERSION,
		coordinationVersion: COORDINATION_VERSION,
		runId: resolvedRunId,
		owner: coordinationOwner,
		fence: { ...fence },
		startedAt,
		status: "frozen",
		stores: prepared.map((store) => ({
			name: store.name,
			kind: store.kind,
			admission: "pending",
			drain: "pending",
			watermark: null,
			stoppedAt: null,
			inFlightAtStop: null,
			drainedAt: null,
			operationIds: {
				quiesce: `${resolvedRunId}:${store.name}:quiesce`,
				snapshot: `${resolvedRunId}:${store.name}:snapshot`,
				resume: `${resolvedRunId}:${store.name}:resume`,
			},
		})),
		freezeWatermark: { perStore: {}, takenAt: null },
		snapshot: { status: "not-attempted" },
		network_calls: 0,
		digest: null,
	});

	// The record is assembled incrementally: one live per-store entry updated
	// in place, merged into a fresh record shell at each persistence point.
	const recordEntries = new Map(
		prepared.map((store) => [
			store.name,
			{
				name: store.name,
				kind: store.kind,
				admission: "pending",
				drain: "pending",
				watermark: null,
				stoppedAt: null,
				inFlightAtStop: null,
				drainedAt: null,
				operationIds: {
					quiesce: `${resolvedRunId}:${store.name}:quiesce`,
					snapshot: `${resolvedRunId}:${store.name}:snapshot`,
					resume: `${resolvedRunId}:${store.name}:resume`,
				},
			},
		]),
	);
	function finalizeRecord(patch) {
		const record = baseRecord();
		for (const store of record.stores) {
			const live = recordEntries.get(store.name);
			if (live) Object.assign(store, live);
		}
		Object.assign(record, patch);
		return record;
	}

	// 2. Persist owner/fence and intent BEFORE each admission side effect.
	mkdirSync(coordDir, { recursive: true, mode: DIR_MODE });
	chmodSync(coordDir, DIR_MODE);
	const admissionContext = (name, operation) => ({
		runId: resolvedRunId, owner: coordinationOwner, fence: fence.token,
		operationId: `${resolvedRunId}:${name}:${operation}`,
	});
	persistFreezeRecord(coordDir, finalizeRecord({ status: "needs-review" }));
	const stopped = [];
	try {
		for (const store of prepared) {
			const adapter = adapters.get(store.name).quiesceAdapter;
			const entry = recordEntries.get(store.name);
			entry.admission = "intent";
			persistFreezeRecord(coordDir, finalizeRecord({ status: "needs-review" }));
			let outcome;
			try {
				outcome = await adapter.stopAdmission(admissionContext(store.name, "stop-admission"));
			} catch (error) {
				entry.admission = "unknown";
				throw failureRecord(
					adapterErrorCode(error, "stop-admission-failed"),
					store.name,
				);
			}
			stopped.push(store.name);
			entry.admission = "stopped";
			entry.stoppedAt = outcome && typeof outcome.stoppedAt === "number" ? outcome.stoppedAt : clock();
			entry.inFlightAtStop = outcome && typeof outcome.inFlight === "number" ? outcome.inFlight : null;
			persistFreezeRecord(coordDir, finalizeRecord({ status: "needs-review" }));
		}
	} catch (failure) {
		const resumeErrors = [];
		for (const name of [...stopped].reverse()) {
			try {
				await adapters.get(name).quiesceAdapter.resumeAdmission(admissionContext(name, "resume"));
				recordEntries.get(name).admission = "resumed";
			} catch {
				resumeErrors.push(name);
			}
		}
		let recoveryPersistence = "confirmed";
		try {
			persistFreezeRecord(coordDir, finalizeRecord({ status: "needs-review" }));
		} catch {
			recoveryPersistence = "uncertain";
		}
		const safeFailure = failureRecord(
			failure.code === "freeze-record-write-failed" ? "freeze-record-write-failed" : "stop-admission-failed",
			failure.store,
		);
		throw new FreezeCoordinatorError(
			"freeze-partial",
			"freeze admission failed; recovery requires review",
			{
				details: {
					stopped,
					resumed: stopped.filter((name) => !resumeErrors.includes(name)),
					resumeErrors,
					failed: safeFailure,
					runId: resolvedRunId,
					status: "needs-review",
					recoveryPersistence,
				},
			},
		);
	}

	// 3. Drain in lock order. A freeze-timeout (or any unverifiable drain) is
	//    persisted and returned as needs-review; admission stays stopped and is
	//    only restored by an explicit resumeFrozen().
	const drainFailure = { store: null, code: null };
	for (const store of prepared) {
		const adapter = adapters.get(store.name).quiesceAdapter;
		try {
			const outcome = await adapter.drain({ timeoutMs: drainTimeout, now: clock });
			const entry = recordEntries.get(store.name);
			entry.drain = "confirmed";
			entry.drainedAt = outcome && typeof outcome.drainedAt === "number" ? outcome.drainedAt : clock();
		} catch (error) {
			drainFailure.store = store.name;
			drainFailure.code = error && error.code === "freeze-timeout" ? "freeze-timeout" : "drain-failed";
			const entry = recordEntries.get(store.name);
			if (entry) entry.drain = drainFailure.code === "freeze-timeout" ? "timeout" : "failed";
			break;
		}
	}

	if (drainFailure.store !== null) {
		mkdirSync(coordDir, { recursive: true, mode: DIR_MODE });
		chmodSync(coordDir, DIR_MODE);
		const drainedNames = prepared.filter((store) => recordEntries.get(store.name)?.drain === "confirmed").map((s) => s.name);
		const record = finalizeRecord({ status: "needs-review" });
		persistFreezeRecord(coordDir, record);
		return {
			status: "needs-review",
			runId: resolvedRunId,
			freezeRecord: record,
			frozen: drainedNames,
			pending: prepared.filter((store) => !drainedNames.includes(store.name)).map((s) => s.name),
			failure: failureRecord(drainFailure.code, drainFailure.store),
			run: null,
		};
	}

	// 4. Common freeze watermark: every store drained, so every watermark is a
	//    quiet-store value of the same instant. Persist status `frozen`; the
	//    watermark survives into the terminal record written after the run.
	const perStore = {};
	for (const store of prepared) {
		const watermark = adapters.get(store.name).quiesceAdapter.watermark();
		recordEntries.get(store.name).watermark = watermark;
		perStore[store.name] = watermark;
	}
	const commonFreezeWatermark = { perStore, takenAt: clock() };
	mkdirSync(coordDir, { recursive: true, mode: DIR_MODE });
	chmodSync(coordDir, DIR_MODE);
	let record = finalizeRecord({ status: "frozen", freezeWatermark: commonFreezeWatermark });
	persistFreezeRecord(coordDir, record);

	// 5. Snapshot through the orchestrator. Its outcome is reported verbatim.
	const orchestrator = createSnapshotOrchestrator({
		rootDir,
		allowRoot,
		now: clock,
		owner: coordinationOwner,
		fenceTtlMs: ttl,
	});
	for (const store of prepared) {
		orchestrator.registerStore({
			name: store.name,
			kind: store.kind,
			path: store.path,
			adapter: adapters.get(store.name).snapshotAdapter,
		});
	}
	const run = await orchestrator.run({ runId: resolvedRunId });

	// Merge the journal's owner/fence view into the terminal record. A journal
	// that cannot be read after a finished run is an honest needs-review, not a
	// whitewash.
	let journalView = null;
	try {
		const journal = JSON.parse(readFileSync(join(runDir, JOURNAL_NAME), "utf8"));
		journalView = {
			owner: journal.owner,
			fence: journal.fence,
			state: journal.state,
			stores: Array.isArray(journal.stores)
				? journal.stores.map((state) => ({ name: state.name, quiesce: state.quiesce, resume: state.resume }))
				: [],
		};
	} catch {
		journalView = null;
	}
	record = finalizeRecord({
		status: run.status === "success" ? "success" : run.status,
		freezeWatermark: commonFreezeWatermark,
		snapshot: { status: run.status, manifest: run.manifestPath ? runDir : null, journal: journalView },
	});
	persistFreezeRecord(coordDir, record);

	return { status: record.status, runId: resolvedRunId, freezeRecord: record, run };
}

/**
 * Explicitly recover a freeze scene — and nothing else. Never re-runs a
 * snapshot, never re-executes a user task, never replays an execution.
 *
 * Authorization is layered, mirroring the orchestrator's recoverRun:
 *   * the caller must be the run's recorded `owner`;
 *   * the injected clock must be inside the coordination fence
 *     (`now() <= record.fence.expiresAt`);
 *   * when the orchestrator run was attempted (its journal exists), the same
 *     owner is re-authorized there and ONLY the journal-resumable stores are
 *     resumed, replayed with the SAME fence token and deterministic
 *     operationId (recoverRun's own semantics);
 *   * stores registered in the coordination record but absent from the call
 *     are left untouched; stores passed but not registered are ignored.
 *
 * Admission is resumed in REVERSE lock order after the orchestrator recovery;
 * every failure is recorded and surfaced — the record's terminal status is
 * `resumed` only when nothing failed, otherwise `needs-review`.
 *
 * @param {object} options
 * @param {string} options.rootDir
 * @param {string} options.allowRoot
 * @param {string} options.runId
 * @param {string} options.owner
 * @param {{name: string, adapter: object}[]} options.stores
 * @param {() => number} [options.now]
 */
export async function resumeFrozen({ rootDir, allowRoot, runId, owner, stores, now } = {}) {
	const clock = makeClock(now);
	const { realRoot } = resolveRoots({ rootDir, allowRoot });
	assertSafeSegment(runId, "invalid-run-id", "runId");
	const coordDir = coordinationDirFor(realRoot, runId);
	if (!isWithin(coordDir, realRoot) || dirname(coordDir) === realRoot) {
		throw new FreezeCoordinatorError("invalid-run-id", "runId escapes the snapshot root");
	}
	const record = readFreezeRecord(coordDir);

	// Authorization first: a caller who is not the recorded owner learns
	// nothing about the scene and touches nothing.
	if (typeof owner !== "string" || owner.length === 0 || owner !== record.owner) {
		throw new FreezeCoordinatorError("recovery-not-authorized", "owner does not match the freeze record");
	}
	if (clock() > record.fence.expiresAt) {
		throw new FreezeCoordinatorError("fence-expired", "the coordination fence has expired; recovery is refused");
	}

	const provided = new Map();
	for (const store of stores ?? []) {
		if (store && typeof store.name === "string") provided.set(store.name, store.adapter);
	}
	// Only stores registered in the coordination record are actionable.
	const actionable = record.stores.filter((entry) => provided.has(entry.name));
	const ignored = [...provided.keys()].filter((name) => !record.stores.some((entry) => entry.name === name));

	// Fail closed: prove every actionable store can do what we may ask, before
	// anything is touched. Admission-resumable stores need resumeAdmission();
	// journal-resumable stores additionally need a snapshot adapter whose
	// resume() recoverRun will replay.
	let journalResumable = [];
	const runDir = join(realRoot, runId);
	let journal = null;
	if (entryExists(join(runDir, JOURNAL_NAME))) {
		journal = inspectRun({ rootDir, allowRoot, runId });
		journalResumable = journal.resumable;
	}
	const isAdmissionResumable = (entry) => ["stopped", "intent", "unknown"].includes(entry.admission);
	const admissionResumable = actionable.filter(isAdmissionResumable);
	for (const entry of actionable) {
		const adapter = provided.get(entry.name);
		if (admissionResumable.some((candidate) => candidate.name === entry.name)) {
			if (adapter === null || adapter === undefined || typeof adapter.resumeAdmission !== "function") {
				throw new FreezeCoordinatorError("invalid-store", `no resumeAdmission() supplied for store ${entry.name}`);
			}
		}
		if (journalResumable.includes(entry.name)) {
			const snapshot = validateQuiesceAdapter({ name: entry.name, adapter }).snapshotAdapter;
			if (typeof snapshot.resume !== "function") {
				throw new FreezeCoordinatorError("invalid-store", `no resumable adapter supplied for store ${entry.name}`);
			}
		}
	}

	// Layer 1 — orchestrator recovery (owner + fence re-authorized inside
	// recoverRun against the journal; same fence token, same operationIds).
	let recovered = { runId, resumed: [], failed: [] };
	if (journal !== null && journalResumable.length > 0) {
		recovered = await recoverRun({
			rootDir,
			allowRoot,
			runId,
			owner,
			now: clock,
			stores: actionable
				.filter((entry) => journalResumable.includes(entry.name))
				.map((entry) => ({
					name: entry.name,
					adapter: validateQuiesceAdapter({ name: entry.name, adapter: provided.get(entry.name) }).snapshotAdapter,
				})),
		});
	}

	// Layer 2 — admission resumption in REVERSE lock order. Idempotent per the
	// adapter contract; a failure is recorded, never hidden.
	const resumedAdmission = [];
	const failedAdmission = [];
	for (const entry of [...admissionResumable].reverse()) {
		try {
			if (clock() > record.fence.expiresAt) throw new FreezeCoordinatorError("fence-expired");
			await provided.get(entry.name).resumeAdmission({
				runId, owner: record.owner, fence: record.fence.token, operationId: entry.operationIds.resume,
			});
			entry.admission = "resumed";
			resumedAdmission.push(entry.name);
		} catch {
			entry.drain = entry.drain === "confirmed" ? entry.drain : "failed";
			failedAdmission.push(entry.name);
		}
	}

	const status = recovered.failed.length === 0 && recovered.status !== "needs-review" && failedAdmission.length === 0 &&
		!record.stores.some(isAdmissionResumable) ? "resumed" : "needs-review";
	record.status = status;
	record.recovery = {
		resumedAdmission,
		failedAdmission,
		recovered: { resumed: recovered.resumed, failed: recovered.failed },
		journalPersistence: recovered.journalPersistence ?? "confirmed",
		ignored,
		at: clock(),
	};
	persistFreezeRecord(coordDir, record);
	return {
		status,
		runId,
		resumedAdmission,
		failedAdmission,
		recovered,
		ignored,
		freezeRecord: record,
	};
}

/**
 * Read-only rollback preflight (mirrors the drill's phase 1): verifies the
 * snapshot run's coordination record AND manifest success, re-derives every
 * store's snapshot evidence from the bytes on disk, and compares each store's
 * CURRENT watermark against its frozen watermark. ANY drift fails closed:
 *   * current < frozen — the store regressed/lost data since the freeze; this
 *     module refuses to layer a restore over an unexplained regression;
 *   * current > frozen — post-freeze data exists; rollback must not overwrite
 *     it. `newDataSinceFreeze` summarizes the drift (counts + watermarks only,
 *     never moved data); preserving that delta is a DEPLOYMENT duty this plan
 *     only reports, never performs;
 *   * incomparable shapes — watermark-incomparable, refused.
 *
 * NEVER mutates anything: a returned `allowed:false` (or any throw) leaves the
 * stores and the tree exactly as they were.
 *
 * @param {object} options
 * @param {string} options.rootDir
 * @param {string} options.allowRoot
 * @param {string} options.runId
 * @param {{name: string, adapter: object}[]} options.stores live store adapters
 *        providing watermark() (and, for executeRollback, restoreFrozen()).
 */
export function planRollback({ rootDir, allowRoot, runId, stores } = {}) {
	const prepared = validateStoreList(stores);
	const { runDir, record, manifest } = loadRunArtifacts({ rootDir, allowRoot, runId });

	const reasons = [];
	const pushReason = (code, store, extra = {}) => reasons.push(failureRecord(code, store, extra));

	if (record.status !== "success") {
		pushReason("freeze-not-successful", undefined, { status: record.status });
	}
	if (manifest.status !== "success") {
		pushReason("snapshot-not-successful", undefined, { status: manifest.status });
	}

	// Evidence re-derivation, per store, read-only. All failures are collected
	// (not just the first) so an operator sees the full refusal surface.
	const manifestStores = Array.isArray(manifest.stores) ? manifest.stores : [];
	const provided = new Map(prepared.map((store) => [store.name, store]));
	const plan = [];
	for (const store of manifestStores) {
		const live = provided.get(store.name);
		if (!live) {
			pushReason("no-rollback-target", store.name);
			continue;
		}
		validateQuiesceAdapter(live, { requireRestore: true });
		const snapshotDir = join(runDir, store.name);
		if (!entryExists(snapshotDir)) {
			pushReason("snapshot-dir-missing", store.name);
			continue;
		}
		try {
			const files = verifyStoreEvidence(snapshotDir, store);
			const frozenWatermark = record.freezeWatermark.perStore[store.name];
			if (frozenWatermark === undefined) {
				pushReason("freeze-record-inconsistent", store.name, { missing: "watermark" });
				continue;
			}
			plan.push({ store: store.name, kind: store.kind, snapshotDir, files, frozenWatermark });
		} catch (error) {
			pushReason(error instanceof FreezeCoordinatorError ? error.code : "snapshot-verify-failed", store.name);
		}
	}
	for (const live of prepared) {
		if (!manifestStores.some((store) => store.name === live.name)) {
			pushReason("not-in-snapshot", live.name);
		}
	}

	// Watermark drift detection against the recorded common freeze watermark.
	const newDataSinceFreeze = {};
	for (const entry of plan) {
		const current = provided.get(entry.store).adapter.watermark();
		const frozen = entry.frozenWatermark;
		const cmp = compareWatermarks(current, frozen);
		if (cmp === null) {
			pushReason("watermark-incomparable", entry.store, { frozen, current });
			continue;
		}
		if (cmp < 0) {
			pushReason("watermark-regressed", entry.store, { frozen, current });
			continue;
		}
		if (cmp > 0) {
			newDataSinceFreeze[entry.store] = { frozen, current, records: null, direction: "ahead" };
			pushReason("new-data-since-freeze", entry.store, { frozen, current });
		}
	}

	return {
		allowed: reasons.length === 0,
		reasons,
		plan: reasons.length === 0 ? plan : [],
		newDataSinceFreeze,
		manifest,
		freezeRecord: record,
		network_calls: 0,
	};
}

/**
 * Guarded rollback: switches future routing back to the frozen bytes — it does
 * not, and cannot, replay an old execution.
 *
 *   1. planRollback(); if the plan is not allowed this throws
 *      `rollback-refused` carrying every collected reason, BEFORE any store is
 *      touched (zero writes);
 *   2. re-read every watermark (a drift between plan and execute fails closed
 *      the same way);
 *   3. require every adapter to declare rollbackContract =
 *      "conditional-restore-v1" and implement restoreFrozenConditional().
 *      It must check the frozen watermark atomically at commit and exclude
 *      concurrent writes throughout restore, including awaits; { applied:false }
 *      means no mutation. No declaration/method means zero restores;
 *   4. post-restore watermark must still equal the frozen value. This is only
 *      a contract violation detector, NOT evidence of byte conservation.
 *   5. an adapter restore failure aborts the remaining stores and throws
 *      `rollback-store-failed` with the completed/failed/pending breakdown.
 *
 * @param {object} options
 * @param {string} options.rootDir
 * @param {string} options.allowRoot
 * @param {string} options.runId
 * @param {{name: string, adapter: object}[]} options.stores
 * @param {() => number} [options.now]
 */
export async function executeRollback({ rootDir, allowRoot, runId, stores, now } = {}) {
	makeClock(now);
	const plan = planRollback({ rootDir, allowRoot, runId, stores });
	if (!plan.allowed) {
		throw new FreezeCoordinatorError(
			"rollback-refused",
			`rollback refused: ${plan.reasons.map((reason) => reason.code).join(", ")}`,
			{ details: { reasons: plan.reasons, newDataSinceFreeze: plan.newDataSinceFreeze } },
		);
	}

	// Validate ALL contracts and ALL fresh watermarks before the first restore.
	const provided = new Map(stores.map((store) => [store.name, store.adapter]));
	const reasons = [];
	const before = new Map();
	for (const entry of plan.plan) {
		const adapter = provided.get(entry.store);
		if (adapter.rollbackContract !== "conditional-restore-v1" ||
			typeof adapter.restoreFrozenConditional !== "function") {
			reasons.push(failureRecord("rollback-contract-required", entry.store));
		}
		const current = adapter.watermark();
		before.set(entry.store, current);
		const cmp = compareWatermarks(current, entry.frozenWatermark);
		if (cmp !== 0) reasons.push(failureRecord(cmp === null ? "watermark-incomparable"
			: cmp < 0 ? "watermark-regressed" : "new-data-since-freeze", entry.store));
	}
	if (reasons.length > 0) {
		throw new FreezeCoordinatorError("rollback-refused", "rollback execution preflight refused", {
			details: { reasons, restored: [] },
		});
	}

	const restored = [];
	const storeFailures = [];
	const invariants = [];
	for (const entry of plan.plan) {
		const adapter = provided.get(entry.store);
		let outcome;
		try {
			outcome = await adapter.restoreFrozenConditional(entry.snapshotDir, {
				expectedWatermark: entry.frozenWatermark, protectAfter: entry.frozenWatermark,
			});
		} catch (error) {
			storeFailures.push({
				...failureRecord(adapterErrorCode(error, "restore-failed"), entry.store),
				index: restored.length,
			});
			break;
		}
		if (outcome?.applied === false) {
			throw new FreezeCoordinatorError("rollback-refused", "conditional restore refused", {
				details: { restored, refused: entry.store, pending: plan.plan.slice(restored.length + 1).map((item) => item.store) },
			});
		}
		if (outcome?.applied !== true) {
			storeFailures.push(failureRecord("restore-failed", entry.store));
			break;
		}
		const after = adapter.watermark();
		const cmp = compareWatermarks(after, before.get(entry.store));
		if (cmp !== 0) {
			invariants.push({
				store: entry.store,
				before: before.get(entry.store),
				after,
				violation: cmp === null ? "incomparable" : cmp < 0 ? "moved-backwards" : "moved-forward",
			});
		}
		restored.push({
			store: entry.store,
			kind: entry.kind,
			restoredFiles: entry.files.length,
			restoredBytes: entry.files.reduce((sum, file) => sum + file.bytes, 0),
			watermarkBefore: before.get(entry.store),
			watermarkAfter: after,
		});
		if (invariants.length > 0) break;
	}

	if (invariants.length > 0) {
		throw new FreezeCoordinatorError("rollback-invariant", "post-restore watermark invariant violated", {
			details: { restored, violations: invariants, storeFailures },
		});
	}
	if (storeFailures.length > 0) {
		const pending = plan.plan.slice(restored.length + 1).map((entry) => entry.store);
		throw new FreezeCoordinatorError("rollback-store-failed", `store ${storeFailures[0].store} restore failed`, {
			details: { restored, failed: storeFailures, pending },
		});
	}
	return { status: "success", runId, restored, network_calls: 0 };
}
