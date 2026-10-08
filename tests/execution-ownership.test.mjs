// Tests for runtime/execution-ownership.mjs (M02/I03d — durable ownership, new
// synthetic slice).
//
// Pure-module tests: the clock, the launcher and the canceller are all synthetic
// in-test fakes; there is NO network, NO real SDK, NO production store, NO file
// I/O and NO side effect of any kind outside this process. They pin the audit
// acceptance conditions in docs/audits/durable-ownership-proposal-r1.md:
// typed composite ownership key, single in-flight submission, route-off by
// default, honest compensation, precise-scope cancel, crash recovery to
// owner-lost, per-execution fence and separable concurrency slots.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	ExecutionOwnership,
	ExecutionOwnershipError,
	ownershipKey,
	parseOwnershipKey,
} from "../runtime/execution-ownership.mjs";

/** Assert `fn` throws an ExecutionOwnershipError carrying exactly `code`. */
function expectCode(fn, code) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof ExecutionOwnershipError, `expected ExecutionOwnershipError, got ${error}`);
		assert.equal(error.code, code);
		return true;
	}, `expected ExecutionOwnershipError("${code}")`);
}

/** A canonical ownership key, with optional component overrides. */
function keyOf(overrides = {}) {
	return ownershipKey({
		channel: "bg",
		accountId: "acct-1",
		profileId: "prof-1",
		executionId: "exec-1",
		cycle: 0,
		...overrides,
	});
}

/** Recording launcher fake; optionally throws for named intent ids. */
function fakeLauncher({ failIntentIds = [] } = {}) {
	const launches = [];
	return {
		launches,
		launch(intent) {
			launches.push(intent);
			if (failIntentIds.includes(intent.intentId)) throw new Error(`launch fault: ${intent.intentId}`);
		},
	};
}

