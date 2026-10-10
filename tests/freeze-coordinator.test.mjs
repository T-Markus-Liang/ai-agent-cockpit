// Wave 5/S04b joint verification — freeze coordinator & guarded rollback.
//
// This suite exercises control-plane/freeze-coordinator.mjs end to end with
// FULLY SYNTHETIC stores living under a private `os.tmpdir()/freeze-coord-*`
// tree: a real WAL-mode SQLite event store, a JSON outbox file store, a
// directory-of-events store, and a pure in-memory store. Every store is
// fronted by an injected quiesce adapter of the freeze-coordinator protocol
// shape; nothing here touches production state (~/.local/state/personal-ai-os/,
// ~/.local/state/ai-agent-cockpit/, ~/.wechat-acp/), launches a service, uses
// the network, credentials, a model or WeChat, or invokes git. The conversion
// step inside the conservation chain is a MOCK stub on purpose: the real
// snapshot -> convert chain is proven by tests/migration-rollback-drill.test.mjs
// (state-converter unchanged, read-only); this suite's subject is the freeze /
// resume / guarded-rollback coordination itself.
//
// Covered scenarios (S04 remediation plan §6 items 5-7):
//   * double dry-run — two freeze runs over identical inputs agree modulo
//     runId/time, and the freeze-record digests are equal;
//   * four store kinds conserve identity + counts through
//     freeze -> snapshot -> (mocked convert) -> guarded rollback;
//   * drain timeout -> needs-review, admission stays stopped, resumeFrozen
//     closes the loop; a wrong owner and an expired fence touch nothing;
//   * partial stopAdmission failure -> earlier stores re-admitted, durable
//     owner/fence intent and unknown admission recoverable before snapshot;
//   * interrupted-scene recovery (hand-written pre-snapshot record; a
//     quiesce-unknown orchestrator run) touches only registered, matched stores;
//   * rollback refusal on watermark regression and on post-freeze data, with
//     newDataSinceFreeze summaries and zero writes;
//   * rollback-invariant violation reported, never whitewashed;
//   * the injected adapters really drive the orchestrator (deterministic
//     operationIds, lock order = registration order);
//   * read-only negatives: manifest tamper, missing targets, config guards.

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, mock, test } from "node:test";
import { DatabaseSync, backup } from "node:sqlite";

import {
	COORDINATION_DIR,
	FREEZE_RECORD_NAME,
	FreezeCoordinatorError,
	executeRollback,
	freezeAndSnapshot,
	planRollback,
	resumeFrozen,
} from "../control-plane/freeze-coordinator.mjs";

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER = "freeze-test-owner";

const createdRoots = [];

function makeWorkspace() {
	const base = mkdtempSync(join(tmpdir(), "freeze-coord-"));
	createdRoots.push(base);
	const snapshots = join(base, "snapshots");
	mkdirSync(snapshots, { recursive: true, mode: DIR_MODE });
	return { base, allowRoot: base, snapshots };
}

