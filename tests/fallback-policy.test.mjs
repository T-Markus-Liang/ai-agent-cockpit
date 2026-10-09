// Tests for runtime/fallback-policy.mjs (M02/I03b fourth slice).
//
// Pure-module tests: a synthetic injected clock, no network, no file reads, no
// side effects, no real provider. They pin the V39 fallback-policy contract —
// bounded fallback (MAX 1 automatic attempt, no retry storm), a unified
// side-effect barrier (a fallback needs BOTH `hasProducedMessage` and
// `hasUsedTools` strictly `false` for EVERY degradable kind; a missing/unknown
// flag is refused), context provenance preserved by a strict JSON deep clone and
// deep freeze (non-JSON input is rejected, never dropped), and every decision
// names refs only (no secret).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFallbackPolicy, FallbackError, MAX_AUTOMATIC_ATTEMPTS, classifyLaunchFailure } from "../runtime/fallback-policy.mjs";

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

	assert.deepEqual(policy.classifyFailure({ kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }), { eligible: true, reason: "startup-failure" });

	const result = policy.nextAttempt("user-1", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false });
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

	assert.deepEqual(policy.classifyFailure({ kind: "rate_limit", hasProducedMessage: false, hasUsedTools: false }), { eligible: true, reason: "rate-limited" });
	const limited = policy.nextAttempt("rl", { kind: "rate_limit", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(limited.action, "fallback");
	assert.equal(limited.reason, "rate-limited");
	assert.equal(limited.attempt, 1);

	assert.deepEqual(policy.classifyFailure({ kind: "protocol_error", hasProducedMessage: false, hasUsedTools: false }), { eligible: true, reason: "protocol-failure" });
	const protocol = policy.nextAttempt("proto", { kind: "protocol_error", hasProducedMessage: false, hasUsedTools: false });
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

	const first = policy.nextAttempt("bounded", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(first.action, "fallback");
	assert.equal(first.attempt, 1);

	// Even a fresh, clean, eligible failure is refused the second time — the
	// retry is bounded to ONE automatic attempt. Reported as a plain stop, never
	// thrown, never a storm.
	const second = policy.nextAttempt("bounded", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(second.action, "stop");
	assert.equal(second.reason, "fallback-exhausted");
	assert.ok(!("candidate" in second), "a stop carries no candidate");

	// A chain with no fallback candidate also exhausts immediately.
	const solo = createFallbackPolicy({ chain: [CHAIN[0]], now: clock.now });
	const only = solo.nextAttempt("solo", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(only.action, "stop");
	assert.equal(only.reason, "fallback-exhausted");
});

test("8. reset re-arms exactly one attempt; different scopeKeys are counted independently", () => {
	const clock = fixedClock();
	const policy = createFallbackPolicy({ chain: CHAIN, now: clock.now });

	assert.equal(policy.nextAttempt("a", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }).action, "fallback");
	assert.equal(policy.nextAttempt("a", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }).action, "stop");
	policy.reset("a"); // a new user-request cycle begins
	const rearmed = policy.nextAttempt("a", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(rearmed.action, "fallback");
	assert.equal(rearmed.attempt, 1, "counting restarts at 1 after reset");

	// Scope b was never touched and is unaffected by a's history or reset.
	const b = policy.nextAttempt("b", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false });
	assert.equal(b.action, "fallback");
	assert.equal(b.attempt, 1);
	// Resetting an unknown scope is a harmless no-op.
	policy.reset("never-seen");
	assert.equal(policy.nextAttempt("c", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }).action, "fallback");
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
	policy.nextAttempt("a", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }); // fallback
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
	assert.equal(restored.nextAttempt("a", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }).reason, "fallback-exhausted");
	assert.equal(restored.nextAttempt("b", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }).action, "fallback", "scope b still has its one attempt");

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
			policy.nextAttempt("s", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }),
			policy.nextAttempt("s", { kind: "rate_limit", hasProducedMessage: false, hasUsedTools: false }),
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
	assert.equal(policy.nextAttempt("z", { kind: "startup_error", hasProducedMessage: false, hasUsedTools: false }).candidate.provider, "kimi");
});

