// Personal AI OS 0.3.0 M02/I03b — runtime request-scoped budget/deadline policy
// (third slice, pure).
//
// Design intent (docs/plans/0.3.0-upgrade.md): the runtime layer currently has
// NO budget or deadline concept at all — contracts.mjs `REQUEST_FIELDS` carries
// no budget/deadline field, and the goal-side budget in control-plane/
// goal-store.mjs is entirely separate from the runtime. This slice introduces
// the runtime-side budget primitive. Wiring it into pi-adapter is a LATER slice
// and is deliberately NOT done here.
//
// Shape references (read-only, NOT modified):
//   - control-plane/goal-store.mjs:13-14  — maxIterations/maxTokens/maxDurationMs
//     defaults and bounds.
//   - control-plane/goal-store.mjs:56-64  — grantFailureReason: expiry, token
//     budget and iteration-cap semantics ("授权期限已到", token 预算已耗尽).
//   - control-plane/goal-store.mjs:205     — checkpoint may not change budget.
//   - control-plane/goal-store.mjs:210-216 — reserve / reconcileUsage / settle.
//
// V31 interface contract enforced here:
//   * Once a budget is exhausted or expired it can NOT be used for further side
//     effects. Every mutating entry point (`charge`) and every precondition
//     check (`assertActive`) fails closed with `budget-exhausted` /
//     `budget-expired`; a settled scope fails with `budget-settled`.
//   * A budget can NOT be extended, renewed, topped up or raised ("不能续期限").
//     THERE IS DELIBERATELY NO extend / renew / increase / raise / refill /
//     reset / unsettle / release API anywhere on this module. Re-`grant` for a
//     scope that already has an UNSETTLED budget is itself refused with
//     `invalid-grant` (no overwrite, no renewal). Expiry is a hard wall derived
//     from `issuedAt + maxDurationMs`; nothing widens it.
//   * Settled budgets are retained for audit ("保留记录供审计"). `settle` never
//     deletes the record, and re-`grant` for a scope whose budget was already
//     settled opens a NEW authorization cycle while KEEPING the old settled
//     record (with its charged counters) fully intact. A lookup always prefers
//     the live (unsettled) record; when only settled records remain, the most
//     recent one is reported, so the scope reads as `budget-settled`. A scope
//     never holds two unsettled records at once — a second live one is
//     `invalid-grant` (`grant`) or `invalid-state` (`fromJSON`).
//   * A success can NOT be faked ("不能假装成功"). `settle` only flips a flag on
//     an existing live record and is idempotent-safe — a second settle is
//     refused with `budget-settled`. The module never invents success, never
//     manufactures a completion, never reports a settled scope as active, and
//     carries no completion/marker concept to fabricate.
//   * The injected clock is validated on EVERY deadline-sensitive call
//     (`grant`, `charge`, `assertActive`, `remaining`). A clock that throws, or
//     returns a non-number / non-finite / negative value, is `clock-invalid`; a
//     grant whose derived `expiresAt` overflows the safe-integer range is
//     `invalid-grant`. A reading that cannot be trusted is refused BEFORE any
//     state moves or any effect is authorised — an unverifiable remaining
//     duration is NEVER treated as "still active" (`NaN >= expiresAt` is `false`).
//
// Pure ESM, zero dependencies, side-effect free: no I/O, no network, no timers,
// no environment access, no globals. Time is the only ambient input and it is
// injectable via `now` so tests are fully synthetic and deterministic.
//
// Contract — createBudgetPolicy({ now }):
//   now: () => number            epoch milliseconds; default Date.now.
//
//   grant({ scopeKey, maxTokens, maxDurationMs, maxCalls? }) -> frozen grant
//     scopeKey       non-empty string.
//     maxTokens      positive integer (finite).
//     maxDurationMs  positive integer (finite); expiresAt = now() + maxDurationMs.
//     maxCalls       optional positive integer; when omitted the cap is `null`
//                    (unbounded) and is stored as `null` so the record stays
//                    JSON-clean.
//     Returns a FROZEN copy:
//       { scopeKey, maxTokens, maxCalls, issuedAt, expiresAt,
//         chargedTokens: 0, chargedCalls: 0, settled: false }
//     A live (unsettled) budget for the same scopeKey already existing is
//     `invalid-grant` — the existing grant is never overwritten or renewed. If
//     the previous budget for that scope was settled, this opens a new cycle and
//     the settled record is RETAINED (see toJSON), never replaced. An unusable
//     clock is `clock-invalid`, and a derived `expiresAt` that overflows the
//     safe-integer range is `invalid-grant` — neither stores a record.
//
//   charge(scopeKey, { tokens = 0, calls = 0 })
//       -> { remainingTokens, remainingCalls, remainingMs }
//     unknown scope        -> BudgetError("unknown-budget")
//     settled scope        -> BudgetError("budget-settled")
//     unusable clock       -> BudgetError("clock-invalid")
//     now() >= expiresAt   -> BudgetError("budget-expired")
//     negative / non-finite / non-number tokens or calls -> BudgetError("invalid-grant")
//     deduction would push chargedTokens > maxTokens or (when capped)
//       chargedCalls > maxCalls -> BudgetError("budget-exhausted"), ATOMIC:
//       the check and the deduction are all-or-nothing, so a refused charge
//       leaves every counter unchanged (zero movement).
//     Otherwise the deduction is applied and the remaining amounts are returned.
//
//   assertActive(scopeKey) -> { remainingTokens, remainingCalls, remainingMs }
//     unknown  -> "unknown-budget"; settled -> "budget-settled";
//     unusable clock -> "clock-invalid"; expired -> "budget-expired"; budget
//     already fully used up (chargedTokens >= maxTokens, or a cap reached) ->
//     "budget-exhausted".
//     Returns the remaining amounts while the budget is genuinely active.
//
//   remaining(scopeKey) -> { remainingTokens, remainingCalls, remainingMs }
//     Pure query, never mutates state. An unknown scope is refused
//     ("unknown-budget") and an unusable clock is refused ("clock-invalid");
//     otherwise a settled or expired scope is still readable so a caller can
//     audit the frozen numbers.
//
//   settle(scopeKey) -> frozen settled record
//     Marks the live record settled and KEEPS it for audit. Repeating it is
//     "budget-settled". No other state change; no completion is manufactured.
//
//   toJSON()      -> { version: 1, grants: [ ...records ] }
//     Every retained record across every scope, grouped by scope in insertion
//     order; a re-granted scope therefore serializes its settled record(s) AND
//     its live record.
//   fromJSON(data) -> this
//     Full-validation restore. Any structural violation (wrong version, wrong
//     field set, wrong types, charged > max, non-object, out-of-range time
//     window — non-finite, negative or overflowing the safe-integer range — or
//     more than one UNSETTLED record for a scope) is "invalid-state". One scope
//     may carry several records (older settled cycles plus one live cycle).
//     After restore, charge / expiry / settle behave exactly as before
//     serialization.
//
// `remainingCalls` is `Infinity` when the grant carried no `maxCalls` cap.

