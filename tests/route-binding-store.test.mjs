// Tests for runtime/route-binding-store.mjs (M02/I03c second slice).
//
// Durable persistence + V03 atomicity for the frozen route-binding contract.
// Every test uses a throwaway temp directory and REAL sqlite files; nothing here
// touches production state, and no existing file/module is modified.
//
// Coverage (>= 10); 11-15 are the RBS-F001 fail-closed poison negatives, 16-18
// the RBS-E001 provenance-gate negatives:
//   1  persistence across close/reopen (fields intact)
//   2  binding-conflict writes nothing (dump identical before/after)
//   3  idempotent re-bind writes nothing (row count stays 1)
//   4  intent persistence + idempotency (row count stays 1)
//   5  crash-atomicity: an uncommitted row never survives a reopen
//   6  expired legacy binding loads (record retained) but resolve fails closed
//   7  unknown schema version is refused, DB content unchanged
//   8  legacy scope violation survives a reopen
//   9  file 0600 / directory 0700
//   10 memory/DB consistency: DB key set == memory-visible key set
//   11 after close() every API is refused
//   12 INSERT failure -> poisoned; the idempotent retry is refused, not faked
//   13 write failure + reload failure stays poisoned (no ghost success)
//   14 COMMIT failure -> poisoned (no ghost success)
//   15 intent INSERT failure -> poisoned
//   16 a foreign database is refused untouched (bytes/mode/entries identical)
//   17 a zero-byte file initializes fresh; a valid store reopens normally
//   18 symlink / non-regular path refused (never followed)

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openBindingStore, SCHEMA_VERSION } from "../runtime/route-binding-store.mjs";
import { RouteBindingError } from "../runtime/route-binding.mjs";

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

/** A complete, valid pi-durable binding (durable owner; no scope, no expiry). */
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

/** A row-shaped, fully valid legacy record, for the crash-atomicity test. */
function legacyRecordJSON() {
	return JSON.stringify({
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
	});
}

/** Assert a RouteBindingError with the given code is thrown. */
function throwsCode(fn, code) {
	assert.throws(fn, (error) => error instanceof RouteBindingError && error.code === code, `expected RouteBindingError(${code})`);
}

/** A fresh throwaway temp directory. */
async function tempDir() {
	return mkdtemp(join(tmpdir(), "aios-route-store-"));
}

/** Full durable dump (meta + bindings + intents), read through a separate conn. */
function dump(file) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return {
			meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all().map((r) => ({ key: r.key, value: r.value })),
			bindings: db
				.prepare("SELECT request_owner, request_id, record_json, created_at FROM bindings ORDER BY request_owner, request_id")
				.all(),
			intents: db
				.prepare("SELECT request_owner, request_id, effect_key, intent_json FROM intents ORDER BY request_owner, request_id, effect_key")
				.all(),
		};
	} finally {
		db.close();
	}
}

/** Row count for one table via a separate connection. */
function countRows(file, table) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
	} finally {
		db.close();
	}
}

