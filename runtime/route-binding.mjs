// Personal AI OS 0.3.0 M02/I03c — single route binding + expiring legacy binding
// (first slice, pure).
//
// Design intent (docs/plans/0.3.0-upgrade.md:77,101-103; docs/plans/0.3.0-pruning.md:72):
//   1. ONE owner per request. "同一请求只绑定一个引擎" — a request is bound to
//      exactly one runtime ("legacy" | "pi-durable"). A second bind for the same
//      requestKey either returns the existing binding unchanged (idempotent) or
//      fails closed with "binding-conflict". Concurrent binding of the same
//      request to two engines (double ownership / permanent dual runtime) is
//      structurally impossible: "legacy 不能与新 owner 同时拥有同一请求".
//   2. TERM-LIMITED legacy. "legacy 不是永久第二套运行底座" — a legacy binding
//      is a transitional thin-compat facade that MUST carry an explicit expiry
//      ("legacy-expiry-required") and a non-empty allow-list of the specific old
//      tasks it may still route ("legacy-scope-required"); it never accepts new
//      work. Expiry is fail-closed on read ("binding-expired"): the record is
//      kept (never auto-switched, never deleted) but can no longer be resolved.
//      The expiry discipline mirrors control-plane/goal-store.mjs:58-59 (grant
//      expiry) and control-plane/store.mjs:580 (APPROVAL_EXPIRY_REQUIRED).
//   3. INTEGRITY FIELDS for audit. "代码版本、接口版本、授权摘要、执行工作目录及
//      模型/provider 标识进入审计" — codeVersion / interfaceVersion /
//      authorizationDigest / cwd / modelRef are locked into the binding at
//      creation and are part of the byte-identical idempotency comparison, so a
//      retry can never silently switch them.
//   4. EFFECT INTENT skeleton. planEffect produces a pure advisory EffectIntent
//      ({ requiresApproval: true, sideEffects: false }), the same shape family
//      as control-plane/router.mjs RoutePlan — no side effect is performed here.
//
// NOT WIRED IN THIS SLICE: this is a pure in-memory library. It is not called by
// the bridge, the runtime adapter or the control plane; persistence/transport
// wiring is a later slice. It performs NO IO: no network, no file reads, no
// environment access, no clock reads of its own (time is injected via `now`).
// Serialization (toJSON/fromJSON) is provided for a future adapter, not written
// to any store here.
//
// Contract — createRouteBindingRegistry({ now? }):
//   now: injected clock `() => number` (default Date.now), so expiry is testable.
//
//   registry.bind(binding) -> frozen Binding
//     validates and freezes a binding; idempotent for an identical requestKey;
//     any differing field (including `runtime`) -> RouteBindingError("binding-conflict").
//   registry.resolve(requestKey) -> frozen Binding
//     missing -> "unbound-request"; expired -> "binding-expired"; else the binding.
//   registry.planEffect(requestKey, { effectKey, taskId? }) -> frozen EffectIntent
//     effectKey mismatch -> "effect-conflict"; out-of-scope legacy taskId ->
//     "legacy-scope-violation"; repeated same requestKey+effectKey -> same intent.
//   registry.toJSON() -> stable plain data.
//   createRouteBindingRegistry.fromJSON(data, { now? }) -> new registry (fully
//     re-validated; corrupt data -> "invalid-registry" / "invalid-binding").
//   registry.size / registry.intentCount -> observability counters (no mutation).

/** The two engines; a request binds to exactly one. */
const RUNTIMES = Object.freeze(["legacy", "pi-durable"]);

/** Serialization envelope identity, pinned so tampering is detected on load. */
const SERIALIZATION_TYPE = "RouteBindingRegistry";
const SERIALIZATION_VERSION = 1;
const INTENT_TYPE = "EffectIntent";
const INTENT_VERSION = 1;

// Per-registry restore hook, kept off the public object so the documented API
// stays exactly { bind, resolve, planEffect, toJSON, size, intentCount }.
const RESTORERS = new WeakMap();

/** Fail-closed denial. `code` identifies the reason for audit and tests. */
export class RouteBindingError extends Error {
	constructor(code, message) {
		super(message ?? `route binding rejected: ${code}`);
		this.name = "RouteBindingError";
		this.code = code;
	}
}

/** True for a non-null, non-array, plain-ish object. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required free-text field: a non-empty string. */
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** Sorted own-key list, used to enforce "exactly these two fields" on modelRef. */
function ownKeys(value) {
	return Object.keys(value).sort();
}