/** Fail-closed budget denial. `code` identifies the reason. */
export class BudgetError extends Error {
	constructor(code, message) {
		super(message ?? `budget policy rejected: ${code}`);
		this.name = "BudgetError";
		this.code = code;
	}
}

/** Throw a BudgetError with the given code. */
function fail(code, message) {
	throw new BudgetError(code, message);
}

/** True for a non-null, non-array, plain-ish object. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A positive integer (finite by definition of Number.isInteger). */
function isPositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** A finite, non-negative number (integrality is not required here). */
function isFiniteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The exact, complete field set of a persisted grant record. */
const RECORD_FIELDS = [
	"scopeKey",
	"maxTokens",
	"maxCalls",
	"issuedAt",
	"expiresAt",
	"chargedTokens",
	"chargedCalls",
	"settled",
];

/**
 * Validate and normalize one persisted grant record from a snapshot. Throws
 * BudgetError("invalid-state") on any shape violation (fail closed).
 */
function normalizeRecord(raw) {
	if (!isPlainObject(raw)) fail("invalid-state", "grant record must be an object");
	const keys = Object.keys(raw);
	if (keys.length !== RECORD_FIELDS.length || keys.some((key) => !RECORD_FIELDS.includes(key))) {
		fail("invalid-state", "grant record has an unexpected field set");
	}
	if (typeof raw.scopeKey !== "string" || raw.scopeKey.trim() === "") {
		fail("invalid-state", "grant record scopeKey must be a non-empty string");
	}
	if (!isPositiveInteger(raw.maxTokens)) {
		fail("invalid-state", `grant record for ${raw.scopeKey}: maxTokens must be a positive integer`);
	}
	if (raw.maxCalls !== null && !isPositiveInteger(raw.maxCalls)) {
		fail("invalid-state", `grant record for ${raw.scopeKey}: maxCalls must be null or a positive integer`);
	}
	if (
		typeof raw.issuedAt !== "number" || !Number.isFinite(raw.issuedAt) || raw.issuedAt < 0 ||
		typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt) ||
		raw.expiresAt > Number.MAX_SAFE_INTEGER || raw.expiresAt <= raw.issuedAt
	) {
		fail("invalid-state", `grant record for ${raw.scopeKey}: invalid time window`);
	}
	if (!isFiniteNonNegative(raw.chargedTokens) || raw.chargedTokens > raw.maxTokens) {
		fail("invalid-state", `grant record for ${raw.scopeKey}: chargedTokens out of range`);
	}
	if (!isFiniteNonNegative(raw.chargedCalls) || (raw.maxCalls !== null && raw.chargedCalls > raw.maxCalls)) {
		fail("invalid-state", `grant record for ${raw.scopeKey}: chargedCalls out of range`);
	}
	if (typeof raw.settled !== "boolean") {
		fail("invalid-state", `grant record for ${raw.scopeKey}: settled must be a boolean`);
	}
	return {
		scopeKey: raw.scopeKey,
		maxTokens: raw.maxTokens,
		maxCalls: raw.maxCalls,
		issuedAt: raw.issuedAt,
		expiresAt: raw.expiresAt,
		chargedTokens: raw.chargedTokens,
		chargedCalls: raw.chargedCalls,
		settled: raw.settled,
	};
}

