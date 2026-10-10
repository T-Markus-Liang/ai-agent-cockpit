// Personal AI OS 0.3.0 M02/I03b — unified provider/credential reference resolver
// (second slice, pure).
//
// Design intent (docs/plans/0.3.0-upgrade.md): replace the scattered ad-hoc
// tokenFile / private-file reads with ONE fail-closed resolver that turns a
// `"provider/modelId"` reference name into a resolved descriptor. Fail closed
// and never guess: an unregistered model or an unresolvable credential is a hard
// denial, mirroring pi-adapter.mjs `unresolved-model` (reject, do not fall back
// to another model or engine).
//
// Two hard rules this module enforces:
//   1. No retry storm and no global-config mutation. A resolve calls the
//      injected `lookup` AT MOST ONCE; failure is terminal for that call. The
//      module never writes configuration, never persists anything, never
//      retries.
//   2. Credential hygiene. The registry holds only references (baseUrl is
//      config, not secret; credentialRef is a NAME, not the value). The only
//      way a credential enters is the caller-injected `lookup`. Errors carry the
//      reference name only — never the credential value, never the raw error
//      message (which may embed a secret or a private path).
//
// Shape references (read-only, NOT modified):
//   - config/wechat-acp.json:18,28 — existing ad-hoc `tokenFile` references.
//   - control-plane/goal-ai.mjs — existing private ~/.dsh/.credentials.yaml read.
//   - runtime/pi-adapter.mjs:230,385 — `unresolved-model` fail-closed semantics.
//
// NOT WIRED IN THIS SLICE: this module is a pure library. It is not yet called
// by the bridge, the runtime adapter or the control plane; that wiring is a
// later slice. It is fully offline and side-effect free: no network, no file
// reads, no environment access, no credentials hard-coded, no runtime
// dependencies. It never mints authority and never touches storage.
//
// Contract — createProviderResolver({ registry, lookup }):
//   registry: object keyed by `"provider/modelId"` reference name, value
//             `{ provider, modelId, baseUrl?, credentialRef? }`. Validated
//             entry-by-entry at construction; any invalid entry throws
//             ProviderResolutionError("invalid-registry"). The whole registry
//             (and each entry) is deep-frozen in place, so a later resolve can
//             never mutate it.
//             Aliasing is allowed: several reference names may resolve to the
//             SAME provider/modelId with different credentialRef (multi-account
//             / multi-credential, e.g. `kimi/work` and `kimi/personal` both ->
//             `kimi/kimi-k3`). Resolution is strictly by reference name; no
//             provider/modelId pair is treated as a duplicate.
//   lookup:   caller-injected `async (credentialRef) => string | undefined`
//             (e.g. read a private tokenFile). The module itself NEVER reads
//             files / env / network.
//   resolve(modelRef) -> Promise<{ provider, modelId, baseUrl?, credential? }>
//     - modelRef not registered            -> ProviderResolutionError("unresolved-model"), lookup NOT called.
//     - entry has no credentialRef         -> resolved result (no `credential` field), lookup NOT called.
//     - entry has credentialRef            -> lookup called EXACTLY ONCE:
//         * non-empty string                 -> result carries `credential`;
//         * empty / undefined / non-string   -> ProviderResolutionError("unresolved-credential"), NO second call;
//         * lookup throws                    -> ProviderResolutionError("credential-lookup-failed") with the reference name only
//                                               (the raw error message is deliberately dropped).
//   Deterministic: identical inputs -> deeply equal output; every resolve call
//   triggers at most one lookup.

/** Reference-name shape: exactly one `/`, neither side empty or whitespace. */
const REFERENCE_NAME = /^[^\s/]+\/[^\s/]+$/;

/** Fail-closed denial. `code` identifies the reason; `message` names only refs. */
export class ProviderResolutionError extends Error {
	constructor(code, message) {
		super(message ?? `provider resolution rejected: ${code}`);
		this.name = "ProviderResolutionError";
		this.code = code;
	}
}