after(() => {
	for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fsyncPath(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is not portable; never invalidates the write.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeFileAtomic(destination, bytes) {
	mkdirSync(dirname(destination), { recursive: true, mode: DIR_MODE });
	const tmp = join(dirname(destination), `.${destination.split("/").pop()}.${process.pid}.tmp`);
	writeFileSync(tmp, bytes, { mode: FILE_MODE });
	fsyncPath(tmp);
	renameSync(tmp, destination);
	fsyncPath(dirname(destination));
	return destination;
}

// ---------------------------------------------------------------------------
// synthetic stores, each fronted by an injected quiesce adapter
// ---------------------------------------------------------------------------
//
// Every adapter implements the freeze-coordinator protocol:
//   stopAdmission / resumeAdmission / drain / watermark / snapshotAdapter /
//   restoreFrozen
// and records call counts + the orchestrator ctx objects it was invoked with,
// so the tests can prove WHICH layer drove WHICH call.

function trackAdapter(impl) {
	const calls = {
		stopAdmission: 0,
		resumeAdmission: 0,
		drain: 0,
		watermark: 0,
		quiesce: 0,
		snapshotTo: 0,
		resume: 0,
		restoreFrozen: 0,
	};
	const ctxLog = [];
	const adapter = {
		rollbackContract: "conditional-restore-v1",
		async stopAdmission(ctx) {
			calls.stopAdmission += 1;
			return impl.stopAdmission(ctx);
		},
		async resumeAdmission(ctx) {
			calls.resumeAdmission += 1;
			return impl.resumeAdmission(ctx);
		},
		async drain(args) {
			calls.drain += 1;
			return impl.drain(args);
		},
		watermark() {
			calls.watermark += 1;
			return impl.watermark();
		},
		snapshotAdapter() {
			return {
				async quiesce(ctx) {
					calls.quiesce += 1;
					ctxLog.push(ctx);
					return impl.quiesce ? impl.quiesce(ctx) : undefined;
				},
				async snapshotTo(target, ctx) {
					calls.snapshotTo += 1;
					ctxLog.push(ctx);
					return impl.snapshotTo(target, ctx);
				},
				async resume(ctx) {
					calls.resume += 1;
					ctxLog.push(ctx);
					return impl.resume ? impl.resume(ctx) : undefined;
				},
			};
		},
		async restoreFrozen(target, opts) {
			calls.restoreFrozen += 1;
			return impl.restoreFrozen(target, opts);
		},
		async restoreFrozenConditional(target, opts) {
			// Default fixtures commit synchronously before their promise returns:
			// no event-loop interleaving between compare and the byte mutation.
			if (impl.watermark() !== opts.expectedWatermark) return { applied: false };
			assert.equal(opts.protectAfter, opts.expectedWatermark);
			await adapter.restoreFrozen(target, opts);
			return { applied: true };
		},
	};
	return { adapter, calls, ctxLog };
}

/** Admission-control half shared by every synthetic store. */
function gate(impl, state) {
	state.admissionStopped = false;
	impl.hangDrain = false;
	impl.failStop = false;
	impl.stopAdmission = () => {
		if (impl.failStop) throw new Error("admission gate jammed");
		state.admissionStopped = true;
		return { stoppedAt: FIXED_NOW, inFlight: 0 };
	};
	impl.resumeAdmission = () => {
		state.admissionStopped = false;
		return { resumedAt: FIXED_NOW };
	};
	impl.drain = async ({ now }) => {
		if (impl.hangDrain) {
			const error = new Error("in-flight writes remain past the drain deadline");
			error.code = "freeze-timeout";
			error.watermark = impl.watermark();
			throw error;
		}
		return { drainedAt: now() };
	};
}

/** A live WAL-mode SQLite event store (content kept in the -wal sidecar). */
function makeSqliteEventStore(path) {
	const state = {};
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
	const impl = {
		watermark() {
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				const row = db.prepare("SELECT COALESCE(MAX(event_id), '') AS w FROM turns").get();
				return String(row.w);
			} finally {
				db.close();
			}
		},
		async snapshotTo(target) {
			mkdirSync(target, { mode: DIR_MODE });
			const snapshotFile = join(target, "snapshot.sqlite");
			const source = new DatabaseSync(path, { readOnly: true });
			try {
				await backup(source, snapshotFile);
			} finally {
				source.close();
			}
			const check = new DatabaseSync(snapshotFile);
			try {
				check.exec("PRAGMA journal_mode=DELETE");
				const row = check.prepare("PRAGMA integrity_check").get();
				if (String(Object.values(row)[0] ?? "") !== "ok") {
					throw new Error("sqlite snapshot failed integrity_check");
				}
			} finally {
				check.close();
			}
			writeFileSync(snapshotFile, readFileSync(snapshotFile), { mode: FILE_MODE });
			return { files: ["snapshot.sqlite"] };
		},
		async restoreFrozen(target, { protectAfter }) {
			const db = new DatabaseSync(path);
			let protectedRows;
			try {
				protectedRows = db
					.prepare("SELECT event_id, payload FROM turns WHERE event_id > ? ORDER BY event_id")
					.all(protectAfter);
			} finally {
				db.close();
			}
			// Atomic single-file restore: snapshot is a self-contained
			// DELETE-mode database (the online backup folded the WAL).
			writeFileAtomic(path, readFileSync(join(target, "snapshot.sqlite")));
			const reopened = new DatabaseSync(path);
			try {
				const reinsert = reopened.prepare("INSERT OR REPLACE INTO turns(event_id, payload) VALUES(?, ?)");
				for (const row of protectedRows) reinsert.run(row.event_id, row.payload);
			} finally {
				reopened.close();
			}
		},
		insert(eventId, payload) {
			const db = new DatabaseSync(path);
			try {
				db.prepare("INSERT OR REPLACE INTO turns(event_id, payload) VALUES(?, ?)").run(eventId, payload);
			} finally {
				db.close();
			}
		},
		corrupt() {
			const db = new DatabaseSync(path);
			try {
				db.exec("UPDATE turns SET payload = 'GARBAGE'");
			} finally {
				db.close();
			}
		},
		dump() {
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				const tables = db
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
					.all();
				const dump = {};
				for (const { name } of tables) {
					const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
					dump[name] = rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
				}
				return dump;
			} finally {
				db.close();
			}
		},
	};
	gate(impl, state);
	const tracked = trackAdapter(impl);
	return { kind: "sqlite", path, state, impl, ...tracked };
}

function seedSqliteEventStore(path, events) {
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("CREATE TABLE turns(event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
	for (const [eventId, payload] of events) {
		db.prepare("INSERT INTO turns(event_id, payload) VALUES(?, ?)").run(eventId, payload);
	}
	db.close();
}

/** A JSON outbox file: an array of { id, seq, text } records. */
function makeJsonStore(file, records) {
	const state = {};
	writeFileAtomic(file, Buffer.from(`${JSON.stringify(records, null, 2)}\n`, "utf8"));
	const read = () => JSON.parse(readFileSync(file, "utf8"));
	const write = (recordsToWrite) =>
		writeFileAtomic(file, Buffer.from(`${JSON.stringify(recordsToWrite, null, 2)}\n`, "utf8"));
	const impl = {
		watermark: () => read().reduce((max, record) => Math.max(max, record.seq), 0),
		async snapshotTo(target) {
			mkdirSync(target, { mode: DIR_MODE });
			writeFileSync(join(target, "outbox.json"), readFileSync(file), { mode: FILE_MODE });
			return { files: ["outbox.json"] };
		},
		async restoreFrozen(target, { protectAfter }) {
			const frozen = JSON.parse(readFileSync(join(target, "outbox.json"), "utf8"));
			const current = read();
			const merged = [
				...frozen.filter((record) => record.seq <= protectAfter),
				...current.filter((record) => record.seq > protectAfter),
			].sort((a, b) => a.seq - b.seq);
			write(merged);
		},
		insert(record) {
			write([...read(), record].sort((a, b) => a.seq - b.seq));
		},
		delete(id) {
			write(read().filter((record) => record.id !== id));
		},
		corrupt() {
			write(read().map((record) => ({ ...record, text: "GARBAGE" })));
		},
		dump: read,
	};
	gate(impl, state);
	const tracked = trackAdapter(impl);
	return { kind: "json", path: file, state, impl, ...tracked };
}

/** A directory of event files ev-0001.json … : watermark = the highest name. */
function makeDirEventStore(dir, count) {
	const state = {};
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	for (let index = 1; index <= count; index += 1) {
		const name = `ev-${String(index).padStart(4, "0")}.json`;
		writeFileSync(join(dir, name), `${JSON.stringify({ id: name, seq: index, text: `event ${index}` })}\n`, {
			mode: FILE_MODE,
		});
	}
	const list = () => readdirSync(dir).sort();
	const impl = {
		watermark: () => list().reduce((max, name) => (name > max ? name : max), ""),
		async snapshotTo(target) {
			mkdirSync(target, { mode: DIR_MODE });
			for (const name of list()) {
				writeFileSync(join(target, name), readFileSync(join(dir, name)), { mode: FILE_MODE });
			}
			return { files: list() };
		},
		async restoreFrozen(target, { protectAfter }) {
			const frozenFiles = readdirSync(target).sort();
			for (const name of frozenFiles) {
				writeFileAtomic(join(dir, name), readFileSync(join(target, name)));
			}
			// Protect post-freeze additions: re-apply any current event file the
			// snapshot does not cover. Extra unknown files are left in place
			// (never silently deleted — the drill's philosophy).
			for (const name of list()) {
				if (name > protectAfter && !frozenFiles.includes(name)) {
					writeFileAtomic(join(dir, name), readFileSync(join(dir, name)));
				}
			}
		},
		insert(seq) {
			const name = `ev-${String(seq).padStart(4, "0")}.json`;
			writeFileSync(join(dir, name), `${JSON.stringify({ id: name, seq, text: `event ${seq}` })}\n`, {
				mode: FILE_MODE,
			});
		},
		corrupt() {
			for (const name of list()) {
				writeFileAtomic(join(dir, name), Buffer.from('{"id":"' + name + '","text":"GARBAGE"}\n'));
			}
		},
		dump: () => Object.fromEntries(list().map((name) => [name, readFileSync(join(dir, name), "utf8")])),
	};
	gate(impl, state);
	const tracked = trackAdapter(impl);
	return { kind: "direvents", path: dir, state, impl, ...tracked };
}

/** A pure in-memory store: identity Map + monotonic seq watermark. */
function makeMemoryStore(seed) {
	const state = {};
	const entries = new Map(seed.map((record) => [record.id, { ...record }]));
	let watermark = seed.reduce((max, record) => Math.max(max, record.seq), 0);
	const impl = {
		watermark: () => watermark,
		async snapshotTo(target) {
			mkdirSync(target, { mode: DIR_MODE });
			const dump = [...entries.values()].sort((a, b) => a.seq - b.seq);
			writeFileSync(join(target, "entries.json"), `${JSON.stringify(dump, null, 2)}\n`, { mode: FILE_MODE });
			return { files: ["entries.json"] };
		},
		async restoreFrozen(target, { protectAfter }) {
			const frozen = JSON.parse(readFileSync(join(target, "entries.json"), "utf8"));
			// Capture post-freeze additions BEFORE the map is cleared, then
			// restore frozen content and re-apply everything after protectAfter.
			const protectedRows = [...entries.values()].filter((record) => record.seq > protectAfter);
			entries.clear();
			for (const record of frozen.filter((entry) => entry.seq <= protectAfter)) {
				entries.set(record.id, { ...record });
			}
			for (const record of protectedRows) entries.set(record.id, { ...record });
			watermark = Math.max(watermark, ...[...entries.values()].map((record) => record.seq));
		},
		insert(record) {
			entries.set(record.id, { ...record });
			watermark = Math.max(watermark, record.seq);
		},
		delete(id) {
			entries.delete(id);
			watermark = [...entries.values()].reduce((max, record) => Math.max(max, record.seq), 0);
		},
		corrupt() {
			for (const [id, record] of entries) entries.set(id, { ...record, text: "GARBAGE" });
		},
		dump: () => [...entries.values()].sort((a, b) => a.seq - b.seq),
	};
	gate(impl, state);
	const tracked = trackAdapter(impl);
	return { kind: "memory", path: undefined, state, impl, ...tracked };
}

/** Registration entry for the coordinator (lock order = array order). */
function registration(store, name) {
	return { name, kind: store.kind, adapter: store.adapter };
}

function freezeRecordPath(rootDir, runId) {
	return join(rootDir, COORDINATION_DIR, runId, FREEZE_RECORD_NAME);
}

function readFreezeRecord(rootDir, runId) {
	return JSON.parse(readFileSync(freezeRecordPath(rootDir, runId), "utf8"));
}

// ---------------------------------------------------------------------------
// double dry-run
// ---------------------------------------------------------------------------

test("double dry-run: two freeze runs over identical inputs agree modulo runId and time", async () => {
	const ws = makeWorkspace();
	const buildStores = (tag) => {
		const storeDir = join(ws.base, tag);
		const sqlitePath = join(storeDir, "memory.sqlite");
		seedSqliteEventStore(sqlitePath, [
			["e001", "hello"],
			["e002", "world"],
		]);
		return [
			registration(makeSqliteEventStore(sqlitePath), "memory"),
			registration(
				makeJsonStore(join(storeDir, "outbox.json"), [
					{ id: "r1", seq: 1, text: "one" },
					{ id: "r2", seq: 2, text: "two" },
				]),
				"outbox",
			),
		];
	};

	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, now: fixedClock, owner: OWNER };
	const runA = await freezeAndSnapshot({ ...common, stores: buildStores("dry-a"), runId: "dry-run-a" });
	const runB = await freezeAndSnapshot({ ...common, stores: buildStores("dry-b"), runId: "dry-run-b" });
	assert.equal(runA.status, "success");
	assert.equal(runB.status, "success");

	// Same input bytes -> same per-store evidence digests across runs.
	const evidenceOf = (run) =>
		Object.fromEntries(run.run.manifest.stores.map((store) => [store.name, store.sha256]));
	assert.deepEqual(evidenceOf(runA), evidenceOf(runB));

	// The freeze records are byte-identical modulo runId and the random fence
	// token; their deterministic digests MUST be equal.
	const recordA = readFreezeRecord(ws.snapshots, "dry-run-a");
	const recordB = readFreezeRecord(ws.snapshots, "dry-run-b");
	assert.equal(recordA.digest, recordB.digest);
	const normalize = (record) => {
		const clone = JSON.parse(JSON.stringify(record));
		clone.runId = "<runId>";
		clone.fence.token = "<token>";
		for (const store of clone.stores) {
			for (const phase of Object.keys(store.operationIds)) {
				store.operationIds[phase] = store.operationIds[phase].replace(/^[^:]+/, "<runId>");
			}
		}
		if (clone.snapshot && clone.snapshot.journal) clone.snapshot.journal.fence.token = "<token>";
		if (clone.snapshot) clone.snapshot.manifest = "<runDir>";
		return clone;
	};
	assert.deepEqual(normalize(recordA), normalize(recordB));
});

// ---------------------------------------------------------------------------
// four store kinds conserve identity + counts through the whole chain
// ---------------------------------------------------------------------------

test("four store kinds conserve identity and counts through freeze -> snapshot -> convert(mock) -> rollback", async () => {
	const ws = makeWorkspace();
	const storesDir = join(ws.base, "stores");
	mkdirSync(storesDir, { recursive: true, mode: DIR_MODE });

	const sqlitePath = join(storesDir, "memory.sqlite");
	seedSqliteEventStore(sqlitePath, [
		["e001", "hello"],
		["e002", "world"],
		["e003", "wal-row"],
	]);
	const sqlite = makeSqliteEventStore(sqlitePath);

	const outbox = makeJsonStore(join(storesDir, "outbox.json"), [
		{ id: "r1", seq: 1, text: "receipt-one" },
		{ id: "r2", seq: 2, text: "receipt-two" },
		{ id: "r3", seq: 3, text: "receipt-three" },
	]);

	const events = makeDirEventStore(join(storesDir, "events"), 3);

	const memory = makeMemoryStore([
		{ id: "m1", seq: 1, text: "memory-one" },
		{ id: "m2", seq: 2, text: "memory-two" },
	]);

	const stores = [
		registration(sqlite, "memory"),
		registration(outbox, "outbox"),
		registration(events, "events"),
		registration(memory, "mem"),
	];

	// Baseline: counts + identity sets + content.
	const baseline = {
		memory: sqlite.impl.dump(),
		outbox: outbox.impl.dump(),
		events: events.impl.dump(),
		mem: memory.impl.dump(),
	};

	const freeze = await freezeAndSnapshot({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		stores,
		now: fixedClock,
		owner: OWNER,
		runId: "conservation-run",
	});
	assert.equal(freeze.status, "success");

	// The coordination record is persisted atomically with private modes.
	const recordPath = freezeRecordPath(ws.snapshots, "conservation-run");
	assert.ok(existsSync(recordPath));
	assert.equal(statSync(recordPath).mode & 0o777, FILE_MODE, "freeze-record.json is 0600");
	assert.equal(statSync(dirname(recordPath)).mode & 0o777, DIR_MODE, "coordination dir is 0700");
	const record = readFreezeRecord(ws.snapshots, "conservation-run");
	assert.equal(record.status, "success");
	assert.deepEqual(Object.keys(record.freezeWatermark.perStore).sort(), ["events", "mem", "memory", "outbox"]);
	for (const store of record.stores) {
		assert.equal(store.admission, "stopped");
		assert.equal(store.drain, "confirmed");
		assert.equal(store.watermark, record.freezeWatermark.perStore[store.name]);
	}

	// (Mocked) conversion step on the snapshot copies — the real converter
	// chain is the drill's subject; here we only prove the coordinator hands
	// over consistent, verifiable snapshot files.
	const convertStubCalls = [];
	for (const store of freeze.run.manifest.stores) {
		const dir = join(freeze.run.dir, store.name);
		convertStubCalls.push(dir);
		assert.ok(existsSync(dir));
	}
	assert.equal(convertStubCalls.length, 4);

	// Fault injection that does NOT move any watermark: payloads are wrecked,
	// logical sequences untouched (the rollback guard must stay green).
	sqlite.impl.corrupt();
	outbox.impl.corrupt();
	events.impl.corrupt();
	memory.impl.corrupt();
	assert.notDeepEqual(sqlite.impl.dump(), baseline.memory);

	const plan = planRollback({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		runId: "conservation-run",
		stores,
	});
	assert.equal(plan.allowed, true);
	assert.deepEqual(plan.newDataSinceFreeze, {});

	const executed = await executeRollback({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		runId: "conservation-run",
		stores,
		now: fixedClock,
	});
	assert.equal(executed.status, "success");
	assert.equal(executed.restored.length, 4);
	for (const entry of executed.restored) {
		assert.ok(entry.restoredFiles > 0);
	}

	// Conservation: identity sets, counts and content return to the baseline.
	assert.deepEqual(sqlite.impl.dump(), baseline.memory, "sqlite content conserved");
	assert.deepEqual(outbox.impl.dump(), baseline.outbox, "json identities + content conserved");
	assert.deepEqual(events.impl.dump(), baseline.events, "directory files conserved");
	assert.deepEqual(memory.impl.dump(), baseline.mem, "memory store identities conserved");
});

// ---------------------------------------------------------------------------
// drain timeout -> needs-review; explicit resumeFrozen closes the loop
// ---------------------------------------------------------------------------

test("drain timeout: needs-review, admission stays stopped, only resumeFrozen resumes it", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const beta = makeMemoryStore([{ id: "b1", seq: 1, text: "beta" }]);
	beta.impl.hangDrain = true;
	const stores = [registration(alpha, "alpha"), registration(beta, "beta")];

	const freeze = await freezeAndSnapshot({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		stores,
		now: fixedClock,
		owner: OWNER,
		perStoreTimeoutMs: 25,
		runId: "timeout-run",
	});
	assert.equal(freeze.status, "needs-review");
	assert.deepEqual(freeze.frozen, ["alpha"]);
	assert.deepEqual(freeze.pending, ["beta"]);
	assert.equal(freeze.failure.code, "freeze-timeout");
	assert.equal(freeze.failure.store, "beta");

	// Nobody resumed anything; the orchestrator was never started.
	assert.equal(alpha.calls.resumeAdmission, 0);
	assert.equal(beta.calls.resumeAdmission, 0);
	assert.ok(!existsSync(join(ws.snapshots, "timeout-run")), "no orchestrator run dir");
	assert.ok(!existsSync(join(ws.snapshots, "timeout-run", "manifest.json")));

	const record = readFreezeRecord(ws.snapshots, "timeout-run");
	assert.equal(record.status, "needs-review");
	assert.equal(record.stores.find((store) => store.name === "alpha").drain, "confirmed");
	assert.equal(record.stores.find((store) => store.name === "beta").drain, "timeout");

	// A wrong owner learns nothing and touches nothing.
	await assert.rejects(
		() =>
			resumeFrozen({
				rootDir: ws.snapshots,
				allowRoot: ws.allowRoot,
				runId: "timeout-run",
				owner: "intruder",
				stores,
				now: fixedClock,
			}),
		(error) => error instanceof FreezeCoordinatorError && error.code === "recovery-not-authorized",
	);
	assert.equal(alpha.calls.resumeAdmission, 0);
	assert.equal(beta.calls.resumeAdmission, 0);

	// An expired fence refuses too.
	await assert.rejects(
		() =>
			resumeFrozen({
				rootDir: ws.snapshots,
				allowRoot: ws.allowRoot,
				runId: "timeout-run",
				owner: OWNER,
				stores,
				now: () => FIXED_NOW + 3_600_001,
			}),
		(error) => error instanceof FreezeCoordinatorError && error.code === "fence-expired",
	);

	// The right owner closes the loop: admission resumes in REVERSE lock order.
	const resumeOrder = [];
	for (const [store, name] of [
		[alpha, "alpha"],
		[beta, "beta"],
	]) {
		const original = store.adapter.resumeAdmission.bind(store.adapter);
		store.adapter.resumeAdmission = async () => {
			resumeOrder.push(name);
			return original();
		};
	}
	const ghost = makeMemoryStore([{ id: "g1", seq: 1, text: "ghost" }]);
	const recovered = await resumeFrozen({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		runId: "timeout-run",
		owner: OWNER,
		stores: [...stores, registration(ghost, "ghost")],
		now: fixedClock,
	});
	assert.equal(recovered.status, "resumed");
	assert.deepEqual([...recovered.resumedAdmission].sort(), ["alpha", "beta"]);
	assert.deepEqual(recovered.ignored, ["ghost"]);
	assert.equal(ghost.calls.resumeAdmission, 0, "unregistered stores are never touched");
	assert.equal(recovered.recovered.resumed.length, 0, "no orchestrator run existed to recover");
	assert.deepEqual(resumeOrder, ["beta", "alpha"], "admission resumes in REVERSE lock order");
	const after = readFreezeRecord(ws.snapshots, "timeout-run");
	assert.equal(after.status, "resumed");
	assert.equal(after.stores.find((store) => store.name === "alpha").admission, "resumed");
	assert.equal(after.stores.find((store) => store.name === "beta").admission, "resumed");
});

