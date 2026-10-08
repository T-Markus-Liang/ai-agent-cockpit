// Tests for runtime/fallback-policy.mjs (M02/I03b fourth slice).
//
// Pure-module tests: a synthetic injected clock, no network, no file reads, no
// side effects, no real provider. They pin the V39 fallback-policy contract —
// bounded fallback (MAX 1 automatic attempt, no retry storm), uncertain
// side effects are never replayed on another engine, context provenance is
// preserved and never dropped, and every decision names refs only (no secret).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFallbackPolicy, FallbackError, MAX_AUTOMATIC_ATTEMPTS } from "../runtime/fallback-policy.mjs";

/** A fake secret used to prove no decision path ever carries a credential value. */
const FAKE_SECRET = "sk-FALLBACK-TEST-DO-NOT-LEAK-0123456789abcdef";

const CHAIN = [
	{ ref: "openai/gpt-4o", provider: "openai", modelId: "gpt-4o" },
	{ ref: "kimi/kimi-k2", provider: "kimi", modelId: "kimi-k2" },
	{ ref: "local/llama", provider: "local", modelId: "llama" },
];

/** Deterministic clock; tests move time explicitly. */
function fixedClock(start = 1_700_000_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms) => { t += ms; },
		set: (value) => { t = value; },
	};
}

/** Assert `fn` throws a FallbackError carrying exactly `code`. */
function expectCode(fn, code) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof FallbackError, `expected FallbackError, got ${error}`);
		assert.equal(error.code, code);
		return true;
	}, `expected FallbackError("${code}")`);
}

test("1. chain validation: empty, malformed elements and duplicate refs are invalid-chain", () => {
	const base = { ref: "openai/gpt-4o", provider: "openai", modelId: "gpt-4o" };
	const invalid = [
		undefined, // missing chain
		[], // empty array
		"openai/gpt-4o", // not an array
		[{ provider: "openai", modelId: "gpt-4o" }], // missing ref
		[{ ref: 42, provider: "openai", modelId: "gpt-4o" }], // non-string ref
		[{ ref: "not-a-reference", provider: "openai", modelId: "gpt-4o" }], // no slash
		[{ ref: "openai/", provider: "openai", modelId: "gpt-4o" }], // empty model half
		[{ ref: "openai/gpt-4o", modelId: "gpt-4o" }], // missing provider
		[{ ref: "openai/gpt-4o", provider: "", modelId: "gpt-4o" }], // empty provider
		[{ ref: "openai/gpt-4o", provider: "openai" }], // missing modelId
		[{ ref: "openai/gpt-4o", provider: "openai", modelId: "" }], // empty modelId
		[base, { ...base }], // duplicate ref
		["nope"], // element not an object
	];
	for (const chain of invalid) {
		expectCode(() => createFallbackPolicy({ chain }), "invalid-chain");
	}
	// A well-formed chain constructs cleanly.
	const policy = createFallbackPolicy({ chain: CHAIN });
	assert.equal(policy.chain.length, 3);
	assert.equal(MAX_AUTOMATIC_ATTEMPTS, 1);
});

test("2. startup_error is eligible and falls back to the second candidate, attempt 1", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	assert.deepEqual(policy.classifyFailure({ kind: "startup_error" }), { eligible: true, reason: "startup-failure" });

	const result = policy.nextAttempt("user-1", { kind: "startup_error" });
	assert.equal(result.action, "fallback");
	assert.equal(result.attempt, 1);
	assert.equal(result.reason, "startup-failure");
	assert.equal(result.candidate.ref, "kimi/kimi-k2", "the next candidate after the primary");
	assert.equal(result.candidate.provider, "kimi");
	assert.equal(result.candidate.modelId, "kimi-k2");
	assert.ok(Object.isFrozen(result), "decision result is frozen");
	assert.ok(Object.isFrozen(result.candidate), "candidate is frozen");
});