/** True for a non-null, non-array, plain-ish object. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usable baseUrl is an absolute http(s) URL. */
function isValidBaseUrl(value) {
	if (typeof value !== "string" || value.length === 0) return false;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** Recursively freeze an object graph in place, returning it. */
function deepFreeze(value) {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

/**
 * Validate one registry entry and return a normalized frozen copy holding only
 * the known fields. Throws ProviderResolutionError("invalid-registry") on any
 * shape violation; the message names only the reference name.
 */
function normalizeEntry(reference, entry) {
	if (!isPlainObject(entry)) {
		throw new ProviderResolutionError("invalid-registry", `registry entry for ${reference} must be an object`);
	}
	if (typeof entry.provider !== "string" || entry.provider.length === 0) {
		throw new ProviderResolutionError("invalid-registry", `registry entry for ${reference} is missing a non-empty provider`);
	}
	if (typeof entry.modelId !== "string" || entry.modelId.length === 0) {
		throw new ProviderResolutionError("invalid-registry", `registry entry for ${reference} is missing a non-empty modelId`);
	}

	const normalized = { provider: entry.provider, modelId: entry.modelId };

	if (entry.baseUrl !== undefined && entry.baseUrl !== null) {
		if (!isValidBaseUrl(entry.baseUrl)) {
			throw new ProviderResolutionError("invalid-registry", `registry entry for ${reference} has an invalid baseUrl`);
		}
		normalized.baseUrl = entry.baseUrl;
	}

	if (entry.credentialRef !== undefined && entry.credentialRef !== null) {
		if (typeof entry.credentialRef !== "string" || entry.credentialRef.length === 0) {
			throw new ProviderResolutionError("invalid-registry", `registry entry for ${reference} has an invalid credentialRef`);
		}
		normalized.credentialRef = entry.credentialRef;
	}

	return normalized;
}

/**
 * Create a fail-closed provider/credential resolver over a frozen registry.
 * @param {object} options
 * @param {Record<string, {provider: string, modelId: string, baseUrl?: string, credentialRef?: string}>} options.registry
 * @param {(credentialRef: string) => string | undefined | Promise<string | undefined>} [options.lookup]
 * @returns {{ resolve: (modelRef: string) => Promise<{provider: string, modelId: string, baseUrl?: string, credential?: string}> }}
 */
export function createProviderResolver({ registry, lookup } = {}) {
	if (!isPlainObject(registry)) {
		throw new ProviderResolutionError("invalid-registry", "registry must be an object");
	}
	if (lookup !== undefined && typeof lookup !== "function") {
		throw new ProviderResolutionError("invalid-registry", "lookup must be a function when provided");
	}

	// Validate every entry first (fail before exposing any resolve), then deep-
	// freeze the caller's registry in place so no later resolve can mutate it.
	const resolved = Object.create(null);
	for (const reference of Object.keys(registry)) {
		if (!REFERENCE_NAME.test(reference)) {
			throw new ProviderResolutionError("invalid-registry", `invalid reference name: ${reference}`);
		}
		const entry = normalizeEntry(reference, registry[reference]);
		resolved[reference] = Object.freeze(entry);
	}
	Object.freeze(resolved);
	deepFreeze(registry);

	async function resolve(modelRef) {
		if (typeof modelRef !== "string") {
			throw new ProviderResolutionError("unresolved-model", "model reference must be a string");
		}
		if (!Object.hasOwn(resolved, modelRef)) {
			throw new ProviderResolutionError("unresolved-model", `model reference not registered: ${modelRef}`);
		}

		const entry = resolved[modelRef];
		const result = { provider: entry.provider, modelId: entry.modelId };
		if (entry.baseUrl !== undefined) result.baseUrl = entry.baseUrl;

		if (entry.credentialRef !== undefined) {
			let credential;
			try {
				// At most one lookup per resolve call: no retry, no backoff loop.
				credential = await lookup(entry.credentialRef);
			} catch {
				// The raw error is dropped on purpose: it may embed a secret value
				// or a private file path. Only the reference name is reported.
				throw new ProviderResolutionError("credential-lookup-failed", `credential lookup failed for reference: ${entry.credentialRef}`);
			}
			if (typeof credential !== "string" || credential.length === 0) {
				throw new ProviderResolutionError("unresolved-credential", `credential reference did not resolve: ${entry.credentialRef}`);
			}
			result.credential = credential;
		}

		return result;
	}

	return { resolve };
}