/** Recording canceller fake; optionally throws for named submission ids. */
function fakeCanceller({ failSubmissionIds = [] } = {}) {
	const calls = [];
	return {
		calls,
		cancel(target) {
			calls.push(target);
			if (failSubmissionIds.includes(target.submissionId)) throw new Error(`cancel fault: ${target.submissionId}`);
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Typed composite ownership key
// ---------------------------------------------------------------------------

test("1. ownershipKey derives a typed composite key and round-trips through parse", () => {
	const key = keyOf();
	assert.equal(key, "own1.bg.YWNjdC0x.cHJvZi0x.ZXhlYy0x.0");

	const parsed = parseOwnershipKey(key);
	assert.deepEqual(parsed, {
		key,
		channel: "bg",
		accountId: "acct-1",
		profileId: "prof-1",
		executionId: "exec-1",
		cycle: 0,
	});
	assert.ok(Object.isFrozen(parsed));

	// Re-deriving from the parsed components is byte-identical.
	assert.equal(ownershipKey(parsed), key);

	// An executionId that contains the separator still parses back exactly,
	// because free-text segments are base64url-encoded (no injection): the only
	// "." characters in the key are the structural separators.
	const dotted = keyOf({ executionId: "a.b.c" });
	assert.equal(parseOwnershipKey(dotted).executionId, "a.b.c");
	assert.equal(dotted.split(".").length, 6, "no separators leak from an id");

	// Unicode ids round-trip through UTF-8.
	const uni = keyOf({ accountId: "账户-🧑", profileId: "プロファイル" });
	assert.equal(parseOwnershipKey(uni).accountId, "账户-🧑");
	assert.equal(parseOwnershipKey(uni).profileId, "プロファイル");
});

test("2. foreground and background never collide, and malformed/foreign keys are refused", () => {
	// Same ids, different channel -> DIFFERENT keys (fg/bg name-collision guard).
	const fg = ownershipKey({ channel: "fg", accountId: "a", profileId: "p", executionId: "e", cycle: 0 });
	const bg = ownershipKey({ channel: "bg", accountId: "a", profileId: "p", executionId: "e", cycle: 0 });
	assert.notEqual(fg, bg);

	// A different cycle is a different key (new cycle == new execution identity).
	assert.notEqual(keyOf({ cycle: 0 }), keyOf({ cycle: 1 }));

	// Foreign / malformed keys are refused.
	const badKeys = [
		"",
		"bg.exec-1",
		"own1.xx.YQ.Yg.Yw.0", // bad channel
		"own1.bg..Yg.Yw.0", // empty segment
		"own1.bg.YQ.Yg.Yw.00", // non-canonical cycle (leading zero)
		"own1.bg.YQ.Yg.Yw.-1", // negative cycle
		"own1.bg.YQ.Yg.Yw.1.extra", // too many segments (separator injection)
		"own1.bg.YQ.Yg.Yw.1.0", // wrong prefix shape
		"own2.bg.YQ.Yg.Yw.0", // unknown prefix
		"own1.bg.YQ!.Yg.Yw.0", // non-base64url charset
		"own1.bg.YQ.Yg.Yw.99999999999999999999", // cycle beyond safe integer
	];
	for (const bad of badKeys) expectCode(() => parseOwnershipKey(bad), "invalid-key");
	expectCode(() => parseOwnershipKey(42), "invalid-key");
	expectCode(() => parseOwnershipKey(undefined), "invalid-key");

	// Derivation refuses missing / mistyped components.
	expectCode(() => ownershipKey(null), "invalid-key");
	expectCode(() => ownershipKey({ channel: "bg", accountId: "", profileId: "p", executionId: "e", cycle: 0 }), "invalid-key");
	expectCode(() => ownershipKey({ channel: "fg", accountId: "a", profileId: 7, executionId: "e", cycle: 0 }), "invalid-key");
	expectCode(() => ownershipKey({ channel: "bg", accountId: "a", profileId: "p", executionId: "e", cycle: 1.5 }), "invalid-key");
	expectCode(() => ownershipKey({ channel: "bg", accountId: "a", profileId: "p", executionId: "e", cycle: -1 }), "invalid-key");
	expectCode(() => ownershipKey({ channel: "bg", accountId: "a", profileId: "p", executionId: "e", cycle: Number.MAX_SAFE_INTEGER + 1 }), "invalid-key");
});

// ---------------------------------------------------------------------------
// 3. Registration / binding immutability
// ---------------------------------------------------------------------------

test("3. registerExecution binds an immutable Task/Grant identity and conflicts on change", () => {
	const eo = new ExecutionOwnership();
	const key = keyOf();
	const registered = eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });
	assert.equal(registered.key, key);
	assert.equal(registered.fence, 0);
	assert.ok(Object.isFrozen(registered));
	assert.equal(eo.size, 1);

	// An identical re-register is idempotent...
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });
	// ...but a differing binding is refused, leaving the original intact.
	expectCode(() => eo.registerExecution({ key, goalId: "g1", taskId: "t2", grantRef: "gr1" }), "binding-conflict");
	expectCode(() => eo.registerExecution({ key, goalId: "other", taskId: "t1", grantRef: "gr1" }), "binding-conflict");
	assert.equal(eo.status(key).taskId, "t1");

	// Unknown executions are refused on every keyed operation.
	expectCode(() => eo.status(keyOf({ executionId: "nope" })), "unknown-execution");
	expectCode(() => eo.beginSubmission(keyOf({ executionId: "nope" }), { submissionId: "s", payloadDigest: "d" }), "unknown-execution");
});

// ---------------------------------------------------------------------------
// 4. Single in-flight submission + terminal states
// ---------------------------------------------------------------------------

test("4. one in-flight submission per execution, globally unique submission ids", () => {
	const eo = new ExecutionOwnership();
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });

	const first = eo.beginSubmission(key, { submissionId: "s1", payloadDigest: "d1" });
	assert.equal(first.status, "in-flight");
	assert.equal(first.outcome, null);
	assert.equal(eo.fence(key), 1);

	// A second concurrent input for the same execution is refused: no smuggling a
	// replay of the old task under the same execution identity.
	expectCode(() => eo.beginSubmission(key, { submissionId: "s2", payloadDigest: "d2" }), "submission-in-flight");
	assert.equal(eo.fence(key), 1, "a refused begin does not advance the fence");

	// Once the first submission reaches a terminal state a fresh one is allowed.
	eo.completeSubmission(key, "s1");
	const second = eo.beginSubmission(key, { submissionId: "s2", payloadDigest: "d2" });
	assert.equal(second.status, "in-flight");
	assert.equal(eo.status(key).submissions.length, 2, "both submissions are retained");

	// submissionId uniqueness spans the WHOLE registry (cross-execution reuse).
	const otherKey = keyOf({ executionId: "exec-2" });
	eo.registerExecution({ key: otherKey, goalId: "g1", taskId: "t2", grantRef: "gr1" });
	expectCode(() => eo.beginSubmission(otherKey, { submissionId: "s1", payloadDigest: "x" }), "submission-exists");
});