test("13. side-effect barrier: every degradable kind needs BOTH flags strictly false", () => {
	const policy = createFallbackPolicy({ chain: CHAIN, now: () => 1 });
	const clean = { hasProducedMessage: false, hasUsedTools: false };
	const notCleanCases = [
		{ hasProducedMessage: true, hasUsedTools: false },
		{ hasProducedMessage: false, hasUsedTools: true },
		{ hasProducedMessage: true, hasUsedTools: true },
		{}, // both flags missing -> unknown -> refuse
		{ hasProducedMessage: undefined, hasUsedTools: undefined },
		{ hasProducedMessage: false }, // one flag missing -> not proven clean
		{ hasUsedTools: false },
		{ hasProducedMessage: 0, hasUsedTools: 0 }, // only the strict `false` proves clean
		{ hasProducedMessage: null, hasUsedTools: null },
		{ hasProducedMessage: "false", hasUsedTools: "false" },
	];
	const cleanReason = {
		startup_error: "startup-failure",
		timeout: "timeout-clean",
		protocol_error: "protocol-failure",
		rate_limit: "rate-limited",
	};
	for (const kind of Object.keys(cleanReason)) {
		assert.deepEqual(policy.classifyFailure({ kind, ...clean }), { eligible: true, reason: cleanReason[kind] }, `${kind} clean is eligible`);
		let i = 0;
		for (const flags of notCleanCases) {
			const reason = kind === "timeout" ? "timeout-dirty" : "unclean-side-effects";
			const failure = { kind, ...flags };
			assert.deepEqual(policy.classifyFailure(failure), { eligible: false, reason }, `${kind} not proven clean -> ${reason}`);
			const stop = policy.nextAttempt(`barrier-${kind}-${i++}`, failure);
			assert.equal(stop.action, "stop", `${kind} not proven clean never authorizes a candidate`);
			assert.equal(stop.reason, reason);
			assert.ok(!("candidate" in stop), "a refused fallback carries no candidate");
		}
	}
	// No refused failure ever consumed the one automatic attempt.
	assert.equal(policy.toJSON().scopes.length, 0, "dirty/unknown paths consume no attempt budget");
});

test("14. audit repro flipped: a dirty protocol/rate_limit/startup and a flag-less protocol_error never fall back", () => {
	const policy = createFallbackPolicy({ chain: CHAIN, now: () => 100 });
	const dirty = { hasProducedMessage: true, hasUsedTools: true };
	for (const kind of ["protocol_error", "rate_limit", "startup_error"]) {
		assert.deepEqual(policy.classifyFailure({ kind, ...dirty }), { eligible: false, reason: "unclean-side-effects" });
		const stop = policy.nextAttempt(`dirty-${kind}`, { kind, ...dirty });
		assert.equal(stop.action, "stop");
		assert.equal(stop.reason, "unclean-side-effects");
		assert.ok(!("candidate" in stop), "a failure that already produced a message/used tools gets no candidate");
	}
	// protocol_error with BOTH flags absent (the r1 miss) is refused as well.
	assert.deepEqual(policy.classifyFailure({ kind: "protocol_error" }), { eligible: false, reason: "unclean-side-effects" });
	assert.deepEqual(policy.nextAttempt("missing-proto", { kind: "protocol_error" }), { action: "stop", reason: "unclean-side-effects" });
});

test("15. auth_error and mid-tool/unknown results are refused regardless of the side-effect flags", () => {
	const policy = createFallbackPolicy({ chain: CHAIN, now: () => 1 });
	for (const flags of [{}, { hasProducedMessage: false, hasUsedTools: false }, { hasProducedMessage: true, hasUsedTools: true }]) {
		assert.deepEqual(policy.classifyFailure({ kind: "auth_error", ...flags }), { eligible: false, reason: "auth-failure" });
	}
	// A clean-LOOKING mid_generation_failure / unknown is still uncertain: a
	// same-named error can land mid tool-loop, so flags alone never rescue it.
	for (const kind of ["mid_generation_failure", "unknown", "some_future_kind"]) {
		assert.deepEqual(policy.classifyFailure({ kind, hasProducedMessage: false, hasUsedTools: false }), { eligible: false, reason: "uncertain-side-effects" });
	}
	assert.equal(policy.toJSON().scopes.length, 0, "no attempt spent by a refused failure");
});

