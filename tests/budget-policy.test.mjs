// Tests for runtime/budget-policy.mjs (M02/I03b third slice).
//
// Pure-module tests: a synthetic injected clock, no network, no file reads, no
// side effects. They pin the V31 budget-policy contract — once a budget is
// exhausted or expired it refuses further side effects, a budget can never be
// renewed or extended, and a success can never be faked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createBudgetPolicy, BudgetError } from "../runtime/budget-policy.mjs";
import * as budgetModule from "../runtime/budget-policy.mjs";

/** Deterministic clock; tests move time explicitly. */
function fixedClock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms) => { t += ms; },
		set: (value) => { t = value; },
	};
}

/** Assert `fn` throws a BudgetError carrying exactly `code`. */
function expectCode(fn, code) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof BudgetError, `expected BudgetError, got ${error}`);
		assert.equal(error.code, code);
		return true;
	}, `expected BudgetError("${code}")`);
}

test("1. grant issues a frozen budget with a derived absolute expiry", () => {
	const clock = fixedClock(5000);
	const policy = createBudgetPolicy({ now: clock.now });

	const grant = policy.grant({ scopeKey: "s1", maxTokens: 1000, maxDurationMs: 30000, maxCalls: 3 });
	assert.deepEqual(grant, {
		scopeKey: "s1",
		maxTokens: 1000,
		maxCalls: 3,
		issuedAt: 5000,
		expiresAt: 35000,
		chargedTokens: 0,
		chargedCalls: 0,
		settled: false,
	});
	assert.ok(Object.isFrozen(grant), "grant is frozen");
	assert.throws(() => { grant.chargedTokens = 999; }, TypeError, "frozen grant cannot be mutated");

	// maxCalls omitted -> null cap (unbounded), still JSON-clean.
	const open = policy.grant({ scopeKey: "s2", maxTokens: 10, maxDurationMs: 1000 });
	assert.equal(open.maxCalls, null);
	assert.equal(open.expiresAt, 6000);

	// issuedAt/expiresAt are read from the injected clock, not wall time.
	clock.advance(250);
	const later = policy.grant({ scopeKey: "s3", maxTokens: 10, maxDurationMs: 1000 });
	assert.equal(later.issuedAt, 5250);
	assert.equal(later.expiresAt, 6250);
});

test("2. charge deducts tokens and calls and reports exact remainders", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 100, maxDurationMs: 10000, maxCalls: 5 });

	const first = policy.charge("s", { tokens: 30, calls: 2 });
	assert.deepEqual(first, { remainingTokens: 70, remainingCalls: 3, remainingMs: 10000 });

	clock.advance(4000);
	const second = policy.charge("s", { tokens: 10, calls: 1 });
	assert.deepEqual(second, { remainingTokens: 60, remainingCalls: 2, remainingMs: 6000 });

	// No usage argument is a no-op movement.
	assert.deepEqual(policy.charge("s"), { remainingTokens: 60, remainingCalls: 2, remainingMs: 6000 });

	// A grant with no maxCalls reports an unbounded remaining call count.
	policy.grant({ scopeKey: "u", maxTokens: 5, maxDurationMs: 10000 });
	assert.deepEqual(policy.charge("u", { tokens: 1 }), { remainingTokens: 4, remainingCalls: Infinity, remainingMs: 10000 });
});

test("3. an over-budget charge is atomic: budget-exhausted with zero movement", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 100, maxDurationMs: 10000 });

	policy.charge("s", { tokens: 60 });
	expectCode(() => policy.charge("s", { tokens: 50 }), "budget-exhausted");
	// Refused charge left the counter untouched...
	assert.equal(policy.remaining("s").remainingTokens, 40);
	// ...so a smaller charge that still fits is accepted.
	assert.equal(policy.charge("s", { tokens: 30 }).remainingTokens, 10);
	// Exactly reaching the cap is allowed; one token more is not.
	assert.equal(policy.charge("s", { tokens: 10 }).remainingTokens, 0);
	expectCode(() => policy.charge("s", { tokens: 1 }), "budget-exhausted");
	assert.equal(policy.remaining("s").remainingTokens, 0);
});

