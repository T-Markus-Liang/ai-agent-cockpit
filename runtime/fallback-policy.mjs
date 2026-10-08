// Personal AI OS 0.3.0 M02/I03b — provider fallback policy (fourth slice, pure).
//
// Design intent (docs/plans/0.3.0-upgrade.md): the bridge already carries a
// BOUNDED fallback rule for an unavailable primary agent, but the runtime layer
// (runtime/pi-adapter.mjs) has NO fallback concept at all — an unresolved model
// is fail-closed (`unresolved-model`, reject; never fall back to another model
// or engine). This slice extracts the bridge's fallback posture into a single
// pure, inspectable policy module so the runtime can adopt the SAME bounded rule
// later. Wiring it into the adapter is a LATER slice and is deliberately NOT
// done here.
//
// Shape references (read-only, NOT modified):
//   - vendor/wechat-acp/src/acp/session.ts:1017-1061 — candidate chain
//     [primary, ...fallbackAgents]; on auth/init failure the NEXT candidate is
//     tried; a fallback session is never persisted, and a persisted session id is
//     NEVER resumed inside a different harness.
//   - vendor/wechat-acp/src/acp/session.ts:1400-1405 — the timeout downgrade is
//     permitted ONLY when `cleaned && !hasProducedMessage && !hasUsedTools &&
//     automaticRetryCount < 1 && !fallbackUsers.has(userId)`: exactly ONE
//     automatic retry through the first fallback. No retry storm.
//   - vendor/wechat-acp/src/acp/session.ts:253-254 — per-user fallback memory.
//
// V39 interface contract enforced here:
//   * Bounded fallback. MAX_AUTOMATIC_ATTEMPTS is 1 (mirrors the bridge's
//     `automaticRetryCount < 1`). A second eligible request for the SAME scope
//     is refused with `fallback-exhausted` — reported as a plain stop, never
//     thrown, never a retry storm. Counting is per scopeKey; `reset(scopeKey)`
//     clears it (the caller calls it when a fresh user request cycle begins).
//   * Uncertain side effects are NOT replayed on another engine. A primary
//     failure that may already have produced a message or used tools
//     (`timeout-dirty`), or that is a mid-generation / unknown failure
//     (`uncertain-side-effects`), is a hard stop: the context can not be safely
//     re-driven elsewhere. `auth_error` is likewise a hard stop (`auth-failure`)
//     — no retry storm, and credentials are never guessed by swapping engines.
//   * Context provenance is preserved, never dropped. buildFallbackContext deep-
//     copies the caller's assembled context and ADDS a `fallback` provenance
//     marker ({ from, to, attempt, at }); every original key (persona, turns,
//     facts, ...) survives. The marker names refs only — never a secret.
//   * Secret hygiene / determinism. The decision log carries reference names
//     only (no credential value, no URL). Every output is a frozen copy; the
//     only ambient input is time, injectable via `now` so tests are synthetic
//     and deterministic.
//
// Pure ESM, zero dependencies, side-effect free: no I/O, no network, no timers,
// no environment access, no globals, no credentials. The caller's `chain` is
// deep-frozen in place so a later decision can never mutate it.
//
// Contract — createFallbackPolicy({ chain, now }):
//   chain: ordered candidate array `[{ ref, provider, modelId }]`.
//          ref is a non-empty reference name; provider / modelId are non-empty
//          strings. Must be a non-empty array with NO duplicate ref. Any
//          violation throws FallbackError("invalid-chain").
//   now:   () => number  epoch milliseconds; default Date.now.
//
//   classifyFailure(failure) -> frozen { eligible, reason }
//     failure = { kind, hasProducedMessage?, hasUsedTools? }. Rules:
//       startup_error                        -> eligible  "startup-failure"
//       timeout & !hasProducedMessage & !hasUsedTools -> eligible "timeout-clean"
//       timeout otherwise                    -> not       "timeout-dirty"
//       protocol_error                       -> eligible  "protocol-failure"
//       auth_error                           -> not       "auth-failure"
//       rate_limit                           -> eligible  "rate-limited"
//       mid_generation_failure / unknown / anything unrecognized
//                                            -> not       "uncertain-side-effects"
//     `hasProducedMessage`/`hasUsedTools` gate on the strict value `false`; an
//     absent flag therefore reads as "possibly produced" (dirty, do not retry).
//
//   nextAttempt(scopeKey, failure)
//       -> frozen { action: "fallback", candidate, attempt, reason }
//        | frozen { action: "stop", reason }
//     classifyFailure not eligible                 -> stop with that reason.
//     eligible, but MAX_AUTOMATIC_ATTEMPTS already spent for the scope
//       OR the chain has no next candidate          -> stop "fallback-exhausted".
//     eligible, candidate available                -> fallback to the next
//       untried candidate in chain order, attempt = 1.
//     Every call appends one decision record (see `decisions`).
//
//   buildFallbackContext({ originalContext, fromRef, toRef, attempt })
//       -> frozen deep-copied context + fallback marker
//     originalContext must be a plain, JSON-compatible object and must NOT
//     already carry a `fallback` key. Output = deep copy with every original key
//     preserved, plus `fallback: { from: fromRef, to: toRef, attempt, at }`.
//     fromRef / toRef must be refs present in the chain
//       -> otherwise FallbackError("invalid-chain").
//
//   reset(scopeKey) -> this
//     Clears the automatic-attempt counter for the scope (the audit log is
//     retained). A scope that had spent its one attempt may fall back again.
//     Different scopeKeys are counted independently.
//
//   decisions() -> frozen array of frozen decision records, in insertion order:
//     { scopeKey, fromRef, toRef?, attempt, outcome, reason, at }
//     `outcome` is "fallback" | "stop"; `toRef` is a reference name only.
//
//   toJSON() -> { version: 1, chain: [...], scopes: [{ scopeKey, attemptsUsed }],
//                 decisions: [...] }
//   fromJSON(data) -> this
//     Full-validation restore. Any structural violation (wrong version, invalid
//     chain, bad scope record, attemptsUsed above the bound, malformed decision)
//     throws FallbackError("invalid-state"). After restore, nextAttempt /
//     decisions behave exactly as before serialization.

