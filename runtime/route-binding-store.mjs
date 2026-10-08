// Personal AI OS 0.3.0 M02/I03c — durable route-binding store (second slice).
//
// Persistence + V03 atomicity layer for the frozen in-memory route-binding
// contract in ./route-binding.mjs. This module adds NO new routing policy: every
// logical rule (single owner per request, idempotent re-bind, fail-closed
// binding-conflict, term-limited legacy expiry/scope, advisory EffectIntent) is
// delegated to `createRouteBindingRegistry`, which stays untouched. Here we only
// make the same registry durable across process restarts.
//
// Design intent (docs/plans/0.3.0-upgrade.md; M02/I03c second slice):
//   Persist a route binding so a request stays bound to exactly one engine even
//   after a crash/restart, and so a prepared effect intent is not lost.
//
// V03 ATOMICITY (the whole point of this slice)
//   "Writing the binding and writing the intent must not leave half a record."
//   The observable failure we forbid is a *durable* split between the binding
//   row and the intent row (a binding with no matching intent, or an intent with
//   no binding). Two mechanisms guarantee it:
//
//     1. Single-statement write transactions. Every durable write runs under
//        `BEGIN IMMEDIATE` ... `COMMIT`. Today each write is exactly one INSERT,
//        so it is atomic by construction; the transaction wrapper is kept so
//        future multi-row writes stay atomic for free. An uncommitted
//        transaction (crash / power loss / a connection closed without COMMIT)
//        is rolled back by SQLite's journal, so a half-written row never
//        survives a restart.
//     2. Write-through memory with rollback. The in-memory registry is the
//        logical authority; the DB is the durable mirror.
//
//   MEMORY/DB CONSISTENCY SCHEME (why there is never "in memory but not in DB")
//     - `bind` / `planEffect` first apply the change to the in-memory registry
//       (reusing route-binding's exact logic — validation, conflict detection,
//       idempotency). If that throws (invalid-binding / binding-conflict /
//       binding-expired / effect-conflict / legacy-scope-violation), neither the
//       registry nor the DB was touched.
//     - A change that does NOT grow the registry (an idempotent re-bind or
//       re-plan) is returned as-is and writes NOTHING to the DB.
//     - A change that DOES grow the registry is persisted immediately, inside a
//       single IMMEDIATE transaction, before the call returns. node:sqlite's
//       `DatabaseSync` is fully synchronous, so the decision and the INSERT/COMMIT
//       execute in one uninterrupted critical section: no other reader can ever
//       observe the in-memory record while the DB row is still missing.
//     - If the INSERT/COMMIT fails, the durable state is unchanged (the
//       transaction rolled back), so we re-load the registry FROM THE DB. Memory
//       is thereby rolled back to exactly the durable state; the error is
//       rethrown and the caller sees a failure with zero durable effect — never
//       "memory has it, DB does not".
//     - A crash *between* the in-memory update and the COMMIT kills the process,
//       so the volatile in-memory record vanishes with it; the DB is either fully
//       committed or fully rolled back. No half state is durable either way.
//     The DB is only ever read back to rebuild memory, never auto-migrated,
//     auto-healed or silently downgraded.
//
// Schema (SCHEMA_VERSION = 1):
//   meta(key TEXT PRIMARY KEY, value TEXT)
//     one row: ('schema_version', '1').
//   bindings(request_owner, request_id, record_json, created_at,
//            PRIMARY KEY (request_owner, request_id))
//     one normalized route-binding record per request.
//   intents(request_owner, request_id, effect_key, intent_json, created_at,
//           PRIMARY KEY (request_owner, request_id, effect_key))
//     one advisory EffectIntent per (request, effectKey).
//
// Fail-closed schema handling: a store whose meta.schema_version exists and is
// not SCHEMA_VERSION is refused with RouteBindingError("unsupported-schema-version").
// It is never migrated, never erased, never read at a downgraded version.
//
// Dependencies: `node:sqlite` and ./route-binding.mjs only. No network, no
// environment access; the clock is injected via `now`.

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createRouteBindingRegistry, RouteBindingError } from "./route-binding.mjs";

/** On-disk schema understood by this module. */
export const SCHEMA_VERSION = 1;

// Serialization envelope identity, matching route-binding.mjs:55-56. Pinned here
// (route-binding does not export it) so a rebuild from stored records is
// re-validated through exactly the same loader the pure module publishes.
const SERIALIZATION_TYPE = "RouteBindingRegistry";
const SERIALIZATION_VERSION = 1;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Wrap a caller clock. A non-function clock fails closed before any IO; a broken
 * clock is surfaced by the registry itself where it matters (expiry/created_at).
 */
function createClock(now) {
	if (now !== undefined && typeof now !== "function") {
		throw new RouteBindingError("invalid-registry", "now must be a function when provided");
	}
	return now ?? Date.now;
}

/**
 * Open a durable route-binding store at `dbPath`.
 *
 * The parent directory is created 0700 when missing, the database file is
 * restricted to 0600. An unknown/absent schema version is initialized to
 * SCHEMA_VERSION; a conflicting version fails closed.
 *
 * Store API (all synchronous, backed by node:sqlite `DatabaseSync`):
 *   bind(binding)                              -> frozen Binding (idempotent, durable)
 *   resolve(requestKey)                        -> frozen Binding (expiry-gated)
 *   planEffect(requestKey, { effectKey, taskId? }) -> frozen EffectIntent (idempotent, durable)
 *   close()                                    -> close the DB handle
 *   size / intentCount                         -> live registry counters
 *   dbPath                                     -> the resolved absolute path
 *
 * @param {string} dbPath
 * @param {{ now?: () => number }} [options]
 */
