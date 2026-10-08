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
//       transaction rolled back), but the store does NOT pretend to have
//       recovered: it enters a POISONED state. The grown in-memory record is
//       discarded (best-effort re-load from the DB; if even that fails the
//       registry is left empty), the original error is rethrown, and every later
//       authoritative read/write/idempotent retry is refused with
//       "store-poisoned" until an explicit recover(). A failed write therefore
//       can never masquerade as a persisted success — never "memory has it, DB
//       does not".
//     - A crash *between* the in-memory update and the COMMIT kills the process,
//       so the volatile in-memory record vanishes with it; the DB is either fully
//       committed or fully rolled back. No half state is durable either way.
//     The DB is only ever read back to rebuild memory, never auto-migrated,
//     auto-healed or silently downgraded.
//
// Schema (SCHEMA_VERSION = 1):
//   meta(key TEXT PRIMARY KEY, value TEXT)
//     rows: ('store_namespace', STORE_NAMESPACE), ('schema_version', '1').
//   bindings(request_owner, request_id, record_json, created_at,
//            PRIMARY KEY (request_owner, request_id))
//     one normalized route-binding record per request.
//   intents(request_owner, request_id, effect_key, intent_json, created_at,
//           PRIMARY KEY (request_owner, request_id, effect_key))
//     one advisory EffectIntent per (request, effectKey).
//
// Provenance / source gate (RBS-E001): before ANY chmod or DDL, an existing
// non-empty file must already carry this module's provenance marker
// (meta.store_namespace === STORE_NAMESPACE). A non-empty file without it is
// refused with RouteBindingError("unknown_existing_db") and left byte-, mode-
// and directory-entry-identical; a symlink or other non-regular path is refused
// with RouteBindingError("unsafe-store-path"). Only an absent or zero-byte file
// may be initialized fresh. No arbitrary SQLite file is ever assumed to be ours.
//
// Fail-closed schema handling: a store we own (valid namespace) whose
// meta.schema_version exists and is not SCHEMA_VERSION is refused with
// RouteBindingError("unsupported-schema-version"). It is never migrated, never
// erased, never read at a downgraded version.
//
// Fail-closed write handling (RBS-F001): if any durable write path fails
// (INSERT / COMMIT) or the recovery reload fails, the store enters a POISONED
// state and every subsequent authoritative read/write/idempotent retry is
// refused with RouteBindingError("store-poisoned") — never a fake success —
// until an explicit recover() reloads-and-validates from the durable rows. After
// close() every API is refused with RouteBindingError("store-closed"). An
// uncommitted record is never reported as a successful persistence.
//
// Dependencies: `node:sqlite` and ./route-binding.mjs only. No network, no
// environment access; the clock is injected via `now`.

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
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

// Provenance marker identifying a file as OUR store (RBS-E001). Any existing
// non-empty database without this marker is refused before we touch it, so an
// unrelated SQLite file is never adopted, chmod-ed or given our tables.
const STORE_NAMESPACE_KEY = "store_namespace";
const STORE_NAMESPACE = "personal-ai-os/route-binding-store";

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
 * Provenance gate (RBS-E001). Decide whether `absolute` may be initialized or
 * opened, WITHOUT mutating it. Throws fail-closed otherwise:
 *   - absent path                          -> allowed (fresh initialization)
 *   - zero-byte regular file               -> allowed (treated as fresh)
 *   - symlink / non-regular path           -> "unsafe-store-path" (never followed)
 *   - non-empty file with our namespace    -> allowed
 *   - any other non-empty file             -> "unknown_existing_db" (untouched)
 */
function assertStoreProvenance(absolute) {
	let stats;
	try {
		stats = lstatSync(absolute);
	} catch (error) {
		if (error !== null && error.code === "ENOENT") return; // fresh path
		throw error;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new RouteBindingError("unsafe-store-path", "store path must be a regular file (no symlink or special file)");
	}
	if (stats.size === 0) return; // empty placeholder, safe to initialize

	// Non-empty existing file: it must already be ours. Probe read-only so the
	// file's bytes, mode and directory entries are left exactly as they are.
	let probe;
	try {
		probe = new DatabaseSync(absolute, { readOnly: true });
	} catch {
		throw new RouteBindingError("unknown_existing_db", "existing file is not a readable route-binding store");
	}
	try {
		let row;
		try {
			row = probe.prepare("SELECT value FROM meta WHERE key = ?").get(STORE_NAMESPACE_KEY);
		} catch {
			throw new RouteBindingError("unknown_existing_db", "existing database has no recognizable route-binding meta");
		}
		if (row === undefined || row.value !== STORE_NAMESPACE) {
			throw new RouteBindingError("unknown_existing_db", "existing database is not a Personal AI OS route-binding store");
		}
	} finally {
		probe.close();
	}
}

