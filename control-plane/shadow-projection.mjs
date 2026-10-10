// Personal AI OS 0.3.0 Wave 5 — shadow projection layer for the migration story.
//
// The migration story the P5/P6 readiness map lays out — frozen-writes consistent
// snapshot -> versioned conversion -> SHADOW -> whitelist canary/drain -> naming
// batch 2 -> rollback freeze points (p5-p6-readiness-r1.md:24) — crosses its
// rehearsal step here. The converted copy and its ORIGINAL source are run through
// the SAME set of READ-ONLY projections and the two results are compared, leaving
// a re-verifiable report: a dress rehearsal before any canary ever runs.
//
// SCOPE / HARD BOUNDARIES (same spirit as control-plane/state-converter.mjs:13-21
// and control-plane/snapshot-orchestrator.mjs:10-18)
//   * PURE: this module performs NO filesystem IO. It consumes two already-parsed
//     JSON state objects a caller hands it; reading the files is the caller's (or
//     the test's) job. It makes no network calls, reads no environment, and never
//     touches ~/.local/state/personal-ai-os/, ~/.wechat-acp/ or any other
//     production/launchd-owned state. The clock is injected via `now`.
//   * OBSERVABLE SEMANTICS, NOT BYTES: a projection distils a state to a
//     canonical, ORDER-INDEPENDENT summary — counts, histograms, digest sets and
//     numeric aggregates — so that a legitimate conversion (which may add optional
//     fields, reorder map keys or supply empty collection scaffolds) still matches
//     its source. The comparison is the sha256 of that canonical summary.
//   * NEVER FABRICATE A MATCH: a projection is only reported as matching when the
//     two canonical digests are equal; a projection that throws is reported
//     `status:'failed'` with `match:false` (never silently dropped, never allowed
//     to abort the rest of the batch).
//
// THE CONTRACT
//   runShadowProjection({ legacyState, convertedState, kind, now?, projections? })
//     -> { version, kind, projections, allMatch, reportDigest, generatedAt }
//   * `kind` is 'control-plane' or 'goals'; both states are parsed top-level
//     objects of that kind.
//   * Each built-in projection outputs
//     `{ name, status, legacyDigest, convertedDigest, match, detail? }` where a
//     digest is `sha256:<hex>` over the key-sorted (canonical) serialisation of
//     the projection's value. When `match` is false, `detail` carries a bounded
//     canonical summary of EACH side (so the divergence is inspectable) — a
//     mismatch is NEVER written as a match.
//   * `reportDigest` is the sha256 of the whole report with `generatedAt`
//     removed: two runs on the same input (same states, same `now`) yield the same
//     `reportDigest`. `generatedAt` is the only non-deterministic field.
//   * Fail-closed: an unknown `kind`, a state that is not an object, or a
//     collection that is missing / wrongly shaped on the converted side throws a
//     ShadowProjectionError. A `projections` array of functions REPLACES the
//     built-ins (the seam the deployment batch can use for real projections).
//
// Dependencies: node:crypto only (no new dependency).

import { createHash } from "node:crypto";

/** Report schema version understood by this module. */
export const SHADOW_PROJECTION_VERSION = "shadow-projection-v1";

/** The two state kinds this layer understands. */
export const SUPPORTED_KINDS = Object.freeze(["control-plane", "goals"]);

/** Upper bound (characters) on each side's canonical summary in a `detail`. */
export const DETAIL_LIMIT = 2000;

