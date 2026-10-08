// Personal AI OS 0.3.0 M02/I03d — durable execution ownership (new synthetic
// slice, pure).
//
// Design intent: docs/audits/durable-ownership-proposal-r1.md — the auditor
// CONDITIONALLY ACCEPTED "an explicit background conversation owns its own
// durable execution" as the direction that closes V11/V12, PROVIDED the concrete
// gaps below are closed. This slice implements ONLY the new, synthetic,
// no-legacy-history ownership core; it is deliberately NOT wired to production
// and does NOT touch any old `stalled` row (audit point 5: legacy migration is
// NOT approved for automatic execution).
//
// The audit's six conditions, and how this module answers them:
//
//   1. ONE in-flight Submission per execution. "必须限制/拒第二输入". A second
//      `beginSubmission` for an execution that already holds an in-flight
//      submission fails closed with "submission-in-flight": a new input for the
//      SAME execution can NOT surreptitiously replay the old task. To run more
//      work for the same identity the host opens a NEW cycle (a different
//      ownership key) — never a second concurrent submission.
//
//   2. TYPED composite conversation key. "conversationKey 用类型化
//      owner/account/profile/execution/cycle 复合键；不只拼 bg:<executionId>".
//      `ownershipKey({ channel, accountId, profileId, executionId, cycle })`
//      encodes a single typed string
//        own1.<channel>.<b64url(accountId)>.<b64url(profileId)>.<b64url(executionId)>.<cycle>
//      Each free-text id is base64url-encoded so a separator can never be
//      injected, and the host's confirmed Task/Execution/Grant identity is bound
//      separately via `registerExecution` (goalId / taskId / grantRef). A fg and
//      a bg execution that share every id still get DIFFERENT keys (the leading
//      channel field), so foreground/background name collisions can not alias.
//      `parseOwnershipKey` is a strict, canonical round-trip inverse that rejects
//      any foreign or malformed key.
//
//   3. Concurrent slots are SEPARATE from cumulative budget. This module keeps a
//      slot register (maxConcurrent, default 1) with ZERO coupling to
//      runtime/budget-policy.mjs: budget counts cumulative tokens/calls/deadline,
//      slots count simultaneous live executions — different concerns. A host may
//      pass `grantConcurrencyCap`; if `maxConcurrent > grantConcurrencyCap` the
//      registry REFUSES to be constructed ("concurrency-cap"), so a
//      configurable concurrency can never widen an existing grant's permission.
//
//   4. ONE authoritative owner/fence, no second scheduler. Every state
//      transition carries an optional `expectedFence`; a stale value is refused
//      with "stale-fence". The fence is a per-execution monotonically increasing
//      integer. This module is a PURE LIBRARY: no timers, no loops, no automatic
//      progression — advancement happens only when the host explicitly calls in
//      (we do NOT layer a second scheduler/registry over the product's existing
//      one).
//
//   5. Crash recovery is honest, never auto-driving. `snapshot()` serializes the
//      whole registry; `ExecutionOwnership.fromJSON(snapshot, ports)` restores
//      it. On restore, every submission still "in-flight" becomes "owner-lost"
//      (the owner died and the EFFECT IS UNKNOWN), its slot is released, and
//      nothing is replayed or continued. To resume, the host must explicitly open
//      a NEW cycle / NEW intent and dispatch again. A corrupt snapshot is refused
//      ("invalid-state").
//
//   6. Pending advancement and fault windows are explicit / atomic. The
//      background route is DEFAULT OFF (`routes.backgroundDispatch === false`): a
//      `dispatchBackgroundTask` call returns `{ dispatched: false, reason:
//      "route-disabled" }` with ZERO side effects (no slot, no intent, no
//      submission — the registry snapshot is byte-identical before and after).
//      When the route is explicitly enabled the dispatch is an atomic sequence:
//      reserve slot -> build an immutable launch intent (intentId / ownershipKey
//      / payloadDigest / createdAt) -> begin submission -> invoke the injected
//      `launcher.launch(intent)` port. If the launcher throws, the dispatch is
//      COMPENSATED (slot released, submission marked failed, intent carries a
//      status trail) and reported honestly — there is NO ghost success. A
//      repeated `intentId` returns the original record and never re-launches.
//
// Precision cancel (audit acceptance criterion "单Submission/Execution/Goal
// 各scope"): `cancel({ scope: "submission" | "execution" | "goal", ... })`
// performs the cancellation through the injected `canceller` port, records only a
// status transition + fence increment (records are NEVER deleted), reports an
// already-terminal target honestly as "already-terminal", and returns a
// per-target result array for a goal-scope cancel. A `partial` outcome is its OWN
// terminal value — it is never folded into "cancelled" at the API layer.
//
// Pure ESM, zero imports. Time is injected via `now` (default Date.now) so tests
// are fully synthetic and deterministic. Node's `Buffer` is used only to encode
// the typed key's base64url segments (a pure codec, no ambient state).
//
// Honest boundaries (see docs/handoffs/m02-execution-ownership-r1.md): NOT wired
// into any real SDK, does NOT migrate old stalled rows, does NOT enable the
// production route, cross-process single-owner fencing is NOT proven here, and a
// privacy epoch is only recorded as an opaque token (never verified — that
// belongs to the context-assembler wiring, a separate dependency).