test("3. only a CLEAN timeout is eligible; a dirty timeout stops with timeout-dirty", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	assert.deepEqual(
		policy.classifyFailure({ kind: "timeout", hasProducedMessage: false, hasUsedTools: false }),
		{ eligible: true, reason: "timeout-clean" },
	);
	const clean = policy.nextAttempt("clean", { kind: "timeout", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(clean.action, "fallback");
	assert.equal(clean.reason, "timeout-clean");

	// Any flag true (or absent — strict `=== false`) is dirty: side effects are
	// uncertain, so the prompt is never replayed on another engine.
	const dirtyCases = [
		{ kind: "timeout", hasProducedMessage: false, hasUsedTools: true },
		{ kind: "timeout", hasProducedMessage: true, hasUsedTools: false },
		{ kind: "timeout", hasProducedMessage: true, hasUsedTools: true },
		{ kind: "timeout" }, // flags absent -> not proven clean
	];
	let i = 0;
	for (const failure of dirtyCases) {
		assert.deepEqual(policy.classifyFailure(failure), { eligible: false, reason: "timeout-dirty" });
		const stop = policy.nextAttempt(`dirty-${i++}`, failure);
		assert.equal(stop.action, "stop");
		assert.equal(stop.reason, "timeout-dirty");
	}
});

test("4. auth_error is NOT eligible and never retried (no retry storm, no credential guessing)", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	assert.deepEqual(policy.classifyFailure({ kind: "auth_error" }), { eligible: false, reason: "auth-failure" });
	const stop = policy.nextAttempt("user-auth", { kind: "auth_error" });
	assert.equal(stop.action, "stop");
	assert.equal(stop.reason, "auth-failure");
	// The one automatic attempt was never consumed by the auth failure.
	assert.equal(policy.toJSON().scopes.length, 0, "no attempt spent on an auth failure");
});

test("5. rate_limit and protocol_error are eligible fallbacks", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	assert.deepEqual(policy.classifyFailure({ kind: "rate_limit" }), { eligible: true, reason: "rate-limited" });
	const limited = policy.nextAttempt("rl", { kind: "rate_limit" });
	assert.equal(limited.action, "fallback");
	assert.equal(limited.reason, "rate-limited");
	assert.equal(limited.attempt, 1);

	assert.deepEqual(policy.classifyFailure({ kind: "protocol_error" }), { eligible: true, reason: "protocol-failure" });
	const protocol = policy.nextAttempt("proto", { kind: "protocol_error" });
	assert.equal(protocol.action, "fallback");
	assert.equal(protocol.reason, "protocol-failure");
});

test("6. mid_generation_failure / unknown / unrecognized kinds are uncertain-side-effects stops", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	const uncertain = ["mid_generation_failure", "unknown", "some_future_kind"];
	for (const kind of uncertain) {
		assert.deepEqual(policy.classifyFailure({ kind }), { eligible: false, reason: "uncertain-side-effects" }, `kind=${kind}`);
		const stop = policy.nextAttempt(`u-${kind}`, { kind });
		assert.equal(stop.action, "stop");
		assert.equal(stop.reason, "uncertain-side-effects");
	}
	// A wholly unparseable failure also fails closed rather than retrying.
	assert.deepEqual(policy.classifyFailure(undefined), { eligible: false, reason: "uncertain-side-effects" });
});

test("7. bounded: a second eligible request for the same scope stops with fallback-exhausted", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	const first = policy.nextAttempt("bounded", { kind: "startup_error" });
	assert.equal(first.action, "fallback");
	assert.equal(first.attempt, 1);

	// Even a fresh, clean, eligible failure is refused the second time — the
	// retry is bounded to ONE automatic attempt. Reported as a plain stop, never
	// thrown, never a storm.
	const second = policy.nextAttempt("bounded", { kind: "startup_error" });
	assert.equal(second.action, "stop");
	assert.equal(second.reason, "fallback-exhausted");
	assert.ok(!("candidate" in second), "a stop carries no candidate");

	// A chain with no fallback candidate also exhausts immediately.
	const solo = createFallbackPolicy({ chain: [CHAIN[0]], now: clock.now });
	const only = solo.nextAttempt("solo", { kind: "startup_error" });
	assert.equal(only.action, "stop");
	assert.equal(only.reason, "fallback-exhausted");
});