// ---------------------------------------------------------------------------
// partial stopAdmission failure
// ---------------------------------------------------------------------------

test("partial stopAdmission failure: earlier stores re-admitted, durable unknown scene before snapshot", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const beta = makeMemoryStore([{ id: "b1", seq: 1, text: "beta" }]);
	beta.impl.failStop = true;
	const stores = [registration(alpha, "alpha"), registration(beta, "beta")];

	let error = null;
	try {
		await freezeAndSnapshot({
			rootDir: ws.snapshots,
			allowRoot: ws.allowRoot,
			stores,
			now: fixedClock,
			owner: OWNER,
			runId: "partial-run",
		});
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof FreezeCoordinatorError);
	assert.equal(error.code, "freeze-partial");
	assert.deepEqual(error.details.stopped, ["alpha"]);
	assert.deepEqual(error.details.resumed, ["alpha"]);
	assert.equal(error.details.failed.store, "beta");

	// alpha was re-admitted; beta never got stopped so nobody resumed it.
	assert.equal(alpha.calls.stopAdmission, 1);
	assert.equal(alpha.calls.resumeAdmission, 1);
	assert.equal(beta.calls.stopAdmission, 1);
	assert.equal(beta.calls.resumeAdmission, 0);

	// Stronger than the old zero-record assertion: ownership and intent survive
	// a throw, even when the adapter claims it threw before stopping admission.
	const record = readFreezeRecord(ws.snapshots, "partial-run");
	assert.equal(record.status, "needs-review");
	assert.equal(record.owner, OWNER);
	assert.equal(typeof record.fence.token, "string");
	assert.equal(record.stores[0].admission, "resumed");
	assert.equal(record.stores[1].admission, "unknown");
	assert.equal(record.snapshot.status, "not-attempted");
	assert.ok(!existsSync(join(ws.snapshots, "partial-run")));
	assert.deepEqual(readdirSync(ws.snapshots), [COORDINATION_DIR]);
});