/** Serialization envelope identity, pinned so tampering is detected on load. */
const SERIALIZATION_TYPE = "ExecutionOwnership";
const SERIALIZATION_VERSION = 1;
const KEY_PREFIX = "own1";
const LAUNCH_INTENT_TYPE = "LaunchIntent";
const LAUNCH_INTENT_VERSION = 1;

/** Channels: foreground vs explicit background get distinct key spaces. */
const CHANNELS = Object.freeze(["fg", "bg"]);

/** Submission state machine. Terminal states are immutable. */
const STATUS_IN_FLIGHT = "in-flight";
const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled", "owner-lost", "partial"]);

/**
 * The admissible terminal outcome for each terminal status. `partial` is an
 * independent value and NEVER maps to `cancelled`; a launch fault keeps status
 * `failed` but carries the more specific `launch-failed` outcome.
 */
const OUTCOMES_BY_STATUS = Object.freeze({
	completed: Object.freeze(["completed"]),
	failed: Object.freeze(["failed", "launch-failed"]),
	cancelled: Object.freeze(["cancelled"]),
	"owner-lost": Object.freeze(["owner-lost"]),
	partial: Object.freeze(["partial"]),
});

/** Outcomes `completeSubmission` accepts (partial is a first-class outcome). */
const COMPLETE_OUTCOMES = Object.freeze(["completed", "partial"]);
/** Outcomes `failSubmission` accepts. */
const FAIL_OUTCOMES = Object.freeze(["failed"]);

/** Intent lifecycle statuses recorded for audit. */
const INTENT_STATUSES = Object.freeze(["pending", "launched", "launch-failed", "cancelled", "owner-lost"]);

/** Fail-closed ownership denial. `code` identifies the reason for audit/tests. */
export class ExecutionOwnershipError extends Error {
	constructor(code, message) {
		super(message ?? `execution ownership rejected: ${code}`);
		this.name = "ExecutionOwnershipError";
		this.code = code;
	}
}

/** Throw an ExecutionOwnershipError with the given code. */
function fail(code, message) {
	throw new ExecutionOwnershipError(code, message);
}