test("5. submission state machine: terminal is immutable and partial is its own outcome", () => {
	const eo = new ExecutionOwnership();
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });

	// partial is a first-class terminal outcome, NEVER folded into cancelled.
	eo.beginSubmission(key, { submissionId: "p1", payloadDigest: "d" });
	const partial = eo.completeSubmission(key, "p1", "partial");
	assert.equal(partial.status, "partial");
	assert.equal(partial.outcome, "partial");
	assert.notEqual(partial.outcome, "cancelled");
	assert.notEqual(partial.status, "cancelled");
	assert.notEqual(partial.status, "completed");

	// Terminal states are immutable.
	expectCode(() => eo.completeSubmission(key, "p1"), "submission-terminal");
	expectCode(() => eo.failSubmission(key, "p1"), "submission-terminal");

	// A completed submission reports "completed".
	eo.beginSubmission(key, { submissionId: "c1", payloadDigest: "d" });
	assert.equal(eo.completeSubmission(key, "c1").status, "completed");
	expectCode(() => eo.completeSubmission(key, "c1"), "submission-terminal");

	// A failed submission reports "failed".
	eo.beginSubmission(key, { submissionId: "f1", payloadDigest: "d" });
	assert.equal(eo.failSubmission(key, "f1").status, "failed");
	expectCode(() => eo.failSubmission(key, "f1"), "submission-terminal");

	// Only the matching in-flight submission can transition.
	eo.beginSubmission(key, { submissionId: "x1", payloadDigest: "d" });
	expectCode(() => eo.completeSubmission(key, "nope"), "unknown-submission");
	// Outcome values are validated per method (complete can't claim "failed").
	expectCode(() => eo.completeSubmission(key, "x1", "failed"), "invalid-argument");
	expectCode(() => eo.failSubmission(key, "x1", "partial"), "invalid-argument");
});

// ---------------------------------------------------------------------------
// 6. Route default off — zero side effects
// ---------------------------------------------------------------------------

test("6. dispatchBackgroundTask is off by default and has zero side effects", () => {
	const launcher = fakeLauncher();
	// No routes option at all -> default off; the launcher is never consulted.
	const eo = new ExecutionOwnership({ ports: { launcher } });
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });

	const before = JSON.stringify(eo.snapshot());
	const result = eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { anything: true } });
	assert.deepEqual(result, { dispatched: false, reason: "route-disabled" });

	// No slot, no intent, no submission — the snapshot is byte-identical.
	assert.equal(eo.slotsInUse, 0);
	assert.equal(eo.intentCount, 0);
	assert.equal(launcher.launches.length, 0);
	assert.equal(JSON.stringify(eo.snapshot()), before);

	// Even for otherwise-invalid input the route-off path short-circuits silently.
	assert.deepEqual(eo.dispatchBackgroundTask({}), { dispatched: false, reason: "route-disabled" });
	assert.equal(JSON.stringify(eo.snapshot()), before);
});

// ---------------------------------------------------------------------------
// 7. Route on — happy path, compensation, idempotent replay
// ---------------------------------------------------------------------------

test("7. the enabled route runs the atomic dispatch sequence against the launcher", () => {
	const launcher = fakeLauncher();
	const eo = new ExecutionOwnership({ routes: { backgroundDispatch: true }, ports: { launcher } });
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });

	const result = eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { prompt: "hi" } });
	assert.equal(result.dispatched, true);
	assert.equal(result.replayed, false);
	assert.equal(result.submissionId, "sub:i1");
	assert.equal(result.status, "in-flight");
	assert.equal(result.intent.type, "LaunchIntent");
	assert.equal(result.intent.intentId, "i1");
	assert.equal(result.intent.ownershipKey, key);
	assert.equal(typeof result.intent.payloadDigest, "string");
	assert.ok(result.intent.payloadDigest.length > 0);
	assert.equal(typeof result.intent.createdAt, "number");
	assert.equal(result.intent.status, "launched");
	assert.ok(Object.isFrozen(result.intent));

	// Slot reserved, launcher called exactly once with the intent.
	assert.equal(eo.slotsInUse, 1);
	assert.equal(launcher.launches.length, 1);
	assert.equal(launcher.launches[0].intentId, "i1");

	// The submission was opened and is in flight.
	const status = eo.status(key);
	assert.equal(status.submissions[0].status, "in-flight");
	assert.equal(status.submissions[0].intentId, "i1");

	// Completing releases the slot.
	eo.completeSubmission(key, "sub:i1");
	assert.equal(eo.slotsInUse, 0);

	// An launcher port is required to enable the route.
	expectCode(() => new ExecutionOwnership({ routes: { backgroundDispatch: true } }), "invalid-argument");
});