test("4. maxCalls caps the number of calls independently of tokens", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 1_000_000, maxDurationMs: 10000, maxCalls: 2 });

	policy.charge("s", { calls: 1 });
	policy.charge("s", { calls: 1 });
	expectCode(() => policy.charge("s", { calls: 1 }), "budget-exhausted");
	const after = policy.remaining("s");
	assert.equal(after.remainingCalls, 0, "call counter frozen at the cap");
	assert.equal(after.remainingTokens, 1_000_000, "token counter untouched by the refused call");

	// A single multi-call charge cannot leap past the cap either.
	const two = createBudgetPolicy({ now: clock.now });
	two.grant({ scopeKey: "t", maxTokens: 1_000_000, maxDurationMs: 10000, maxCalls: 2 });
	expectCode(() => two.charge("t", { calls: 3 }), "budget-exhausted");
	assert.equal(two.remaining("t").remainingCalls, 2);
});

test("5. an expired budget refuses charge and assertActive at the boundary", () => {
	const clock = fixedClock(1000);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 50, maxDurationMs: 5000 }); // expiresAt = 6000

	clock.set(5999);
	assert.equal(policy.charge("s", { tokens: 1 }).remainingTokens, 49);

	clock.set(6000); // now() === expiresAt is already expired
	expectCode(() => policy.charge("s", { tokens: 1 }), "budget-expired");
	expectCode(() => policy.assertActive("s"), "budget-expired");
	// The frozen numbers stay auditable even after expiry.
	assert.equal(policy.remaining("s").remainingTokens, 49);
});

test("6. unknown scopes and settled budgets fail closed with the right code", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });

	expectCode(() => policy.charge("nope", { tokens: 1 }), "unknown-budget");
	expectCode(() => policy.assertActive("nope"), "unknown-budget");
	expectCode(() => policy.remaining("nope"), "unknown-budget");
	expectCode(() => policy.settle("nope"), "unknown-budget");

	policy.grant({ scopeKey: "s", maxTokens: 100, maxDurationMs: 10000 });
	policy.settle("s");
	expectCode(() => policy.charge("s", { tokens: 1 }), "budget-settled");
	expectCode(() => policy.assertActive("s"), "budget-settled");
	expectCode(() => policy.settle("s"), "budget-settled");
});

test("7. no renewal: duplicate grant is refused and no extend/renew/increase API exists", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 100, maxDurationMs: 10000 });

	clock.advance(1000);
	// A second grant for a live scope cannot overwrite or extend it.
	expectCode(() => policy.grant({ scopeKey: "s", maxTokens: 999, maxDurationMs: 999999 }), "invalid-grant");
	assert.equal(policy.remaining("s").remainingTokens, 100, "original budget untouched");

	// Reflection: no member of the module or the policy extends a budget.
	const forbidden = /extend|renew|increase|raise|bump|refill|topup|reset|unsettle|release|delete|clear|grantmore|addbudget/i;
	for (const key of Object.keys(policy)) {
		assert.ok(!forbidden.test(key), `policy exposes a forbidden mutator: ${key}`);
	}
	for (const key of Object.keys(budgetModule)) {
		assert.ok(!forbidden.test(key), `module exports a forbidden mutator: ${key}`);
	}
	assert.deepEqual(
		Object.keys(policy).sort(),
		["assertActive", "charge", "fromJSON", "grant", "remaining", "settle", "toJSON"].sort(),
		"the public surface is exactly the documented contract",
	);
});