/** The one automatic fallback attempt permitted per scope (V39 bound). */
export const MAX_AUTOMATIC_ATTEMPTS = 1;

/** Reference-name shape: exactly one `/`, neither side empty or whitespace. */
const REFERENCE_NAME = /^[^\s/]+\/[^\s/]+$/;

/** Fail-closed fallback denial. `code` identifies the reason. */
export class FallbackError extends Error {
	constructor(code, message) {
		super(message ?? `fallback policy rejected: ${code}`);
		this.name = "FallbackError";
		this.code = code;
	}
}

/** Throw a FallbackError with the given code. */
function fail(code, message) {
	throw new FallbackError(code, message);
}

/** True for a non-null, non-array, plain-ish object. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively freeze an object graph in place, returning it. */
function deepFreeze(value) {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

/**
 * Deep-copy JSON-compatible data (plain objects, arrays, primitives). A
 * non-plain object (Date, Map, function, ...) or a symbol/bigint is refused with
 * the given code — the context must be plain assembled data, and nothing is ever
 * silently dropped.
 */
function cloneData(value, path, code) {
	if (value === null || typeof value !== "object") {
		const kind = typeof value;
		if (kind === "function" || kind === "symbol" || kind === "bigint") {
			fail(code, `context contains a non-serializable ${kind} at ${path}`);
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((item, index) => cloneData(item, `${path}[${index}]`, code));
	if (!isPlainObject(value)) fail(code, `context contains a non-plain object at ${path}`);
	const copy = {};
	for (const key of Object.keys(value)) copy[key] = cloneData(value[key], `${path}.${key}`, code);
	return copy;
}

/**
 * Validate and normalize an ordered candidate chain. Throws with the supplied
 * code on any violation (callers pass "invalid-chain").
 */
function normalizeChain(chain, code) {
	if (!Array.isArray(chain) || chain.length === 0) {
		fail(code, "chain must be a non-empty array of candidates");
	}
	const seen = new Set();
	return chain.map((entry, index) => {
		if (!isPlainObject(entry)) {
			fail(code, `chain candidate ${index} must be an object`);
		}
		if (typeof entry.ref !== "string" || !REFERENCE_NAME.test(entry.ref)) {
			fail(code, `chain candidate ${index} has an invalid ref`);
		}
		if (typeof entry.provider !== "string" || entry.provider.length === 0) {
			fail(code, `chain candidate ${entry.ref} is missing a non-empty provider`);
		}
		if (typeof entry.modelId !== "string" || entry.modelId.length === 0) {
			fail(code, `chain candidate ${entry.ref} is missing a non-empty modelId`);
		}
		if (seen.has(entry.ref)) {
			fail(code, `chain has a duplicate ref: ${entry.ref}`);
		}
		seen.add(entry.ref);
		return Object.freeze({ ref: entry.ref, provider: entry.provider, modelId: entry.modelId });
	});
}

/** The exact, complete field set of a persisted decision record. */
const DECISION_FIELDS = ["scopeKey", "fromRef", "toRef", "attempt", "outcome", "reason", "at"];
const DECISION_REQUIRED_FIELDS = ["scopeKey", "fromRef", "attempt", "outcome", "reason", "at"];

/**
 * Whether a classified failure may be replayed on a fallback candidate. Returns
 * `{ eligible, reason }`. A failure we cannot parse, or an unrecognized kind, is
 * treated as uncertain and NOT eligible (fail closed — never retry blindly).
 */
function classify(kind, hasProducedMessage, hasUsedTools) {
	switch (kind) {
		case "startup_error":
			return { eligible: true, reason: "startup-failure" };
		case "timeout":
			return hasProducedMessage === false && hasUsedTools === false
				? { eligible: true, reason: "timeout-clean" }
				: { eligible: false, reason: "timeout-dirty" };
		case "protocol_error":
			return { eligible: true, reason: "protocol-failure" };
		case "auth_error":
			return { eligible: false, reason: "auth-failure" };
		case "rate_limit":
			return { eligible: true, reason: "rate-limited" };
		case "mid_generation_failure":
		case "unknown":
		default:
			return { eligible: false, reason: "uncertain-side-effects" };
	}
}

/**
 * Create a pure, bounded provider-fallback policy.
 * @param {object} options
 * @param {Array<{ref: string, provider: string, modelId: string}>} options.chain
 * @param {() => number} [options.now] injectable clock (epoch ms); default Date.now.
 * @returns {{
 *   chain: ReadonlyArray<{ref: string, provider: string, modelId: string}>,
 *   classifyFailure: (failure: object) => {eligible: boolean, reason: string},
 *   nextAttempt: (scopeKey: string, failure: object) => object,
 *   buildFallbackContext: (spec: {originalContext: object, fromRef: string, toRef: string, attempt: number}) => object,
 *   reset: (scopeKey: string) => object,
 *   decisions: () => ReadonlyArray<object>,
 *   toJSON: () => {version: number, chain: object[], scopes: object[], decisions: object[]},
 *   fromJSON: (data: unknown) => object,
 * }}
 */
export function createFallbackPolicy({ chain, now } = {}) {
	const clock = now ?? Date.now;
	if (typeof clock !== "function") fail("invalid-chain", "now must be a function");

	// Validate + normalize, then deep-freeze the caller's chain in place so no
	// later decision can mutate it (mirrors provider-resolver's frozen registry).
	const refs = normalizeChain(chain, "invalid-chain");
	const candidateChain = Object.freeze(refs);
	deepFreeze(chain);

	// Per-scope automatic-attempt counter (bounded by MAX_AUTOMATIC_ATTEMPTS) and
	// the append-only audit log. Both are mutable internally; callers only ever
	// receive frozen copies.
	const attemptsUsed = new Map();
	const log = [];

	/** Frozen decision record. */
	function recordDecision(entry) {
		log.push(Object.freeze(entry));
	}

	function classifyFailure(failure) {
		if (!isPlainObject(failure)) {
			return Object.freeze({ eligible: false, reason: "uncertain-side-effects" });
		}
		return Object.freeze(classify(failure.kind, failure.hasProducedMessage, failure.hasUsedTools));
	}

	function nextAttempt(scopeKey, failure) {
		if (typeof scopeKey !== "string" || scopeKey.length === 0) {
			fail("invalid-state", "scopeKey must be a non-empty string");
		}
		const at = clock();
		const used = attemptsUsed.get(scopeKey) ?? 0;
		// `used` is always a valid index: it can only reach 1 after a fallback was
		// made, which requires a chain of at least two candidates.
		const fromRef = candidateChain[Math.min(used, candidateChain.length - 1)].ref;
		const classification = classifyFailure(failure);

		if (!classification.eligible) {
			recordDecision({ scopeKey, fromRef, attempt: used, outcome: "stop", reason: classification.reason, at });
			return Object.freeze({ action: "stop", reason: classification.reason });
		}

		const nextIndex = used + 1;
		if (used >= MAX_AUTOMATIC_ATTEMPTS || nextIndex >= candidateChain.length) {
			recordDecision({ scopeKey, fromRef, attempt: used, outcome: "stop", reason: "fallback-exhausted", at });
			return Object.freeze({ action: "stop", reason: "fallback-exhausted" });
		}

		const candidate = candidateChain[nextIndex];
		const attempt = used + 1;
		attemptsUsed.set(scopeKey, attempt);
		recordDecision({ scopeKey, fromRef, toRef: candidate.ref, attempt, outcome: "fallback", reason: classification.reason, at });
		return Object.freeze({ action: "fallback", candidate, attempt, reason: classification.reason });
	}

	function requireRef(ref, field) {
		if (typeof ref !== "string" || !candidateChain.some((candidate) => candidate.ref === ref)) {
			fail("invalid-chain", `${field} is not a ref in the chain: ${String(ref)}`);
		}
	}

	function buildFallbackContext(spec) {
		const { originalContext, fromRef, toRef, attempt } = spec ?? {};
		if (!isPlainObject(originalContext)) {
			fail("invalid-state", "originalContext must be a plain object");
		}
		requireRef(fromRef, "fromRef");
		requireRef(toRef, "toRef");
		if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
			fail("invalid-state", "attempt must be a positive integer");
		}
		// Fail closed rather than silently overwrite a pre-existing marker: the
		// invariant is that NO part of the original context is ever dropped.
		if (Object.hasOwn(originalContext, "fallback")) {
			fail("invalid-state", "originalContext already carries a fallback marker");
		}
		const copy = cloneData(originalContext, "originalContext", "invalid-state");
		copy.fallback = Object.freeze({ from: fromRef, to: toRef, attempt, at: clock() });
		return Object.freeze(copy);
	}

	function reset(scopeKey) {
		if (typeof scopeKey !== "string" || scopeKey.length === 0) {
			fail("invalid-state", "scopeKey must be a non-empty string");
		}
		attemptsUsed.delete(scopeKey);
		return policy;
	}

	function decisions() {
		return Object.freeze(log.slice());
	}

	function toJSON() {
		const scopes = [];
		for (const [scopeKey, used] of attemptsUsed) {
			if (used > 0) scopes.push({ scopeKey, attemptsUsed: used });
		}
		return { version: 1, chain: candidateChain.map((candidate) => ({ ...candidate })), scopes, decisions: log.map((entry) => ({ ...entry })) };
	}

	/** Validate + normalize one persisted decision record (fail closed). */
	function normalizeDecision(raw) {
		if (!isPlainObject(raw)) fail("invalid-state", "decision record must be an object");
		const keys = Object.keys(raw);
		if (keys.some((key) => !DECISION_FIELDS.includes(key)) || DECISION_REQUIRED_FIELDS.some((key) => !keys.includes(key))) {
			fail("invalid-state", "decision record has an unexpected field set");
		}
		if (typeof raw.scopeKey !== "string" || raw.scopeKey.length === 0) {
			fail("invalid-state", "decision scopeKey must be a non-empty string");
		}
		if (!candidateChain.some((candidate) => candidate.ref === raw.fromRef)) {
			fail("invalid-state", `decision fromRef is not in the chain: ${String(raw.fromRef)}`);
		}
		if (raw.toRef !== undefined && !candidateChain.some((candidate) => candidate.ref === raw.toRef)) {
			fail("invalid-state", `decision toRef is not in the chain: ${String(raw.toRef)}`);
		}
		if (raw.outcome !== "fallback" && raw.outcome !== "stop") {
			fail("invalid-state", "decision outcome must be 'fallback' or 'stop'");
		}
		if (raw.outcome === "fallback" && raw.toRef === undefined) {
			fail("invalid-state", "a fallback decision must carry a toRef");
		}
		if (typeof raw.reason !== "string" || raw.reason.length === 0) {
			fail("invalid-state", "decision reason must be a non-empty string");
		}
		if (!Number.isInteger(raw.attempt) || raw.attempt < 0) {
			fail("invalid-state", "decision attempt must be a non-negative integer");
		}
		if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) {
			fail("invalid-state", "decision at must be a finite number");
		}
		return raw.toRef === undefined
			? { scopeKey: raw.scopeKey, fromRef: raw.fromRef, attempt: raw.attempt, outcome: raw.outcome, reason: raw.reason, at: raw.at }
			: { scopeKey: raw.scopeKey, fromRef: raw.fromRef, toRef: raw.toRef, attempt: raw.attempt, outcome: raw.outcome, reason: raw.reason, at: raw.at };
	}

	function fromJSON(data) {
		if (!isPlainObject(data) || data.version !== 1 || !Array.isArray(data.scopes) || !Array.isArray(data.decisions)) {
			fail("invalid-state", "fallback snapshot must be { version: 1, chain, scopes: [...], decisions: [...] }");
		}
		// The snapshot chain must equal the live chain — a snapshot can never swap
		// the candidate set out from under the policy (fail closed).
		const restoredChain = normalizeChain(data.chain, "invalid-state");
		if (JSON.stringify(restoredChain) !== JSON.stringify(candidateChain)) {
			fail("invalid-state", "snapshot chain does not match the configured chain");
		}
		const restoredAttempts = new Map();
		for (const raw of data.scopes) {
			if (!isPlainObject(raw) || typeof raw.scopeKey !== "string" || raw.scopeKey.length === 0) {
				fail("invalid-state", "scope record must carry a non-empty scopeKey");
			}
			if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "attemptsUsed")) {
				fail("invalid-state", "scope record must be { scopeKey, attemptsUsed }");
			}
			if (!Number.isInteger(raw.attemptsUsed) || raw.attemptsUsed < 0 || raw.attemptsUsed > MAX_AUTOMATIC_ATTEMPTS) {
				fail("invalid-state", `scope ${raw.scopeKey}: attemptsUsed is out of range`);
			}
			// A scope can only have spent an attempt if the chain had a next
			// candidate to spend it on (no fabricated history).
			if (raw.attemptsUsed > candidateChain.length - 1) {
				fail("invalid-state", `scope ${raw.scopeKey}: attemptsUsed exceeds the chain length`);
			}
			if (restoredAttempts.has(raw.scopeKey)) {
				fail("invalid-state", `duplicate scope record: ${raw.scopeKey}`);
			}
			if (raw.attemptsUsed > 0) restoredAttempts.set(raw.scopeKey, raw.attemptsUsed);
		}
		const restoredLog = data.decisions.map((raw) => Object.freeze(normalizeDecision(raw)));
		attemptsUsed.clear();
		for (const [scopeKey, used] of restoredAttempts) attemptsUsed.set(scopeKey, used);
		log.length = 0;
		for (const entry of restoredLog) log.push(entry);
		return policy;
	}

	const policy = {
		chain: candidateChain,
		classifyFailure,
		nextAttempt,
		buildFallbackContext,
		reset,
		decisions,
		toJSON,
		fromJSON,
	};
	return policy;
}