/** Recursively freeze an object graph in place, returning it. */
function deepFreeze(value) {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

/** Structural deep equality over JSON-ish values (primitives, arrays, objects). */
function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const ak = ownKeys(a);
		const bk = ownKeys(b);
		if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
		return ak.every((k) => deepEqual(a[k], b[k]));
	}
	return false;
}

/** Stable Map key for a requestKey pair (JSON avoids any separator collisions). */
function requestKeyString(requestKey) {
	return JSON.stringify([requestKey.ownerId, requestKey.sourceRequestId]);
}

/**
 * Validate and normalize a requestKey pair. Returns a frozen `{ownerId, sourceRequestId}`.
 * Throws RouteBindingError("invalid-binding") on any shape violation.
 */
function normalizeRequestKey(requestKey) {
	if (!isPlainObject(requestKey)) {
		throw new RouteBindingError("invalid-binding", "requestKey must be an object");
	}
	if (!isNonEmptyString(requestKey.ownerId)) {
		throw new RouteBindingError("invalid-binding", "requestKey.ownerId must be a non-empty string");
	}
	if (!isNonEmptyString(requestKey.sourceRequestId)) {
		throw new RouteBindingError("invalid-binding", "requestKey.sourceRequestId must be a non-empty string");
	}
	return Object.freeze({ ownerId: requestKey.ownerId, sourceRequestId: requestKey.sourceRequestId });
}

/** Validate a modelRef as EXACTLY `{provider, modelId}`, both non-empty strings. */
function normalizeModelRef(modelRef) {
	if (!isPlainObject(modelRef)) {
		throw new RouteBindingError("invalid-binding", "modelRef must be an object");
	}
	const keys = ownKeys(modelRef);
	if (keys.length !== 2 || keys[0] !== "modelId" || keys[1] !== "provider") {
		throw new RouteBindingError("invalid-binding", "modelRef must be exactly { provider, modelId }");
	}
	if (!isNonEmptyString(modelRef.provider)) {
		throw new RouteBindingError("invalid-binding", "modelRef.provider must be a non-empty string");
	}
	if (!isNonEmptyString(modelRef.modelId)) {
		throw new RouteBindingError("invalid-binding", "modelRef.modelId must be a non-empty string");
	}
	return Object.freeze({ provider: modelRef.provider, modelId: modelRef.modelId });
}

/** Validate the legacy allow-list scope: non-empty array of non-empty strings. */
function normalizeLegacyScope(legacyScope) {
	// Missing scope, non-object, or an empty / absent allowedTaskIds list -> the
	// transitional facade has no bounded task set, so it must not exist at all.
	if (!isPlainObject(legacyScope)) {
		throw new RouteBindingError("legacy-scope-required", "legacy binding requires legacyScope { allowedTaskIds }");
	}
	const allowed = legacyScope.allowedTaskIds;
	if (!Array.isArray(allowed) || allowed.length === 0) {
		throw new RouteBindingError("legacy-scope-required", "legacy binding requires a non-empty allowedTaskIds list");
	}
	for (const taskId of allowed) {
		if (!isNonEmptyString(taskId)) {
			throw new RouteBindingError("invalid-binding", "legacyScope.allowedTaskIds must contain only non-empty strings");
		}
	}
	return Object.freeze({ allowedTaskIds: Object.freeze([...allowed]) });
}

/**
 * Validate a binding and return a deeply-frozen canonical copy holding only the
 * contract fields. Throws the specific fail-closed code on any violation.
 */