test("8. a launcher fault is compensated honestly — no ghost success", () => {
	const launcher = fakeLauncher({ failIntentIds: ["boom"] });
	const eo = new ExecutionOwnership({ routes: { backgroundDispatch: true }, ports: { launcher } });
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });

	const result = eo.dispatchBackgroundTask({ key, intentId: "boom", payload: { x: 1 } });
	assert.equal(result.dispatched, false);
	assert.equal(result.reason, "launch-failed");
	assert.equal(result.intent.status, "launch-failed");
	assert.match(result.error.message, /launch fault/);

	// Slot released; the submission is honestly failed, never a ghost success.
	assert.equal(eo.slotsInUse, 0);
	const status = eo.status(key);
	assert.equal(status.submissions[0].status, "failed");
	assert.equal(status.submissions[0].outcome, "launch-failed");

	// Replaying the same intentId returns the ORIGINAL (failed) record and does
	// not re-launch.
	const replay = eo.dispatchBackgroundTask({ key, intentId: "boom", payload: { x: 1 } });
	assert.equal(replay.replayed, true);
	assert.equal(replay.dispatched, false);
	assert.equal(replay.status, "launch-failed");
	assert.equal(launcher.launches.length, 1, "never re-launched");
});

test("9. a repeated intentId is idempotent; a disagreeing intentId conflicts", () => {
	const launcher = fakeLauncher();
	const eo = new ExecutionOwnership({ routes: { backgroundDispatch: true }, ports: { launcher } });
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });

	const first = eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { n: 1 } });
	const second = eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { n: 1 } });
	assert.equal(second.replayed, true);
	assert.equal(second.submissionId, first.submissionId);
	assert.deepEqual(second.intent, first.intent);
	assert.equal(launcher.launches.length, 1, "the intent is launched exactly once");

	// Same intentId, different payload -> conflict (never a silent reuse).
	expectCode(() => eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { n: 2 } }), "intent-conflict");
	// Same intentId, different ownership key -> conflict.
	const otherKey = keyOf({ executionId: "exec-2" });
	eo.registerExecution({ key: otherKey, goalId: "g1", taskId: "t2", grantRef: "gr1" });
	expectCode(() => eo.dispatchBackgroundTask({ key: otherKey, intentId: "i1", payload: { n: 1 } }), "intent-conflict");
	assert.equal(launcher.launches.length, 1);

	// The payload digest is deterministic: the same payload re-derives the same
	// fingerprint on a distinct intent. (Complete the in-flight dispatch first so
	// the single slot is free.)
	eo.completeSubmission(key, "sub:i1");
	const a = eo.dispatchBackgroundTask({ key, intentId: "i2", payload: { z: [1, 2, 3] } });
	eo.completeSubmission(key, a.submissionId);
	const b = eo.dispatchBackgroundTask({ key, intentId: "i3", payload: { z: [1, 2, 3] } });
	assert.equal(a.intent.payloadDigest, b.intent.payloadDigest);
});

// ---------------------------------------------------------------------------
// 8. Precise-scope cancellation
// ---------------------------------------------------------------------------

