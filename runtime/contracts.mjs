// P2-B versioned RuntimePort contract.
//
// Bounded, no-permission adapter contract:
//   - a request is a set of caller-supplied REFERENCES, not an approval. The
//     `authorizationDigest` is an opaque caller string canonicalized into the
//     request digest; it is not verified and grants nothing.
//   - the digest binds the caller identity fields plus optional modelRef/cwd. A
//     supplied `payloadDigest` must equal the computed digest.
//   - this module is pure validation/canonicalization: no storage, no models,
//     no tool permissions.
//
// Nothing here mints authority. A future policy broker is still required before
// any real tool/native effect is offered.

import { createHash } from "node:crypto";

/** Version of the whole adapter contract (validation, hashing, doc shape). */
export const CONTRACT_VERSION = 1;
/** Version of the admission-mapping document VALUE shape. */
export const ADMISSION_SCHEMA_VERSION = 1;
/** Registry contract the adapter understands. Unknown versions are refused. */
export const REGISTRY_SCHEMA_VERSION = 1;

/** Session-scoped singleton document kind holding the admission mapping. */
export const ADMISSION_DOC_KIND = "aios.runtime.admission";
/** Persisted document definition version; a higher stored version is refused. */
export const ADMISSION_DOC_VERSION = 1;

/** Fields a caller may supply on a request; any other field is refused. */
const REQUEST_FIELDS = new Set([
	"ownerId",
	"sourceRequestId",
	"content",
	"productTaskId",
	"executionId",
	"profileId",
	"authorizationDigest",
	"modelRef",
	"cwd",
	"payloadDigest",
	"ownership",
]);

/**
 * Ownership kinds a request may declare (M02/I03a). `foreground` work shares the
 * conversation's ordinary scope; `background` work is bound to an explicit
 * execution/goal and survives foreground-scoped cancellation.
 */
const OWNERSHIP_KINDS = new Set(["foreground", "background"]);
/** Fields allowed inside one `request.ownership` object; any other key is refused. */
const OWNERSHIP_FIELDS = new Set(["kind", "executionId", "goalId", "executionIdSource"]);
/** How a background scope's executionId was resolved (M02-F003). */
const EXECUTION_ID_SOURCES = new Set(["nested", "top-level"]);

/**
 * Effective ownership of a request that predates the ownership field. Read-side
 * only: legacy mapping records are normalized to this value in memory, never
 * rewritten on disk, so the stored document keeps whatever shape it had.
 */
export const DEFAULT_OWNERSHIP = Object.freeze({ kind: "foreground" });

/**
 * Validate the shape of one ownership object under `code`. Shared by request
 * validation (invalid-request-field) and mapping validation (malformed-mapping).
 */
function assertOwnership(ownership, code) {
	if (!isPlainObject(ownership)) throw new ContractRejected(code, "ownership must be an object");
	for (const key of Object.keys(ownership)) {
		if (!OWNERSHIP_FIELDS.has(key)) throw new ContractRejected(code, `unknown ownership field: ${key}`);
	}
	if (typeof ownership.kind !== "string" || !OWNERSHIP_KINDS.has(ownership.kind)) {
		throw new ContractRejected(code, "ownership.kind must be foreground or background");
	}
	if (ownership.kind === "foreground") {
		// A foreground scope is the conversation's ordinary scope; an execution or
		// goal binding on it would contradict that, so it is refused rather than ignored.
		if (ownership.executionId !== undefined || ownership.goalId !== undefined || ownership.executionIdSource !== undefined) {
			throw new ContractRejected(code, "foreground ownership cannot carry executionId, goalId or executionIdSource");
		}
		return;
	}
	if (ownership.executionIdSource !== undefined && !EXECUTION_ID_SOURCES.has(ownership.executionIdSource)) {
		throw new ContractRejected(code, "ownership.executionIdSource must be 'nested' or 'top-level'");
	}
	for (const field of ["executionId", "goalId"]) {
		const value = ownership[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim() === "" || value.length > MAX_REFERENCE_LENGTH) {
			throw new ContractRejected(code, `ownership.${field} must be a bounded nonempty string`);
		}
	}
}

/**
 * Validate and normalize one optional ownership object, defaulting to foreground.
 *
 * A background scope MUST resolve to an execution id (M02-F003). The nested
 * `ownership.executionId` is authoritative; when it is absent the request's
 * required top-level `executionId` is adopted and recorded as
 * `executionIdSource: "top-level"`. A nested id that contradicts a present
 * top-level id is fail-closed, and a background scope with no resolvable
 * execution id at all is refused before any admission effect, so a later caller
 * can never discover an un-cancellable running task.
 *
 * Mapping validation (`assertOwnership` under `malformed-mapping`) stays lenient
 * about the missing id: legacy r1 records that wrote `{kind:"background"}` with no
 * executionId must still read back, they simply stay un-cancellable by scope.
 */