test("16. buildFallbackContext rejects every non-JSON value instead of silently dropping it", () => {
	const policy = createFallbackPolicy({ chain: CHAIN, now: () => 1 });
	const refs = { fromRef: CHAIN[0].ref, toRef: CHAIN[1].ref, attempt: 1 };
	const badValues = [
		["Date", new Date(1234)],
		["Map", new Map([["a", 1]])],
		["Set", new Set([1])],
		["custom-prototype", Object.create({ inherited: 1 })],
		["undefined", undefined],
		["NaN", Number.NaN],
		["Infinity", Infinity],
		["-Infinity", -Infinity],
		["function", () => 1],
		["symbol", Symbol("s")],
		["bigint", 10n],
	];
	for (const [, value] of badValues) {
		// The unsupported value is refused whether nested in an object or an array.
		expectCode(() => policy.buildFallbackContext({ originalContext: { persona: "p", nested: { value } }, ...refs }), "invalid-state");
		expectCode(() => policy.buildFallbackContext({ originalContext: { persona: "p", list: [value] }, ...refs }), "invalid-state");
	}
	// The r1 repro: a Date source time is refused, never silently turned into `{}`.
	expectCode(() => policy.buildFallbackContext({ originalContext: { turns: [{ text: "x" }], sourceTime: new Date(1234) }, ...refs }), "invalid-state");
	// A non-plain TOP-LEVEL context is refused too (not just nested values).
	expectCode(() => policy.buildFallbackContext({ originalContext: new Date(1234), ...refs }), "invalid-state");
});

test("17. buildFallbackContext blocks reserved keys, symbol-keyed and non-enumerable properties", () => {
	const policy = createFallbackPolicy({ chain: CHAIN, now: () => 1 });
	const refs = { fromRef: CHAIN[0].ref, toRef: CHAIN[1].ref, attempt: 1 };
	for (const key of ["__proto__", "constructor", "prototype"]) {
		const context = JSON.parse(`{"persona":"p","${key}":"boom"}`);
		expectCode(() => policy.buildFallbackContext({ originalContext: context, ...refs }), "invalid-state");
	}
	const withSymbol = { persona: "p", [Symbol("s")]: 1 };
	expectCode(() => policy.buildFallbackContext({ originalContext: withSymbol, ...refs }), "invalid-state");
	const nonEnumerable = { persona: "p" };
	Object.defineProperty(nonEnumerable, "hidden", { value: 1, enumerable: false });
	expectCode(() => policy.buildFallbackContext({ originalContext: nonEnumerable, ...refs }), "invalid-state");
	const sparse = [1, , 3];
	expectCode(() => policy.buildFallbackContext({ originalContext: { persona: "p", sparse }, ...refs }), "invalid-state");
	// Nothing ever leaked onto the global Object prototype.
	assert.equal(Object.prototype.polluted, undefined);
});

test("18. buildFallbackContext deep-clones and deep-freezes the whole output; the input is untouched", () => {
	const policy = createFallbackPolicy({ chain: CHAIN, now: () => 777 });
	const original = {
		persona: "comrade",
		turns: [{ role: "user", text: "早上好" }, { role: "assistant", text: "早" }],
		facts: ["a", "b"],
		nested: { deep: { list: [1, 2, { x: 3 }] } },
	};
	const snapshot = JSON.stringify(original);
	const context = policy.buildFallbackContext({ originalContext: original, fromRef: CHAIN[0].ref, toRef: CHAIN[1].ref, attempt: 1 });

	// Provenance marker accurate and frozen.
	assert.deepEqual(context.fallback, { from: CHAIN[0].ref, to: CHAIN[1].ref, attempt: 1, at: 777 });
	assert.ok(Object.isFrozen(context.fallback));
	// Every level of the output is frozen — nothing can drift between candidate switches.
	assert.ok(Object.isFrozen(context));
	assert.ok(Object.isFrozen(context.turns));
	assert.ok(Object.isFrozen(context.turns[0]));
	assert.ok(Object.isFrozen(context.nested.deep.list));
	assert.ok(Object.isFrozen(context.nested.deep.list[2]));
	assert.throws(() => { context.turns[0].text = "late edit"; }, TypeError);
	assert.throws(() => { context.nested.deep.list.push(9); }, TypeError);
	// Building the context never modified the caller's input...
	assert.equal(JSON.stringify(original), snapshot, "input is never modified");
	// ...and mutating the input afterwards cannot reach the frozen copy.
	original.turns[0].text = "changed";
	original.nested.deep.list[2].x = 99;
	assert.equal(context.turns[0].text, "早上好");
	assert.equal(context.nested.deep.list[2].x, 3);
	// A null-prototype object is a valid plain JSON object and is accepted.
	const nullProto = Object.create(null);
	nullProto.persona = "p";
	const fromNull = policy.buildFallbackContext({ originalContext: nullProto, fromRef: CHAIN[0].ref, toRef: CHAIN[1].ref, attempt: 1 });
	assert.equal(fromNull.persona, "p");
	assert.ok(Object.isFrozen(fromNull));
});