test("10. cancel covers submission / execution / goal scopes and reports already-terminal", () => {
	const launcher = fakeLauncher();
	const canceller = fakeCanceller();
	const eo = new ExecutionOwnership({
		routes: { backgroundDispatch: true },
		ports: { launcher, canceller },
	});
	const keyG1 = keyOf({ executionId: "exec-1" });
	eo.registerExecution({ key: keyG1, goalId: "goal-A", taskId: "t1", grantRef: "gr1" });

	// submission scope
	eo.beginSubmission(keyG1, { submissionId: "s1", payloadDigest: "d" });
	const fenceBefore = eo.fence(keyG1);
	const submissionResult = eo.cancel({ scope: "submission", key: keyG1, submissionId: "s1" });
	assert.deepEqual(submissionResult, {
		scope: "submission",
		ownershipKey: keyG1,
		submissionId: "s1",
		status: "cancelled",
		fence: fenceBefore + 1,
	});
	assert.equal(canceller.calls.length, 1);
	assert.equal(canceller.calls[0].ownershipKey, keyG1);
	assert.equal(canceller.calls[0].submissionId, "s1");
	// Records are NOT deleted — only a status transition + fence increment.
	assert.equal(eo.status(keyG1).submissions[0].status, "cancelled");
	assert.equal(eo.fence(keyG1), fenceBefore + 1);

	// already-terminal is honest and calls nothing new.
	const again = eo.cancel({ scope: "submission", key: keyG1, submissionId: "s1" });
	assert.equal(again.status, "already-terminal");
	assert.equal(again.fence, fenceBefore + 1, "no fence movement for a terminal target");
	assert.equal(canceller.calls.length, 1);

	// execution scope with no in-flight submission -> already-terminal.
	const execResult = eo.cancel({ scope: "execution", key: keyG1 });
	assert.equal(execResult.scope, "execution");
	assert.equal(execResult.status, "already-terminal");
	assert.equal(canceller.calls.length, 1);

	// goal scope: a per-target result array. Two executions under goal-A, one
	// in-flight (cancelled), one idle (already-terminal).
	const keyG2 = keyOf({ executionId: "exec-2" });
	eo.registerExecution({ key: keyG2, goalId: "goal-A", taskId: "t2", grantRef: "gr1" });
	eo.dispatchBackgroundTask({ key: keyG1, intentId: "dispatch-1", payload: { p: 1 } });
	const goalResults = eo.cancel({ scope: "goal", goalId: "goal-A" });
	assert.ok(Array.isArray(goalResults));
	assert.equal(goalResults.length, 2);
	const cancelled = goalResults.find((r) => r.ownershipKey === keyG1);
	const idle = goalResults.find((r) => r.ownershipKey === keyG2);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(idle.status, "already-terminal");

	// Unknown target / bad scope fail closed.
	expectCode(() => eo.cancel({ scope: "submission", key: keyG1, submissionId: "nope" }), "unknown-submission");
	expectCode(() => eo.cancel({ scope: "execution", key: keyOf({ executionId: "ghost" }) }), "unknown-execution");
	expectCode(() => eo.cancel({ scope: "nonsense", key: keyG1 }), "invalid-argument");
	// A canceller fault is honest: no transition, no fence movement.
	const faulty = fakeCanceller({ failSubmissionIds: ["cs"] });
	const eo2 = new ExecutionOwnership({ ports: { canceller: faulty } });
	const k2 = keyOf({ executionId: "exec-9" });
	eo2.registerExecution({ key: k2, goalId: "goal-B", taskId: "t", grantRef: "gr" });
	eo2.beginSubmission(k2, { submissionId: "cs", payloadDigest: "d" });
	const failedCancel = eo2.cancel({ scope: "submission", key: k2, submissionId: "cs" });
	assert.equal(failedCancel.status, "cancel-failed");
	assert.equal(eo2.status(k2).submissions[0].status, "in-flight", "no false cancellation");
	assert.equal(eo2.fence(k2), 1, "no fence movement on cancel failure");
});

test("11. cancel requires a canceller port", () => {
	const eo = new ExecutionOwnership();
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g", taskId: "t", grantRef: "gr" });
	eo.beginSubmission(key, { submissionId: "s", payloadDigest: "d" });
	expectCode(() => eo.cancel({ scope: "execution", key }), "invalid-argument");
});

// ---------------------------------------------------------------------------
// 9. Crash recovery
// ---------------------------------------------------------------------------

