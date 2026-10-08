// Personal AI OS 0.3.0 M02/I03c — term-limited legacy adapter shell (third slice).
//
// Design intent (docs/plans/0.3.0-upgrade.md; M02/I03c): legacy is NOT a second
// permanent runtime base. It is a bounded, transitional compatibility facade that
// drives the OLD side ACP child-process model through a small injected `driver`,
// exposing the SAME RuntimePort shape as runtime/pi-adapter.mjs
// (submit / wait / observe / recover / abort) so the control plane can talk to
// "Runtime: legacy" without knowing the transport.
//
// This module adds NO new routing policy. Every logical rule about WHO owns a
// request, term limits, scope and idempotency is delegated to the frozen
// route-binding store (`config.store`): a legacy submit binds a `runtime:"legacy"`
// record (explicit expiresAt + non-empty allowedTaskIds from the adapter identity)
// and plans its advisory EffectIntent BEFORE any effect runs. A conflicting /
// expired / out-of-scope submission is refused with the store's own RouteBindingError
// code and the driver is never called.
//
// The whole point (the fixed acceptance): "先存 intent 再 effect，未知 native 启动
// 不重派，不永久双活":
//   1. INTENT-BEFORE-EFFECT — the durable binding + EffectIntent are committed, and
//      the submission mapping row is persisted (status "running"), before the driver
//      is touched. A crash between persistence and dispatch is recoverable by
//      reading the SAME request key back; nothing is guessed or replayed.
//   2. NO RE-DISPATCH OF UNKNOWN NATIVE LAUNCHES — `recover()` re-reads the durable
//      mapping and inspects each still-live/uncertain native session. A session that
//      is `alive` keeps its state; a `gone` session is marked `uncertain`. It NEVER
//      starts a new session and NEVER resends prompt text.
//   3. NO PERMANENT DUAL OWNERSHIP — the legacy adapter shares the SAME store as the
//      pi-durable path. If a request is already bound to `pi-durable`, the legacy
//      `bind` fails closed with `binding-conflict` before the driver is called; a
//      request can never be owned by two engines at once.
//
// Persistence: this adapter owns a small SQLite file of submission MAPPINGS
// (request -> submission/native-session/status). It does not persist execution
// beyond the mapping; the actual legacy run lives in the ACP child the driver owns.
//
// Boundary of this slice: no real ACP / model call is made here. The driver is
// injected; tests supply a FakeDriver. Abort scopes other than a single submission
// (goal-wide / execution / conversation) are REFUSED here — those belong to the pi
// adapter and the goal-runtime, not to this thin legacy facade.
//
// Dependencies: `node:sqlite` and the caller-supplied store only. No network, no
// environment access; the clock is injected via `now`.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** On-disk schema understood by this module's submission-mapping DB. */
export const SCHEMA_VERSION = 1;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** This adapter only ever speaks the "legacy" runtime. */
const RUNTIME = "legacy";

/** Terminal + transitional submission states, in a stable order for reporting. */
const SUBMISSION_STATUSES = Object.freeze(["running", "done", "failed", "uncertain", "cancelled"]);

/**
 * Abort scopes the legacy facade understands: exactly one — `submission`.
 *
 * `goal-wide`, `execution` and `conversation` are deliberately NOT handled here.
 * Product-goal cancellation lives in the goal-runtime; per-conversation and
 * per-execution cancellation live in the pi-durable adapter (they operate on the
 * durable admission mapping, which the legacy facade does not own). Rather than
 * silently approximating them with a single kill, this adapter refuses them.
 */
const REFUSED_SCOPE_KINDS = new Set(["goal-wide", "execution", "conversation"]);

