// Tests for runtime/route-binding.mjs (M02/I03c first slice).
//
// Pure-module tests: no network, no file reads, no environment access, no
// side effects. They pin the single-owner route-binding contract — one engine
// per request (idempotent re-bind, fail-closed on any differing field),
// term-limited legacy bindings (explicit expiry + non-empty task scope,
// fail-closed on expiry with the record retained), integrity fields locked at
// creation, the pure advisory EffectIntent skeleton, and (RB-F001) an intent
// identity that binds the full task/parameters — the same request+effectKey with
// a different task is "intent-conflict", and restore() rejects contradictory
// duplicate intents instead of taking the last one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRouteBindingRegistry, RouteBindingError } from "../runtime/route-binding.mjs";

const LEGACY_KEY = Object.freeze({ ownerId: "owner-1", sourceRequestId: "req-legacy" });
const PI_KEY = Object.freeze({ ownerId: "owner-2", sourceRequestId: "req-pi" });

/** A complete, valid legacy binding (bounded transitional facade). */
function legacyBinding(overrides = {}) {
	return {
		requestKey: { ownerId: "owner-1", sourceRequestId: "req-legacy" },
		runtime: "legacy",
		codeVersion: "0.3.0",
		interfaceVersion: "1",
		modelRef: { provider: "kimi", modelId: "kimi-k2" },
		profileId: "profile-legacy",
		cwd: "/Users/markus/legacy-work",
		authorizationDigest: "auth-legacy",
		effectKey: "effect-legacy",
		legacyScope: { allowedTaskIds: ["task-1", "task-2"] },
		createdAt: 1000,
		expiresAt: 5000,
		...overrides,
	};
}

/** A complete, valid pi-durable binding (durable owner; no scope, no forced expiry). */
function piBinding(overrides = {}) {
	return {
		requestKey: { ownerId: "owner-2", sourceRequestId: "req-pi" },
		runtime: "pi-durable",
		codeVersion: "0.3.0",
		interfaceVersion: "1",
		modelRef: { provider: "openai", modelId: "gpt-4o" },
		profileId: "profile-pi",
		cwd: "/Users/markus/pi-work",
		authorizationDigest: "auth-pi",
		effectKey: "effect-pi",
		legacyScope: null,
		createdAt: 1000,
		...overrides,
	};
}

/** Assert a RouteBindingError with the given code is thrown. */
function throwsCode(fn, code) {
	assert.throws(fn, (error) => error instanceof RouteBindingError && error.code === code, `expected RouteBindingError(${code})`);
}

/** Deep JSON round-trip, proving the serialized form is plain JSON-safe data. */
const roundTripJSON = (value) => JSON.parse(JSON.stringify(value));

test("legacy and pi-durable bindings normalize to the frozen contract shape", () => {
	const registry = createRouteBindingRegistry({ now: () => 0 });

	const legacy = registry.bind(legacyBinding());
	assert.equal(legacy.runtime, "legacy");
	assert.deepEqual(legacy.requestKey, { ownerId: "owner-1", sourceRequestId: "req-legacy" });
	assert.deepEqual(legacy.modelRef, { provider: "kimi", modelId: "kimi-k2" });
	assert.deepEqual(legacy.legacyScope.allowedTaskIds, ["task-1", "task-2"]);
	assert.equal(legacy.expiresAt, 5000);
	assert.equal(registry.resolve(LEGACY_KEY), legacy);

	const pi = registry.bind(piBinding());
	assert.equal(pi.runtime, "pi-durable");
	assert.equal(pi.legacyScope, null, "pi-durable carries no legacy scope");
	assert.equal(pi.expiresAt, null, "omitted expiry reads back as null");
	assert.equal(registry.size, 2);

	// pi-durable MAY declare an explicit expiry; it is preserved.
	const withExpiry = registry.bind(piBinding({
		requestKey: { ownerId: "owner-3", sourceRequestId: "req-pi-2" },
		expiresAt: 9000,
	}));
	assert.equal(withExpiry.expiresAt, 9000);
	assert.equal(registry.size, 3);
});

test("V01: re-binding an identical requestKey is idempotent (same record, count 1)", () => {
	const registry = createRouteBindingRegistry({ now: () => 0 });
	const first = registry.bind(legacyBinding());
	const second = registry.bind(legacyBinding());
	assert.equal(first, second, "returns the same frozen record");
	assert.deepEqual(first, second);
	assert.equal(registry.size, 1, "no second binding is created");
});