test("12. crash recovery marks in-flight submissions owner-lost, releases slots, never replays", () => {
	const launcher = fakeLauncher();
	const canceller = fakeCanceller();
	const eo = new ExecutionOwnership({
		routes: { backgroundDispatch: true },
		ports: { launcher, canceller },
	});
	const key = keyOf({ executionId: "exec-1" });
	eo.registerExecution({ key, goalId: "goal-A", taskId: "t1", grantRef: "gr1" });
	eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { p: 1 } });
	assert.equal(eo.slotsInUse, 1);
	assert.equal(launcher.launches.length, 1);

	const snapshot = JSON.parse(JSON.stringify(eo.snapshot()));

	// Restore with fresh ports.
	const restored = ExecutionOwnership.fromJSON(snapshot, { launcher, canceller });
	const status = restored.status(key);
	assert.equal(status.submissions[0].status, "owner-lost");
	assert.equal(status.submissions[0].outcome, "owner-lost");
	// Slot released and NOTHING was replayed (launcher count unchanged).
	assert.equal(restored.slotsInUse, 0);
	assert.equal(launcher.launches.length, 1, "recovery never auto-replays");

	// Recovery does not auto-continue: the old execution has no in-flight
	// submission, and the recommended resumption is a NEW cycle / NEW intent.
	const resumedKey = keyOf({ executionId: "exec-1", cycle: 1 });
	restored.registerExecution({ key: resumedKey, goalId: "goal-A", taskId: "t1b", grantRef: "gr1" });
	const resumed = restored.dispatchBackgroundTask({ key: resumedKey, intentId: "i2", payload: { p: 2 } });
	assert.equal(resumed.dispatched, true);
	assert.equal(launcher.launches.length, 2);

	// The restored intent for the lost owner is marked, not silently reused.
	assert.equal(restored.snapshot().intents.find((i) => i.intentId === "i1").status, "owner-lost");
});

test("13. a clean snapshot round-trips to an identical registry", () => {
	const launcher = fakeLauncher();
	const eo = new ExecutionOwnership({ routes: { backgroundDispatch: true }, ports: { launcher } });
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });
	eo.beginSubmission(key, { submissionId: "done", payloadDigest: "d" });
	eo.completeSubmission(key, "done"); // terminal, so recovery changes nothing

	const snapshot = eo.snapshot();
	const restored = ExecutionOwnership.fromJSON(snapshot, { launcher });
	assert.deepEqual(restored.snapshot(), snapshot);
	assert.equal(restored.status(key).submissions[0].status, "completed");
});

// ---------------------------------------------------------------------------
// 10. Fence
// ---------------------------------------------------------------------------

test("14. every transition carries an expectedFence and a stale value is refused", () => {
	const eo = new ExecutionOwnership();
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });
	assert.equal(eo.fence(key), 0);

	// Correct fence advances the state.
	eo.beginSubmission(key, { submissionId: "s1", payloadDigest: "d", expectedFence: 0 });
	assert.equal(eo.fence(key), 1);

	// A stale fence is refused and moves nothing.
	expectCode(() => eo.completeSubmission(key, "s1", "completed", { expectedFence: 0 }), "stale-fence");
	assert.equal(eo.status(key).submissions[0].status, "in-flight", "stale transition did not happen");
	assert.equal(eo.fence(key), 1);

	// The current fence is accepted.
	eo.completeSubmission(key, "s1", "completed", { expectedFence: 1 });
	assert.equal(eo.fence(key), 2);

	// A malformed expectedFence is an argument error, not a silent accept.
	expectCode(() => eo.beginSubmission(key, { submissionId: "s2", payloadDigest: "d", expectedFence: -1 }), "invalid-argument");
	expectCode(() => eo.beginSubmission(key, { submissionId: "s2", payloadDigest: "d", expectedFence: 1.5 }), "invalid-argument");
});

// ---------------------------------------------------------------------------
// 11. Concurrency slots
// ---------------------------------------------------------------------------