/**
 * Create a runtime request-scoped budget/deadline policy.
 * @param {object} [options]
 * @param {() => number} [options.now] injectable clock (epoch ms); default Date.now.
 * @returns {{
 *   grant: (spec: {scopeKey: string, maxTokens: number, maxDurationMs: number, maxCalls?: number}) => object,
 *   charge: (scopeKey: string, usage?: {tokens?: number, calls?: number}) => {remainingTokens: number, remainingCalls: number, remainingMs: number},
 *   assertActive: (scopeKey: string) => {remainingTokens: number, remainingCalls: number, remainingMs: number},
 *   remaining: (scopeKey: string) => {remainingTokens: number, remainingCalls: number, remainingMs: number},
 *   settle: (scopeKey: string) => object,
 *   toJSON: () => {version: number, grants: object[]},
 *   fromJSON: (data: unknown) => object,
 * }}
 */
export function createBudgetPolicy({ now } = {}) {
	const clock = now ?? Date.now;
	if (typeof clock !== "function") fail("invalid-grant", "now must be a function");

	// Internal records are MUTABLE so counters can move; callers only ever get
	// frozen copies (see `snapshot`), so external code can never mutate a budget.
	// The map holds a LIST per scopeKey: settled cycles are retained for audit
	// and a re-grant appends a fresh live cycle rather than replacing them.
	let grants = new Map();

	/** Frozen copy of a record, safe to hand to a caller. */
	function snapshot(record) {
		return Object.freeze({ ...record });
	}

	/**
	 * The records retained for a scope, or "unknown-budget". The live
	 * (unsettled) record is preferred; otherwise the most recent settled record
	 * is returned so the scope reads as settled. At most one record per scope is
	 * ever unsettled (enforced by `grant` and `fromJSON`).
	 */
	function requireRecord(scopeKey) {
		if (typeof scopeKey !== "string" || !grants.has(scopeKey)) {
			const shown = typeof scopeKey === "string" ? scopeKey : typeof scopeKey;
			fail("unknown-budget", `unknown budget scope: ${shown}`);
		}
		const list = grants.get(scopeKey);
		for (let i = list.length - 1; i >= 0; i--) if (!list[i].settled) return list[i];
		return list[list.length - 1];
	}

	/**
	 * Read the injected clock for one operation. A deadline can only be evaluated
	 * against a real instant, so an unusable reading — the clock threw, or returned
	 * a non-number / non-finite / negative value — is refused BEFORE any state
	 * moves or any effect is authorised. This is the fail-closed barrier that stops
	 * a faulty clock from being read as "still within the deadline": `NaN >=
	 * expiresAt` is `false` and `-Infinity` compares as unexpired, so an unchecked
	 * reading would silently keep an unverifiable budget active.
	 */
	function readClock() {
		let value;
		try {
			value = clock();
		} catch {
			fail("clock-invalid", "clock threw while reading the current time");
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			fail("clock-invalid", "clock must return a finite, non-negative number");
		}
		return value;
	}

	/** Current remaining amounts for a live record at the given instant. */
	function remainders(record, now) {
		return {
			remainingTokens: record.maxTokens - record.chargedTokens,
			remainingCalls: record.maxCalls === null ? Infinity : record.maxCalls - record.chargedCalls,
			remainingMs: record.expiresAt - now,
		};
	}

	function grant(spec) {
		const { scopeKey, maxTokens, maxDurationMs, maxCalls } = spec ?? {};
		if (typeof scopeKey !== "string" || scopeKey.trim() === "") {
			fail("invalid-grant", "scopeKey must be a non-empty string");
		}
		if (!isPositiveInteger(maxTokens)) {
			fail("invalid-grant", `scope ${scopeKey}: maxTokens must be a positive integer`);
		}
		if (!isPositiveInteger(maxDurationMs)) {
			fail("invalid-grant", `scope ${scopeKey}: maxDurationMs must be a positive integer`);
		}
		const callsCap = maxCalls == null ? null : maxCalls;
		if (callsCap !== null && !isPositiveInteger(callsCap)) {
			fail("invalid-grant", `scope ${scopeKey}: maxCalls must be a positive integer when provided`);
		}
		const existing = grants.get(scopeKey);
		if (existing?.some((record) => !record.settled)) {
			fail("invalid-grant", `scope ${scopeKey} already has an active budget (no overwrite, no renewal)`);
		}
		const issuedAt = readClock();
		const expiresAt = issuedAt + maxDurationMs;
		// The derived absolute expiry must itself be a usable instant: finite,
		// inside the safely-representable integer range and strictly after issue.
		// An overflowing window (e.g. a huge maxDurationMs) is refused rather than
		// stored, so no record can ever carry an expiry that comparisons cannot
		// trust — and the refused grant leaves no record behind.
		if (!Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER || expiresAt <= issuedAt) {
			fail("invalid-grant", `scope ${scopeKey}: derived expiry is out of range`);
		}
		const record = {
			scopeKey,
			maxTokens,
			maxCalls: callsCap,
			issuedAt,
			expiresAt,
			chargedTokens: 0,
			chargedCalls: 0,
			settled: false,
		};
		// Append a new cycle; any settled record(s) are retained for audit.
		if (existing) existing.push(record);
		else grants.set(scopeKey, [record]);
		return snapshot(record);
	}

	function charge(scopeKey, usage) {
		const record = requireRecord(scopeKey);
		if (record.settled) fail("budget-settled", `budget for scope ${scopeKey} is settled`);
		const now = readClock();
		if (now >= record.expiresAt) fail("budget-expired", `budget for scope ${scopeKey} expired`);
		const tokens = usage?.tokens ?? 0;
		const calls = usage?.calls ?? 0;
		if (!isFiniteNonNegative(tokens) || !isFiniteNonNegative(calls)) {
			fail("invalid-grant", `scope ${scopeKey}: tokens and calls must be finite non-negative numbers`);
		}
		// Atomic check-and-deduct: nothing is written unless BOTH budgets admit
		// the full charge, so a refusal leaves every counter untouched.
		const nextTokens = record.chargedTokens + tokens;
		const nextCalls = record.chargedCalls + calls;
		if (nextTokens > record.maxTokens || (record.maxCalls !== null && nextCalls > record.maxCalls)) {
			const capCalls = record.maxCalls === null ? "\u221e" : record.maxCalls;
			fail(
				"budget-exhausted",
				`budget for scope ${scopeKey} exhausted: charged ${nextTokens}/${record.maxTokens} tokens, ${nextCalls}/${capCalls} calls`,
			);
		}
		record.chargedTokens = nextTokens;
		record.chargedCalls = nextCalls;
		return remainders(record, now);
	}

	function assertActive(scopeKey) {
		const record = requireRecord(scopeKey);
		if (record.settled) fail("budget-settled", `budget for scope ${scopeKey} is settled`);
		const now = readClock();
		if (now >= record.expiresAt) fail("budget-expired", `budget for scope ${scopeKey} expired`);
		if (record.chargedTokens >= record.maxTokens || (record.maxCalls !== null && record.chargedCalls >= record.maxCalls)) {
			fail("budget-exhausted", `budget for scope ${scopeKey} is fully used up`);
		}
		return remainders(record, now);
	}

	function remaining(scopeKey) {
		// Pure query, but the remaining duration is only meaningful against a real
		// instant: an unusable clock is refused rather than reported as a
		// meaningless `remainingMs: NaN`. The frozen counters stay readable whenever
		// the clock is sound, whether the scope is live, settled or expired.
		return remainders(requireRecord(scopeKey), readClock());
	}

	function settle(scopeKey) {
		const record = requireRecord(scopeKey);
		if (record.settled) fail("budget-settled", `budget for scope ${scopeKey} is already settled`);
		record.settled = true;
		return snapshot(record);
	}

	function toJSON() {
		const all = [];
		for (const list of grants.values()) for (const record of list) all.push({ ...record });
		return { version: 1, grants: all };
	}

	function fromJSON(data) {
		if (!isPlainObject(data) || data.version !== 1 || !Array.isArray(data.grants)) {
			fail("invalid-state", "budget snapshot must be { version: 1, grants: [...] }");
		}
		const restored = new Map();
		const live = new Set();
		for (const raw of data.grants) {
			const record = normalizeRecord(raw);
			// A scope may keep several settled cycles plus at most one live one.
			if (!record.settled) {
				if (live.has(record.scopeKey)) {
					fail("invalid-state", `multiple unsettled records for scope: ${record.scopeKey}`);
				}
				live.add(record.scopeKey);
			}
			const list = restored.get(record.scopeKey);
			if (list) list.push(record);
			else restored.set(record.scopeKey, [record]);
		}
		grants = restored;
		return policy;
	}

	const policy = { grant, charge, assertActive, remaining, settle, toJSON, fromJSON };
	return policy;
}