// ---------------------------------------------------------------------------
// interrupted-scene recovery: only registered, owner/fence-matched stores
// ---------------------------------------------------------------------------

test("stopAdmission pauses then throws: pre-call intent survives and only authorized recovery resumes unknown", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
	const beta = makeMemoryStore([{ id: "b", seq: 1, text: "keep" }]);
	const gamma = makeMemoryStore([{ id: "c", seq: 1, text: "keep" }]);
	const stores = [registration(alpha, "alpha"), registration(beta, "beta"), registration(gamma, "gamma")];
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, runId: "pause-throw", owner: OWNER, stores, now: fixedClock };
	let stopCtx;
	beta.impl.stopAdmission = (ctx) => {
		stopCtx = ctx;
		const before = readFreezeRecord(ws.snapshots, common.runId);
		assert.equal(before.stores[1].admission, "intent");
		assert.equal(before.owner, ctx.owner);
		assert.equal(before.fence.token, ctx.fence);
		assert.equal(ctx.operationId, "pause-throw:beta:stop-admission");
		beta.state.admissionStopped = true;
		throw new Error("paused, then response lost");
	};
	await assert.rejects(() => freezeAndSnapshot(common), (error) => {
		assert.equal(error.code, "freeze-partial");
		assert.equal(error.details.status, "needs-review");
		assert.equal(error.details.recoveryPersistence, "confirmed");
		return true;
	});
	assert.equal(alpha.state.admissionStopped, false);
	assert.equal(beta.state.admissionStopped, true);
	assert.equal(beta.calls.resumeAdmission, 0, "unknown stop is never blindly resumed");
	assert.equal(gamma.calls.stopAdmission, 0);
	assert.equal(beta.calls.snapshotTo, 0);
	assert.ok(!existsSync(join(ws.snapshots, common.runId)), "no snapshot journal exists");
	const record = readFreezeRecord(ws.snapshots, common.runId);
	assert.equal(record.stores[1].admission, "unknown");
	for (const override of [{ owner: "intruder" }, { now: () => FIXED_NOW + 3_600_001 }]) {
		await assert.rejects(() => resumeFrozen({ ...common, ...override }),
			(error) => ["recovery-not-authorized", "fence-expired"].includes(error.code));
	}
	assert.equal(beta.calls.resumeAdmission, 0);
	const incomplete = await resumeFrozen({ ...common, stores: [registration(alpha, "alpha")] });
	assert.equal(incomplete.status, "needs-review", "omitting the unknown store cannot claim recovered");
	let resumeCtx;
	beta.impl.resumeAdmission = (ctx) => { resumeCtx = ctx; beta.state.admissionStopped = false; };
	const recovered = await resumeFrozen(common);
	assert.equal(recovered.status, "resumed");
	assert.deepEqual(recovered.resumedAdmission, ["beta"]);
	assert.equal(resumeCtx.owner, stopCtx.owner);
	assert.equal(resumeCtx.fence, stopCtx.fence);
	assert.equal(resumeCtx.operationId, "pause-throw:beta:resume");
	assert.equal(beta.state.admissionStopped, false);
	assert.equal(gamma.calls.resumeAdmission, 0);
});