test("15. concurrency slots cap simultaneous dispatch and a grant cap cannot be widened", () => {
	const launcher = fakeLauncher();
	const canceller = fakeCanceller();
	const eo = new ExecutionOwnership({ routes: { backgroundDispatch: true }, maxConcurrent: 1, ports: { launcher, canceller } });
	const key1 = keyOf({ executionId: "exec-1" });
	const key2 = keyOf({ executionId: "exec-2" });
	eo.registerExecution({ key: key1, goalId: "g1", taskId: "t1", grantRef: "gr1" });
	eo.registerExecution({ key: key2, goalId: "g1", taskId: "t2", grantRef: "gr1" });

	eo.dispatchBackgroundTask({ key: key1, intentId: "i1", payload: { p: 1 } });
	assert.equal(eo.slotsInUse, 1);

	// The second concurrent dispatch exceeds the slot ceiling, atomically.
	expectCode(() => eo.dispatchBackgroundTask({ key: key2, intentId: "i2", payload: { p: 2 } }), "slot-exhausted");
	assert.equal(eo.slotsInUse, 1);
	assert.equal(eo.intentCount, 1, "the refused dispatch created no intent");

	// Completing the first releases the slot, so the second now fits.
	eo.completeSubmission(key1, "sub:i1");
	assert.equal(eo.slotsInUse, 0);
	const second = eo.dispatchBackgroundTask({ key: key2, intentId: "i2", payload: { p: 2 } });
	assert.equal(second.dispatched, true);
	assert.equal(eo.slotsInUse, 1);

	// Cancelling also releases the slot.
	eo.cancel({ scope: "execution", key: key2 });
	assert.equal(eo.slotsInUse, 0);

	// maxConcurrent > grantConcurrencyCap is refused AT CONSTRUCTION.
	expectCode(() => new ExecutionOwnership({ maxConcurrent: 3, grantConcurrencyCap: 2 }), "concurrency-cap");
	// Within the cap is allowed.
	const ok = new ExecutionOwnership({ maxConcurrent: 2, grantConcurrencyCap: 2 });
	assert.equal(ok.maxConcurrent, 2);
	assert.equal(ok.grantConcurrencyCap, 2);
	// No cap supplied -> uncapped-by-host, still bounded by maxConcurrent.
	const uncapped = new ExecutionOwnership({ maxConcurrent: 4 });
	assert.equal(uncapped.grantConcurrencyCap, null);
});

// ---------------------------------------------------------------------------
// 12. Snapshot determinism + corruption rejection
// ---------------------------------------------------------------------------

test("16. snapshot is deterministic and every corrupt snapshot is refused", () => {
	const launcher = fakeLauncher();
	const canceller = fakeCanceller();
	const eo = new ExecutionOwnership({ routes: { backgroundDispatch: true }, ports: { launcher, canceller } });
	const key = keyOf();
	eo.registerExecution({ key, goalId: "g1", taskId: "t1", grantRef: "gr1" });
	eo.beginSubmission(key, { submissionId: "s1", payloadDigest: "d" });
	eo.completeSubmission(key, "s1");
	eo.dispatchBackgroundTask({ key, intentId: "i1", payload: { p: 1 } });

	// Deterministic: identical structure twice, and JSON-clean.
	const a = eo.snapshot();
	const b = eo.snapshot();
	assert.deepEqual(a, b);
	assert.deepEqual(JSON.parse(JSON.stringify(a)), a);

	const snapshot = JSON.parse(JSON.stringify(a));
	const tampers = [
		(snap) => { snap.type = "SomethingElse"; },
		(snap) => { snap.version = 2; },
		(snap) => { snap.executions = "nope"; },
		(snap) => { snap.intents = null; },
		(snap) => { snap.executions[0].fence = -1; },
		(snap) => { snap.executions[0].key = "not-a-key"; },
		(snap) => { snap.executions[0].submissions[0].status = "weird"; },
		(snap) => { snap.executions[0].submissions[0].outcome = "cancelled"; }, // completed != cancelled
		(snap) => { snap.executions[0].submissions[0].ownershipKey = keyOf({ executionId: "elsewhere" }); },
		(snap) => { snap.executions.push({ ...snap.executions[0] }); }, // duplicate key
		(snap) => { snap.executions[0].submissions.push({ ...snap.executions[0].submissions[0] }); }, // duplicate submissionId
		(snap) => { snap.intents[0].ownershipKey = keyOf({ executionId: "ghost" }); }, // intent with no execution
		(snap) => { snap.intents[0].status = "flying"; },
		(snap) => { snap.slotsInUse = -1; },
	];
	for (const tamper of tampers) {
		const copy = JSON.parse(JSON.stringify(snapshot));
		tamper(copy);
		expectCode(() => ExecutionOwnership.fromJSON(copy, { launcher, canceller }), "invalid-state");
	}
	expectCode(() => ExecutionOwnership.fromJSON(null), "invalid-state");
	expectCode(() => ExecutionOwnership.fromJSON("not json"), "invalid-state");
	expectCode(() => ExecutionOwnership.fromJSON({ type: "ExecutionOwnership", version: 1 }), "invalid-state");
});