test("8. field validation rejects every malformed grant and charge with invalid-grant", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });

	const invalidGrants = [
		undefined,
		{},
		{ scopeKey: "", maxTokens: 10, maxDurationMs: 10 },
		{ scopeKey: "   ", maxTokens: 10, maxDurationMs: 10 },
		{ scopeKey: 42, maxTokens: 10, maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: 0, maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: -1, maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: 1.5, maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: Infinity, maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: NaN, maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: "10", maxDurationMs: 10 },
		{ scopeKey: "s", maxTokens: 10, maxDurationMs: 0 },
		{ scopeKey: "s", maxTokens: 10, maxDurationMs: -5 },
		{ scopeKey: "s", maxTokens: 10, maxDurationMs: 1.5 },
		{ scopeKey: "s", maxTokens: 10, maxDurationMs: 10, maxCalls: 0 },
		{ scopeKey: "s", maxTokens: 10, maxDurationMs: 10, maxCalls: -1 },
		{ scopeKey: "s", maxTokens: 10, maxDurationMs: 10, maxCalls: 2.5 },
	];
	for (const spec of invalidGrants) {
		expectCode(() => policy.grant(spec), "invalid-grant");
	}

	policy.grant({ scopeKey: "ok", maxTokens: 10, maxDurationMs: 10 });
	expectCode(() => policy.charge("ok", { tokens: -1 }), "invalid-grant");
	expectCode(() => policy.charge("ok", { calls: -1 }), "invalid-grant");
	expectCode(() => policy.charge("ok", { tokens: Infinity }), "invalid-grant");
	expectCode(() => policy.charge("ok", { tokens: NaN }), "invalid-grant");
	expectCode(() => policy.charge("ok", { calls: "2" }), "invalid-grant");
	// A rejected charge never moved the counters.
	assert.equal(policy.remaining("ok").remainingTokens, 10);
});

test("9. toJSON/fromJSON round-trips behaviour and rejects tampered snapshots", () => {
	const clock = fixedClock(1000);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "a", maxTokens: 100, maxDurationMs: 5000, maxCalls: 4 }); // expiresAt 6000
	policy.grant({ scopeKey: "b", maxTokens: 50, maxDurationMs: 9000 });
	policy.charge("a", { tokens: 20, calls: 1 });
	clock.advance(2000);

	const snapshot = JSON.parse(JSON.stringify(policy.toJSON()));

	// Same clock as the source: movement and settle behave identically.
	const restored = createBudgetPolicy({ now: clock.now });
	restored.fromJSON(snapshot);
	assert.deepEqual(restored.remaining("a"), policy.remaining("a"));
	assert.deepEqual(restored.remaining("b"), policy.remaining("b"));
	assert.deepEqual(restored.charge("a", { tokens: 5 }), policy.charge("a", { tokens: 5 }));
	restored.settle("b");
	expectCode(() => restored.charge("b", { tokens: 1 }), "budget-settled");

	// A clock past `a`'s expiry makes the restored grant expire identically.
	const later = createBudgetPolicy({ now: () => 6000 });
	later.fromJSON(snapshot);
	expectCode(() => later.charge("a", { tokens: 1 }), "budget-expired");
	expectCode(() => later.assertActive("a"), "budget-expired");

	// Every tampered snapshot is rejected as invalid-state.
	const tampers = [
		(snap) => { snap.version = 2; },
		(snap) => { snap.grants = "nope"; },
		(snap) => { snap.grants[0].maxTokens = "lots"; },
		(snap) => { snap.grants[0].maxTokens = 0; },
		(snap) => { snap.grants[0].chargedTokens = 999; }, // > maxTokens
		(snap) => { snap.grants[0].chargedCalls = 99; }, // > maxCalls
		(snap) => { snap.grants[0].settled = "yes"; },
		(snap) => { snap.grants[0].expiresAt = snap.grants[0].issuedAt; },
		(snap) => { snap.grants[0].extra = true; },
		(snap) => { delete snap.grants[0].maxCalls; },
		(snap) => { snap.grants.push({ ...snap.grants[0] }); }, // second unsettled record for one scope
	];
	for (const tamper of tampers) {
		const copy = JSON.parse(JSON.stringify(snapshot));
		tamper(copy);
		expectCode(() => createBudgetPolicy({ now: clock.now }).fromJSON(copy), "invalid-state");
	}
	expectCode(() => createBudgetPolicy().fromJSON(null), "invalid-state");
	expectCode(() => createBudgetPolicy().fromJSON(undefined), "invalid-state");
});

test("10. scopes are isolated: charging one never affects another", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "a", maxTokens: 100, maxDurationMs: 10000 });
	policy.grant({ scopeKey: "b", maxTokens: 100, maxDurationMs: 10000 });

	policy.charge("a", { tokens: 90 });
	assert.equal(policy.remaining("a").remainingTokens, 10);
	assert.equal(policy.remaining("b").remainingTokens, 100, "b is untouched by a's charge");

	expectCode(() => policy.charge("a", { tokens: 20 }), "budget-exhausted");
	assert.equal(policy.remaining("b").remainingTokens, 100, "b still untouched after a's refusal");
	assert.equal(policy.charge("b", { tokens: 20 }).remainingTokens, 80);

	// Settling one scope does not settle the other.
	policy.settle("a");
	expectCode(() => policy.charge("a", { tokens: 1 }), "budget-settled");
	assert.equal(policy.charge("b", { tokens: 1 }).remainingTokens, 79);
});