test("19. S03a launch gate: classifyLaunchFailure covers every branch (touched barrier dominates)", () => {
	// POSITIVE — the three degradable launch kinds advance ONLY on the explicit
	// clean proof (providerSessionTouched === false).
	assert.deepEqual(classifyLaunchFailure({ kind: "spawn-not-found", providerSessionTouched: false }), { advance: true, reason: "spawn-not-found" });
	assert.deepEqual(classifyLaunchFailure({ kind: "startup-exit", providerSessionTouched: false }), { advance: true, reason: "startup-exit-clean" });
	assert.deepEqual(classifyLaunchFailure({ kind: "startup-timeout", providerSessionTouched: false }), { advance: true, reason: "startup-timeout-clean" });

	// NEGATIVE — the unknown-launch-effect barrier runs FIRST for every kind,
	// even a degradable one: true / undefined / missing / non-false all refuse.
	for (const touched of [true, undefined, null, 0, 1, "false"]) {
		assert.deepEqual(classifyLaunchFailure({ kind: "spawn-not-found", providerSessionTouched: touched }), { advance: false, reason: "unknown-launch-effect" });
		assert.deepEqual(classifyLaunchFailure({ kind: "startup-exit", providerSessionTouched: touched }), { advance: false, reason: "unknown-launch-effect" });
		assert.deepEqual(classifyLaunchFailure({ kind: "startup-timeout", providerSessionTouched: touched }), { advance: false, reason: "unknown-launch-effect" });
		assert.deepEqual(classifyLaunchFailure({ kind: "aborted", providerSessionTouched: touched }), { advance: false, reason: "unknown-launch-effect" });
	}
	assert.deepEqual(classifyLaunchFailure({ kind: "spawn-not-found" }), { advance: false, reason: "unknown-launch-effect" });
	assert.deepEqual(classifyLaunchFailure({}), { advance: false, reason: "unknown-launch-effect" });

	// NEGATIVE — proven-clean stop kinds: a user abort, an auth failure, a
	// permission error and an uncertain cleanup never advance (the remediation
	// §5.3 rule: auth, unknown launch effect and permission errors are never
	// retried on another harness "because no prompt was sent yet").
	assert.deepEqual(classifyLaunchFailure({ kind: "aborted", providerSessionTouched: false }), { advance: false, reason: "launch-aborted" });
	assert.deepEqual(classifyLaunchFailure({ kind: "auth_error", providerSessionTouched: false }), { advance: false, reason: "auth-failure" });
	assert.deepEqual(classifyLaunchFailure({ kind: "spawn-permission", providerSessionTouched: false }), { advance: false, reason: "permission-denied" });
	assert.deepEqual(classifyLaunchFailure({ kind: "cleanup-uncertain", providerSessionTouched: false }), { advance: false, reason: "cleanup-uncertain" });

	// NEGATIVE — everything unrecognized stops fail-closed: launch-error,
	// initialize/JSON-RPC failures, spawn-error, unknown strings, missing or
	// non-string kinds (an unstructured plain Error carries no kind at all).
	for (const kind of ["launch-error", "initialize-error", "spawn-error", "unknown", "startup_error", "timeout", "", "some_future_kind", undefined, null, 42, {}, true]) {
		assert.deepEqual(classifyLaunchFailure({ kind, providerSessionTouched: false }), { advance: false, reason: "uncertain-side-effects" }, `kind=${String(kind)}`);
	}

	// NEGATIVE — malformed input (not a plain object) fails closed as an
	// unknown launch effect.
	for (const malformed of [undefined, null, 42, "kind", [], true]) {
		assert.deepEqual(classifyLaunchFailure(malformed), { advance: false, reason: "unknown-launch-effect" });
	}

	// The verdict is frozen, and deciding never leaks a secret-bearing input.
	const secretTouched = { kind: "spawn-not-found", providerSessionTouched: false, token: FAKE_SECRET };
	const verdict = classifyLaunchFailure(secretTouched);
	assert.ok(Object.isFrozen(verdict));
	assert.equal(JSON.stringify(verdict).includes(FAKE_SECRET), false);
});