function normalizeOwnership(ownership, topLevelExecutionId) {
	if (ownership === undefined) return DEFAULT_OWNERSHIP;
	assertOwnership(ownership, "invalid-request-field");
	if (ownership.kind === "foreground") return DEFAULT_OWNERSHIP;
	const topLevel = typeof topLevelExecutionId === "string" && topLevelExecutionId.trim() !== "" && topLevelExecutionId.length <= MAX_REFERENCE_LENGTH
		? topLevelExecutionId
		: undefined;
	if (ownership.executionId !== undefined && topLevel !== undefined && ownership.executionId !== topLevel) {
		throw new ContractRejected("ownership-execution-conflict", "background ownership.executionId contradicts the request's top-level executionId");
	}
	const executionId = ownership.executionId ?? topLevel;
	if (executionId === undefined) {
		throw new ContractRejected("missing-execution-binding", "background ownership requires an executionId: set ownership.executionId or a top-level request.executionId");
	}
	const normalized = { kind: "background", executionId };
	if (ownership.executionId === undefined) normalized.executionIdSource = "top-level";
	if (ownership.goalId !== undefined) normalized.goalId = ownership.goalId;
	return Object.freeze(normalized);
}

/** Read the effective ownership of a persisted request record (legacy default). */
export function effectiveOwnership(record) {
	return record?.ownership ?? DEFAULT_OWNERSHIP;
}

/** Non-empty caller references required on every request. */
const REQUIRED_REFERENCES = [
	"ownerId",
	"sourceRequestId",
	"productTaskId",
	"executionId",
	"profileId",
	"authorizationDigest",
];

/** Upper bound for any single caller reference/identifier string. */
export const MAX_REFERENCE_LENGTH = 512;
/** Upper bound for the input content of one request. */
export const MAX_CONTENT_LENGTH = 1_000_000;
/** A field that must be a lowercase SHA-256 hex digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isHexDigest(value) {
	return typeof value === "string" && SHA256_HEX.test(value);
}

/** Fail-closed contract rejection. `code` identifies the denial reason. */
export class ContractRejected extends Error {
	constructor(code, message, options) {
		super(message ?? `runtime contract rejected: ${code}`, options);
		this.name = "ContractRejected";
		this.code = code;
	}
}

/** Reject a same-request-key submission whose body/profile/digest changed. */
export class RequestConflict extends ContractRejected {
	constructor(code, message) {
		super(code ?? "request-conflict", message ?? "request key already bound to a different request");
		this.name = "RequestConflict";
		this.status = 409;
	}
}