test("V02: a differing field is a binding-conflict and leaves the existing binding untouched", () => {
	const registry = createRouteBindingRegistry({ now: () => 0 });
	const original = registry.bind(legacyBinding());
	throwsCode(() => registry.bind(legacyBinding({ authorizationDigest: "auth-other" })), "binding-conflict");
	const after = registry.resolve(LEGACY_KEY);
	assert.equal(after, original, "existing binding object unchanged");
	assert.equal(after.authorizationDigest, "auth-legacy");
	assert.equal(registry.size, 1);
});

test("no double-live: legacy then pi-durable for the same request is a binding-conflict", () => {
	const registry = createRouteBindingRegistry({ now: () => 0 });
	registry.bind(legacyBinding());
	throwsCode(() => registry.bind(piBinding({ requestKey: { ownerId: "owner-1", sourceRequestId: "req-legacy" } })), "binding-conflict");
	assert.equal(registry.resolve(LEGACY_KEY).runtime, "legacy", "original owner still bound");
	assert.equal(registry.size, 1);
});

test("legacy requires an explicit expiry and a non-empty task scope", () => {
	const registry = createRouteBindingRegistry({ now: () => 0 });
	throwsCode(() => registry.bind(legacyBinding({ expiresAt: undefined })), "legacy-expiry-required");
	throwsCode(() => registry.bind(legacyBinding({ expiresAt: null })), "legacy-expiry-required");
	throwsCode(() => registry.bind(legacyBinding({ legacyScope: undefined })), "legacy-scope-required");
	throwsCode(() => registry.bind(legacyBinding({ legacyScope: null })), "legacy-scope-required");
	throwsCode(() => registry.bind(legacyBinding({ legacyScope: {} })), "legacy-scope-required");
	throwsCode(() => registry.bind(legacyBinding({ legacyScope: { allowedTaskIds: [] } })), "legacy-scope-required");
	assert.equal(registry.size, 0, "nothing was stored by the rejected binds");
});

test("expiry is fail-closed on resolve: valid before expiresAt, binding-expired at it, record retained", () => {
	let t = 4999;
	const registry = createRouteBindingRegistry({ now: () => t });
	const binding = registry.bind(legacyBinding());
	assert.equal(registry.resolve(LEGACY_KEY), binding, "one tick before expiry resolves");

	t = 5000;
	throwsCode(() => registry.resolve(LEGACY_KEY), "binding-expired");
	assert.equal(registry.size, 1, "expiry does not delete the record");
	throwsCode(() => registry.resolve(LEGACY_KEY), "binding-expired"); // still expired, never auto-switched

	// A pi-durable binding with no expiry never expires.
	registry.bind(piBinding());
	t = Number.MAX_SAFE_INTEGER;
	assert.equal(registry.resolve(PI_KEY).runtime, "pi-durable");
});

test("legacy planEffect is scope-bounded: in-scope yields an intent, out-of-scope is denied", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	registry.bind(legacyBinding());
	const intent = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	assert.equal(intent.type, "EffectIntent");
	assert.equal(intent.version, 1);
	assert.equal(intent.runtime, "legacy");
	assert.equal(intent.effectKey, "effect-legacy");
	assert.equal(intent.taskId, "task-1");
	assert.equal(intent.requiresApproval, true);
	assert.equal(intent.sideEffects, false);
	assert.deepEqual(intent.requestKey, { ownerId: "owner-1", sourceRequestId: "req-legacy" });
	throwsCode(() => registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-99" }), "legacy-scope-violation");
	throwsCode(() => registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy" }), "legacy-scope-violation", "no taskId is not in scope");
});

test("field validation fails closed with invalid-binding", () => {
	const registry = createRouteBindingRegistry({ now: () => 0 });
	for (const field of ["codeVersion", "interfaceVersion", "profileId", "cwd", "authorizationDigest", "effectKey"]) {
		const missing = legacyBinding();
		delete missing[field];
		throwsCode(() => registry.bind(missing), "invalid-binding");
		throwsCode(() => registry.bind(legacyBinding({ [field]: "" })), "invalid-binding");
	}
	throwsCode(() => registry.bind(legacyBinding({ requestKey: { ownerId: "owner-1" } })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ requestKey: { ownerId: "", sourceRequestId: "req-legacy" } })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ runtime: "other" })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ cwd: "relative/work" })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ createdAt: Number.NaN })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ expiresAt: Number.POSITIVE_INFINITY })), "invalid-binding");
	// modelRef must be EXACTLY { provider, modelId }, two non-empty strings.
	throwsCode(() => registry.bind(legacyBinding({ modelRef: { provider: "kimi" } })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ modelRef: { provider: "kimi", modelId: "kimi-k2", extra: "x" } })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ modelRef: { provider: "kimi", modelId: "" } })), "invalid-binding");
	throwsCode(() => registry.bind(legacyBinding({ modelRef: "kimi/kimi-k2" })), "invalid-binding");
	// pi-durable must not carry a legacy scope (semantic conflict).
	throwsCode(() => registry.bind(piBinding({ legacyScope: { allowedTaskIds: ["task-1"] } })), "invalid-binding");
	assert.equal(registry.size, 0);
	throwsCode(() => registry.resolve({}), "invalid-binding", "resolve rejects a malformed requestKey");
});