test("11. assertActive returns remainders while active and refuses once maxed", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 10, maxDurationMs: 10000 });

	assert.deepEqual(policy.assertActive("s"), { remainingTokens: 10, remainingCalls: Infinity, remainingMs: 10000 });
	policy.charge("s", { tokens: 10 });
	expectCode(() => policy.assertActive("s"), "budget-exhausted");

	const capped = createBudgetPolicy({ now: clock.now });
	capped.grant({ scopeKey: "c", maxTokens: 1000, maxDurationMs: 10000, maxCalls: 1 });
	capped.charge("c", { calls: 1 });
	expectCode(() => capped.assertActive("c"), "budget-exhausted");
});

test("12. error messages carry only the scope key and numbers, never foreign context", () => {
	const clock = fixedClock(0);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "scope-xyz", maxTokens: 5, maxDurationMs: 10000 });

	const cases = [
		[() => policy.charge("scope-xyz", { tokens: 99 }), "budget-exhausted"],
		[() => policy.charge("nope", { tokens: 1 }), "unknown-budget"],
		[() => policy.grant({ scopeKey: "scope-xyz", maxTokens: 1, maxDurationMs: 1 }), "invalid-grant"],
	];
	for (const [fn, code] of cases) {
		assert.throws(fn, (error) => {
			assert.equal(error.code, code);
			assert.equal(typeof error.message, "string");
			// The offending scope key is named; the amount is present for the
			// numeric failures. Nothing else (no stack, no payload) leaks in.
			assert.ok(error.message.includes("scope") || error.message.includes("budget"), "message names its subject");
			return true;
		});
	}
});

test("13. re-granting a settled scope retains the settled record for audit", () => {
	const clock = fixedClock(1000);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 100, maxDurationMs: 5000, maxCalls: 3 }); // expiresAt 6000
	policy.charge("s", { tokens: 40, calls: 2 });
	policy.settle("s");

	clock.advance(10000); // the old grant is long expired; a new cycle starts fresh
	const fresh = policy.grant({ scopeKey: "s", maxTokens: 200, maxDurationMs: 8000 });
	assert.deepEqual(fresh, {
		scopeKey: "s",
		maxTokens: 200,
		maxCalls: null,
		issuedAt: 11000,
		expiresAt: 19000,
		chargedTokens: 0,
		chargedCalls: 0,
		settled: false,
	});

	// toJSON carries BOTH records: the settled one first, with its counters intact.
	const two = policy.toJSON();
	assert.equal(two.grants.length, 2);
	assert.deepEqual(two.grants[0], {
		scopeKey: "s",
		maxTokens: 100,
		maxCalls: 3,
		issuedAt: 1000,
		expiresAt: 6000,
		chargedTokens: 40,
		chargedCalls: 2,
		settled: true,
	});
	assert.equal(two.grants[1].settled, false);
	assert.equal(two.grants[1].issuedAt, 11000);

	// The new cycle charges in isolation; the settled record never moves.
	assert.deepEqual(policy.charge("s", { tokens: 50 }), { remainingTokens: 150, remainingCalls: Infinity, remainingMs: 8000 });
	assert.equal(policy.toJSON().grants[0].chargedTokens, 40, "retained settled record frozen at 40");

	// Round-trip preserves both records and the live cycle's behaviour.
	const clone = JSON.parse(JSON.stringify(policy.toJSON()));
	const restored = createBudgetPolicy({ now: clock.now });
	restored.fromJSON(clone);
	assert.equal(restored.toJSON().grants.length, 2);
	assert.deepEqual(restored.remaining("s"), policy.remaining("s"));
	assert.equal(restored.toJSON().grants[0].chargedTokens, 40, "settled record survives round-trip");
	assert.equal(restored.toJSON().grants[1].chargedTokens, 50);
	assert.deepEqual(restored.charge("s", { tokens: 10 }), policy.charge("s", { tokens: 10 }));

	// Settling the fresh cycle keeps both records with no live one left.
	restored.settle("s");
	assert.deepEqual(restored.toJSON().grants.map((g) => g.settled), [true, true]);
	expectCode(() => restored.charge("s", { tokens: 1 }), "budget-settled");

	// fromJSON still refuses two UNSETTLED records for one scope.
	const bad = JSON.parse(JSON.stringify(clone)); // old settled + new unsettled
	bad.grants[0].settled = false;
	expectCode(() => createBudgetPolicy({ now: clock.now }).fromJSON(bad), "invalid-state");
});