/** SHA-256 hex; used for every object key derived from caller input. */
export function hashKey(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalize a request. Rejects unknown fields, missing/empty
 * references, and malformed optional fields BEFORE any caller effect. Returns a
 * frozen normalized copy containing only recognized fields.
 */
export function validateRequest(request) {
	if (!isPlainObject(request)) throw new ContractRejected("invalid-request", "request must be a plain object");
	for (const key of Object.keys(request)) {
		if (!REQUEST_FIELDS.has(key)) throw new ContractRejected("unknown-field", `unknown request field: ${key}`);
	}
	// Resolve ownership BEFORE any other reference check so a background scope that
	// carries no resolvable execution binding is refused at the top of admission
	// (M02-F003), never after a row or a generation exists.
	const ownership = normalizeOwnership(request.ownership, request.executionId);
	for (const field of REQUIRED_REFERENCES) {
		const value = request[field];
		if (typeof value !== "string" || value.trim() === "") {
			throw new ContractRejected("invalid-request-field", `request.${field} must be a nonempty string`);
		}
		if (value.length > MAX_REFERENCE_LENGTH) {
			throw new ContractRejected("invalid-request-field", `request.${field} exceeds ${MAX_REFERENCE_LENGTH} characters`);
		}
	}
	if (typeof request.content !== "string" || request.content.length === 0) {
		throw new ContractRejected("invalid-request-field", "request.content must be a nonempty string");
	}
	if (request.content.length > MAX_CONTENT_LENGTH) {
		throw new ContractRejected("invalid-request-field", `request.content exceeds ${MAX_CONTENT_LENGTH} characters`);
	}
	const normalized = {
		ownerId: request.ownerId,
		sourceRequestId: request.sourceRequestId,
		content: request.content,
		productTaskId: request.productTaskId,
		executionId: request.executionId,
		profileId: request.profileId,
		authorizationDigest: request.authorizationDigest,
	};
	if (request.modelRef !== undefined) {
		const modelRef = request.modelRef;
		if (!isPlainObject(modelRef)) throw new ContractRejected("invalid-request-field", "request.modelRef must be an object");
		const keys = Object.keys(modelRef);
		if (keys.length !== 2 || keys.some((key) => key !== "provider" && key !== "modelId")) {
			throw new ContractRejected("invalid-request-field", "request.modelRef must have exactly provider and modelId");
		}
		if (typeof modelRef.provider !== "string" || modelRef.provider.trim() === "" || typeof modelRef.modelId !== "string" || modelRef.modelId.trim() === "") {
			throw new ContractRejected("invalid-request-field", "request.modelRef provider/modelId must be nonempty strings");
		}
		if (modelRef.provider.length > MAX_REFERENCE_LENGTH || modelRef.modelId.length > MAX_REFERENCE_LENGTH) {
			throw new ContractRejected("invalid-request-field", `request.modelRef fields exceed ${MAX_REFERENCE_LENGTH} characters`);
		}
		normalized.modelRef = { provider: modelRef.provider, modelId: modelRef.modelId };
	}
	if (request.cwd !== undefined) {
		if (typeof request.cwd !== "string" || request.cwd.trim() === "") {
			throw new ContractRejected("invalid-request-field", "request.cwd must be a nonempty string");
		}
		if (request.cwd.length > MAX_REFERENCE_LENGTH) {
			throw new ContractRejected("invalid-request-field", `request.cwd exceeds ${MAX_REFERENCE_LENGTH} characters`);
		}
		normalized.cwd = request.cwd;
	}
	if (request.payloadDigest !== undefined) {
		if (typeof request.payloadDigest !== "string" || request.payloadDigest.trim() === "") {
			throw new ContractRejected("invalid-request-field", "request.payloadDigest must be a nonempty string");
		}
		if (!isHexDigest(request.payloadDigest)) {
			throw new ContractRejected("invalid-request-field", "request.payloadDigest must be a 64-character lowercase SHA-256 hex digest");
		}
		normalized.payloadDigest = request.payloadDigest;
	}
	// Ownership is normalized to an explicit object so every new request record
	// persists it; an absent/foreground request is pinned to the default.
	normalized.ownership = ownership;
	return Object.freeze(normalized);
}

function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
		.join(",")}}`;
}

/**
 * Canonical digest over the caller references plus modelRef/cwd when present.
 * `payloadDigest` is intentionally excluded so it can be compared to the result.
 */
export function computeDigest(normalized) {
	const canonical = {
		ownerId: normalized.ownerId,
		sourceRequestId: normalized.sourceRequestId,
		content: normalized.content,
		productTaskId: normalized.productTaskId,
		executionId: normalized.executionId,
		profileId: normalized.profileId,
		authorizationDigest: normalized.authorizationDigest,
	};
	if (normalized.modelRef !== undefined) canonical.modelRef = { provider: normalized.modelRef.provider, modelId: normalized.modelRef.modelId };
	if (normalized.cwd !== undefined) canonical.cwd = normalized.cwd;
	return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/** Stable SHA-256 key for one owner/source-request pair. */
export function requestKeyFor(ownerId, sourceRequestId) {
	// Hash a JSON tuple, not a delimiter-joined string: a NUL (or any delimiter)
	// inside either reference cannot collide with a different pair.
	return hashKey(JSON.stringify([ownerId, sourceRequestId]));
}

function assertNonEmptyString(record, field) {
	if (typeof record[field] !== "string" || record[field].length === 0) {
		throw new ContractRejected("malformed-mapping", `admission mapping ${field} must be a nonempty string`);
	}
}

function assertModelRefShape(record) {
	if (!isPlainObject(record.modelRef) || typeof record.modelRef.provider !== "string" || record.modelRef.provider.length === 0 || typeof record.modelRef.modelId !== "string" || record.modelRef.modelId.length === 0) {
		throw new ContractRejected("malformed-mapping", "admission mapping modelRef must be a provider/modelId object");
	}
}

/** Validate the materialized admission document value. Unknown versions are refused, never erased. */
export function assertAdmissionDoc(value) {
	if (!isPlainObject(value)) {
		throw new ContractRejected("unknown-mapping-version", "unsupported admission mapping version malformed");
	}
	if (value.schemaVersion !== ADMISSION_SCHEMA_VERSION || value.contractVersion !== CONTRACT_VERSION) {
		throw new ContractRejected("unknown-mapping-version", `unsupported admission mapping version ${value.schemaVersion}/${value.contractVersion}`);
	}
	if (!isPlainObject(value.owners) || !isPlainObject(value.requests) || !isPlainObject(value.submissions)) {
		throw new ContractRejected("malformed-mapping", "admission mapping owners/requests/submissions must be objects");
	}
	for (const owner of Object.values(value.owners)) {
		if (!isPlainObject(owner)) throw new ContractRejected("malformed-mapping", "admission owner record must be an object");
		assertNonEmptyString(owner, "ownerId");
		assertNonEmptyString(owner, "profileId");
		if (!Number.isSafeInteger(owner.conversationId) || owner.conversationId <= 0) {
			throw new ContractRejected("malformed-mapping", "admission owner conversationId must be a positive integer");
		}
		assertModelRefShape(owner);
		if (owner.toolProfile !== undefined && (!isPlainObject(owner.toolProfile) || owner.toolProfile.version !== 1 ||
			Object.keys(owner.toolProfile).some(key => !['version', 'digest'].includes(key)) || !/^sha256:[a-f0-9]{64}$/.test(owner.toolProfile.digest))) {
			throw new ContractRejected('unknown-tool-profile', 'unsupported stored tool profile');
		}
		if (owner.cwd !== undefined && owner.cwd !== null && typeof owner.cwd !== "string") {
			throw new ContractRejected("malformed-mapping", "admission owner cwd must be a string or null");
		}
	}
	for (const request of Object.values(value.requests)) {
		if (!isPlainObject(request)) throw new ContractRejected("malformed-mapping", "admission request record must be an object");
		assertNonEmptyString(request, "ownerId");
		assertNonEmptyString(request, "sourceRequestId");
		assertNonEmptyString(request, "digest");
		assertNonEmptyString(request, "productTaskId");
		assertNonEmptyString(request, "executionId");
		assertNonEmptyString(request, "profileId");
		assertNonEmptyString(request, "authorizationDigest");
		if (!Number.isSafeInteger(request.conversationId) || request.conversationId <= 0) {
			throw new ContractRejected("malformed-mapping", "admission request conversationId must be a positive integer");
		}
		assertModelRefShape(request);
		if (request.cwd !== undefined && typeof request.cwd !== "string") {
			throw new ContractRejected("malformed-mapping", "admission request cwd must be a string");
		}
		// Ownership is optional on legacy records; when present it must be a valid
		// object. A missing field reads back as foreground via `effectiveOwnership`.
		if (request.ownership !== undefined) assertOwnership(request.ownership, "malformed-mapping");
	}
  for (const [key, owner] of Object.entries(value.owners)) {
    if (key !== hashKey(owner.ownerId)) throw new ContractRejected("malformed-mapping", "owner key mismatch");
  }
  for (const [key, request] of Object.entries(value.requests)) {
    const owner = value.owners[hashKey(request.ownerId)];
    if (key !== requestKeyFor(request.ownerId, request.sourceRequestId)
        || request.ownerHash !== hashKey(request.ownerId) || !owner
        || request.conversationId !== owner.conversationId || request.profileId !== owner.profileId
        || request.modelRef.provider !== owner.modelRef.provider || request.modelRef.modelId !== owner.modelRef.modelId
        || (request.cwd ?? null) !== (owner.cwd ?? null) || !/^[0-9a-f]{64}$/.test(request.digest)) {
      throw new ContractRejected("malformed-mapping", "request binding mismatch");
    }
  }
  if (new Set(Object.values(value.submissions)).size !== Object.keys(value.submissions).length) {
    throw new ContractRejected("malformed-mapping", "submission bound more than once");
  }
  for (const [key, submissionId] of Object.entries(value.submissions)) {
    if (!Object.hasOwn(value.requests, key)) throw new ContractRejected("malformed-mapping", "orphan submission binding");
		if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
			throw new ContractRejected("malformed-mapping", "admission submission id must be a positive integer");
		}
	}
}

/** Validate the caller-supplied registry contract version. */
export function assertRegistryVersion(version) {
	if (version !== REGISTRY_SCHEMA_VERSION) {
		throw new ContractRejected("unknown-registry-version", `unsupported registry schema version ${version}`);
	}
}

/** Empty admission mapping value; also the document's initial value. */
export function initialAdmissionDoc() {
	return {
		schemaVersion: ADMISSION_SCHEMA_VERSION,
		contractVersion: CONTRACT_VERSION,
		owners: {},
		requests: {},
		submissions: {},
	};
}