function normalizeBinding(binding) {
	if (!isPlainObject(binding)) {
		throw new RouteBindingError("invalid-binding", "binding must be an object");
	}

	// 1. Required identity / integrity fields.
	const requestKey = normalizeRequestKey(binding.requestKey);
	if (!RUNTIMES.includes(binding.runtime)) {
		throw new RouteBindingError("invalid-binding", `runtime must be one of ${RUNTIMES.join(", ")}`);
	}
	for (const field of ["codeVersion", "interfaceVersion", "profileId", "cwd", "authorizationDigest", "effectKey"]) {
		if (!isNonEmptyString(binding[field])) {
			throw new RouteBindingError("invalid-binding", `${field} must be a non-empty string`);
		}
	}
	const modelRef = normalizeModelRef(binding.modelRef);
	if (!binding.cwd.startsWith("/")) {
		throw new RouteBindingError("invalid-binding", "cwd must be an absolute path");
	}
	if (typeof binding.createdAt !== "number" || !Number.isFinite(binding.createdAt)) {
		throw new RouteBindingError("invalid-binding", "createdAt must be a finite number");
	}
	// expiresAt is optional in general; when present it must be a finite number.
	if (binding.expiresAt !== undefined && binding.expiresAt !== null) {
		if (typeof binding.expiresAt !== "number" || !Number.isFinite(binding.expiresAt)) {
			throw new RouteBindingError("invalid-binding", "expiresAt must be a finite number when provided");
		}
	}

	// 2. Term limit + scope. legacy is a bounded transitional facade; pi-durable
	//    is the durable owner and carries neither an allow-list nor a forced
	//    expiry (but may declare one).
	let legacyScope = null;
	let expiresAt = binding.expiresAt ?? null;
	if (binding.runtime === "legacy") {
		if (binding.expiresAt === undefined || binding.expiresAt === null) {
			throw new RouteBindingError("legacy-expiry-required", "legacy binding requires an explicit expiresAt");
		}
		legacyScope = normalizeLegacyScope(binding.legacyScope);
	} else if (binding.legacyScope !== undefined && binding.legacyScope !== null) {
		// pi-durable with a legacy scope is a semantic conflict: the durable owner
		// is not a scoped compatibility facade.
		throw new RouteBindingError("invalid-binding", "pi-durable binding must not carry a legacyScope");
	}

	const normalized = {
		requestKey,
		runtime: binding.runtime,
		codeVersion: binding.codeVersion,
		interfaceVersion: binding.interfaceVersion,
		modelRef,
		profileId: binding.profileId,
		cwd: binding.cwd,
		authorizationDigest: binding.authorizationDigest,
		effectKey: binding.effectKey,
		legacyScope,
		createdAt: binding.createdAt,
		expiresAt,
	};
	return deepFreeze(normalized);
}

/** Build the canonical frozen EffectIntent for a resolved binding + effectKey. */
function buildIntent(binding, effectKey, taskId) {
	const intent = {
		type: INTENT_TYPE,
		version: INTENT_VERSION,
		requestKey: binding.requestKey,
		runtime: binding.runtime,
		effectKey,
		requiresApproval: true,
		sideEffects: false,
	};
	if (taskId !== undefined) intent.taskId = taskId;
	return deepFreeze(intent);
}

/**
 * Create an in-memory, fail-closed route-binding registry.
 * @param {{ now?: () => number }} [options]
 */