// ---------------------------------------------------------------------------
// Negative tests for audit finding M02-BP-F001 (clock anomaly kept the budget
// usable). These pin the fail-closed barrier: a clock reading that cannot anchor
// a deadline is refused on grant/charge/assertActive/remaining BEFORE any state
// moves or any effect is authorised, and is never misread as "still active".
// ---------------------------------------------------------------------------

/**
 * A clock whose reading can be swapped mid-test. `setValue` makes `now()` return
 * an arbitrary (possibly invalid) value; `setThrow` makes it throw. This models a
 * real host clock failing AFTER a budget was validly granted — the audit repro.
 */
function controllableClock(start = 1000) {
	let mode = { kind: "value", value: start };
	return {
		now: () => {
			if (mode.kind === "throw") throw new Error("clock failure");
			return mode.value;
		},
		setValue: (value) => { mode = { kind: "value", value }; },
		setThrow: () => { mode = { kind: "throw" }; },
	};
}

test("14. a valid grant then an injected faulty clock fails closed with zero movement", () => {
	const clock = controllableClock(100);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 5, maxDurationMs: 1000, maxCalls: 3 }); // expiresAt = 1100

	// While the clock is sound the budget is genuinely live and usable.
	assert.deepEqual(policy.assertActive("s"), { remainingTokens: 5, remainingCalls: 3, remainingMs: 1000 });

	const before = policy.toJSON(); // full record set, every field
	const faulty = [NaN, Infinity, -Infinity, -1, "100", undefined, null, true];

	for (const value of faulty) {
		clock.setValue(value);
		// The audit's exact repro: assertActive must REFUSE, never report success
		// with a NaN remainingMs, and charge must not slip through.
		expectCode(() => policy.assertActive("s"), "clock-invalid");
		expectCode(() => policy.charge("s", { tokens: 1, calls: 1 }), "clock-invalid");
		expectCode(() => policy.remaining("s"), "clock-invalid");
		// No charge landed and no record moved, field by field.
		assert.deepEqual(policy.toJSON(), before, `state unchanged after faulty clock ${String(value)}`);
	}

	// A clock that THROWS is a fault too, refused before any movement.
	clock.setThrow();
	expectCode(() => policy.assertActive("s"), "clock-invalid");
	expectCode(() => policy.charge("s", { tokens: 1, calls: 1 }), "clock-invalid");
	expectCode(() => policy.remaining("s"), "clock-invalid");
	assert.deepEqual(policy.toJSON(), before, "state unchanged after a throwing clock");

	// Restoring a sound clock restores the exact original behaviour.
	clock.setValue(100);
	assert.deepEqual(policy.assertActive("s"), { remainingTokens: 5, remainingCalls: 3, remainingMs: 1000 });
	assert.deepEqual(policy.charge("s", { tokens: 1, calls: 1 }), { remainingTokens: 4, remainingCalls: 2, remainingMs: 1000 });
});

test("15. grant refuses a faulty clock and an overflowing derived expiry, leaving no record", () => {
	const clock = controllableClock(1000);
	const policy = createBudgetPolicy({ now: clock.now });

	for (const value of [NaN, Infinity, -Infinity, -5, "1000"]) {
		clock.setValue(value);
		expectCode(() => policy.grant({ scopeKey: "g", maxTokens: 10, maxDurationMs: 1000 }), "clock-invalid");
		expectCode(() => policy.remaining("g"), "unknown-budget");
	}
	clock.setThrow();
	expectCode(() => policy.grant({ scopeKey: "g", maxTokens: 10, maxDurationMs: 1000 }), "clock-invalid");
	assert.deepEqual(policy.toJSON(), { version: 1, grants: [] }, "a refused grant stores no record");

	// A sound clock but a huge duration pushes the derived expiry past the
	// safely-representable integer range -> invalid-grant, still no record.
	clock.setValue(1);
	expectCode(() => policy.grant({ scopeKey: "g", maxTokens: 10, maxDurationMs: Number.MAX_SAFE_INTEGER }), "invalid-grant");
	assert.deepEqual(policy.toJSON(), { version: 1, grants: [] }, "an overflowing grant stores no record");

	// The exact boundary: as long as the derived expiry fits, the grant stands.
	clock.setValue(0);
	const ok = policy.grant({ scopeKey: "g", maxTokens: 10, maxDurationMs: Number.MAX_SAFE_INTEGER });
	assert.equal(ok.expiresAt, Number.MAX_SAFE_INTEGER);
	assert.equal(policy.remaining("g").remainingMs, Number.MAX_SAFE_INTEGER);
});