/** Fail-closed denial. `code` identifies the reason for audit and tests. */
export class LegacyAdapterError extends Error {
	constructor(code, message, options) {
		super(message ?? `legacy adapter rejected: ${code}`, options);
		this.name = "LegacyAdapterError";
		this.code = code;
	}
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** Stable in-memory Map key for a requestKey pair (JSON avoids delimiter collisions). */
function submissionKey(requestKey) {
	return JSON.stringify([requestKey.ownerId, requestKey.sourceRequestId]);
}

/**
 * Validate the adapter-level legacy identity.
 *
 * `expiresAt` and `allowedTaskIds` are intentionally NOT validated here: a missing
 * term or scope must surface through the store's own fail-closed codes
 * (`legacy-expiry-required` / `legacy-scope-required`) when the binding is built,
 * not through a second, divergent policy in this shell.
 */
function normalizeIdentity(identity) {
	if (!isPlainObject(identity)) throw new LegacyAdapterError("invalid-identity", "identity must be an object");
	for (const field of ["codeVersion", "interfaceVersion", "profileId", "cwd", "authorizationDigest"]) {
		if (!isNonEmptyString(identity[field])) {
			throw new LegacyAdapterError("invalid-identity", `identity.${field} must be a non-empty string`);
		}
	}
	const modelRef = identity.modelRef;
	if (!isPlainObject(modelRef) || !isNonEmptyString(modelRef.provider) || !isNonEmptyString(modelRef.modelId)) {
		throw new LegacyAdapterError("invalid-identity", "identity.modelRef must be { provider, modelId } of non-empty strings");
	}
	return Object.freeze({
		codeVersion: identity.codeVersion,
		interfaceVersion: identity.interfaceVersion,
		modelRef: Object.freeze({ provider: modelRef.provider, modelId: modelRef.modelId }),
		profileId: identity.profileId,
		cwd: identity.cwd,
		authorizationDigest: identity.authorizationDigest,
		expiresAt: identity.expiresAt,
		allowedTaskIds: identity.allowedTaskIds,
	});
}

/** Validate a submit request, returning the fields this adapter consumes. */
function normalizeSubmitRequest(request) {
	if (!isPlainObject(request)) throw new LegacyAdapterError("invalid-request", "request must be an object");
	for (const field of ["ownerId", "sourceRequestId", "effectKey", "text"]) {
		if (!isNonEmptyString(request[field])) {
			throw new LegacyAdapterError("invalid-request", `request.${field} must be a non-empty string`);
		}
	}
	if (request.taskId !== undefined && !isNonEmptyString(request.taskId)) {
		throw new LegacyAdapterError("invalid-request", "request.taskId must be a non-empty string when provided");
	}
	return {
		ownerId: request.ownerId,
		sourceRequestId: request.sourceRequestId,
		effectKey: request.effectKey,
		taskId: request.taskId,
		text: request.text,
	};
}

/** Validate a `{ ownerId, sourceRequestId }` request key. */
function normalizeRequestKey(requestKey) {
	if (!isPlainObject(requestKey)) throw new LegacyAdapterError("invalid-request-key", "requestKey must be an object");
	if (!isNonEmptyString(requestKey.ownerId) || !isNonEmptyString(requestKey.sourceRequestId)) {
		throw new LegacyAdapterError("invalid-request-key", "requestKey requires non-empty ownerId and sourceRequestId");
	}
	return { ownerId: requestKey.ownerId, sourceRequestId: requestKey.sourceRequestId };
}

/** A frozen, secret-free projection of a stored submission record. */
function freezeSubmission(record) {
	const view = {
		submissionId: record.submissionId,
		requestKey: { ownerId: record.requestKey.ownerId, sourceRequestId: record.requestKey.sourceRequestId },
		effectKey: record.effectKey,
		status: record.status,
		nativeSessionId: record.nativeSessionId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
	if (record.taskId !== undefined) view.taskId = record.taskId;
	if (record.output !== undefined) view.output = record.output;
	return Object.freeze(view);
}

/**
 * Create a term-limited legacy adapter over an opened route-binding store.
 *
 * @param {object} config
 * @param {object} config.store    an opened route-binding store (openBindingStore)
 * @param {object} config.driver   injected async execution driver:
 *                                 `startSession(params) -> { nativeSessionId }`,
 *                                 `prompt(nativeSessionId, text) -> { status, output? }`,
 *                                 `kill(nativeSessionId)`, `status(nativeSessionId) -> "alive"|"gone"`.
 * @param {object} config.identity adapter-level legacy identity + term/scope.
 * @param {string} config.dbPath   path of the adapter's own submission-mapping SQLite file.
 * @param {() => number} [config.now] injected clock (default Date.now).
 */
export function createLegacyAdapter(config = {}) {
	if (!isPlainObject(config)) throw new LegacyAdapterError("invalid-config", "config must be an object");
	const { store, driver } = config;
	if (
		!isPlainObject(store) || typeof store.bind !== "function" ||
		typeof store.planEffect !== "function" || typeof store.resolve !== "function"
	) {
		throw new LegacyAdapterError("invalid-config", "config.store must be an opened route-binding store");
	}
	if (
		!isPlainObject(driver) ||
		["startSession", "prompt", "kill", "status"].some((method) => typeof driver[method] !== "function")
	) {
		throw new LegacyAdapterError("invalid-config", "config.driver must implement startSession/prompt/kill/status");
	}
	const identity = normalizeIdentity(config.identity);
	const now = config.now ?? Date.now;
	if (typeof now !== "function") throw new LegacyAdapterError("invalid-config", "config.now must be a function");
	if (!isNonEmptyString(config.dbPath)) {
		throw new LegacyAdapterError("invalid-config", "config.dbPath must be a non-empty string");
	}

	// Private parent (0700 when created) + private mapping file (0600).
	const absolute = resolvePath(config.dbPath);
	mkdirSync(dirname(absolute), { recursive: true, mode: DIR_MODE });
	const db = new DatabaseSync(absolute);
	chmodSync(absolute, FILE_MODE);

	// Schema bootstrap. `meta` first so the version is inspected BEFORE any other
	// table is touched; a conflicting version fails closed without being migrated.
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
	const versionRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
	if (versionRow === undefined) {
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
	} else if (Number(versionRow.value) !== SCHEMA_VERSION) {
		db.close();
		throw new LegacyAdapterError(
			"unsupported-schema-version",
			`unsupported legacy-adapter schema ${versionRow.value}; expected ${SCHEMA_VERSION}`,
		);
	}
	db.exec(
		"CREATE TABLE IF NOT EXISTS legacy_submissions (request_owner TEXT NOT NULL, request_id TEXT NOT NULL, " +
			"submission_id TEXT NOT NULL, native_session_id TEXT, status TEXT NOT NULL, record_json TEXT NOT NULL, " +
			"created_at REAL NOT NULL, PRIMARY KEY (request_owner, request_id))",
	);

	// In-memory submission mapping is the read authority; the DB is the durable mirror.
	let submissions = loadSubmissions();
	let closed = false;

	function loadSubmissions() {
		const map = new Map();
		for (const row of db.prepare("SELECT record_json FROM legacy_submissions").all()) {
			const record = JSON.parse(row.record_json);
			map.set(submissionKey(record.requestKey), record);
		}
		return map;
	}

	/** Run `work` inside a single IMMEDIATE write transaction (rollback on throw). */
	function inTransaction(work) {
		db.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			const result = work();
			db.exec("COMMIT");
			committed = true;
			return result;
		} finally {
			if (!committed) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// Already rolled back (or the commit failure already ended it).
				}
			}
		}
	}

	function writeRow(record, insert) {
		inTransaction(() => {
			if (insert) {
				db.prepare(
					"INSERT INTO legacy_submissions (request_owner, request_id, submission_id, native_session_id, status, record_json, created_at) " +
						"VALUES (?, ?, ?, ?, ?, ?, ?)",
				).run(
					record.requestKey.ownerId,
					record.requestKey.sourceRequestId,
					record.submissionId,
					record.nativeSessionId,
					record.status,
					JSON.stringify(record),
					record.createdAt,
				);
			} else {
				db.prepare(
					"UPDATE legacy_submissions SET submission_id = ?, native_session_id = ?, status = ?, record_json = ? " +
						"WHERE request_owner = ? AND request_id = ?",
				).run(
					record.submissionId,
					record.nativeSessionId,
					record.status,
					JSON.stringify(record),
					record.requestKey.ownerId,
					record.requestKey.sourceRequestId,
				);
			}
		});
	}

	/**
	 * Persist a submission, then publish it to memory. The DB write runs first
	 * (synchronously); a write failure leaves memory untouched. A crash after the
	 * write but before the in-memory set only ever loses the volatile copy — the
	 * durable mapping is complete and is what recover() re-reads.
	 */
	function save(record, insert) {
		writeRow(record, insert);
		submissions.set(submissionKey(record.requestKey), record);
		return record;
	}

	function statusCounts() {
		const counts = {};
		for (const status of SUBMISSION_STATUSES) counts[status] = 0;
		for (const record of submissions.values()) counts[record.status] = (counts[record.status] ?? 0) + 1;
		return counts;
	}

	function assertOpen() {
		if (closed) throw new LegacyAdapterError("adapter-closed", "legacy adapter is closed");
	}

	/**
	 * Deterministic binding createdAt: reuse the existing record's createdAt when a
	 * binding already exists (so a retry stays byte-identical and re-bind is
	 * idempotent), otherwise stamp the clock. An expired-but-present binding is not
	 * readable through the store's expiry gate, so it falls back to `now()`; that
	 * request is refused with `binding-expired` at planEffect regardless.
	 */
	function bindingCreatedAt(requestKey) {
		try {
			return store.resolve(requestKey).createdAt;
		} catch (error) {
			if (error?.code === "unbound-request" || error?.code === "binding-expired") return now();
			throw error;
		}
	}

	/** Build the legacy binding for one submit from the adapter identity + request. */
	function legacyBinding(normalized, requestKey) {
		return {
			requestKey,
			runtime: RUNTIME,
			codeVersion: identity.codeVersion,
			interfaceVersion: identity.interfaceVersion,
			modelRef: { provider: identity.modelRef.provider, modelId: identity.modelRef.modelId },
			profileId: identity.profileId,
			cwd: identity.cwd,
			authorizationDigest: identity.authorizationDigest,
			effectKey: normalized.effectKey,
			legacyScope: identity.allowedTaskIds === undefined ? undefined : { allowedTaskIds: [...identity.allowedTaskIds] },
			createdAt: bindingCreatedAt(requestKey),
			expiresAt: identity.expiresAt,
		};
	}

	/**
	 * Admit a legacy submission.
	 *
	 * Order (fixed): (1) durable legacy bind, (2) advisory EffectIntent plan, both
	 * through the shared store with the adapter's legacy expiry/scope; a conflict,
	 * expiry, or out-of-scope task is refused with the store's own code and the
	 * driver is NEVER called. (3) an existing submission for the same request key is
	 * returned unchanged (idempotent; the real execution count does not grow).
	 * (4) only then is the driver started; the mapping row is persisted BEFORE the
	 * effect. A driver failure marks the submission `uncertain` (the intent is
	 * already durable) and raises `driver-failure` — it is never silently retried.
	 */
	async function submit(request) {
		assertOpen();
		const normalized = normalizeSubmitRequest(request);
		const requestKey = { ownerId: normalized.ownerId, sourceRequestId: normalized.sourceRequestId };

		// (1) + (2): bind and plan through the frozen store. RouteBindingError codes
		// (binding-conflict / legacy-expiry-required / legacy-scope-required /
		// binding-expired / legacy-scope-violation) propagate untouched.
		store.bind(legacyBinding(normalized, requestKey));
		store.planEffect(requestKey, { effectKey: normalized.effectKey, taskId: normalized.taskId });

		// (3) idempotency: the same request key already has a submission.
		const existing = submissions.get(submissionKey(requestKey));
		if (existing !== undefined) return freezeSubmission(existing);

		// (4) intent is durable; persist the submission mapping (running) BEFORE the
		// effect so a crash mid-dispatch is recoverable by the SAME request key.
		const createdAt = now();
		const record = {
			submissionId: randomUUID(),
			requestKey,
			effectKey: normalized.effectKey,
			...(normalized.taskId === undefined ? {} : { taskId: normalized.taskId }),
			status: "running",
			nativeSessionId: null,
			createdAt,
			updatedAt: createdAt,
		};
		save(record, true);

		try {
			const started = await driver.startSession({
				requestKey,
				effectKey: normalized.effectKey,
				...(normalized.taskId === undefined ? {} : { taskId: normalized.taskId }),
				text: normalized.text,
			});
			const nativeSessionId = started?.nativeSessionId;
			if (!isNonEmptyString(nativeSessionId)) {
				throw new LegacyAdapterError("driver-failure", "driver.startSession did not return a nativeSessionId");
			}
			record.nativeSessionId = nativeSessionId;
			record.updatedAt = now();
			save(record, false);

			const result = await driver.prompt(nativeSessionId, normalized.text);
			record.status = result?.status === "failed" ? "failed" : "done";
			if (result?.output !== undefined) record.output = result.output;
			record.updatedAt = now();
			save(record, false);
		} catch (error) {
			// The intent is already durable; the mapping becomes `uncertain` so a
			// later recover() reconciles it against the real native session. We never
			// silently retry — the caller sees the failure.
			record.status = "uncertain";
			record.updatedAt = now();
			save(record, false);
			throw new LegacyAdapterError("driver-failure", `legacy driver failed: ${error?.message ?? String(error)}`, { cause: error });
		}
		return freezeSubmission(record);
	}

	/** Current persisted state (and output, if any) of one submission. */
	async function wait(requestKey) {
		assertOpen();
		const key = normalizeRequestKey(requestKey);
		const record = submissions.get(submissionKey(key));
		if (record === undefined) {
			throw new LegacyAdapterError("unknown-submission", `no legacy submission for request ${key.ownerId}/${key.sourceRequestId}`);
		}
		return freezeSubmission(record);
	}

	/** Adapter-level snapshot: submission/status counts plus a secret-free identity summary. */
	function observe() {
		assertOpen();
		return Object.freeze({
			runtime: RUNTIME,
			submissions: submissions.size,
			byStatus: Object.freeze(statusCounts()),
			identity: Object.freeze({
				codeVersion: identity.codeVersion,
				interfaceVersion: identity.interfaceVersion,
				modelRef: identity.modelRef,
				profileId: identity.profileId,
				cwd: identity.cwd,
				expiresAt: identity.expiresAt ?? null,
				allowedTaskIds: Object.freeze([...(identity.allowedTaskIds ?? [])]),
			}),
		});
	}

	/**
	 * Re-read the durable submission mapping and reconcile in-flight sessions.
	 *
	 * For every `running`/`uncertain` submission we ask the driver about its EXISTING
	 * native session: `alive` keeps the record exactly as it is; anything else is
	 * marked `uncertain`. A submission with no recorded native session (startSession
	 * never returned) is `uncertain` too. This NEVER starts a new session, NEVER
	 * resends prompt text, and never promotes a submission to a terminal success.
	 */
	async function recover() {
		assertOpen();
		submissions = loadSubmissions();
		let checked = 0;
		let alive = 0;
		let gone = 0;
		for (const record of [...submissions.values()]) {
			if (record.status !== "running" && record.status !== "uncertain") continue;
			checked += 1;
			let observed = "gone";
			if (isNonEmptyString(record.nativeSessionId)) {
				observed = await driver.status(record.nativeSessionId);
			}
			if (observed === "alive") {
				alive += 1; // keep the record exactly as it is
				continue;
			}
			gone += 1;
			if (record.status !== "uncertain") {
				record.status = "uncertain";
				record.updatedAt = now();
				save(record, false);
			}
		}
		const counts = statusCounts();
		return Object.freeze({
			recovered: true,
			total: submissions.size,
			checked,
			alive,
			gone,
			running: counts.running,
			uncertain: counts.uncertain,
		});
	}

	/**
	 * Abort exactly one submission: kill its native session and mark it cancelled.
	 *
	 * Only `{ kind: "submission", requestKey }` is accepted. `goal-wide`,
	 * `execution` and `conversation` scopes belong to the goal-runtime / the
	 * pi-durable adapter (which own their respective mappings) and are refused here.
	 */
	async function abort(scope) {
		assertOpen();
		const kind = isPlainObject(scope) ? scope.kind : scope;
		if (kind === undefined || kind === null) {
			throw new LegacyAdapterError("scope-required", "abort requires an explicit scope");
		}
		if (REFUSED_SCOPE_KINDS.has(kind)) {
			throw new LegacyAdapterError(
				"unsupported-scope",
				`abort scope '${kind}' is not offered by the legacy adapter (owned by the pi runtime / goal-runtime)`,
			);
		}
		if (kind !== "submission") {
			throw new LegacyAdapterError("unsupported-scope", `unsupported abort scope: ${String(kind)}`);
		}
		const key = normalizeRequestKey(scope.requestKey);
		const record = submissions.get(submissionKey(key));
		if (record === undefined) {
			throw new LegacyAdapterError("unknown-submission", `no legacy submission for request ${key.ownerId}/${key.sourceRequestId}`);
		}
		if (isNonEmptyString(record.nativeSessionId) && record.status !== "cancelled") {
			await driver.kill(record.nativeSessionId);
		}
		record.status = "cancelled";
		record.updatedAt = now();
		save(record, false);
		return freezeSubmission(record);
	}

	/** Close the submission-mapping DB handle (the shared store is the caller's). */
	function close() {
		if (closed) return;
		closed = true;
		db.close();
	}

	return { submit, wait, observe, recover, abort, close, dbPath: absolute };
}