export function createRouteBindingRegistry({ now } = {}) {
	if (now !== undefined && typeof now !== "function") {
		throw new RouteBindingError("invalid-registry", "now must be a function when provided");
	}
	const clock = now ?? Date.now;

	// Registry state is intentionally NOT frozen: later binds are allowed. Each
	// stored binding record and intent object is individually deep-frozen.
	const bindings = new Map();
	const intents = new Map();

	function bind(binding) {
		const normalized = normalizeBinding(binding);
		const key = requestKeyString(normalized.requestKey);
		const existing = bindings.get(key);
		if (existing !== undefined) {
			// Byte-identical -> idempotent, return the SAME frozen record; a single
			// differing field (including runtime) -> fail closed, existing untouched.
			if (deepEqual(existing, normalized)) return existing;
			throw new RouteBindingError("binding-conflict", "request already bound to a different runtime binding");
		}
		bindings.set(key, normalized);
		return normalized;
	}

	function resolve(requestKey) {
		const normalizedKey = normalizeRequestKey(requestKey);
		const binding = bindings.get(requestKeyString(normalizedKey));
		if (binding === undefined) {
			throw new RouteBindingError("unbound-request", "no binding exists for this request");
		}
		// Fail closed on expiry: report it, but never auto-switch and never delete.
		if (binding.expiresAt !== null && clock() >= binding.expiresAt) {
			throw new RouteBindingError("binding-expired", "the binding has expired");
		}
		return binding;
	}

	function planEffect(requestKey, { effectKey, taskId } = {}) {
		const binding = resolve(requestKey);
		if (!isNonEmptyString(effectKey)) {
			throw new RouteBindingError("invalid-binding", "effectKey must be a non-empty string");
		}
		if (effectKey !== binding.effectKey) {
			throw new RouteBindingError("effect-conflict", "effectKey does not match the binding");
		}
		if (taskId !== undefined && !isNonEmptyString(taskId)) {
			throw new RouteBindingError("invalid-binding", "taskId must be a non-empty string when provided");
		}
		// A legacy facade may only route the exact old tasks it was scoped to.
		if (binding.runtime === "legacy" && !binding.legacyScope.allowedTaskIds.includes(taskId)) {
			throw new RouteBindingError("legacy-scope-violation", "task is not in the legacy binding scope");
		}
		const intentKey = `${requestKeyString(binding.requestKey)}::${effectKey}`;
		const existing = intents.get(intentKey);
		if (existing !== undefined) return existing;
		const intent = buildIntent(binding, effectKey, taskId);
		intents.set(intentKey, intent);
		return intent;
	}

	function toJSON() {
		return {
			type: SERIALIZATION_TYPE,
			version: SERIALIZATION_VERSION,
			bindings: [...bindings.values()],
			intents: [...intents.values()],
		};
	}

	// Rebuild this registry from serialized data, re-validating structure and
	// every record. Validation here is deliberately clock-independent: expiry is
	// a read-time gate (resolve), so restoring a registry that already holds an
	// expired legacy binding must still succeed. Structural corruption ->
	// "invalid-registry"; any bad binding/intent record -> "invalid-binding".
	function restore(data) {
		if (!isPlainObject(data)) {
			throw new RouteBindingError("invalid-registry", "serialized registry must be an object");
		}
		if (data.type !== SERIALIZATION_TYPE || data.version !== SERIALIZATION_VERSION) {
			throw new RouteBindingError("invalid-registry", "serialized registry has an unknown type/version");
		}
		if (!Array.isArray(data.bindings) || !Array.isArray(data.intents)) {
			throw new RouteBindingError("invalid-registry", "serialized registry requires bindings and intents arrays");
		}

		const byKey = new Map();
		for (const binding of data.bindings) {
			const normalized = bind(binding); // full re-validation; dupes -> binding-conflict
			byKey.set(requestKeyString(normalized.requestKey), normalized);
		}

		for (const intent of data.intents) {
			if (!isPlainObject(intent) || intent.type !== INTENT_TYPE || intent.version !== INTENT_VERSION ||
				intent.requiresApproval !== true || intent.sideEffects !== false ||
				!isNonEmptyString(intent.effectKey) || !RUNTIMES.includes(intent.runtime)) {
				throw new RouteBindingError("invalid-binding", "serialized intent is malformed");
			}
			if (intent.taskId !== undefined && !isNonEmptyString(intent.taskId)) {
				throw new RouteBindingError("invalid-binding", "serialized intent has an invalid taskId");
			}
			const requestKey = normalizeRequestKey(intent.requestKey);
			const binding = byKey.get(requestKeyString(requestKey));
			if (binding === undefined) {
				throw new RouteBindingError("invalid-binding", "serialized intent has no matching binding");
			}
			if (binding.runtime !== intent.runtime) {
				throw new RouteBindingError("invalid-binding", "serialized intent runtime does not match its binding");
			}
			if (intent.effectKey !== binding.effectKey) {
				throw new RouteBindingError("invalid-binding", "serialized intent effectKey does not match its binding");
			}
			if (binding.runtime === "legacy" && !binding.legacyScope.allowedTaskIds.includes(intent.taskId)) {
				throw new RouteBindingError("invalid-binding", "serialized intent taskId is outside the legacy scope");
			}
			// Rebuild canonically and require an exact match, so tampering with any
			// intent field (envelope or taskId presence) is rejected.
			const canonical = buildIntent(binding, intent.effectKey, intent.taskId);
			if (!deepEqual(canonical, intent)) {
				throw new RouteBindingError("invalid-binding", "serialized intent does not round-trip");
			}
			intents.set(`${requestKeyString(requestKey)}::${intent.effectKey}`, canonical);
		}
	}

	const registry = {
		bind,
		resolve,
		planEffect,
		toJSON,
		get size() {
			return bindings.size;
		},
		get intentCount() {
			return intents.size;
		},
	};
	RESTORERS.set(registry, restore);
	return registry;
}

/**
 * Rebuild a registry from `toJSON` data, re-validating everything. Any structural
 * corruption -> "invalid-registry"; any bad binding/intent record -> "invalid-binding".
 */
function fromJSON(data, { now } = {}) {
	const registry = createRouteBindingRegistry({ now });
	RESTORERS.get(registry)(data);
	return registry;
}

// Attach the loader as a static on the factory, per the contract's
// `static fromJSON(data)` shape.
createRouteBindingRegistry.fromJSON = fromJSON;