test("freeze Error subclass codes, including modified codes, cannot leak through admission failure", async () => {
	for (const mutate of [false, true]) {
		const ws = makeWorkspace();
		const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
		const canary = "secret-code-/private/credential";
		const error = new FreezeCoordinatorError(canary);
		assert.equal(error.code, "freeze-adapter-failed");
		if (mutate) error.code = canary;
		alpha.impl.stopAdmission = () => { throw error; };
		await assert.rejects(() => freezeAndSnapshot({ rootDir: ws.snapshots, allowRoot: ws.allowRoot,
			stores: [registration(alpha, "alpha")], runId: "redacted", owner: OWNER, now: fixedClock }), (caught) => {
			assert.equal(caught.details.failed.code, "stop-admission-failed");
			assert.ok(!JSON.stringify(caught).includes(canary));
			assert.ok(!caught.message.includes(canary));
			return true;
		});
		assert.ok(!readFileSync(freezeRecordPath(ws.snapshots, "redacted"), "utf8").includes(canary));
	}
});

test("partial admission cleanup attempts every confirmed store even when a resume fails", async () => {
	const ws = makeWorkspace();
	const stores = ["a", "b", "c"].map((name) => {
		const store = makeMemoryStore([{ id: name, seq: 1, text: "keep" }]);
		return { name, store };
	});
	const order = [];
	for (const { name, store } of stores) {
		const resume = store.impl.resumeAdmission;
		store.impl.resumeAdmission = (ctx) => {
			order.push(name);
			if (name === "b") throw new Error("gate still paused");
			return resume(ctx);
		};
	}
	stores[2].store.impl.stopAdmission = () => {
		stores[2].store.state.admissionStopped = true;
		throw new Error("pause response lost");
	};
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, owner: OWNER, now: fixedClock,
		stores: stores.map(({ name, store }) => registration(store, name)), runId: "cleanup" };
	await assert.rejects(() => freezeAndSnapshot(common), (error) => {
		assert.equal(error.code, "freeze-partial");
		assert.deepEqual(error.details.resumeErrors, ["b"]);
		return true;
	});
	assert.deepEqual(order, ["b", "a"]);
	assert.deepEqual(readFreezeRecord(ws.snapshots, "cleanup").stores.map((entry) => entry.admission), ["resumed", "stopped", "unknown"]);
	stores[1].store.impl.resumeAdmission = () => { stores[1].store.state.admissionStopped = false; };
	const recovered = await resumeFrozen(common);
	assert.equal(recovered.status, "resumed");
	assert.deepEqual(recovered.resumedAdmission, ["c", "b"]);
	assert.equal(stores[0].store.calls.resumeAdmission, 1, "confirmed cleanup is not replayed");
});