test("effectKey mismatch is an effect-conflict", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	registry.bind(legacyBinding());
	throwsCode(() => registry.planEffect(LEGACY_KEY, { effectKey: "effect-other", taskId: "task-1" }), "effect-conflict");
	throwsCode(() => registry.planEffect(LEGACY_KEY, { effectKey: "", taskId: "task-1" }), "invalid-binding");
	assert.equal(registry.intentCount, 0, "no intent registered on denial");
});

test("intent registration is idempotent per requestKey+effectKey (count stays 1)", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	registry.bind(legacyBinding());
	const first = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	const second = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	assert.equal(first, second, "same intent object returned");
	assert.equal(registry.intentCount, 1);
});

test("toJSON/fromJSON round-trips behavior and rejects tampered data", () => {
	let t = 1000;
	const registry = createRouteBindingRegistry({ now: () => t });
	registry.bind(legacyBinding());
	registry.bind(piBinding());
	registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });

	const data = roundTripJSON(registry.toJSON());
	const restored = createRouteBindingRegistry.fromJSON(data, { now: () => t });
	assert.equal(restored.size, 2);
	assert.equal(restored.intentCount, 1);
	assert.deepEqual(restored.resolve(LEGACY_KEY), registry.resolve(LEGACY_KEY));
	assert.deepEqual(restored.resolve(PI_KEY), registry.resolve(PI_KEY));
	assert.deepEqual(
		restored.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" }),
		registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" }),
	);

	// Expiry behaves identically after reload.
	t = 5000;
	throwsCode(() => restored.resolve(LEGACY_KEY), "binding-expired");
	throwsCode(() => registry.resolve(LEGACY_KEY), "binding-expired");
	assert.equal(restored.resolve(PI_KEY).runtime, "pi-durable");

	// Tampered payloads are rejected.
	throwsCode(() => createRouteBindingRegistry.fromJSON({ ...data, version: 2 }), "invalid-registry");
	throwsCode(() => createRouteBindingRegistry.fromJSON(null), "invalid-registry");
	throwsCode(() => createRouteBindingRegistry.fromJSON({ type: "RouteBindingRegistry", version: 1, bindings: "x", intents: [] }), "invalid-registry");

	const badBinding = roundTripJSON(data);
	badBinding.bindings[0].modelRef.extra = "x";
	throwsCode(() => createRouteBindingRegistry.fromJSON(badBinding), "invalid-binding");

	const badIntent = roundTripJSON(data);
	badIntent.intents[0].requiresApproval = false;
	throwsCode(() => createRouteBindingRegistry.fromJSON(badIntent), "invalid-binding");

	const badIntentRuntime = roundTripJSON(data);
	badIntentRuntime.intents[0].runtime = "pi-durable";
	throwsCode(() => createRouteBindingRegistry.fromJSON(badIntentRuntime), "invalid-binding");
});