/**
 * Open a durable route-binding store at `dbPath`.
 *
 * The parent directory is created 0700 when missing; the database file is
 * restricted to 0600. An absent/zero-byte file is initialized to SCHEMA_VERSION;
 * an existing file that already carries our provenance marker is opened; any
 * other existing file fails closed ("unknown_existing_db"), as do symlinks and
 * non-regular paths ("unsafe-store-path"). A conflicting schema version fails
 * closed. Any durable write failure poisons the store until recover().
 *
 * Store API (all synchronous, backed by node:sqlite `DatabaseSync`):
 *   bind(binding)                              -> frozen Binding (idempotent, durable)
 *   resolve(requestKey)                        -> frozen Binding (expiry-gated)
 *   planEffect(requestKey, { effectKey, taskId? }) -> frozen EffectIntent (idempotent, durable)
 *   recover()                                  -> reload durable truth, clear poison
 *   close()                                    -> close the DB handle; all APIs then refuse
 *   size / intentCount                         -> live registry counters (refused if closed/poisoned)
 *   dbPath                                     -> the resolved absolute path (pure locator, never refuses)
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
	// left exactly as it is).
	mkdirSync(dirname(absolute), { recursive: true, mode: DIR_MODE });

	// Source gate FIRST: no chmod and no DDL may run against a file we do not own.
	assertStoreProvenance(absolute);

	// Private file (0600). Reached only for a fresh/empty file or a file that
	// already carries our provenance marker.
	const db = new DatabaseSync(absolute);
	chmodSync(absolute, FILE_MODE);

	// Schema bootstrap. `meta` is ensured first so provenance and version are
	// inspected BEFORE any other table is created. On a namespace/version
	// conflict we refuse without creating bindings/intents.
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
	const nsRow = db.prepare("SELECT value FROM meta WHERE key = ?").get(STORE_NAMESPACE_KEY);
	if (nsRow === undefined) {
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(STORE_NAMESPACE_KEY, STORE_NAMESPACE);
	} else if (nsRow.value !== STORE_NAMESPACE) {
		db.close();
		throw new RouteBindingError("unknown_existing_db", "existing database is not a Personal AI OS route-binding store");
	}
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

	// Mutable holder so a reload can swap in a fresh registry while every closure
	// keeps reading the current authority. `poisonReason` and `closed` gate every
	// API (see assertUsable).
	const state = { registry: undefined };
	let closed = false;
	let poisonReason = null;

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

	/**
	 * Fail-closed usability gate shared by every API. Once the store is closed or
	 * poisoned (a durable write path or the recovery reload failed),
	 * authoritative reads, writes and idempotent retries are refused with an
	 * honest reason — never a fake success.
	 */
	function assertUsable() {
		if (closed) throw new RouteBindingError("store-closed", "the store is closed");
		if (poisonReason !== null) {
			throw new RouteBindingError("store-poisoned", `the store is poisoned: ${poisonReason}`);
		}
	}

	/**
	 * Enter the poisoned state after a failed write path (INSERT/COMMIT/reload).
	 * The grown in-memory record must NOT survive as authoritative: best-effort
	 * reload the durable truth, and if even that fails leave the registry empty.
	 * Either way every API now rejects until an explicit recover().
	 */
	function poisonAfterWriteFailure(error) {
		const reason = error && error.message ? error.message : String(error);
		poisonReason = reason;
		try {
			state.registry = loadRegistry();
		} catch (reloadError) {
			state.registry = undefined;
			const reloadReason = reloadError && reloadError.message ? reloadError.message : String(reloadError);
			poisonReason = `${reason}; reload also failed: ${reloadReason}`;
		}
	}

	function bind(binding) {
		assertUsable();
		const before = state.registry.size;
		// Reuse route-binding semantics: validates, returns the existing record on
		// an identical re-bind, throws on conflict/invalid. A throw mutates nothing.
		const record = state.registry.bind(binding);
		if (state.registry.size === before) return record; // idempotent: no DB write
		try {
			insertBindingRow(record);
		} catch (error) {
			poisonAfterWriteFailure(error);
			throw error;
		}
		return record;
	}

	function resolve(requestKey) {
		assertUsable();
		return state.registry.resolve(requestKey);
	}

	function planEffect(requestKey, options = {}) {
		assertUsable();
		const before = state.registry.intentCount;
		const intent = state.registry.planEffect(requestKey, options);
		if (state.registry.intentCount === before) return intent; // idempotent: no DB write
		try {
			insertIntentRow(intent, clock());
		} catch (error) {
			poisonAfterWriteFailure(error);
			throw error;
		}
		return intent;
	}

	/**
	 * Explicit controlled recovery from the poisoned state: reload the durable
	 * truth (re-validated through route-binding's loader) and clear the poison. If
	 * the reload fails the store stays poisoned. Refused once the store is closed.
	 */
	function recover() {
		if (closed) throw new RouteBindingError("store-closed", "the store is closed");
		let reloaded;
		try {
			reloaded = loadRegistry();
		} catch (error) {
			poisonReason = error && error.message ? error.message : String(error);
			throw new RouteBindingError("store-poisoned", `recovery failed: ${poisonReason}`);
		}
		state.registry = reloaded;
		poisonReason = null;
	}

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
		recover,
		close,
		get size() {
			assertUsable();
			return state.registry.size;
		},
		get intentCount() {
			assertUsable();
			return state.registry.intentCount;
		},
		get dbPath() {
			return absolute;
		},
	};
}