test("resumeFrozen reopens a hand-written pre-snapshot scene and touches only registered stores", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const beta = makeMemoryStore([{ id: "b1", seq: 1, text: "beta" }]);
	const stores = [registration(alpha, "alpha"), registration(beta, "beta")];

	// Simulate the crash scene directly: the coordinator persisted its phase-A
	// record (status frozen, snapshot not-attempted) and died before run().
	const coordDir = join(ws.snapshots, COORDINATION_DIR, "crashed-run");
	mkdirSync(coordDir, { recursive: true, mode: DIR_MODE });
	const record = {
		schemaVersion: 1,
		coordinationVersion: "freeze-coordinator-v1",
		runId: "crashed-run",
		owner: OWNER,
		fence: { token: "coordination-token", issuedAt: FIXED_NOW, expiresAt: FIXED_NOW + 3_600_000 },
		startedAt: FIXED_NOW,
		status: "frozen",
		stores: ["alpha", "beta"].map((name) => ({
			name,
			kind: "memory",
			admission: name === "alpha" ? "intent" : "stopped",
			drain: "confirmed",
			watermark: 1,
			stoppedAt: FIXED_NOW,
			inFlightAtStop: 0,
			drainedAt: FIXED_NOW,
			operationIds: {
				quiesce: `crashed-run:${name}:quiesce`,
				snapshot: `crashed-run:${name}:snapshot`,
				resume: `crashed-run:${name}:resume`,
			},
		})),
		freezeWatermark: { perStore: { alpha: 1, beta: 1 }, takenAt: FIXED_NOW },
		snapshot: { status: "not-attempted" },
		network_calls: 0,
		digest: null,
	};
	writeFileSync(join(coordDir, FREEZE_RECORD_NAME), `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });

	const ghost = makeMemoryStore([{ id: "g1", seq: 1, text: "ghost" }]);
	const recovered = await resumeFrozen({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		runId: "crashed-run",
		owner: OWNER,
		stores: [...stores, registration(ghost, "ghost")],
		now: fixedClock,
	});
	assert.equal(recovered.status, "resumed");
	assert.equal(alpha.calls.resumeAdmission, 1);
	assert.equal(beta.calls.resumeAdmission, 1);
	assert.equal(ghost.calls.resumeAdmission, 0, "a store absent from the record is ignored");
	// No orchestrator journal exists -> the snapshot layer is never invoked.
	assert.equal(alpha.calls.resume, 0);
	assert.equal(beta.calls.resume, 0);
	const after = readFreezeRecord(ws.snapshots, "crashed-run");
	assert.equal(after.status, "resumed");
});

test("resumeFrozen recovers an orchestrator needs-review run through recoverRun semantics", async () => {
	const ws = makeWorkspace();
	// quiesce pauses the store then throws: the orchestrator records
	// quiesce=unknown and refuses to call the outcome a clean success.
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const quiesceImpl = alpha.adapter.snapshotAdapter;
	let paused = false;
	alpha.adapter = {
		...alpha.adapter,
		snapshotAdapter() {
			const inner = quiesceImpl.call(alpha.adapter);
			return {
				...inner,
				async quiesce(ctx) {
					paused = true;
					inner.quiesce(ctx);
					throw new Error("paused then link dropped");
				},
			};
		},
	};
	const stores = [registration(alpha, "alpha")];

	const freeze = await freezeAndSnapshot({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		stores,
		now: fixedClock,
		owner: OWNER,
		runId: "needs-review-run",
	});
	assert.equal(freeze.status, "needs-review");
	assert.equal(paused, true);
	assert.equal(alpha.calls.resume, 1, "the orchestrator already attempted its in-run resume");

	const record = readFreezeRecord(ws.snapshots, "needs-review-run");
	assert.equal(record.status, "needs-review");
	assert.equal(record.stores[0].admission, "stopped", "admission is still stopped at the coordinator layer");

	await assert.rejects(
		() =>
			resumeFrozen({
				rootDir: ws.snapshots,
				allowRoot: ws.allowRoot,
				runId: "needs-review-run",
				owner: "intruder",
				stores,
				now: fixedClock,
			}),
		(error) => error instanceof FreezeCoordinatorError && error.code === "recovery-not-authorized",
	);
	assert.equal(alpha.calls.resume, 1, "an unauthorized recovery touches nothing");

	const recovered = await resumeFrozen({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		runId: "needs-review-run",
		owner: OWNER,
		stores,
		now: fixedClock,
	});
	assert.equal(recovered.status, "resumed");
	assert.equal(alpha.calls.resumeAdmission, 1);
	const resumeCtx = alpha.ctxLog.find((ctx) => ctx.operationId === "needs-review-run:alpha:resume");
	assert.ok(resumeCtx, "recoverRun replayed the deterministic resume operationId");
	assert.equal(resumeCtx.owner, OWNER);
	const after = readFreezeRecord(ws.snapshots, "needs-review-run");
	assert.equal(after.status, "resumed");
});

test("resumeFrozen preserves snapshot recovery persistence uncertainty even after admission cleanup", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
	alpha.impl.resume = () => { throw new Error("snapshot gate still paused"); };
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, owner: OWNER, now: fixedClock,
		stores: [registration(alpha, "alpha")], runId: "uncertain-recovery" };
	const freeze = await freezeAndSnapshot(common);
	assert.equal(freeze.status, "failed");
	alpha.impl.resume = () => {};
	const originalWrite = fs.writeFileSync;
	const injected = mock.method(fs, "writeFileSync", (path, ...args) => {
		if (String(path).endsWith("journal.json.tmp")) throw new Error("EIO /private/journal-secret");
		return originalWrite(path, ...args);
	});
	syncBuiltinESMExports();
	try {
		const recovery = await resumeFrozen(common);
		assert.equal(recovery.status, "needs-review");
		assert.deepEqual(recovery.failedAdmission, []);
		assert.deepEqual(recovery.recovered.failed, []);
		assert.equal(recovery.recovered.journalPersistence, "uncertain");
		assert.equal(recovery.freezeRecord.recovery.journalPersistence, "uncertain");
		assert.equal(alpha.state.admissionStopped, false);
		assert.equal(readFreezeRecord(ws.snapshots, common.runId).status, "needs-review");
		assert.ok(!JSON.stringify(recovery).includes("/private/journal-secret"));
	} finally {
		injected.mock.restore();
		syncBuiltinESMExports();
	}
});

// ---------------------------------------------------------------------------
// rollback refusals: watermark drift and post-freeze data, zero writes
// ---------------------------------------------------------------------------

test("planRollback refuses watermark regression and post-freeze data with summaries", async () => {
	const ws = makeWorkspace();
	const alpha = makeJsonStore(join(ws.base, "outbox.json"), [{ id: "r1", seq: 1, text: "one" }]);
	const beta = makeMemoryStore([
		{ id: "b1", seq: 1, text: "beta-one" },
		{ id: "b2", seq: 2, text: "beta-two" },
	]);
	const stores = [registration(alpha, "alpha"), registration(beta, "beta")];
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, stores };

	await freezeAndSnapshot({ ...common, now: fixedClock, owner: OWNER, runId: "drift-run" });
	const frozen = readFreezeRecord(ws.snapshots, "drift-run").freezeWatermark.perStore;

	// (i) regression: beta loses its newest record -> watermark moves backwards.
	beta.impl.delete("b2");
	let plan = planRollback({ ...common, runId: "drift-run" });
	assert.equal(plan.allowed, false);
	assert.ok(plan.reasons.some((reason) => reason.code === "watermark-regressed" && reason.store === "beta"));
	assert.deepEqual(plan.plan, []);

	let error = null;
	const betaBytesBefore = sha256File(join(ws.snapshots, "drift-run", "beta", "entries.json"));
	const alphaFileBefore = sha256File(join(ws.base, "outbox.json"));
	try {
		await executeRollback({ ...common, runId: "drift-run", now: fixedClock });
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof FreezeCoordinatorError);
	assert.equal(error.code, "rollback-refused");
	assert.equal(error.details.reasons.some((reason) => reason.code === "watermark-regressed"), true);
	assert.equal(alpha.calls.restoreFrozen, 0, "zero writes on refusal");
	assert.equal(beta.calls.restoreFrozen, 0);
	assert.equal(sha256File(join(ws.base, "outbox.json")), alphaFileBefore, "target untouched");
	assert.equal(sha256File(join(ws.snapshots, "drift-run", "beta", "entries.json")), betaBytesBefore);

	// Repair the regression; now alpha gains a post-freeze record.
	beta.impl.insert({ id: "b2", seq: 2, text: "beta-two" });
	alpha.impl.insert({ id: "r2", seq: 2, text: "new-receipt-after-freeze" });
	plan = planRollback({ ...common, runId: "drift-run" });
	assert.equal(plan.allowed, false);
	const driftReason = plan.reasons.find((reason) => reason.code === "new-data-since-freeze");
	assert.ok(driftReason);
	assert.equal(driftReason.store, "alpha");
	assert.deepEqual(plan.newDataSinceFreeze.alpha, {
		frozen: frozen.alpha,
		current: 2,
		records: null,
		direction: "ahead",
	});

	error = null;
	try {
		await executeRollback({ ...common, runId: "drift-run", now: fixedClock });
	} catch (caught) {
		error = caught;
	}
	assert.equal(error.code, "rollback-refused");
	assert.equal(alpha.calls.restoreFrozen, 0);

	// The deployment preserves the delta out of band (this module only reports
	// it); once the post-freeze record is dispositioned the plan goes green.
	alpha.impl.delete("r2");
	plan = planRollback({ ...common, runId: "drift-run" });
	assert.equal(plan.allowed, true);
	assert.deepEqual(plan.newDataSinceFreeze, {});
});

// ---------------------------------------------------------------------------
// rollback-invariant: a restoreFrozen that moves a watermark backwards
// ---------------------------------------------------------------------------

test("executeRollback rejects all second-read drift before restoring any store", async () => {
	for (const [current, code] of [[0, "watermark-regressed"], [2, "new-data-since-freeze"],
		[{ seq: 1 }, "watermark-incomparable"], [NaN, "watermark-incomparable"]]) {
		const ws = makeWorkspace();
		const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "alpha" }]);
		const beta = makeMemoryStore([{ id: "b", seq: 1, text: "beta" }]);
		const stores = [registration(alpha, "alpha"), registration(beta, "beta")];
		const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, stores, runId: "second-read" };
		await freezeAndSnapshot({ ...common, owner: OWNER, now: fixedClock });
		let reads = 0;
		beta.adapter.watermark = () => ++reads === 1 ? 1 : current;
		await assert.rejects(() => executeRollback(common), (error) => {
			assert.equal(error.code, "rollback-refused");
			assert.ok(error.details.reasons.some((reason) => reason.code === code && reason.store === "beta"));
			return true;
		});
		assert.equal(alpha.calls.restoreFrozen, 0);
		assert.equal(beta.calls.restoreFrozen, 0);
		assert.deepEqual(beta.impl.dump(), [{ id: "b", seq: 1, text: "beta" }]);
	}
});

test("legacy restore that could lose bytes across await is refused without a conditional contract", async () => {
	for (const missing of ["rollbackContract", "restoreFrozenConditional"]) {
		const ws = makeWorkspace();
		const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
		const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, stores: [registration(alpha, "alpha")], runId: "legacy" };
		await freezeAndSnapshot({ ...common, owner: OWNER, now: fixedClock });
		delete alpha.adapter[missing];
		alpha.impl.restoreFrozen = async () => {
			await Promise.resolve();
			alpha.impl.corrupt(); // watermark remains 1: the old >= check missed byte loss.
		};
		await assert.rejects(() => executeRollback(common), (error) => error.code === "rollback-refused" &&
			error.details.reasons.some((reason) => reason.code === "rollback-contract-required"));
		assert.equal(alpha.calls.restoreFrozen, 0);
		assert.deepEqual(alpha.impl.dump(), [{ id: "a", seq: 1, text: "keep" }]);
	}
});

test("a conditional-only adapter can restore frozen bytes without a legacy restore entry point", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot,
		stores: [registration(alpha, "alpha")], runId: "conditional-only" };
	await freezeAndSnapshot({ ...common, owner: OWNER, now: fixedClock });
	alpha.impl.corrupt();
	delete alpha.adapter.restoreFrozen;
	alpha.adapter.restoreFrozenConditional = async (target, opts) => {
		if (alpha.impl.watermark() !== opts.expectedWatermark) return { applied: false };
		await alpha.impl.restoreFrozen(target, opts);
		return { applied: true };
	};
	const rollback = await executeRollback(common);
	assert.equal(rollback.status, "success");
	assert.deepEqual(alpha.impl.dump(), [{ id: "a", seq: 1, text: "keep" }]);
});

test("conditional restore rejects a write arriving across await without losing its bytes", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, stores: [registration(alpha, "alpha")], runId: "conditional" };
	await freezeAndSnapshot({ ...common, owner: OWNER, now: fixedClock });
	let release;
	let entered;
	const started = new Promise((resolve) => { entered = resolve; });
	const wait = new Promise((resolve) => { release = resolve; });
	const conditional = alpha.adapter.restoreFrozenConditional;
	alpha.adapter.restoreFrozenConditional = async (target, opts) => {
		entered();
		await wait;
		return conditional(target, opts); // Atomic compare immediately before fixture commit.
	};
	const rollback = executeRollback(common);
	const rejected = assert.rejects(() => rollback, (error) => error.code === "rollback-refused" && error.details.refused === "alpha");
	await started;
	alpha.impl.insert({ id: "late", seq: 2, text: "must survive" });
	release();
	await rejected;
	assert.equal(alpha.calls.restoreFrozen, 0);
	assert.deepEqual(alpha.impl.dump(), [{ id: "a", seq: 1, text: "keep" }, { id: "late", seq: 2, text: "must survive" }]);
});

test("later store drift during an earlier restore is conditionally refused with honest partial results", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
	const beta = makeMemoryStore([{ id: "b", seq: 1, text: "keep" }]);
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot,
		stores: [registration(alpha, "alpha"), registration(beta, "beta")], runId: "later-drift" };
	await freezeAndSnapshot({ ...common, owner: OWNER, now: fixedClock });
	alpha.impl.corrupt();
	const conditional = alpha.adapter.restoreFrozenConditional;
	alpha.adapter.restoreFrozenConditional = async (target, opts) => {
		const result = await conditional(target, opts);
		beta.impl.insert({ id: "late", seq: 2, text: "must survive" });
		return result;
	};
	await assert.rejects(() => executeRollback(common), (error) => {
		assert.equal(error.code, "rollback-refused");
		assert.equal(error.details.refused, "beta");
		assert.deepEqual(error.details.restored.map((entry) => entry.store), ["alpha"]);
		return true;
	});
	assert.deepEqual(alpha.impl.dump(), [{ id: "a", seq: 1, text: "keep" }]);
	assert.equal(beta.calls.restoreFrozen, 0);
	assert.deepEqual(beta.impl.dump(), [{ id: "b", seq: 1, text: "keep" }, { id: "late", seq: 2, text: "must survive" }]);
});

test("conditional restore failure and unconfirmed outcome never claim success or leak arbitrary codes", async () => {
	for (const outcome of ["throw", "unconfirmed"]) {
		const ws = makeWorkspace();
		const alpha = makeMemoryStore([{ id: "a", seq: 1, text: "keep" }]);
		const beta = makeMemoryStore([{ id: "b", seq: 1, text: "keep" }]);
		const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot,
			stores: [registration(alpha, "alpha"), registration(beta, "beta")], runId: "restore-error" };
		await freezeAndSnapshot({ ...common, owner: OWNER, now: fixedClock });
		alpha.adapter.restoreFrozenConditional = async () => {
			if (outcome === "throw") {
				const error = new FreezeCoordinatorError("secret-restore-code");
				error.code = "secret-restore-code";
				throw error;
			}
		};
		await assert.rejects(() => executeRollback(common), (error) => {
			assert.equal(error.code, "rollback-store-failed");
			assert.equal(error.details.failed[0].code, "restore-failed");
			assert.deepEqual(error.details.pending, ["beta"]);
			assert.ok(!JSON.stringify(error).includes("secret-restore-code"));
			return true;
		});
		assert.equal(beta.calls.restoreFrozen, 0);
	}
});

test("executeRollback reports a post-restore watermark invariant violation, never whitewashes it", async () => {
	const ws = makeWorkspace();
	const alpha = makeJsonStore(join(ws.base, "outbox.json"), [{ id: "r1", seq: 1, text: "one" }]);
	// A contract-violating store: restoreFrozen resets its watermark to the
	// frozen value minus one even though nothing new arrived (simulated bug).
	const beta = makeMemoryStore([{ id: "b1", seq: 5, text: "beta" }]);
	const originalRestore = beta.impl.restoreFrozen;
	let calls = 0;
	beta.impl.restoreFrozen = async (target, opts) => {
		calls += 1;
		await originalRestore(target, opts);
		beta.impl.insert({ id: "b0", seq: 4, text: "reset" });
		beta.impl.delete("b1");
	};
	const stores = [registration(alpha, "alpha"), registration(beta, "beta")];

	await freezeAndSnapshot({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		stores,
		now: fixedClock,
		owner: OWNER,
		runId: "invariant-run",
	});
	const plan = planRollback({ rootDir: ws.snapshots, allowRoot: ws.allowRoot, runId: "invariant-run", stores });
	assert.equal(plan.allowed, true, "watermarks match at plan time");

	let error = null;
	try {
		await executeRollback({ rootDir: ws.snapshots, allowRoot: ws.allowRoot, runId: "invariant-run", stores, now: fixedClock });
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof FreezeCoordinatorError);
	assert.equal(error.code, "rollback-invariant");
	assert.equal(error.details.violations[0].store, "beta");
	assert.equal(error.details.violations[0].violation, "moved-backwards");
	assert.equal(error.details.restored.length, 2, "both restores ran; the violation is reported alongside the truth");
	assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// the injected adapters really drive the orchestrator
// ---------------------------------------------------------------------------

test("the injected snapshot adapters are consumed by the orchestrator with deterministic operationIds", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const beta = makeMemoryStore([{ id: "b1", seq: 1, text: "beta" }]);
	const stores = [registration(alpha, "alpha"), registration(beta, "beta")];

	const freeze = await freezeAndSnapshot({
		rootDir: ws.snapshots,
		allowRoot: ws.allowRoot,
		stores,
		now: fixedClock,
		owner: OWNER,
		runId: "opid-run",
	});
	assert.equal(freeze.status, "success");

	for (const [store, name] of [
		[alpha, "alpha"],
		[beta, "beta"],
	]) {
		assert.equal(store.calls.quiesce, 1);
		assert.equal(store.calls.snapshotTo, 1);
		assert.equal(store.calls.resume, 1);
		for (const phase of ["quiesce", "snapshot", "resume"]) {
			const ctx = store.ctxLog.find((entry) => entry.operationId === `opid-run:${name}:${phase}`);
			assert.ok(ctx, `${name}:${phase} reached the adapter with the deterministic operationId`);
			assert.equal(ctx.runId, "opid-run");
			assert.equal(ctx.owner, OWNER);
			assert.equal(typeof ctx.fence, "string");
		}
	}

	// Lock order = registration order; resume is the exact reverse.
	assert.deepEqual(freeze.run.manifest.quiesceOrder, ["alpha", "beta"]);
	assert.deepEqual(freeze.run.manifest.resumeOrder, ["beta", "alpha"]);
});

// ---------------------------------------------------------------------------
// read-only negatives: tampered manifest, missing pieces, config guards
// ---------------------------------------------------------------------------

test("a tampered snapshot manifest is detected read-only and refused with zero writes", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const stores = [registration(alpha, "alpha")];
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, stores };

	await freezeAndSnapshot({ ...common, now: fixedClock, owner: OWNER, runId: "tamper-run" });
	const manifestPath = join(ws.snapshots, "tamper-run", "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.stores[0].files[0].sha256 = "0".repeat(64);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });

	const before = sha256File(join(ws.snapshots, "tamper-run", "alpha", "entries.json"));
	const plan = planRollback({ ...common, runId: "tamper-run" });
	assert.equal(plan.allowed, false);
	assert.ok(plan.reasons.some((reason) => reason.code === "snapshot-hash-mismatch"));

	let error = null;
	try {
		await executeRollback({ ...common, runId: "tamper-run", now: fixedClock });
	} catch (caught) {
		error = caught;
	}
	assert.equal(error.code, "rollback-refused");
	assert.equal(alpha.calls.restoreFrozen, 0);
	assert.equal(sha256File(join(ws.snapshots, "tamper-run", "alpha", "entries.json")), before);
});

test("config guards fail closed before any store is touched", async () => {
	const ws = makeWorkspace();
	const alpha = makeMemoryStore([{ id: "a1", seq: 1, text: "alpha" }]);
	const common = { rootDir: ws.snapshots, allowRoot: ws.allowRoot, now: fixedClock, owner: OWNER };

	// Adapter missing a freeze-protocol method.
	const broken = makeMemoryStore([{ id: "x1", seq: 1, text: "x" }]);
	const noDrain = { ...broken.adapter };
	delete noDrain.drain;
	await assert.rejects(
		() => freezeAndSnapshot({ ...common, stores: [{ name: "broken", kind: "memory", adapter: noDrain }] }),
		(error) => error instanceof FreezeCoordinatorError && error.code === "invalid-store",
	);

	// Duplicate names.
	await assert.rejects(
		() =>
			freezeAndSnapshot({
				...common,
				stores: [registration(alpha, "same"), registration(makeMemoryStore([{ id: "y", seq: 1, text: "y" }]), "same")],
			}),
		(error) => error instanceof FreezeCoordinatorError && error.code === "duplicate-store",
	);

	// Escaping runId.
	await assert.rejects(
		() => freezeAndSnapshot({ ...common, stores: [registration(alpha, "alpha")], runId: "../escape" }),
		(error) => error instanceof FreezeCoordinatorError && error.code === "invalid-run-id",
	);

	// A root outside allowRoot.
	const outside = join(ws.base, "elsewhere");
	mkdirSync(outside, { recursive: true, mode: DIR_MODE });
	await assert.rejects(
		() =>
			freezeAndSnapshot({
				rootDir: outside,
				allowRoot: ws.snapshots,
				stores: [registration(alpha, "alpha")],
				now: fixedClock,
				owner: OWNER,
			}),
		(error) => error instanceof FreezeCoordinatorError && error.code === "root-outside-allow-root",
	);

	// Planning against a run that does not exist.
	assert.throws(
		() => planRollback({ ...common, runId: "no-such-run", stores: [registration(alpha, "alpha")] }),
		(error) => error instanceof FreezeCoordinatorError && error.code === "freeze-record-missing",
	);

	// Planning with an unregistered live store.
	await freezeAndSnapshot({ ...common, stores: [registration(alpha, "alpha")], runId: "guard-run" });
	const ghost = makeMemoryStore([{ id: "g1", seq: 1, text: "ghost" }]);
	const plan = planRollback({
		...common,
		runId: "guard-run",
		stores: [registration(alpha, "alpha"), registration(ghost, "ghost")],
	});
	assert.equal(plan.allowed, false);
	assert.ok(plan.reasons.some((reason) => reason.code === "not-in-snapshot" && reason.store === "ghost"));

	// Every refusal above happened before any admission was stopped.
	assert.equal(alpha.calls.stopAdmission, 1, "only the successful freeze-run stopped admission");
	assert.equal(broken.calls.stopAdmission, 0);
	assert.deepEqual(readdirSync(ws.snapshots).sort(), [".freeze-coordination", "guard-run"]);
});