test("1: a binding persists across close/reopen with every field intact", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const s1 = openBindingStore(file, { now: () => 0 });
		const written = s1.bind(piBinding());
		s1.close();

		const s2 = openBindingStore(file, { now: () => 0 });
		const resolved = s2.resolve(PI_KEY);
		assert.deepEqual(resolved, written, "durable record equals the in-memory record");
		assert.equal(resolved.runtime, "pi-durable");
		assert.deepEqual(resolved.modelRef, { provider: "openai", modelId: "gpt-4o" });
		assert.equal(resolved.codeVersion, "0.3.0");
		assert.equal(resolved.interfaceVersion, "1");
		assert.equal(resolved.profileId, "profile-pi");
		assert.equal(resolved.cwd, "/Users/markus/pi-work");
		assert.equal(resolved.authorizationDigest, "auth-pi");
		assert.equal(resolved.effectKey, "effect-pi");
		assert.equal(resolved.createdAt, 1000);
		assert.equal(resolved.expiresAt, null);
		assert.equal(s2.size, 1);
		s2.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("2: a binding-conflict writes nothing (DB dump identical before/after)", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		const original = store.bind(legacyBinding());
		const before = dump(file);

		throwsCode(() => store.bind(legacyBinding({ authorizationDigest: "auth-other" })), "binding-conflict");
		throwsCode(() => store.bind(legacyBinding({ runtime: "pi-durable", legacyScope: null })), "binding-conflict");

		assert.deepEqual(dump(file), before, "DB byte-for-byte unchanged after conflicts");
		assert.equal(store.resolve(LEGACY_KEY), original, "existing record untouched");
		assert.equal(countRows(file, "bindings"), 1);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("3: an identical re-bind is idempotent and re-writes nothing", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		const first = store.bind(legacyBinding());
		const before = dump(file);

		const second = store.bind(legacyBinding());
		assert.equal(first, second, "returns the existing record");
		assert.deepEqual(dump(file), before, "no row was re-written");
		assert.equal(countRows(file, "bindings"), 1);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("4: an intent persists and repeated planEffect is idempotent (row count stays 1)", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const s1 = openBindingStore(file, { now: () => 1000 });
		s1.bind(legacyBinding());
		s1.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
		s1.close();

		const s2 = openBindingStore(file, { now: () => 1000 });
		const first = s2.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
		const second = s2.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
		assert.equal(first, second, "same intent object for the same requestKey+effectKey");
		assert.equal(first.taskId, "task-1");
		assert.equal(first.type, "EffectIntent");
		assert.equal(first.requiresApproval, true);
		assert.equal(s2.intentCount, 1);
		assert.equal(countRows(file, "intents"), 1, "only one durable intent row");
		s2.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("5: crash-atomicity: an uncommitted row never survives a reopen", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		// Create the schema, then let a second connection write WITHOUT committing.
		openBindingStore(file, { now: () => 0 }).close();

		const raw = new DatabaseSync(file);
		raw.exec("BEGIN IMMEDIATE");
		raw
			.prepare("INSERT INTO bindings (request_owner, request_id, record_json, created_at) VALUES (?, ?, ?, ?)")
			.run("owner-1", "req-legacy", legacyRecordJSON(), 1000);
		raw.close(); // no COMMIT -> SQLite rolls the transaction back

		const store = openBindingStore(file, { now: () => 0 });
		assert.equal(store.size, 0, "no half-written binding was recovered");
		assert.equal(countRows(file, "bindings"), 0);
		assert.equal(dump(file).bindings.length, 0);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("6: an expired legacy binding is loaded (retained) but resolve fails closed", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const s1 = openBindingStore(file, { now: () => 1000 });
		const held = s1.bind(legacyBinding()); // expiresAt 5000
		s1.close();

		const s2 = openBindingStore(file, { now: () => 6000 });
		assert.equal(s2.size, 1, "the expired record is still loaded");
		throwsCode(() => s2.resolve(LEGACY_KEY), "binding-expired");
		assert.equal(countRows(file, "bindings"), 1, "expiry never deletes the durable record");
		// Reloading again at a pre-expiry clock resolves the unchanged record.
		s2.close();
		const s3 = openBindingStore(file, { now: () => 4999 });
		assert.deepEqual(s3.resolve(LEGACY_KEY), held);
		s3.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("7: an unknown schema version is refused and the DB is left untouched", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		store.bind(piBinding());
		store.close();

		const probe = new DatabaseSync(file, { readOnly: true });
		try {
			assert.equal(
				probe.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version").value,
				String(SCHEMA_VERSION),
				"a fresh store records the current schema version",
			);
		} finally {
			probe.close();
		}

		const raw = new DatabaseSync(file);
		raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run("99", "schema_version");
		raw.close();

		const before = dump(file);
		throwsCode(() => openBindingStore(file, { now: () => 0 }), "unsupported-schema-version");
		assert.deepEqual(dump(file), before, "a refused store rewrites nothing");

		const meta = new DatabaseSync(file, { readOnly: true });
		try {
			assert.equal(meta.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version").value, "99");
		} finally {
			meta.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("8: a legacy scope violation still holds after a reopen", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const s1 = openBindingStore(file, { now: () => 1000 });
		s1.bind(legacyBinding());
		s1.close();

		const s2 = openBindingStore(file, { now: () => 1000 });
		throwsCode(() => s2.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-99" }), "legacy-scope-violation");
		throwsCode(() => s2.planEffect(LEGACY_KEY, { effectKey: "effect-legacy" }), "legacy-scope-violation");
		assert.equal(countRows(file, "intents"), 0, "denied plans write no intent");

		const ok = s2.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" });
		assert.equal(ok.taskId, "task-1");
		s2.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("9: the store file is 0600 and its directory is 0700", async () => {
	const dir = await tempDir();
	try {
		// A nested path proves the parent chain is created 0700 as well.
		const nested = join(dir, "private");
		const file = join(nested, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		store.bind(piBinding());

		assert.equal((await stat(file)).mode & 0o777, 0o600, "store file mode");
		assert.equal((await stat(nested)).mode & 0o777, 0o700, "created parent directory mode");
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("10: the durable key set matches the memory-visible key set", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });

		const specs = [
			{ binding: piBinding(), key: PI_KEY, taskId: undefined },
			{
				binding: piBinding({ requestKey: { ownerId: "owner-3", sourceRequestId: "req-pi-2" }, effectKey: "effect-pi-2" }),
				key: { ownerId: "owner-3", sourceRequestId: "req-pi-2" },
				taskId: undefined,
			},
			{
				binding: piBinding({ requestKey: { ownerId: "owner-4", sourceRequestId: "req-pi-3" }, effectKey: "effect-pi-3" }),
				key: { ownerId: "owner-4", sourceRequestId: "req-pi-3" },
				taskId: undefined,
			},
		];
		for (const spec of specs) store.bind(spec.binding);
		for (const spec of specs) store.planEffect(spec.key, { effectKey: spec.binding.effectKey, taskId: spec.taskId });

		// Memory-visible set: every bound request resolves, and every planned
		// effect re-plans to the same intent.
		const memoryKeys = specs
			.map((spec) => store.resolve(spec.key))
			.map((record) => `${record.requestKey.ownerId}\u0000${record.requestKey.sourceRequestId}`)
			.sort();

		const db = dump(file);
		const dbKeys = db.bindings
			.map((row) => `${row.request_owner}\u0000${row.request_id}`)
			.sort();
		assert.deepEqual(dbKeys, memoryKeys, "bindings: DB == memory");
		assert.equal(db.bindings.length, 3);
		assert.equal(db.intents.length, 3);
		assert.equal(store.size, 3);
		assert.equal(store.intentCount, 3);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// --- RBS-F001: fail-closed poison after any failed write path ---

test("11: every API is refused after close", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		store.bind(piBinding());
		store.close();

		const fresh = piBinding({ requestKey: { ownerId: "owner-3", sourceRequestId: "req-pi-2" }, effectKey: "effect-pi-2" });
		throwsCode(() => store.bind(fresh), "store-closed");
		throwsCode(() => store.resolve(PI_KEY), "store-closed");
		throwsCode(() => store.planEffect(PI_KEY, { effectKey: "effect-pi" }), "store-closed");
		throwsCode(() => store.recover(), "store-closed");
		assert.throws(() => store.size, (error) => error instanceof RouteBindingError && error.code === "store-closed");
		assert.throws(() => store.intentCount, (error) => error instanceof RouteBindingError && error.code === "store-closed");
		assert.equal(countRows(file, "bindings"), 1, "the refused calls wrote nothing");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("12: a failed INSERT poisons the store; the idempotent retry is refused, not faked", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		store.bind(piBinding()); // 1 durable row

		const raw = new DatabaseSync(file);
		raw.exec("CREATE TRIGGER block_insert BEFORE INSERT ON bindings BEGIN SELECT RAISE(ABORT, 'blocked'); END");
		raw.close();

		const second = piBinding({ requestKey: { ownerId: "owner-3", sourceRequestId: "req-pi-2" }, effectKey: "effect-pi-2" });
		assert.throws(() => store.bind(second), (error) => error instanceof Error, "the durable write failure surfaces");

		// Audit repro ①: a same-binding retry must NOT report a ghost success.
		throwsCode(() => store.bind(second), "store-poisoned");
		throwsCode(() => store.resolve(PI_KEY), "store-poisoned");
		assert.throws(() => store.size, (error) => error.code === "store-poisoned");
		assert.equal(countRows(file, "bindings"), 1, "memorySize never diverges from durableSize");

		// Controlled recovery once the fault is removed.
		const raw2 = new DatabaseSync(file);
		raw2.exec("DROP TRIGGER block_insert");
		raw2.close();
		store.recover();
		assert.equal(store.size, 1, "recovered to the durable truth");
		assert.equal(store.bind(second).requestKey.sourceRequestId, "req-pi-2");
		assert.equal(countRows(file, "bindings"), 2);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("13: a write failure whose reload also fails stays poisoned (no ghost success)", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });
		store.bind(piBinding());
		assert.equal(store.size, 1);

		// Audit repro ②: with the store still OPEN, another connection poisons the
		// durable rows (invalid JSON) and blocks INSERT, so the write fails AND the
		// reload fails.
		const raw = new DatabaseSync(file);
		raw.prepare("INSERT INTO bindings (request_owner, request_id, record_json, created_at) VALUES (?, ?, ?, ?)").run("owner-bad", "req-bad", "{ this is not json", 0);
		raw.exec("CREATE TRIGGER block_insert BEFORE INSERT ON bindings BEGIN SELECT RAISE(ABORT, 'blocked'); END");
		raw.close();

		const second = piBinding({ requestKey: { ownerId: "owner-3", sourceRequestId: "req-pi-2" }, effectKey: "effect-pi-2" });
		assert.throws(() => store.bind(second), (error) => error instanceof Error);

		throwsCode(() => store.bind(second), "store-poisoned");
		throwsCode(() => store.resolve(PI_KEY), "store-poisoned");
		assert.throws(() => store.size, (error) => error.code === "store-poisoned");
		throwsCode(() => store.recover(), "store-poisoned", "recovery fails while the corrupt/blocked DB remains");
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("14: a failed COMMIT poisons the store (no ghost success)", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 0 });

		// A second connection holds a SHARED read transaction, so our INSERT
		// succeeds but COMMIT (needing EXCLUSIVE) fails.
		const holder = new DatabaseSync(file);
		holder.exec("BEGIN");
		holder.prepare("SELECT COUNT(*) AS n FROM bindings").get();

		const binding = piBinding();
		assert.throws(() => store.bind(binding), (error) => error instanceof Error, "the durable COMMIT failure surfaces");
		throwsCode(() => store.bind(binding), "store-poisoned");
		throwsCode(() => store.resolve(PI_KEY), "store-poisoned");

		holder.exec("ROLLBACK");
		holder.close();
		assert.equal(countRows(file, "bindings"), 0, "the aborted COMMIT left no durable row");

		store.recover();
		assert.equal(store.size, 0, "recovered to the durable truth (empty)");
		assert.equal(store.bind(binding).runtime, "pi-durable");
		assert.equal(countRows(file, "bindings"), 1);
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("15: a failed intent INSERT poisons the store too", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		const store = openBindingStore(file, { now: () => 1000 });
		store.bind(legacyBinding()); // durable binding, no intent yet

		const raw = new DatabaseSync(file);
		raw.exec("CREATE TRIGGER block_intent BEFORE INSERT ON intents BEGIN SELECT RAISE(ABORT, 'blocked-intent'); END");
		raw.close();

		assert.throws(() => store.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" }), (error) => error instanceof Error);
		throwsCode(() => store.planEffect(LEGACY_KEY, { effectKey: "effect-legacy", taskId: "task-1" }), "store-poisoned");
		throwsCode(() => store.resolve(LEGACY_KEY), "store-poisoned");
		assert.equal(countRows(file, "intents"), 0, "no ghost intent row is reported as persisted");
		store.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// --- RBS-E001: provenance gate before any chmod/DDL ---

test("16: an existing foreign database is refused untouched (no chmod, no DDL)", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "foreign.sqlite");
		const foreign = new DatabaseSync(file);
		foreign.exec("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT)");
		foreign.prepare("INSERT INTO widget (name) VALUES (?)").run("w1");
		foreign.close();
		chmodSync(file, 0o644);

		const bytesBefore = readFileSync(file);
		const modeBefore = (await stat(file)).mode & 0o777;
		const entriesBefore = readdirSync(dir).sort();

		throwsCode(() => openBindingStore(file, { now: () => 0 }), "unknown_existing_db");

		assert.equal(Buffer.compare(bytesBefore, readFileSync(file)), 0, "file bytes unchanged");
		assert.equal((await stat(file)).mode & 0o777, modeBefore, "file mode unchanged (never forced to 0600)");
		assert.deepEqual(readdirSync(dir).sort(), entriesBefore, "no journal/wal/extra directory entries");
		const probe = new DatabaseSync(file, { readOnly: true });
		try {
			const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
			assert.deepEqual(tables.map((row) => row.name), ["widget"], "the foreign schema is intact; our tables were never created");
		} finally {
			probe.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("17: a zero-byte file is initialized fresh and a valid store reopens normally", async () => {
	const dir = await tempDir();
	try {
		const file = join(dir, "bindings.sqlite");
		writeFileSync(file, ""); // 0-byte placeholder: safe to initialize
		const s1 = openBindingStore(file, { now: () => 0 });
		assert.equal(s1.size, 0);
		const written = s1.bind(piBinding());
		s1.close();

		// Provenance marker now present -> normal reopen, record intact.
		const s2 = openBindingStore(file, { now: () => 0 });
		assert.deepEqual(s2.resolve(PI_KEY), written);
		s2.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("18: a symlink or a non-regular path is refused without being followed", async () => {
	const dir = await tempDir();
	try {
		const real = join(dir, "real.sqlite");
		const store = openBindingStore(real, { now: () => 0 });
		store.bind(piBinding());
		store.close();
		const realBytes = readFileSync(real);

		const link = join(dir, "link.sqlite");
		symlinkSync(real, link);
		throwsCode(() => openBindingStore(link, { now: () => 0 }), "unsafe-store-path");
		assert.equal(Buffer.compare(realBytes, readFileSync(real)), 0, "the symlink target was not touched");

		const adir = join(dir, "adir.sqlite");
		mkdirSync(adir);
		throwsCode(() => openBindingStore(adir, { now: () => 0 }), "unsafe-store-path");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