/** A redacted shadow-projection failure. Never carries raw record content. */
export class ShadowProjectionError extends Error {
	constructor(code, message) {
		super(message ?? code);
		this.name = "ShadowProjectionError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// stable serialisation / digests (mirrors state-converter.mjs stable()/fingerprint)
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

/** A projection digest in the same `sha256:<hex>` shape the stores use. */
function digestOf(value) {
	return `sha256:${fingerprint(value)}`;
}

function bounded(text) {
	return text.length > DETAIL_LIMIT
		? `${text.slice(0, DETAIL_LIMIT)}…(truncated ${text.length - DETAIL_LIMIT} chars)`
		: text;
}

function reason(error) {
	const message = error && typeof error.message === "string" && error.message ? error.message : String(error);
	return message.slice(0, 300);
}

// ---------------------------------------------------------------------------
// collection descriptors (the read surface this layer projects over)
// ---------------------------------------------------------------------------
// This list mirrors the collections control-plane/state-converter.mjs reads
// (CONTROL_PLANE_COLLECTIONS / GOAL_COLLECTIONS). It is duplicated here on
// purpose: this module is a read-only *consumer* of the same state shape and must
// stay decoupled from the converter's private internals.
const COLLECTIONS = Object.freeze({
	"control-plane": Object.freeze([
		{ name: "tasks", shape: "map" },
		{ name: "executions", shape: "map" },
		{ name: "evidence", shape: "map" },
		{ name: "approvals", shape: "map" },
		{ name: "locks", shape: "map" },
		{ name: "idempotency", shape: "map" },
		{ name: "events", shape: "array" },
	]),
	goals: Object.freeze([
		{ name: "goals", shape: "map" },
		{ name: "requests", shape: "map" },
		{ name: "events", shape: "array" },
	]),
});

const CP = descriptorIndex("control-plane");
const GOALS = descriptorIndex("goals");

function descriptorIndex(kind) {
	const index = {};
	for (const descriptor of COLLECTIONS[kind]) index[descriptor.name] = descriptor;
	return Object.freeze(index);
}

function isCollectionShape(value, descriptor) {
	if (descriptor.shape === "map") {
		return value !== null && typeof value === "object" && !Array.isArray(value);
	}
	return Array.isArray(value);
}

/** The records of a collection as an array (map values, or the array itself). */
function recordsOf(state, descriptor) {
	const container = state[descriptor.name];
	return descriptor.shape === "map" ? Object.values(container) : [...container];
}

// ---------------------------------------------------------------------------
// projection helpers
// ---------------------------------------------------------------------------
function label(value) {
	return value === undefined ? "(absent)" : String(value);
}

/** A order-independent histogram of `values` (keys normalised to strings). */
function histogram(values) {
	const out = {};
	for (const value of values) {
		const key = label(value);
		out[key] = (out[key] ?? 0) + 1;
	}
	return out;
}

/** Epoch-milliseconds for an ISO string or number, or null if unparseable. */
function toEpoch(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

// ---------------------------------------------------------------------------
// built-in projections — control-plane
// ---------------------------------------------------------------------------
function projectCollectionCounts(state) {
	const counts = {};
	for (const descriptor of COLLECTIONS["control-plane"]) counts[descriptor.name] = recordsOf(state, descriptor).length;
	return counts;
}

function projectTaskStatusHistogram(state) {
	return histogram(recordsOf(state, CP.tasks).map((task) => (task ? task.status : undefined)));
}

function projectExecutionStatusHistogram(state) {
	return histogram(recordsOf(state, CP.executions).map((execution) => (execution ? execution.status : undefined)));
}

function projectApprovalDecisions(state) {
	return histogram(recordsOf(state, CP.approvals).map((approval) => (approval ? approval.decision : undefined)));
}

function projectApprovalDigests(state) {
	const digests = recordsOf(state, CP.approvals).map((approval) => label(approval ? approval.parametersDigest : undefined));
	return [...new Set(digests)].sort();
}

function projectIdempotencyKeys(state) {
	return Object.keys(state.idempotency).sort();
}

/** Which sessions currently hold a lock, split by whether it is live at `now`. */
function projectLockActivity(state, ctx) {
	const active = [];
	const expired = [];
	const keys = Object.keys(state.locks).sort();
	for (const key of keys) {
		const lock = state.locks[key];
		const expiresAt = lock ? toEpoch(lock.expiresAt) : null;
		if (expiresAt !== null && expiresAt > ctx.now) active.push(key);
		else expired.push(key);
	}
	return { total: keys.length, active, expired };
}

function projectEvidenceKinds(state) {
	return histogram(recordsOf(state, CP.evidence).map((evidence) => (evidence ? evidence.kind : undefined)));
}

function projectEvidenceOutcomes(state) {
	const verdicts = { passed: 0, failed: 0, absent: 0 };
	let exitCodeCount = 0;
	let exitCodeSum = 0;
	let nonZeroExitCount = 0;
	for (const evidence of recordsOf(state, CP.evidence)) {
		const exitCode = evidence ? evidence.exitCode : undefined;
		if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
			exitCodeCount += 1;
			exitCodeSum += exitCode;
			if (exitCode !== 0) nonZeroExitCount += 1;
		}
		const verdict = evidence ? evidence.verdict : undefined;
		if (verdict === "passed") verdicts.passed += 1;
		else if (verdict === "failed") verdicts.failed += 1;
		else verdicts.absent += 1;
	}
	return { exitCodeCount, exitCodeSum, nonZeroExitCount, verdicts };
}

// ---------------------------------------------------------------------------
// built-in projections — goals
// ---------------------------------------------------------------------------
function projectGoalCollectionCounts(state) {
	const counts = {};
	for (const descriptor of COLLECTIONS.goals) counts[descriptor.name] = recordsOf(state, descriptor).length;
	return counts;
}

function projectGoalStatusHistogram(state) {
	return histogram(recordsOf(state, GOALS.goals).map((goal) => (goal ? goal.status : undefined)));
}

function projectLimitsTotals(state) {
	let maxTokens = 0;
	let maxIterations = 0;
	for (const goal of recordsOf(state, GOALS.goals)) {
		const limits = goal && goal.spec ? goal.spec.limits : undefined;
		if (!limits || typeof limits !== "object") continue;
		if (Number.isFinite(limits.maxTokens)) maxTokens += limits.maxTokens;
		if (Number.isFinite(limits.maxIterations)) maxIterations += limits.maxIterations;
	}
	return { maxTokens, maxIterations };
}

function projectNextWakeBounds(state) {
	const values = [];
	for (const goal of recordsOf(state, GOALS.goals)) {
		const at = goal ? goal.nextWakeAt : undefined;
		if (typeof at === "number" && Number.isFinite(at)) values.push(at);
	}
	if (values.length === 0) return { count: 0, min: null, max: null };
	return { count: values.length, min: Math.min(...values), max: Math.max(...values) };
}

function projectRecoveryCounts(state) {
	return histogram(
		recordsOf(state, GOALS.goals).map((goal) => {
			const count = goal ? goal.recoveryCount : undefined;
			return Number.isInteger(count) && count >= 0 ? count : 0;
		}),
	);
}

// ---------------------------------------------------------------------------
// built-in projection sets
// ---------------------------------------------------------------------------
const BUILTIN = Object.freeze({
	"control-plane": Object.freeze([
		{ name: "collectionCounts", value: projectCollectionCounts },
		{ name: "taskStatusHistogram", value: projectTaskStatusHistogram },
		{ name: "executionStatusHistogram", value: projectExecutionStatusHistogram },
		{ name: "approvalDecisions", value: projectApprovalDecisions },
		{ name: "approvalDigests", value: projectApprovalDigests },
		{ name: "idempotencyKeys", value: projectIdempotencyKeys },
		{ name: "lockActivity", value: projectLockActivity },
		{ name: "evidenceKinds", value: projectEvidenceKinds },
		{ name: "evidenceOutcomes", value: projectEvidenceOutcomes },
	]),
	goals: Object.freeze([
		{ name: "collectionCounts", value: projectGoalCollectionCounts },
		{ name: "goalStatusHistogram", value: projectGoalStatusHistogram },
		{ name: "limitsTotals", value: projectLimitsTotals },
		{ name: "nextWakeBounds", value: projectNextWakeBounds },
		{ name: "recoveryCounts", value: projectRecoveryCounts },
	]),
});

// ---------------------------------------------------------------------------
// input normalisation / projection resolution
// ---------------------------------------------------------------------------
function makeClock(now) {
	if (now !== undefined && typeof now !== "function") {
		throw new ShadowProjectionError("invalid-config", "now must be a function when provided");
	}
	return now ?? Date.now;
}

/**
 * Validate a state and return a copy with every collection of the kind present
 * and correctly shaped.
 *   * A collection that is present but wrongly shaped is always refused.
 *   * A collection that is ABSENT is refused on the `converted` side (the
 *     converter's output must carry every scaffold) and on the goals `legacy`
 *     side (goal-store requires goals/requests/events). On the control-plane
 *     `legacy` side an absent collection is the legitimate 0.2.2 case the
 *     converter fills with an empty scaffold, so it is normalised to empty rather
 *     than refused.
 */
function normalizeState(state, kind, side) {
	if (!state || typeof state !== "object" || Array.isArray(state)) {
		throw new ShadowProjectionError("invalid-state", `${kind} ${side} state must be a JSON object`);
	}
	const normalized = { ...state };
	for (const descriptor of COLLECTIONS[kind]) {
		if (Object.hasOwn(state, descriptor.name)) {
			if (!isCollectionShape(state[descriptor.name], descriptor)) {
				throw new ShadowProjectionError("invalid-collection", `${kind} ${side} state.${descriptor.name} has the wrong shape`);
			}
			continue;
		}
		const tolerable = side === "legacy" && kind === "control-plane";
		if (!tolerable) {
			throw new ShadowProjectionError("missing-collection", `${kind} ${side} state.${descriptor.name} is missing`);
		}
		normalized[descriptor.name] = descriptor.shape === "map" ? {} : [];
	}
	return normalized;
}

function resolveProjections(kind, projections) {
	if (projections === undefined) return BUILTIN[kind];
	if (!Array.isArray(projections) || projections.length === 0) {
		throw new ShadowProjectionError("invalid-config", "projections must be a non-empty array of functions");
	}
	return projections.map((fn, index) => {
		if (typeof fn !== "function") {
			throw new ShadowProjectionError("invalid-config", `projections[${index}] must be a function`);
		}
		const name = typeof fn.displayName === "string" && fn.displayName ? fn.displayName : fn.name || `projection-${index}`;
		return { name, value: fn };
	});
}

/** Run one projection on both states and compare their canonical digests. */
function runOne(spec, legacy, converted, ctx) {
	const evaluated = [];
	for (const [side, state] of [["legacy", legacy], ["converted", converted]]) {
		try {
			evaluated.push({ side, value: spec.value(state, ctx) });
		} catch (error) {
			return {
				name: spec.name,
				status: "failed",
				legacyDigest: null,
				convertedDigest: null,
				match: false,
				detail: { side, error: reason(error) },
			};
		}
	}
	const [legacySide, convertedSide] = evaluated;
	const legacyDigest = digestOf(legacySide.value);
	const convertedDigest = digestOf(convertedSide.value);
	const match = legacyDigest === convertedDigest;
	const projection = { name: spec.name, status: "ok", legacyDigest, convertedDigest, match };
	if (!match) {
		projection.detail = {
			legacy: bounded(stable(legacySide.value)),
			converted: bounded(stable(convertedSide.value)),
		};
	}
	return projection;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
/**
 * Run the shadow projection of a converted copy against its original source.
 *
 * @param {object} options
 * @param {object} options.legacyState    parsed original state object.
 * @param {object} options.convertedState parsed converted state object.
 * @param {"control-plane"|"goals"} options.kind
 * @param {() => number} [options.now]    injected clock (defaults to Date.now).
 * @param {Array<(state: object, ctx: {now:number}) => any>} [options.projections]
 *        custom projection functions that REPLACE the built-in set.
 * @returns {{version:string, kind:string, projections:object[], allMatch:boolean, reportDigest:string, generatedAt:string}}
 */
export function runShadowProjection({ legacyState, convertedState, kind, now, projections } = {}) {
	if (typeof kind !== "string" || !SUPPORTED_KINDS.includes(kind)) {
		throw new ShadowProjectionError("unknown-kind", `kind must be one of: ${SUPPORTED_KINDS.join(", ")}`);
	}
	const clock = makeClock(now);
	const createdAt = clock();
	const legacy = normalizeState(legacyState, kind, "legacy");
	const converted = normalizeState(convertedState, kind, "converted");
	const specs = resolveProjections(kind, projections);
	const ctx = { now: createdAt };

	const results = specs.map((spec) => runOne(spec, legacy, converted, ctx));
	const allMatch = results.length > 0 && results.every((entry) => entry.status === "ok" && entry.match === true);

	const body = { version: SHADOW_PROJECTION_VERSION, kind, projections: results, allMatch };
	const reportDigest = digestOf(body);
	return { ...body, reportDigest, generatedAt: new Date(createdAt).toISOString() };
}