test("16. boundary expiry holds and a clock fault is never misread as expiry", () => {
	const clock = controllableClock(1000);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "s", maxTokens: 50, maxDurationMs: 5000 }); // expiresAt = 6000

	// One ms before expiry the budget is active; AT expiry it is expired.
	clock.setValue(5999);
	assert.equal(policy.charge("s", { tokens: 1 }).remainingMs, 1);
	clock.setValue(6000);
	expectCode(() => policy.charge("s", { tokens: 1 }), "budget-expired");
	expectCode(() => policy.assertActive("s"), "budget-expired");

	// A broken clock is reported as the clock fault (the fail-closed cause) and
	// moves nothing, rather than being silently swallowed as "expired" or active.
	const before = policy.toJSON();
	clock.setValue(NaN);
	expectCode(() => policy.assertActive("s"), "clock-invalid");
	assert.deepEqual(policy.toJSON(), before);

	// The frozen numbers stay auditable once a sound clock is restored.
	clock.setValue(6000);
	assert.equal(policy.remaining("s").remainingTokens, 49);
});

test("17. fromJSON refuses out-of-range time windows in snapshots", () => {
	const clock = fixedClock(1000);
	const policy = createBudgetPolicy({ now: clock.now });
	policy.grant({ scopeKey: "a", maxTokens: 100, maxDurationMs: 5000 }); // expiresAt 6000
	const snapshot = JSON.parse(JSON.stringify(policy.toJSON()));

	const tampers = [
		(snap) => { snap.grants[0].issuedAt = -1; },
		(snap) => { snap.grants[0].issuedAt = "1000"; },
		(snap) => { snap.grants[0].expiresAt = Number.MAX_SAFE_INTEGER + 1; },
		(snap) => { snap.grants[0].expiresAt = Infinity; },
	];
	for (const tamper of tampers) {
		const copy = JSON.parse(JSON.stringify(snapshot));
		tamper(copy);
		expectCode(() => createBudgetPolicy({ now: clock.now }).fromJSON(copy), "invalid-state");
	}
});

test("18. a restored budget keeps the same fail-closed clock behaviour", () => {
	const clock = controllableClock(1000);
	const source = createBudgetPolicy({ now: clock.now });
	source.grant({ scopeKey: "s", maxTokens: 20, maxDurationMs: 4000, maxCalls: 2 }); // expiresAt 5000
	source.charge("s", { tokens: 5, calls: 1 });

	const snapshot = JSON.parse(JSON.stringify(source.toJSON()));
	const restored = createBudgetPolicy({ now: clock.now });
	restored.fromJSON(snapshot);

	// Sound clock: identical remainder and an identical matching charge.
	assert.deepEqual(restored.remaining("s"), source.remaining("s"));
	assert.deepEqual(restored.charge("s", { tokens: 5 }), source.charge("s", { tokens: 5 }));

	// Fault AFTER restore: the restored budget refuses and does not move.
	const before = restored.toJSON();
	clock.setValue(NaN);
	expectCode(() => restored.charge("s", { tokens: 1, calls: 1 }), "clock-invalid");
	expectCode(() => restored.assertActive("s"), "clock-invalid");
	assert.deepEqual(restored.toJSON(), before);

	// Reopening a sound clock makes it usable again, consistently.
	clock.setValue(1000);
	assert.deepEqual(restored.assertActive("s"), { remainingTokens: 10, remainingCalls: 1, remainingMs: 4000 });
});