test("8. reset re-arms exactly one attempt; different scopeKeys are counted independently", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	assert.equal(policy.nextAttempt("a", { kind: "startup_error" }).action, "fallback");
	assert.equal(policy.nextAttempt("a", { kind: "startup_error" }).action, "stop");
	policy.reset("a"); // a new user-request cycle begins
	const rearmed = policy.nextAttempt("a", { kind: "startup_error" });
	assert.equal(rearmed.action, "fallback");
	assert.equal(rearmed.attempt, 1, "counting restarts at 1 after reset");

	// Scope b was never touched and is unaffected by a's history or reset.
	const b = policy.nextAttempt("b", { kind: "startup_error" });
	assert.equal(b.action, "fallback");
	assert.equal(b.attempt, 1);
	// Resetting an unknown scope is a harmless no-op.
	policy.reset("never-seen");
	assert.equal(policy.nextAttempt("c", { kind: "startup_error" }).action, "fallback");
});

test("9. buildFallbackContext preserves every original key and adds the provenance marker", () => {
	const clock = fixedClock(999);
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });
	const original = {
		persona: "comrade",
		turns: [{ role: "user", text: "早上好" }, { role: "assistant", text: "早" }],
		facts: ["lives-in-shanghai", "prefers-tea"],
		nested: { a: 1, b: [2, 3] },
	};

	const context = policy.buildFallbackContext({
		originalContext: original,
		fromRef: "openai/gpt-4o",
		toRef: "kimi/kimi-k2",
		attempt: 1,
	});

	// Every original key survives, deep-equal.
	assert.deepEqual(context.persona, "comrade");
	assert.deepEqual(context.turns, original.turns);
	assert.deepEqual(context.facts, original.facts);
	assert.deepEqual(context.nested, original.nested);
	assert.deepEqual(
		Object.keys(context).sort(),
		[...Object.keys(original), "fallback"].sort(),
		"no original key dropped, only `fallback` added",
	);
	// The provenance marker is accurate and time-stamped from the injected clock.
	assert.deepEqual(context.fallback, { from: "openai/gpt-4o", to: "kimi/kimi-k2", attempt: 1, at: 999 });
	assert.ok(Object.isFrozen(context), "context is frozen");
	// It is a deep copy: mutating the source afterwards does not touch the output.
	original.turns[0].text = "changed";
	original.nested.b.push(99);
	assert.equal(context.turns[0].text, "早上好");
	assert.deepEqual(context.nested.b, [2, 3]);
	// ...and the frozen output cannot be mutated in place.
	assert.throws(() => { context.persona = "attacker"; }, TypeError);

	// Refs must belong to the chain.
	expectCode(() => policy.buildFallbackContext({ originalContext: original, fromRef: "ghost/ghost", toRef: "kimi/kimi-k2", attempt: 1 }), "invalid-chain");
	expectCode(() => policy.buildFallbackContext({ originalContext: original, fromRef: "openai/gpt-4o", toRef: "ghost/ghost", attempt: 1 }), "invalid-chain");
});