test("records and intents are deeply frozen; expiry/conflict never mutate the registry", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	const binding = registry.bind(legacyBinding());
	assert.ok(Object.isFrozen(binding));
	assert.ok(Object.isFrozen(binding.requestKey));
	assert.ok(Object.isFrozen(binding.modelRef));
	assert.ok(Object.isFrozen(binding.legacyScope));
	assert.ok(Object.isFrozen(binding.legacyScope.allowedTaskIds));
	assert.throws(() => { binding.codeVersion = "hacked"; }, TypeError);
	assert.throws(() => { binding.legacyScope.allowedTaskIds.push("task-3"); }, TypeError);

	const intent = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	assert.ok(Object.isFrozen(intent));
	assert.throws(() => { intent.taskId = "task-2"; }, TypeError);

	// A binding-conflict leaves the registry exactly as it was.
	const snapshot = registry.toJSON();
	throwsCode(() => registry.bind(legacyBinding({ effectKey: "effect-other" })), "binding-conflict");
	assert.deepEqual(registry.toJSON(), snapshot);

	// Expiry neither deletes nor rewrites the record (clock is mutable here).
	let t = 1000;
	const expiring = createRouteBindingRegistry({ now: () => t });
	const held = expiring.bind(legacyBinding());
	t = 5000;
	throwsCode(() => expiring.resolve(LEGACY_KEY), "binding-expired");
	assert.equal(expiring.size, 1);
	assert.equal(expiring.toJSON().bindings[0], held, "identical frozen record retained");
	assert.equal(held.expiresAt, 5000, "record fields unchanged by expiry");
});

test("RB-F001: two in-scope legacy tasks on the same request+effectKey conflict (no silent reuse)", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	registry.bind(legacyBinding()); // scope: task-1, task-2 (both in scope)
	const first = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	const snapshot = registry.toJSON();

	// Audit repro: a second request for the same key with task-2 previously
	// returned the task-1 intent and said nothing. Now it must fail closed.
	throwsCode(() => registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-2" }), "intent-conflict");

	// Zero state change: the original intent is intact and still idempotent.
	assert.deepEqual(registry.toJSON(), snapshot, "a denied conflict mutates nothing");
	assert.equal(registry.intentCount, 1);
	const again = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	assert.equal(again, first, "the original intent is unchanged and still returned");
	assert.equal(again.taskId, "task-1");
});

test("RB-F001: an omitted task and an explicit task are distinct intent bodies", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	registry.bind(piBinding());
	const noTask = registry.planEffect(PI_KEY, { effectKey: "effect-pi" });
	assert.equal(noTask.taskId, undefined, "pi-durable intent may omit taskId");

	// Explicit undefined normalizes to the same body -> idempotent.
	assert.equal(registry.planEffect(PI_KEY, { effectKey: "effect-pi", taskId: undefined }), noTask);
	// A real explicit task is a different body -> conflict, nothing mutated.
	const snapshot = registry.toJSON();
	throwsCode(() => registry.planEffect(PI_KEY, { effectKey: "effect-pi", taskId: "task-9" }), "intent-conflict");
	assert.deepEqual(registry.toJSON(), snapshot);
	assert.equal(registry.intentCount, 1);
});

test("RB-F001: fromJSON rejects a contradictory duplicate intent and skips an identical one", () => {
	const registry = createRouteBindingRegistry({ now: () => 1000 });
	registry.bind(legacyBinding());
	const intent = registry.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
	const data = roundTripJSON(registry.toJSON());

	// An identical duplicate is an idempotent skip, not a last-wins overwrite.
	const dupOk = roundTripJSON(data);
	dupOk.intents.push(roundTripJSON(intent));
	const restored = createRouteBindingRegistry.fromJSON(dupOk, { now: () => 1000 });
	assert.equal(restored.intentCount, 1);
	assert.deepEqual(restored.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" }), intent);
	// The rebuilt registry's re-plan is consistent with the original.
	assert.deepEqual(restored.toJSON(), registry.toJSON());

	// Audit repro: a snapshot that appends a second legal intent with the SAME
	// request+effectKey but a DIFFERENT in-scope task must be rejected, not
	// silently resolved to the last one.
	const contradictory = roundTripJSON(data);
	contradictory.intents.push({ ...roundTripJSON(intent), taskId: "task-2" });
	throwsCode(() => createRouteBindingRegistry.fromJSON(contradictory, { now: () => 1000 }), "intent-conflict");
});