/** True for a non-null, non-array, plain-ish object. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required free-text field: a non-empty string. */
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** A finite, non-negative integer (an absolute instant or a counter). */
function isFiniteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** True when a string contains no lone UTF-16 surrogate (so UTF-8 is exact). */
function isWellFormed(str) {
	if (typeof str.isWellFormed === "function") return str.isWellFormed();
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = str.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/** Recursively freeze an object graph in place, returning it. */
function deepFreeze(value) {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

// ---------------------------------------------------------------------------
// Typed composite ownership key (design contract point 1).
// ---------------------------------------------------------------------------

/**
 * base64url-encode a well-formed string (its UTF-8 bytes). Encoded segments use
 * only [A-Za-z0-9_-], so the "." key separator can never be injected.
 */
function b64urlEncode(str) {
	return Buffer.from(str, "utf8").toString("base64url");
}

/**
 * Strictly decode a base64url segment back to a string, or return null when the
 * segment is not a canonical encoding (bad charset, bad padding, non-canonical
 * trailing bits, or invalid UTF-8). Canonicality is enforced by re-encoding.
 */
function b64urlDecode(segment) {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
	let text;
	try {
		text = Buffer.from(segment, "base64url").toString("utf8");
	} catch {
		return null;
	}
	if (b64urlEncode(text) !== segment) return null;
	return text;
}

/**
 * Derive the typed composite ownership key for one execution.
 * @param {{channel: "fg"|"bg", accountId: string, profileId: string, executionId: string, cycle: number}} parts
 * @returns {string} `own1.<channel>.<b64url(accountId)>.<b64url(profileId)>.<b64url(executionId)>.<cycle>`
 */
export function ownershipKey(input) {
	const { channel, accountId, profileId, executionId, cycle } = input ?? {};
	if (!CHANNELS.includes(channel)) fail("invalid-key", `channel must be one of ${CHANNELS.join(", ")}`);
	for (const [name, value] of [["accountId", accountId], ["profileId", profileId], ["executionId", executionId]]) {
		if (!isNonEmptyString(value)) fail("invalid-key", `${name} must be a non-empty string`);
		if (!isWellFormed(value)) fail("invalid-key", `${name} must be well-formed unicode`);
	}
	if (!Number.isSafeInteger(cycle) || cycle < 0) fail("invalid-key", "cycle must be a non-negative safe integer");
	return `${KEY_PREFIX}.${channel}.${b64urlEncode(accountId)}.${b64urlEncode(profileId)}.${b64urlEncode(executionId)}.${cycle}`;
}

/**
 * Strict inverse of `ownershipKey`: parse a typed composite key back to its
 * components, or fail closed with "invalid-key" for any foreign/malformed value.
 * Returns a frozen `{ key, channel, accountId, profileId, executionId, cycle }`.
 */
export function parseOwnershipKey(key) {
	if (typeof key !== "string") fail("invalid-key", "ownership key must be a string");
	const parts = key.split(".");
	if (parts.length !== 6 || parts[0] !== KEY_PREFIX) {
		fail("invalid-key", "ownership key has an unknown shape (expected 6 own1.* segments)");
	}
	const [, channel, accountSegment, profileSegment, executionSegment, cycleSegment] = parts;
	if (!CHANNELS.includes(channel)) fail("invalid-key", `ownership key channel must be one of ${CHANNELS.join(", ")}`);
	if (!/^(0|[1-9][0-9]*)$/.test(cycleSegment)) fail("invalid-key", "ownership key cycle segment is not a canonical integer");
	const cycle = Number(cycleSegment);
	if (!Number.isSafeInteger(cycle)) fail("invalid-key", "ownership key cycle segment is out of range");
	const accountId = b64urlDecode(accountSegment);
	const profileId = b64urlDecode(profileSegment);
	const executionId = b64urlDecode(executionSegment);
	if (accountId === null || profileId === null || executionId === null) {
		fail("invalid-key", "ownership key carries a malformed base64url segment");
	}
	// Re-derive and require an exact match, so only the canonical encoding is
	// accepted (no alternate/aliasing representations of the same identity).
	const canonical = ownershipKey({ channel, accountId, profileId, executionId, cycle });
	if (canonical !== key) fail("invalid-key", "ownership key is not in canonical form");
	return deepFreeze({ key: canonical, channel, accountId, profileId, executionId, cycle });
}

// ---------------------------------------------------------------------------
// Deterministic payload digest (non-cryptographic content fingerprint).
// ---------------------------------------------------------------------------

/** Stable JSON of a JSON-ish value with sorted object keys; else invalid-argument. */
function stableStringify(value) {
	const seen = new WeakSet();
	const walk = (node) => {
		if (node === null) return null;
		const type = typeof node;
		if (type === "number") {
			if (!Number.isFinite(node)) fail("invalid-argument", "payload numbers must be finite");
			return node;
		}
		if (type === "string" || type === "boolean") return node;
		if (type === "object") {
			if (seen.has(node)) fail("invalid-argument", "payload must not contain cycles");
			seen.add(node);
			if (Array.isArray(node)) return node.map(walk);
			const ordered = {};
			for (const key of Object.keys(node).sort()) ordered[key] = walk(node[key]);
			return ordered;
		}
		fail("invalid-argument", `payload must be JSON-serializable (got ${type})`);
	};
	return JSON.stringify(walk(value));
}

/**
 * Deterministic content fingerprint of a payload (canonical JSON + FNV-1a 32).
 * This is an identity/dedupe token, NOT a cryptographic hash.
 */
function contentDigest(value) {
	const text = stableStringify(value);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A durable, fail-closed execution-ownership registry.
 *
 * @param {object} [options]
 * @param {{backgroundDispatch?: boolean}} [options.routes]
 *        New-task routing. `backgroundDispatch` DEFAULTS TO FALSE (production
 *        routing stays off — audit point 6).
 * @param {number} [options.maxConcurrent] Concurrent slot ceiling (default 1).
 * @param {number} [options.grantConcurrencyCap]
 *        Optional host-granted concurrency cap. `maxConcurrent > cap` is refused
 *        at construction ("concurrency-cap") — a configurable concurrency can
 *        never widen an existing grant.
 * @param {{launcher?: {launch: Function}, canceller?: {cancel: Function}}} [options.ports]
 *        Injected side-effect ports. `launcher` is required when the background
 *        route is enabled; `canceller` is required to call `cancel`.
 * @param {() => number} [options.now] Injectable clock (default Date.now).
 */
export class ExecutionOwnership {
	constructor({ routes, maxConcurrent = 1, grantConcurrencyCap, ports = {}, now } = {}) {
		const clock = now ?? Date.now;
		if (typeof clock !== "function") fail("invalid-argument", "now must be a function");
		if (routes !== undefined && !isPlainObject(routes)) fail("invalid-argument", "routes must be an object");
		const backgroundDispatch = routes?.backgroundDispatch ?? false;
		if (typeof backgroundDispatch !== "boolean") {
			fail("invalid-argument", "routes.backgroundDispatch must be a boolean");
		}
		if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
			fail("invalid-argument", "maxConcurrent must be a positive integer");
		}
		let cap = null;
		if (grantConcurrencyCap !== undefined && grantConcurrencyCap !== null) {
			if (!Number.isInteger(grantConcurrencyCap) || grantConcurrencyCap <= 0) {
				fail("invalid-argument", "grantConcurrencyCap must be a positive integer when provided");
			}
			// A configurable concurrency must never exceed the granted permission.
			if (maxConcurrent > grantConcurrencyCap) {
				fail("concurrency-cap", `maxConcurrent ${maxConcurrent} exceeds the granted concurrency cap ${grantConcurrencyCap}`);
			}
			cap = grantConcurrencyCap;
		}
		if (!isPlainObject(ports)) fail("invalid-argument", "ports must be an object");
		const launcher = ports.launcher ?? null;
		const canceller = ports.canceller ?? null;
		if (launcher !== null && typeof launcher.launch !== "function") {
			fail("invalid-argument", "ports.launcher must expose launch(intent)");
		}
		if (canceller !== null && typeof canceller.cancel !== "function") {
			fail("invalid-argument", "ports.canceller must expose cancel(target)");
		}
		if (backgroundDispatch && launcher === null) {
			fail("invalid-argument", "the backgroundDispatch route requires an injected launcher port");
		}

		this._clock = clock;
		this._launcher = launcher;
		this._canceller = canceller;
		this._routes = Object.freeze({ backgroundDispatch });
		this._maxConcurrent = maxConcurrent;
		this._grantConcurrencyCap = cap;
		this._executions = new Map(); // ownershipKey -> execution record
		this._intents = new Map(); // intentId -> launch intent record
		this._submissionIds = new Set(); // global submissionId uniqueness
		this._slotHolders = new Set(); // submissionIds currently holding a slot
	}

	// --- read-only observability -------------------------------------------

	get maxConcurrent() {
		return this._maxConcurrent;
	}

	get grantConcurrencyCap() {
		return this._grantConcurrencyCap;
	}

	get slotsInUse() {
		return this._slotHolders.size;
	}

	get routes() {
		return this._routes;
	}

	get size() {
		return this._executions.size;
	}

	get intentCount() {
		return this._intents.size;
	}

	/** The current fence for an execution (monotonic, per execution). */
	fence(key) {
		return this._requireExecution(key).fence;
	}

	/** A frozen audit view of one execution (binding + fence + submissions). */
	status(key) {
		return this._executionView(this._requireExecution(key));
	}

	// --- registration -------------------------------------------------------

	/**
	 * Bind an execution to the host-confirmed Task/Grant identity. The binding is
	 * immutable: an identical re-register is idempotent, a differing one is a
	 * "binding-conflict".
	 */
	registerExecution({ key, goalId, taskId, grantRef } = {}) {
		const parsed = parseOwnershipKey(key);
		if (!isNonEmptyString(goalId)) fail("invalid-argument", "goalId must be a non-empty string");
		if (!isNonEmptyString(taskId)) fail("invalid-argument", "taskId must be a non-empty string");
		if (!isNonEmptyString(grantRef)) fail("invalid-argument", "grantRef must be a non-empty string");

		const existing = this._executions.get(parsed.key);
		if (existing) {
			if (existing.goalId !== goalId || existing.taskId !== taskId || existing.grantRef !== grantRef) {
				fail("binding-conflict", `execution ${parsed.key} is already bound to a different Task/Grant identity`);
			}
			return this._executionView(existing);
		}
		const record = {
			key: parsed.key,
			channel: parsed.channel,
			accountId: parsed.accountId,
			profileId: parsed.profileId,
			executionId: parsed.executionId,
			cycle: parsed.cycle,
			goalId,
			taskId,
			grantRef,
			fence: 0,
			createdAt: this._clock(),
			submissions: [],
		};
		this._executions.set(record.key, record);
		return this._executionView(record);
	}

	// --- submissions --------------------------------------------------------

	/**
	 * Open the single in-flight Submission for an execution. A second call while
	 * one is in flight is refused ("submission-in-flight"); a submissionId already
	 * used anywhere in the registry is refused ("submission-exists").
	 */
	beginSubmission(key, { submissionId, payloadDigest, intentId, expectedFence } = {}) {
		const record = this._requireExecution(key);
		this._assertFence(record, expectedFence);
		const submission = this._openSubmission(record, { submissionId, payloadDigest, intentId });
		return this._submissionView(submission);
	}

	/**
	 * Complete the current in-flight submission. `outcome` is "completed"
	 * (default) or "partial" — a partial is its OWN terminal state, never folded
	 * into "cancelled". Only the matching in-flight submission can transition.
	 */
	completeSubmission(key, submissionId, outcome = "completed", { expectedFence } = {}) {
		return this._finishSubmission(key, submissionId, outcome, COMPLETE_OUTCOMES, expectedFence);
	}

	/** Fail the current in-flight submission (`outcome` defaults to "failed"). */
	failSubmission(key, submissionId, outcome = "failed", { expectedFence } = {}) {
		return this._finishSubmission(key, submissionId, outcome, FAIL_OUTCOMES, expectedFence);
	}

	// --- new-task routing (default off) ------------------------------------

	/**
	 * Dispatch a NEW background task. When `routes.backgroundDispatch` is false
	 * (the default) this returns `{ dispatched: false, reason: "route-disabled" }`
	 * with ZERO side effects. When enabled it runs the atomic sequence
	 * reserve-slot -> intent -> begin-submission -> launcher.launch, compensating
	 * honestly on a launcher fault and never re-launching a replayed intentId.
	 */
	dispatchBackgroundTask({ key, intentId, payload, payloadDigest, submissionId, expectedFence } = {}) {
		// Route off is checked FIRST and short-circuits: no validation, no state.
		if (!this._routes.backgroundDispatch) {
			return { dispatched: false, reason: "route-disabled" };
		}

		const record = this._requireExecution(key);
		this._assertFence(record, expectedFence);
		if (!isNonEmptyString(intentId)) fail("invalid-argument", "intentId must be a non-empty string");
		const digest = isNonEmptyString(payloadDigest)
			? payloadDigest
			: payload !== undefined
				? contentDigest(payload)
				: undefined;
		if (!isNonEmptyString(digest)) fail("invalid-argument", "dispatch requires a payload or a payloadDigest string");
		const sid = submissionId ?? `sub:${intentId}`;
		if (!isNonEmptyString(sid)) fail("invalid-argument", "submissionId must be a non-empty string when provided");

		// Idempotency: a repeated intentId returns the ORIGINAL record, and never
		// re-launches. A repeated intentId that disagrees on key/digest conflicts.
		const existing = this._intents.get(intentId);
		if (existing) {
			if (existing.ownershipKey !== record.key || existing.payloadDigest !== digest) {
				fail("intent-conflict", `intentId ${intentId} already exists with a different ownership key or payload`);
			}
			return {
				dispatched: existing.status === "launched",
				replayed: true,
				intent: this._intentView(existing),
				submissionId: existing.submissionId,
				status: existing.status,
			};
		}

		// Reserve a slot BEFORE any record is written.
		this._assertSlotAvailable();

		// Immutable launch intent (intentId / ownershipKey / payloadDigest / createdAt).
		const intent = {
			type: LAUNCH_INTENT_TYPE,
			version: LAUNCH_INTENT_VERSION,
			intentId,
			ownershipKey: record.key,
			payloadDigest: digest,
			createdAt: this._clock(),
			status: "pending",
			submissionId: null,
		};
		this._intents.set(intentId, intent);

		let submission;
		try {
			submission = this._openSubmission(record, { submissionId: sid, payloadDigest: digest, intentId });
		} catch (error) {
			// The submission was refused (e.g. already in flight): undo the intent,
			// release the reserved slot and surface the honest reason.
			this._intents.delete(intentId);
			throw error;
		}
		intent.submissionId = submission.submissionId;
		intent.status = "launched";
		this._slotHolders.add(submission.submissionId);

		try {
			this._launcher.launch(this._intentView(intent));
		} catch (error) {
			// Compensation: no ghost success. Release the slot, mark the submission
			// failed and leave a status trail on the intent.
			this._slotHolders.delete(submission.submissionId);
			submission.status = "failed";
			submission.outcome = "launch-failed";
			intent.status = "launch-failed";
			record.fence += 1;
			return {
				dispatched: false,
				reason: "launch-failed",
				intent: this._intentView(intent),
				submissionId: submission.submissionId,
				error: { message: String(error?.message ?? error) },
			};
		}
		return {
			dispatched: true,
			replayed: false,
			intent: this._intentView(intent),
			submissionId: submission.submissionId,
			status: submission.status,
		};
	}

	// --- precise-scope cancellation ----------------------------------------

	/**
	 * Cancel by precise scope: "submission" (key + submissionId), "execution"
	 * (key) or "goal" (goalId). The cancellation is executed through the injected
	 * `canceller` port; records are never deleted (status transition + fence only).
	 * An already-terminal target reports honestly as "already-terminal". A
	 * goal-scope cancel returns a per-target result array.
	 */
	cancel({ scope, key, submissionId, goalId, expectedFence } = {}) {
		if (this._canceller === null) fail("invalid-argument", "cancel requires an injected canceller port");

		if (scope === "submission") {
			const record = this._requireExecution(key);
			this._assertFence(record, expectedFence);
			if (!isNonEmptyString(submissionId)) {
				fail("invalid-argument", "submissionId is required for a submission-scope cancel");
			}
			const submission = record.submissions.find((s) => s.submissionId === submissionId);
			if (!submission) fail("unknown-submission", `execution ${record.key} has no submission ${submissionId}`);
			return { scope: "submission", ownershipKey: record.key, ...this._cancelSubmission(record, submission) };
		}

		if (scope === "execution") {
			const record = this._requireExecution(key);
			this._assertFence(record, expectedFence);
			const inflight = this._inFlight(record);
			if (!inflight) {
				return { scope: "execution", ownershipKey: record.key, submissionId: null, status: "already-terminal", fence: record.fence };
			}
			return { scope: "execution", ownershipKey: record.key, ...this._cancelSubmission(record, inflight) };
		}

		if (scope === "goal") {
			if (!isNonEmptyString(goalId)) fail("invalid-argument", "goalId is required for a goal-scope cancel");
			if (expectedFence !== undefined) {
				fail("invalid-argument", "expectedFence is not supported for a goal-scope cancel");
			}
			const results = [];
			for (const record of this._executions.values()) {
				if (record.goalId !== goalId) continue;
				const inflight = this._inFlight(record);
				if (!inflight) {
					results.push({ ownershipKey: record.key, submissionId: null, status: "already-terminal", fence: record.fence });
				} else {
					results.push({ ownershipKey: record.key, ...this._cancelSubmission(record, inflight) });
				}
			}
			return results;
		}

		fail("invalid-argument", "cancel scope must be one of submission, execution, goal");
	}

	// --- serialization ------------------------------------------------------

	/**
	 * A deterministic, JSON-serializable snapshot of the whole registry. Two calls
	 * on the same state produce deep-equal data.
	 */
	snapshot() {
		const executions = [];
		for (const record of this._executions.values()) {
			executions.push({
				key: record.key,
				goalId: record.goalId,
				taskId: record.taskId,
				grantRef: record.grantRef,
				fence: record.fence,
				createdAt: record.createdAt,
				submissions: record.submissions.map((s) => ({ ...s })),
			});
		}
		const intents = [];
		for (const intent of this._intents.values()) intents.push({ ...intent });
		return {
			type: SERIALIZATION_TYPE,
			version: SERIALIZATION_VERSION,
			routes: { backgroundDispatch: this._routes.backgroundDispatch },
			maxConcurrent: this._maxConcurrent,
			grantConcurrencyCap: this._grantConcurrencyCap,
			slotsInUse: this._slotHolders.size,
			executions,
			intents,
		};
	}

	/**
	 * Rebuild a registry from `snapshot()` data (a plain object or a JSON string),
	 * fully re-validated. Any structural corruption is "invalid-state". On restore
	 * every still in-flight submission becomes "owner-lost" (the owner died; the
	 * effect is unknown), its slot is released, and NOTHING is replayed — the host
	 * must open a new cycle / new intent to resume.
	 */
	static fromJSON(data, ports = {}, options = {}) {
		let source = data;
		if (typeof data === "string") {
			try {
				source = JSON.parse(data);
			} catch {
				fail("invalid-state", "snapshot is not valid JSON");
			}
		}
		if (!isPlainObject(source) || source.type !== SERIALIZATION_TYPE || source.version !== SERIALIZATION_VERSION) {
			fail("invalid-state", `snapshot must be { type: "${SERIALIZATION_TYPE}", version: ${SERIALIZATION_VERSION}, ... }`);
		}
		if (!Array.isArray(source.executions) || !Array.isArray(source.intents)) {
			fail("invalid-state", "snapshot requires executions and intents arrays");
		}
		if (source.grantConcurrencyCap !== null && !Number.isInteger(source.grantConcurrencyCap)) {
			fail("invalid-state", "snapshot grantConcurrencyCap must be null or a positive integer");
		}
		if (!isFiniteNonNegative(source.slotsInUse) || !Number.isInteger(source.slotsInUse)) {
			fail("invalid-state", "snapshot slotsInUse must be a non-negative integer");
		}

		const registry = new ExecutionOwnership({
			routes: source.routes,
			maxConcurrent: source.maxConcurrent,
			grantConcurrencyCap: source.grantConcurrencyCap,
			ports,
			now: options.now,
		});
		if (source.slotsInUse > registry._maxConcurrent) {
			fail("invalid-state", "snapshot slotsInUse exceeds maxConcurrent");
		}

		for (const raw of source.executions) {
			registry._restoreExecution(raw);
		}
		for (const raw of source.intents) {
			registry._restoreIntent(raw);
		}
		// Crash recovery: every in-flight submission lost its owner. Honest,
		// no replay; the slot is released as a consequence.
		for (const record of registry._executions.values()) {
			for (const submission of record.submissions) {
				if (submission.status === STATUS_IN_FLIGHT) {
					submission.status = "owner-lost";
					submission.outcome = "owner-lost";
					registry._slotHolders.delete(submission.submissionId);
					if (submission.intentId) {
						const intent = registry._intents.get(submission.intentId);
						if (intent && intent.status === "launched") intent.status = "owner-lost";
					}
				}
			}
		}
		return registry;
	}

	// --- internals ----------------------------------------------------------

	_restoreExecution(raw) {
		if (!isPlainObject(raw)) fail("invalid-state", "execution record must be an object");
		const parsed = parseOwnershipKeySafe(raw.key);
		if (!isNonEmptyString(raw.goalId) || !isNonEmptyString(raw.taskId) || !isNonEmptyString(raw.grantRef)) {
			fail("invalid-state", `execution ${parsed.key}: goalId/taskId/grantRef must be non-empty strings`);
		}
		if (!isFiniteNonNegative(raw.fence) || !Number.isInteger(raw.fence)) {
			fail("invalid-state", `execution ${parsed.key}: fence must be a non-negative integer`);
		}
		if (!isFiniteNonNegative(raw.createdAt)) fail("invalid-state", `execution ${parsed.key}: createdAt must be a finite number`);
		if (!Array.isArray(raw.submissions)) fail("invalid-state", `execution ${parsed.key}: submissions must be an array`);
		if (this._executions.has(parsed.key)) fail("invalid-state", `duplicate execution key: ${parsed.key}`);
		const record = {
			key: parsed.key,
			channel: parsed.channel,
			accountId: parsed.accountId,
			profileId: parsed.profileId,
			executionId: parsed.executionId,
			cycle: parsed.cycle,
			goalId: raw.goalId,
			taskId: raw.taskId,
			grantRef: raw.grantRef,
			fence: raw.fence,
			createdAt: raw.createdAt,
			submissions: [],
		};
		for (const rawSubmission of raw.submissions) {
			record.submissions.push(this._restoreSubmission(parsed.key, rawSubmission));
		}
		this._executions.set(record.key, record);
	}

	_restoreSubmission(ownershipKeyValue, raw) {
		if (!isPlainObject(raw)) fail("invalid-state", "submission record must be an object");
		if (!isNonEmptyString(raw.submissionId)) fail("invalid-state", "submissionId must be a non-empty string");
		if (raw.ownershipKey !== ownershipKeyValue) fail("invalid-state", `submission ${raw.submissionId}: ownershipKey mismatch`);
		if (!isNonEmptyString(raw.payloadDigest)) fail("invalid-state", `submission ${raw.submissionId}: payloadDigest must be a non-empty string`);
		if (raw.intentId !== null && !isNonEmptyString(raw.intentId)) fail("invalid-state", `submission ${raw.submissionId}: intentId must be null or a non-empty string`);
		if (raw.status !== STATUS_IN_FLIGHT && !TERMINAL_STATUSES.includes(raw.status)) {
			fail("invalid-state", `submission ${raw.submissionId}: unknown status ${String(raw.status)}`);
		}
		if (raw.status === STATUS_IN_FLIGHT) {
			if (raw.outcome !== null) fail("invalid-state", `submission ${raw.submissionId}: an in-flight submission must have a null outcome`);
		} else if (!OUTCOMES_BY_STATUS[raw.status].includes(raw.outcome)) {
			fail("invalid-state", `submission ${raw.submissionId}: outcome ${String(raw.outcome)} is not valid for status ${raw.status}`);
		}
		if (!isFiniteNonNegative(raw.createdAt)) fail("invalid-state", `submission ${raw.submissionId}: createdAt must be a finite number`);
		if (this._submissionIds.has(raw.submissionId)) fail("invalid-state", `duplicate submissionId: ${raw.submissionId}`);
		this._submissionIds.add(raw.submissionId);
		return {
			submissionId: raw.submissionId,
			ownershipKey: raw.ownershipKey,
			payloadDigest: raw.payloadDigest,
			intentId: raw.intentId,
			status: raw.status,
			outcome: raw.outcome,
			createdAt: raw.createdAt,
		};
	}

	_restoreIntent(raw) {
		if (!isPlainObject(raw)) fail("invalid-state", "intent record must be an object");
		if (raw.type !== LAUNCH_INTENT_TYPE || raw.version !== LAUNCH_INTENT_VERSION) {
			fail("invalid-state", "intent record has an unknown type/version");
		}
		if (!isNonEmptyString(raw.intentId)) fail("invalid-state", "intentId must be a non-empty string");
		const parsed = parseOwnershipKeySafe(raw.ownershipKey);
		if (!isNonEmptyString(raw.payloadDigest)) fail("invalid-state", `intent ${raw.intentId}: payloadDigest must be a non-empty string`);
		if (!isFiniteNonNegative(raw.createdAt)) fail("invalid-state", `intent ${raw.intentId}: createdAt must be a finite number`);
		if (!INTENT_STATUSES.includes(raw.status)) fail("invalid-state", `intent ${raw.intentId}: unknown status ${String(raw.status)}`);
		if (raw.submissionId !== null && !isNonEmptyString(raw.submissionId)) {
			fail("invalid-state", `intent ${raw.intentId}: submissionId must be null or a non-empty string`);
		}
		if (this._intents.has(raw.intentId)) fail("invalid-state", `duplicate intentId: ${raw.intentId}`);
		const record = this._executions.get(parsed.key);
		if (!record) fail("invalid-state", `intent ${raw.intentId}: no execution is registered for its ownership key`);
		if (raw.submissionId !== null) {
			const submission = record.submissions.find((s) => s.submissionId === raw.submissionId);
			if (!submission) fail("invalid-state", `intent ${raw.intentId}: its submission does not exist`);
			if (submission.intentId !== raw.intentId) fail("invalid-state", `intent ${raw.intentId}: its submission points at another intent`);
		}
		this._intents.set(raw.intentId, {
			type: raw.type,
			version: raw.version,
			intentId: raw.intentId,
			ownershipKey: raw.ownershipKey,
			payloadDigest: raw.payloadDigest,
			createdAt: raw.createdAt,
			status: raw.status,
			submissionId: raw.submissionId,
		});
	}

	_requireExecution(key) {
		const parsed = parseOwnershipKey(key);
		const record = this._executions.get(parsed.key);
		if (!record) fail("unknown-execution", `no execution is registered for ${parsed.key}`);
		return record;
	}

	_inFlight(record) {
		for (const submission of record.submissions) {
			if (submission.status === STATUS_IN_FLIGHT) return submission;
		}
		return null;
	}

	_assertFence(record, expectedFence) {
		if (expectedFence === undefined) return;
		if (!Number.isInteger(expectedFence) || expectedFence < 0) {
			fail("invalid-argument", "expectedFence must be a non-negative integer when provided");
		}
		if (expectedFence !== record.fence) {
			fail("stale-fence", `execution ${record.key}: expected fence ${expectedFence}, current fence ${record.fence}`);
		}
	}

	_assertSlotAvailable() {
		if (this._slotHolders.size >= this._maxConcurrent) {
			fail("slot-exhausted", `concurrency slot limit reached (${this._maxConcurrent})`);
		}
	}

	_openSubmission(record, { submissionId, payloadDigest, intentId }) {
		if (!isNonEmptyString(submissionId)) fail("invalid-argument", "submissionId must be a non-empty string");
		if (!isNonEmptyString(payloadDigest)) fail("invalid-argument", "payloadDigest must be a non-empty string");
		if (intentId !== undefined && intentId !== null && !isNonEmptyString(intentId)) {
			fail("invalid-argument", "intentId must be a non-empty string when provided");
		}
		// One in-flight submission per execution: a second input must not smuggle
		// a replay of the old task under the same execution identity.
		const inflight = this._inFlight(record);
		if (inflight) {
			fail("submission-in-flight", `execution ${record.key} already has an in-flight submission ${inflight.submissionId}`);
		}
		if (this._submissionIds.has(submissionId)) {
			fail("submission-exists", `submissionId ${submissionId} is already used`);
		}
		const submission = {
			submissionId,
			ownershipKey: record.key,
			payloadDigest,
			intentId: intentId ?? null,
			status: STATUS_IN_FLIGHT,
			outcome: null,
			createdAt: this._clock(),
		};
		record.submissions.push(submission);
		this._submissionIds.add(submissionId);
		record.fence += 1;
		return submission;
	}

	_finishSubmission(key, submissionId, outcome, allowed, expectedFence) {
		const record = this._requireExecution(key);
		this._assertFence(record, expectedFence);
		if (!isNonEmptyString(submissionId)) fail("invalid-argument", "submissionId must be a non-empty string");
		if (!allowed.includes(outcome)) fail("invalid-argument", `outcome must be one of ${allowed.join(", ")}`);
		const submission = record.submissions.find((s) => s.submissionId === submissionId);
		if (!submission) fail("unknown-submission", `execution ${record.key} has no submission ${submissionId}`);
		if (submission.status !== STATUS_IN_FLIGHT) {
			fail("submission-terminal", `submission ${submissionId} is already ${submission.status}`);
		}
		submission.status = outcome;
		submission.outcome = outcome;
		this._releaseSlot(submission);
		record.fence += 1;
		return this._submissionView(submission);
	}

	_cancelSubmission(record, submission) {
		if (submission.status !== STATUS_IN_FLIGHT) {
			return { submissionId: submission.submissionId, status: "already-terminal", fence: record.fence };
		}
		let cancelError = null;
		try {
			this._canceller.cancel({
				scope: "submission",
				ownershipKey: record.key,
				submissionId: submission.submissionId,
				goalId: record.goalId,
				executionId: record.executionId,
				channel: record.channel,
			});
		} catch (error) {
			cancelError = error;
		}
		if (cancelError) {
			// The real cancellation did not happen: record honestly, do not
			// transition, do not advance the fence.
			return {
				submissionId: submission.submissionId,
				status: "cancel-failed",
				fence: record.fence,
				error: { message: String(cancelError?.message ?? cancelError) },
			};
		}
		submission.status = "cancelled";
		submission.outcome = "cancelled";
		this._releaseSlot(submission);
		if (submission.intentId) {
			const intent = this._intents.get(submission.intentId);
			if (intent && intent.status === "launched") intent.status = "cancelled";
		}
		record.fence += 1;
		return { submissionId: submission.submissionId, status: "cancelled", fence: record.fence };
	}

	_releaseSlot(submission) {
		this._slotHolders.delete(submission.submissionId);
	}

	_executionView(record) {
		return deepFreeze({
			key: record.key,
			channel: record.channel,
			accountId: record.accountId,
			profileId: record.profileId,
			executionId: record.executionId,
			cycle: record.cycle,
			goalId: record.goalId,
			taskId: record.taskId,
			grantRef: record.grantRef,
			fence: record.fence,
			createdAt: record.createdAt,
			submissions: record.submissions.map((s) => ({ ...s })),
		});
	}

	_submissionView(submission) {
		return deepFreeze({ ...submission });
	}

	_intentView(intent) {
		return deepFreeze({ ...intent });
	}
}

/**
 * `parseOwnershipKey` for snapshot validation: any malformed key violates the
 * snapshot envelope, so it is reported as "invalid-state" rather than "invalid-key".
 */
function parseOwnershipKeySafe(key) {
	try {
		return parseOwnershipKey(key);
	} catch (error) {
		if (error instanceof ExecutionOwnershipError && error.code === "invalid-key") {
			fail("invalid-state", `snapshot carries an invalid ownership key: ${String(key)}`);
		}
		throw error;
	}
}