export function openBindingStore(dbPath, { now } = {}) {
	if (typeof dbPath !== "string" || dbPath.length === 0) {
		throw new RouteBindingError("invalid-binding", "dbPath must be a non-empty string");
	}
	const clock = createClock(now);
	const absolute = resolvePath(dbPath);

	// Private parent (created 0700 only when missing; an existing directory is
	// left exactly as it is) + private file (0600).
	mkdirSync(dirname(absolute), { recursive: true, mode: DIR_MODE });
	const db = new DatabaseSync(absolute);
	chmodSync(absolute, FILE_MODE);

	// Schema bootstrap. `meta` is ensured first so the version can be inspected
	// BEFORE any other table is touched. On a version conflict we refuse without
	// creating bindings/intents, so a foreign DB is never modified.
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
	const versionRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
	if (versionRow === undefined) {
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
	} else if (Number(versionRow.value) !== SCHEMA_VERSION) {
		db.close();
		throw new RouteBindingError(
			"unsupported-schema-version",
			`unsupported route-binding store schema ${versionRow.value}; expected ${SCHEMA_VERSION}`,
		);
	}
	db.exec(
		"CREATE TABLE IF NOT EXISTS bindings (request_owner TEXT NOT NULL, request_id TEXT NOT NULL, " +
			"record_json TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (request_owner, request_id))",
	);
	db.exec(
		"CREATE TABLE IF NOT EXISTS intents (request_owner TEXT NOT NULL, request_id TEXT NOT NULL, " +
			"effect_key TEXT NOT NULL, intent_json TEXT NOT NULL, created_at REAL NOT NULL, " +
			"PRIMARY KEY (request_owner, request_id, effect_key))",
	);

	// Mutable holder so a rollback can swap in a freshly-reloaded registry while
	// every closure keeps reading the current authority.
	const state = { registry: undefined };

	/**
	 * Rebuild the in-memory registry from the durable rows, through route-binding's
	 * published fromJSON loader (full re-validation; clock-independent restore, so
	 * a stored-but-expired legacy binding loads and only fails later at resolve).
	 */
	function loadRegistry() {
		const bindings = db
			.prepare("SELECT record_json FROM bindings")
			.all()
			.map((row) => JSON.parse(row.record_json));
		const intents = db
			.prepare("SELECT intent_json FROM intents")
			.all()
			.map((row) => JSON.parse(row.intent_json));
		return createRouteBindingRegistry.fromJSON(
			{ type: SERIALIZATION_TYPE, version: SERIALIZATION_VERSION, bindings, intents },
			{ now: clock },
		);
	}

	/**
	 * Run `work` inside a single IMMEDIATE write transaction. A thrown error (or a
	 * failed COMMIT) leaves the transaction rolled back and the DB untouched.
	 */
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

	function insertBindingRow(record) {
		inTransaction(() => {
			db.prepare(
				"INSERT INTO bindings (request_owner, request_id, record_json, created_at) VALUES (?, ?, ?, ?)",
			).run(record.requestKey.ownerId, record.requestKey.sourceRequestId, JSON.stringify(record), record.createdAt);
		});
	}

	function insertIntentRow(intent, createdAt) {
		inTransaction(() => {
			db.prepare(
				"INSERT INTO intents (request_owner, request_id, effect_key, intent_json, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(
				intent.requestKey.ownerId,
				intent.requestKey.sourceRequestId,
				intent.effectKey,
				JSON.stringify(intent),
				createdAt,
			);
		});
	}

	// Roll the in-memory registry back to the durable truth after a failed write.
	// Best-effort: if even the reload fails the original error is preserved.
	function rollbackMemory(originalError) {
		try {
			state.registry = loadRegistry();
		} catch {
			// Preserve the original write failure.
		}
		throw originalError;
	}

	function bind(binding) {
		const before = state.registry.size;
		// Reuse route-binding semantics: validates, returns the existing record on
		// an identical re-bind, throws on conflict/invalid. A throw mutates nothing.
		const record = state.registry.bind(binding);
		if (state.registry.size === before) return record; // idempotent: no DB write
		try {
			insertBindingRow(record);
		} catch (error) {
			rollbackMemory(error);
		}
		return record;
	}

	function resolve(requestKey) {
		return state.registry.resolve(requestKey);
	}

	function planEffect(requestKey, options = {}) {
		const before = state.registry.intentCount;
		const intent = state.registry.planEffect(requestKey, options);
		if (state.registry.intentCount === before) return intent; // idempotent: no DB write
		try {
			insertIntentRow(intent, clock());
		} catch (error) {
			rollbackMemory(error);
		}
		return intent;
	}

	let closed = false;
	function close() {
		if (closed) return;
		closed = true;
		db.close();
	}

	state.registry = loadRegistry();

	return {
		bind,
		resolve,
		planEffect,
		close,
		get size() {
			return state.registry.size;
		},
		get intentCount() {
			return state.registry.intentCount;
		},
		get dbPath() {
			return absolute;
		},
	};
}