test("10. decision log names refs/reasons only and survives a toJSON/fromJSON round-trip", () => {
	const clock = fixedClock(1234);
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });
	policy.nextAttempt("a", { kind: "startup_error" }); // fallback
	policy.nextAttempt("a", { kind: "timeout", hasUsedTools: true, credential: FAKE_SECRET }); // stop timeout-dirty
	policy.nextAttempt("b", { kind: "auth_error" }); // stop auth-failure

	const log = policy.decisions();
	assert.equal(log.length, 3);
	assert.ok(Object.isFrozen(log), "decisions() is a frozen copy");
	const requiredFields = ["at", "attempt", "fromRef", "outcome", "reason", "scopeKey"];
	for (const entry of log) {
		const keys = Object.keys(entry);
		assert.ok(requiredFields.every((field) => keys.includes(field)), "every required field is present");
		assert.ok(keys.every((field) => field === "toRef" || requiredFields.includes(field)), "no unexpected field sneaks in");
		// toRef appears only on a fallback decision, and is a ref name.
		if (entry.outcome === "fallback") assert.ok(keys.includes("toRef"), "a fallback decision carries toRef");
		else assert.ok(!keys.includes("toRef"), "a stop decision omits toRef");
	}
	assert.deepEqual(log[0], { scopeKey: "a", fromRef: "openai/gpt-4o", toRef: "kimi/kimi-k2", attempt: 1, outcome: "fallback", reason: "startup-failure", at: 1234 });
	assert.deepEqual(log[1], { scopeKey: "a", fromRef: "kimi/kimi-k2", attempt: 1, outcome: "stop", reason: "timeout-dirty", at: 1234 });
	assert.deepEqual(log[2], { scopeKey: "b", fromRef: "openai/gpt-4o", attempt: 0, outcome: "stop", reason: "auth-failure", at: 1234 });

	// Hygiene: the injected secret (carried on the failure object) never leaks.
	assert.ok(!JSON.stringify(log).includes(FAKE_SECRET), "no secret in the decision log");
	assert.ok(!JSON.stringify(policy.toJSON()).includes(FAKE_SECRET), "no secret in the snapshot");

	// Round-trip: attempts and log are byte-for-byte identical afterwards.
	const clone = JSON.parse(JSON.stringify(policy.toJSON()));
	const restored = createFallbackPolicy({ chain: CHAIN, now: clock.now });
	restored.fromJSON(clone);
	assert.deepEqual(restored.decisions(), log, "decision log survives round-trip");
	assert.deepEqual(restored.toJSON(), policy.toJSON(), "snapshot is stable across round-trip");
	// The restored counters keep the bound: scope a already spent its attempt.
	assert.equal(restored.nextAttempt("a", { kind: "startup_error" }).reason, "fallback-exhausted");
	assert.equal(restored.nextAttempt("b", { kind: "startup_error" }).action, "fallback", "scope b still has its one attempt");

	// fromJSON validates fully and fails closed.
	const tamperCases = [
		{ ...clone, version: 2 },
		{ ...clone, chain: [{ ref: "evil/evil", provider: "evil", modelId: "evil" }] },
		{ ...clone, scopes: [{ scopeKey: "a", attemptsUsed: 5 }] },
		{ ...clone, scopes: [{ scopeKey: "a", attemptsUsed: 1 }, { scopeKey: "a", attemptsUsed: 1 }] },
		{ ...clone, decisions: [{ scopeKey: "a", fromRef: "openai/gpt-4o", attempt: 1, outcome: "fallback", reason: "startup-failure", at: 1 }] }, // fallback without toRef
		{ ...clone, decisions: [{ scopeKey: "a", fromRef: "openai/gpt-4o", toRef: "kimi/kimi-k2", attempt: 1, outcome: "nope", reason: "startup-failure", at: 1 }] },
	];
	for (const bad of tamperCases) {
		expectCode(() => createFallbackPolicy({ chain: CHAIN, now: clock.now }).fromJSON(bad), "invalid-state");
	}
});

test("11. deterministic: the same input sequence yields deeply equal output", () => {
	const run = () => {
		const policy = createFallbackPolicy({ chain: CHAIN, now: () => 4242 });
		const output = [
			policy.classifyFailure({ kind: "timeout", hasProducedMessage: false, hasUsedTools: false }),
			policy.nextAttempt("s", { kind: "startup_error" }),
			policy.nextAttempt("s", { kind: "rate_limit" }),
			policy.nextAttempt("t", { kind: "mid_generation_failure" }),
			policy.buildFallbackContext({ originalContext: { persona: "p" }, fromRef: "openai/gpt-4o", toRef: "kimi/kimi-k2", attempt: 1 }),
		];
		return { output, log: policy.decisions(), snapshot: policy.toJSON() };
	};
	assert.deepEqual(run(), run());
	assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

test("12. the configured chain is deep-frozen in place (no later mutation possible)", () => {
	const chain = [
		{ ref: "openai/gpt-4o", provider: "openai", modelId: "gpt-4o" },
		{ ref: "kimi/kimi-k2", provider: "kimi", modelId: "kimi-k2" },
	];
	const policy = createFallbackPolicy({ chain, now: () => 1 });
	assert.ok(Object.isFrozen(chain), "chain frozen in place");
	assert.ok(Object.isFrozen(chain[0]), "candidate frozen in place");
	assert.throws(() => { chain[0].provider = "attacker"; }, TypeError);
	assert.throws(() => { chain.push({ ref: "evil/evil", provider: "evil", modelId: "evil" }); }, TypeError);
	// The frozen candidate chain still resolves to the original provider.
	assert.equal(policy.nextAttempt("z", { kind: "startup_error" }).candidate.provider, "kimi");
});
