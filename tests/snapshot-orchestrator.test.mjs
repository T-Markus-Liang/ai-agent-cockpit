// Focused tests for the Wave 5 consistent quiesced snapshot orchestrator.
//
// Every fixture is a self-built synthetic tree under a private
// `os.tmpdir()/snapshot-orch-*` directory. These tests never touch production
// state (~/.local/state/personal-ai-os/, ~/.wechat-acp/), never launch a service,
// never use the network, credentials, a model or WeChat, and never invoke git.

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, mock, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
	createSnapshotOrchestrator,
	inspectRun,
	recoverRun,
	SnapshotOrchestratorError,
} from "../control-plane/snapshot-orchestrator.mjs";

const createdRoots = [];

/** A private workspace: `base` is the allow-root, `rootDir` the snapshot root. */
function makeWorkspace() {
	const base = mkdtempSync(join(tmpdir(), "snapshot-orch-"));
	createdRoots.push(base);
	const rootDir = join(base, "snapshots");
	mkdirSync(rootDir, { recursive: true, mode: 0o700 });
	return { base, allowRoot: base, rootDir };
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Recompute the module's combined directory digest (sorted path+sha256 lines). */
function combinedDigest(files) {
	const hasher = createHash("sha256");
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	for (const file of sorted) {
		hasher.update(file.path);
		hasher.update("\0");
		hasher.update(file.sha256);
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

function readManifest(runDir) {
	return JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
}

function readJournal(runDir) {
	return JSON.parse(readFileSync(join(runDir, "journal.json"), "utf8"));
}

/** Every byte persisted under `dir`, concatenated (for secret/canary sweeps). */
function readTreeText(dir) {
	let text = "";
	for (const name of readdirSync(dir).sort()) {
		const child = join(dir, name);
		const stats = lstatSync(child);
		if (stats.isDirectory()) text += readTreeText(child);
		else if (stats.isFile()) text += readFileSync(child).toString("latin1");
	}
	return text;
}

function byName(manifest) {
	return Object.fromEntries(manifest.stores.map((store) => [store.name, store]));
}

/** Deterministic in-memory adapter for order/failure assertions. */
function recordingAdapter(name, calls, { snapshotThrows = false, resumeThrows = false } = {}) {
	return {
		async quiesce() {
			calls.push(`quiesce:${name}`);
		},
		async snapshotTo(targetDir) {
			calls.push(`snapshot:${name}`);
			if (snapshotThrows) throw new Error(`boom-${name}`);
			mkdirSync(targetDir, { mode: 0o700 });
			writeFileSync(join(targetDir, "data.bin"), name);
			return { files: ["data.bin"] };
		},
		async resume() {
			calls.push(`resume:${name}`);
			if (resumeThrows) throw new Error(`resume-fail-${name}`);
		},
	};
}

after(() => {
	for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

test("happy path: sqlite (WAL) + filedir snapshot to a fresh run dir with verifiable evidence", async () => {
	const ws = makeWorkspace();

	// A live WAL-mode SQLite store whose committed rows are still only in the
	// -wal sidecar (never checkpointed): a plain cp of the main file would lose them.
	const storeDir = join(ws.base, "stores", "mem0");
	mkdirSync(storeDir, { recursive: true, mode: 0o700 });
	const dbPath = join(storeDir, "ingest.sqlite");
	const live = new DatabaseSync(dbPath);
	live.exec("PRAGMA journal_mode=WAL");
	live.exec("CREATE TABLE turns(event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
	const insert = live.prepare("INSERT INTO turns(event_id,payload) VALUES(?,?)");
	insert.run("e1", JSON.stringify({ role: "user", text: "hello" }));
	insert.run("e2", JSON.stringify({ role: "assistant", text: "hi" }));
	assert.ok(existsSync(`${dbPath}-wal`), "expected uncheckpointed WAL content before snapshot");

	// A directory store with nested files.
	const dirStore = join(ws.base, "stores", "goals");
	mkdirSync(join(dirStore, "sub"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dirStore, "goals.json"), '{"goals":[]}\n');
	writeFileSync(join(dirStore, "sub", "a.txt"), "hello");

	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "mem0", kind: "sqlite", path: dbPath });
	orchestrator.registerStore({ name: "goals", kind: "filedir", path: dirStore });

	const result = await orchestrator.run();
	assert.equal(result.status, "success");
	assert.match(result.runId, /^run-/);

	const manifest = readManifest(result.dir);
	assert.equal(manifest.status, "success");
	assert.equal(manifest.schemaVersion, 2);
	assert.equal(manifest.orchestratorVersion, "snapshot-orchestrator-v1");
	assert.equal(manifest.network_calls, 0);
	assert.equal(manifest.stores.length, 2);
	assert.deepEqual(manifest.quiesceOrder, ["mem0", "goals"]);
	assert.deepEqual(manifest.resumeOrder, ["goals", "mem0"]);

	// The intent journal closes out as a fully confirmed, completed run.
	const journal = readJournal(result.dir);
	assert.equal(journal.journalVersion, 1);
	assert.equal(journal.state, "completed");
	assert.equal(typeof journal.owner, "string");
	assert.equal(typeof journal.fence.token, "string");
	assert.ok(journal.fence.expiresAt > journal.fence.issuedAt);
	for (const state of journal.stores) {
		assert.equal(state.quiesce, "confirmed");
		assert.equal(state.snapshot, "ok");
		assert.equal(state.resume, "confirmed");
	}

	// WAL content survived: the snapshot holds both rows.
	const snapshot = new DatabaseSync(join(result.dir, "mem0", "snapshot.sqlite"), { readOnly: true });
	try {
		assert.equal(snapshot.prepare("SELECT count(*) AS c FROM turns").get().c, 2);
		assert.equal(snapshot.prepare("SELECT payload FROM turns WHERE event_id='e1'").get().payload,
			JSON.stringify({ role: "user", text: "hello" }));
	} finally {
		snapshot.close();
	}

	// Evidence is self-recomputable.
	for (const store of manifest.stores) {
		const dir = join(result.dir, store.name);
		for (const file of store.files) {
			assert.equal(file.sha256, sha256File(join(dir, file.path)));
			assert.equal(file.bytes, statSync(join(dir, file.path)).size);
		}
		assert.equal(store.sha256, combinedDigest(store.files));
		assert.equal(store.bytes, store.files.reduce((sum, file) => sum + file.bytes, 0));
	}

	// Filedir content is byte-identical.
	const mem0 = byName(manifest).mem0;
	assert.deepEqual(mem0.files.map((file) => file.path), ["snapshot.sqlite"]);
	assert.equal(readFileSync(join(result.dir, "goals", "goals.json"), "utf8"), '{"goals":[]}\n');
	assert.equal(readFileSync(join(result.dir, "goals", "sub", "a.txt"), "utf8"), "hello");
	const goals = byName(manifest).goals;
	assert.deepEqual(goals.files.map((file) => file.path).sort(), ["goals.json", "sub/a.txt"]);

	live.close();
});

test("quiesce runs in registration order; every quiesced store resumes in reverse", async () => {
	const ws = makeWorkspace();
	const calls = [];
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	for (const name of ["a", "b", "c"]) {
		orchestrator.registerStore({ name, kind: "spy", adapter: recordingAdapter(name, calls) });
	}
	const result = await orchestrator.run();
	assert.equal(result.status, "success");
	assert.deepEqual(calls, [
		"quiesce:a", "quiesce:b", "quiesce:c",
		"snapshot:a", "snapshot:b", "snapshot:c",
		"resume:c", "resume:b", "resume:a",
	]);
});

test("a snapshot failure is never a success; quiesced stores still resume in reverse", async () => {
	const ws = makeWorkspace();
	const calls = [];
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", calls) });
	orchestrator.registerStore({ name: "bad", kind: "spy", adapter: recordingAdapter("bad", calls, { snapshotThrows: true }) });
	orchestrator.registerStore({ name: "c", kind: "spy", adapter: recordingAdapter("c", calls) });

	const result = await orchestrator.run();
	assert.equal(result.status, "failed");
	assert.deepEqual(calls, [
		"quiesce:a", "quiesce:bad", "quiesce:c",
		"snapshot:a", "snapshot:bad",
		"resume:c", "resume:bad", "resume:a",
	]);

	const manifest = readManifest(result.dir);
	assert.equal(manifest.status, "failed");
	assert.deepEqual(manifest.error, { code: "snapshot-failed", stage: "snapshot", store: "bad" });
	const stores = byName(manifest);
	assert.equal(stores.a.status, "ok");
	assert.equal(stores.bad.status, "failed");
	assert.deepEqual(stores.bad.error, { code: "snapshot-failed", stage: "snapshot", store: "bad" });
	assert.equal(stores.c.status, "not-run");
	assert.equal(stores.c.sha256, undefined, "an unattempted store carries no evidence");

	// The journal confirms the failing snapshot and that every quiesced store
	// was resumed (confirmed) during cleanup.
	const journal = readJournal(result.dir);
	assert.equal(journal.state, "aborted");
	for (const state of journal.stores) assert.equal(state.resume, "confirmed");
	assert.equal(journal.stores.find((state) => state.name === "bad").snapshot, "failed");
	assert.equal(journal.stores.find((state) => state.name === "c").snapshot, "not-attempted");
});

test("a resume failure is recorded and does not abort the cleanup chain; run is not a success", async () => {
	const ws = makeWorkspace();
	const calls = [];
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", calls) });
	orchestrator.registerStore({ name: "b", kind: "spy", adapter: recordingAdapter("b", calls, { resumeThrows: true }) });
	orchestrator.registerStore({ name: "c", kind: "spy", adapter: recordingAdapter("c", calls) });

	const result = await orchestrator.run();
	assert.equal(result.status, "failed");
	// Reverse order c, b, a; b throws, yet a is still resumed -> chain not aborted.
	assert.deepEqual(calls, [
		"quiesce:a", "quiesce:b", "quiesce:c",
		"snapshot:a", "snapshot:b", "snapshot:c",
		"resume:c", "resume:b", "resume:a",
	]);
	assert.equal(result.resumeErrors.length, 1);
	assert.deepEqual(result.resumeErrors[0], { code: "resume-failed", stage: "resume", store: "b" });

	// All snapshots themselves succeeded.
	const manifest = readManifest(result.dir);
	assert.equal(manifest.status, "failed");
	assert.deepEqual(manifest.resumeErrors, [{ code: "resume-failed", stage: "resume", store: "b" }]);
	assert.ok(manifest.stores.every((store) => store.status === "ok"));

	// The journal honestly records the failed resume next to the confirmed ones.
	const journal = readJournal(result.dir);
	assert.equal(journal.stores.find((state) => state.name === "b").resume, "failed");
	assert.equal(journal.stores.filter((state) => state.resume === "confirmed").length, 2);
});

test("refuses a symlinked store path (file and directory) without touching the tree", async () => {
	const ws = makeWorkspace();
	const realDir = join(ws.base, "real-goals");
	mkdirSync(realDir, { mode: 0o700 });
	writeFileSync(join(realDir, "x"), "x");
	const dirLink = join(ws.base, "goals-link");
	symlinkSync(realDir, dirLink);

	const realDb = join(ws.base, "real.sqlite");
	writeFileSync(realDb, "not-a-db-but-a-file");
	const fileLink = join(ws.base, "mem0-link");
	symlinkSync(realDb, fileLink);

	const before = { rootEntries: readdirSync(ws.rootDir).sort(), realDirEntries: readdirSync(realDir).sort() };

	const dirOrch = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	dirOrch.registerStore({ name: "goals", kind: "filedir", path: dirLink });
	await assert.rejects(
		() => dirOrch.run(),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "unsafe-store-path",
	);

	const fileOrch = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	fileOrch.registerStore({ name: "mem0", kind: "sqlite", path: fileLink });
	await assert.rejects(
		() => fileOrch.run(),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "unsafe-store-path",
	);

	assert.deepEqual(readdirSync(ws.rootDir).sort(), before.rootEntries);
	assert.deepEqual(readdirSync(realDir).sort(), before.realDirEntries);
});

test("refuses a rootDir outside the explicitly passed allow root", () => {
	const base = mkdtempSync(join(tmpdir(), "snapshot-orch-"));
	createdRoots.push(base);
	const allowed = join(base, "allowed");
	const outside = join(base, "outside");
	mkdirSync(allowed, { mode: 0o700 });
	mkdirSync(outside, { mode: 0o700 });

	assert.throws(
		() => createSnapshotOrchestrator({ rootDir: outside, allowRoot: allowed }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "root-outside-allow-root",
	);
	// A snapshot root equal to or inside the allowed root is accepted.
	assert.doesNotThrow(() => createSnapshotOrchestrator({ rootDir: allowed, allowRoot: allowed }));
	const nested = join(allowed, "snaps");
	mkdirSync(nested, { mode: 0o700 });
	assert.doesNotThrow(() => createSnapshotOrchestrator({ rootDir: nested, allowRoot: allowed }));
});

test("requires an explicit absolute allowRoot, refused before any filesystem access", () => {
	// Missing allowRoot (no implicit default of rootDir) fails closed.
	assert.throws(
		() => createSnapshotOrchestrator({ rootDir: "/tmp/whatever" }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-config",
	);
	// Non-string and empty allowRoot fail closed.
	assert.throws(
		() => createSnapshotOrchestrator({ rootDir: "/tmp/whatever", allowRoot: 42 }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-config",
	);
	assert.throws(
		() => createSnapshotOrchestrator({ rootDir: "/tmp/whatever", allowRoot: "" }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-config",
	);
	// A relative allowRoot is refused (an implicit CWD-relative boundary is not an
	// explicit declaration), and this is the FIRST refusal — no realpath is taken.
	assert.throws(
		() => createSnapshotOrchestrator({ rootDir: "/tmp/whatever", allowRoot: "relative/root" }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-config",
	);
});

test("refuses an existing run directory and leaves it byte-, inode-, mode- and entry-identical", async () => {
	const ws = makeWorkspace();
	const runId = "run-fixed";
	const existing = join(ws.rootDir, runId);
	mkdirSync(existing, { mode: 0o700 });
	writeFileSync(join(existing, "keep.txt"), "keep");
	const entriesBefore = readdirSync(existing).sort();
	const bytesBefore = readFileSync(join(existing, "keep.txt"), "utf8");
	const statBefore = lstatSync(existing);
	const fileStatBefore = lstatSync(join(existing, "keep.txt"));

	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", []) });

	await assert.rejects(
		() => orchestrator.run({ runId }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "target-exists",
	);
	const statAfter = lstatSync(existing);
	const fileStatAfter = lstatSync(join(existing, "keep.txt"));
	assert.deepEqual(readdirSync(existing).sort(), entriesBefore);
	assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), bytesBefore);
	assert.equal(statAfter.ino, statBefore.ino);
	assert.equal(statAfter.mode, statBefore.mode);
	assert.equal(fileStatAfter.ino, fileStatBefore.ino);
	assert.equal(fileStatAfter.mode, fileStatBefore.mode);
});

test("refuses an unknown store kind at registration", () => {
	const ws = makeWorkspace();
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	assert.throws(
		() => orchestrator.registerStore({ name: "z", kind: "carrier-pigeon", path: ws.base }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "unknown-kind",
	);
	// An injected adapter makes the same custom kind acceptable.
	assert.doesNotThrow(() =>
		orchestrator.registerStore({ name: "z", kind: "carrier-pigeon", adapter: recordingAdapter("z", []) }),
	);
});

test("refuses a store whose type does not match its kind, before any write", async () => {
	const ws = makeWorkspace();
	const filePath = join(ws.base, "a-file");
	writeFileSync(filePath, "x");
	const dirPath = join(ws.base, "a-dir");
	mkdirSync(dirPath, { mode: 0o700 });
	const before = readdirSync(ws.rootDir).sort();

	const sqliteOrch = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	sqliteOrch.registerStore({ name: "s", kind: "sqlite", path: dirPath });
	await assert.rejects(
		() => sqliteOrch.run(),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "store-type-mismatch",
	);

	const dirOrch = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	dirOrch.registerStore({ name: "d", kind: "filedir", path: filePath });
	await assert.rejects(
		() => dirOrch.run(),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "store-type-mismatch",
	);

	assert.deepEqual(readdirSync(ws.rootDir).sort(), before);
});

test("refuses a missing store path without creating the run directory", async () => {
	const ws = makeWorkspace();
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "gone", kind: "sqlite", path: join(ws.base, "nope.sqlite") });
	await assert.rejects(
		() => orchestrator.run(),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "store-missing",
	);
	assert.deepEqual(readdirSync(ws.rootDir), []);
});

test("rejects a concurrent run and gives each run a fresh, non-overwriting id", async () => {
	const ws = makeWorkspace();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({
		name: "slow",
		kind: "spy",
		adapter: {
			async quiesce() {
				await gate;
			},
			async snapshotTo(targetDir) {
				mkdirSync(targetDir, { mode: 0o700 });
				writeFileSync(join(targetDir, "d"), "d");
				return { files: ["d"] };
			},
			async resume() {},
		},
	});

	const first = orchestrator.run();
	await assert.rejects(
		() => orchestrator.run(),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "snapshot-in-progress",
	);
	release();
	const firstResult = await first;
	assert.equal(firstResult.status, "success");

	const secondResult = await orchestrator.run();
	assert.equal(secondResult.status, "success");
	assert.notEqual(firstResult.runId, secondResult.runId);
	assert.deepEqual(readdirSync(ws.rootDir).sort(), [firstResult.runId, secondResult.runId].sort());
});

test("accepts an injected clock and records it in the run id and timestamps", async () => {
	const ws = makeWorkspace();
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, now: () => 4242 });
	orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", []) });
	const result = await orchestrator.run();
	assert.equal(result.startedAt, 4242);
	assert.equal(result.finishedAt, 4242);
	assert.match(result.runId, /^run-4242-\d+$/);
});

// --- SN-F002: name / target guards -------------------------------------------

test("registerStore refuses unsafe store names before anything touches the filesystem", () => {
	const ws = makeWorkspace();
	// The classic SN-F002 victim: a directory a "../victim" store would escape to.
	const victim = join(ws.base, "victim");
	mkdirSync(victim, { mode: 0o700 });
	writeFileSync(join(victim, "keep.txt"), "keep");
	const victimStatBefore = lstatSync(victim);
	const rootEntriesBefore = readdirSync(ws.rootDir).sort();

	const badNames = [
		"../victim",
		"a/b",
		".",
		"..",
		"a\\b",
		"a\0b",
		"manifest.json",
		"manifest.json.tmp",
		"journal.json",
		"journal.json.tmp",
		"x.stage",
		"x".repeat(256),
	];
	for (const name of badNames) {
		const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
		assert.throws(
			() => orchestrator.registerStore({ name, kind: "spy", adapter: recordingAdapter("spy", []) }),
			(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-store",
			`expected invalid-store for ${JSON.stringify(name)}`,
		);
	}

	// Refusal is total: the victim and the snapshot root are untouched.
	const victimStatAfter = lstatSync(victim);
	assert.equal(victimStatAfter.ino, victimStatBefore.ino);
	assert.equal(victimStatAfter.mode, victimStatBefore.mode);
	assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "keep");
	assert.deepEqual(readdirSync(ws.rootDir).sort(), rootEntriesBefore);
});

test("run() refuses an unsafe or reserved runId before any write", async () => {
	const ws = makeWorkspace();
	const rootEntriesBefore = readdirSync(ws.rootDir).sort();
	const badRunIds = [
		"../victim",
		"a/b",
		".",
		"..",
		"a\\b",
		"a\0b",
		"manifest.json",
		"manifest.json.tmp",
		"journal.json",
		"journal.json.tmp",
		"x.stage",
		"y".repeat(256),
	];
	for (const runId of badRunIds) {
		const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
		orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", []) });
		await assert.rejects(
			() => orchestrator.run({ runId }),
			(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-run-id",
			`expected invalid-run-id for ${JSON.stringify(runId)}`,
		);
	}
	assert.deepEqual(readdirSync(ws.rootDir).sort(), rootEntriesBefore);
});

test("an in-run target collision fails closed (target-exists) and never overwrites the rival", async () => {
	const ws = makeWorkspace();
	// Store "b" is an honest filedir store; store "a" is clumsy/hostile and
	// occupies b's target directory from inside its own snapshotTo.
	const bSource = join(ws.base, "b-source");
	mkdirSync(bSource, { mode: 0o700 });
	writeFileSync(join(bSource, "data.txt"), "b-data");
	const bSourceStatBefore = lstatSync(bSource);

	const runId = "run-race";
	const runDir = join(ws.rootDir, runId);
	let plantedStat = null;
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({
		name: "a",
		kind: "spy",
		adapter: {
			async quiesce() {},
			async snapshotTo(targetDir) {
				mkdirSync(targetDir, { mode: 0o700 });
				writeFileSync(join(targetDir, "a.txt"), "a");
				const rival = join(dirname(targetDir), "b");
				mkdirSync(rival, { mode: 0o700 });
				plantedStat = lstatSync(rival);
				return { files: ["a.txt"] };
			},
			async resume() {},
		},
	});
	orchestrator.registerStore({ name: "b", kind: "filedir", path: bSource });

	const result = await orchestrator.run({ runId });
	assert.equal(result.status, "failed");
	assert.deepEqual(result.error, { code: "target-exists", stage: "snapshot", store: "b" });

	// The planted directory survives: same inode, same mode, still empty, and
	// the losing adapter's staging directory was cleaned up.
	const planted = join(runDir, "b");
	const plantedAfter = lstatSync(planted);
	assert.equal(plantedAfter.ino, plantedStat.ino, "the planted directory was not replaced");
	assert.equal(plantedAfter.mode, plantedStat.mode);
	assert.deepEqual(readdirSync(planted), [], "the planted directory was not overwritten");
	assert.ok(!existsSync(`${planted}.stage`), "the losing adapter cleaned its staging dir");
	// The rival's source is untouched too.
	assert.equal(lstatSync(bSource).ino, bSourceStatBefore.ino);
	assert.equal(readFileSync(join(bSource, "data.txt"), "utf8"), "b-data");

	const manifest = readManifest(runDir);
	const stores = byName(manifest);
	assert.equal(stores.a.status, "ok");
	assert.equal(stores.b.status, "failed");
	assert.deepEqual(stores.b.error, { code: "target-exists", stage: "snapshot", store: "b" });
});

// --- SN-F001: quiesce intent journal, owner/fence and recovery ---------------

test("quiesce that pauses then throws: needs-review, journal unknown, cleanup resume still fires", async () => {
	const ws = makeWorkspace();
	const calls = [];
	const bad = { paused: false, resumeCalls: 0 };
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", calls) });
	orchestrator.registerStore({
		name: "bad",
		kind: "spy",
		adapter: {
			async quiesce() {
				bad.paused = true; // the side effect lands first...
				calls.push("quiesce:bad");
				throw new Error("quiesce blew up after pausing"); // ...then the call fails
			},
			async snapshotTo() {
				throw new Error("snapshotTo must never run after a failed quiesce");
			},
			async resume() {
				calls.push("resume:bad");
				bad.resumeCalls += 1;
				bad.paused = false;
			},
		},
	});
	orchestrator.registerStore({ name: "c", kind: "spy", adapter: recordingAdapter("c", calls) });

	const result = await orchestrator.run({ runId: "run-quiesce-throw" });
	assert.equal(result.status, "needs-review");
	assert.deepEqual(
		calls,
		["quiesce:a", "quiesce:bad", "resume:bad", "resume:a"],
		"no snapshot after a failed quiesce; every issued store resumes in reverse",
	);
	assert.equal(bad.resumeCalls, 1);
	assert.equal(bad.paused, false, "the idempotent cleanup resume unpaused the store");

	const manifest = readManifest(result.dir);
	assert.equal(manifest.status, "needs-review");
	const stores = byName(manifest);
	assert.equal(stores.bad.quiesce, "unknown");
	assert.equal(stores.bad.snapshot, "not-attempted");
	assert.equal(stores.bad.resume, "confirmed");
	assert.equal(stores.bad.status, "not-run");
	assert.equal(stores.a.quiesce, "confirmed");
	assert.equal(stores.a.snapshot, "not-attempted");
	assert.equal(stores.a.resume, "confirmed");
	assert.equal(stores.c.quiesce, "not-attempted", "quiesce never reached store c");
	assert.equal(stores.c.resume, "not-attempted");
	assert.deepEqual(manifest.quiesceOrder, ["a", "bad"]);
	assert.deepEqual(manifest.resumeOrder, ["bad", "a"]);
	assert.deepEqual(manifest.error, { code: "quiesce-failed", stage: "quiesce", store: "bad" });

	const journal = readJournal(result.dir);
	assert.equal(journal.state, "aborted");
	assert.equal(journal.stores.find((state) => state.name === "bad").quiesce, "unknown");
	assert.equal(journal.stores.find((state) => state.name === "a").quiesce, "confirmed");
});

test("quiesce that throws before any side effect is still honestly unknown + needs-review", async () => {
	const ws = makeWorkspace();
	const bad = { resumeCalls: 0 };
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({
		name: "bad",
		kind: "spy",
		adapter: {
			async quiesce() {
				throw new Error("quiesce failed cleanly, before touching anything");
			},
			async snapshotTo() {
				throw new Error("snapshotTo must never run");
			},
			async resume() {
				bad.resumeCalls += 1; // idempotent no-op: there was nothing to undo
			},
		},
	});

	const result = await orchestrator.run({ runId: "run-quiesce-clean-throw" });
	// The caller cannot prove the pause never applied from the throw alone, so
	// the journal says `unknown` and the run needs review even here.
	assert.equal(result.status, "needs-review");
	assert.equal(bad.resumeCalls, 1, "resume is still issued (it must be idempotent)");
	const journal = readJournal(result.dir);
	assert.equal(journal.stores[0].quiesce, "unknown");
	assert.equal(journal.stores[0].resume, "confirmed");
	const manifest = readManifest(result.dir);
	assert.equal(byName(manifest).bad.status, "not-run");
});

test("inspectRun is a read-only honest view: needsReview, resumable, journal-missing", async () => {
	const ws = makeWorkspace();
	const bad = { paused: false };
	const orchestrator = createSnapshotOrchestrator({
		rootDir: ws.rootDir,
		allowRoot: ws.allowRoot,
		owner: "owner-inspect",
	});
	orchestrator.registerStore({
		name: "bad",
		kind: "spy",
		adapter: {
			async quiesce() {
				bad.paused = true;
				throw new Error("pause state unknowable from here");
			},
			async snapshotTo() {
				throw new Error("snapshotTo must never run");
			},
			async resume() {
				bad.paused = false;
			},
		},
	});
	const result = await orchestrator.run({ runId: "run-inspect" });
	assert.equal(result.status, "needs-review");

	const view = inspectRun({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, runId: "run-inspect" });
	assert.equal(view.runId, "run-inspect");
	assert.equal(view.owner, "owner-inspect");
	assert.equal(view.state, "aborted");
	assert.deepEqual(view.needsReview, ["bad"], "the unknown quiesce stays flagged for review");
	assert.deepEqual(view.resumable, [], "cleanup already resumed the store");

	assert.throws(
		() => inspectRun({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, runId: "run-nope" }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "journal-missing",
	);
});

/** A run whose resume fails, leaving the store paused for recovery tests. */
async function makePausedRun(ws, { owner, fenceTtlMs } = {}) {
	const state = { paused: false, runResumeCalls: 0 };
	const orchestrator = createSnapshotOrchestrator({
		rootDir: ws.rootDir,
		allowRoot: ws.allowRoot,
		now: () => 1000,
		owner,
		fenceTtlMs,
	});
	orchestrator.registerStore({
		name: "s",
		kind: "spy",
		adapter: {
			async quiesce() {
				state.paused = true;
			},
			async snapshotTo(targetDir) {
				mkdirSync(targetDir, { mode: 0o700 });
				writeFileSync(join(targetDir, "d"), "d");
				return { files: ["d"] };
			},
			async resume() {
				state.runResumeCalls += 1;
				throw new Error("resume exploded; the store stays paused");
			},
		},
	});
	const result = await orchestrator.run({ runId: "run-recover" });
	return { state, result };
}

/** A recovery adapter whose resume records its ctx and unpauses the store. */
function recoveryAdapter(state, recovery) {
	return {
		async quiesce() {},
		async snapshotTo() {
			throw new Error("recoverRun must never re-run a snapshot");
		},
		async resume(ctx) {
			recovery.ctxs.push(ctx);
			state.paused = false;
		},
	};
}

test("recoverRun resumes the paused store for the owner inside the fence, replaying the same ids", async () => {
	const ws = makeWorkspace();
	const { state, result } = await makePausedRun(ws, { owner: "owner-1" });
	assert.equal(result.status, "failed");
	assert.equal(state.paused, true, "the failed resume left the store paused");
	const journalBefore = readJournal(result.dir);
	assert.equal(journalBefore.stores[0].resume, "failed");

	const recovery = { ctxs: [] };
	const outcome = await recoverRun({
		rootDir: ws.rootDir,
		allowRoot: ws.allowRoot,
		runId: "run-recover",
		owner: "owner-1",
		now: () => 1500,
		stores: [{ name: "s", adapter: recoveryAdapter(state, recovery) }],
	});
	assert.deepEqual(outcome, { runId: "run-recover", resumed: ["s"], failed: [] });
	assert.equal(state.paused, false);
	assert.equal(recovery.ctxs.length, 1);
	assert.equal(recovery.ctxs[0].runId, "run-recover");
	assert.equal(recovery.ctxs[0].owner, "owner-1");
	assert.equal(recovery.ctxs[0].fence, journalBefore.fence.token, "recovery replays the journal's fence token");
	assert.equal(
		recovery.ctxs[0].operationId,
		"run-recover:s:resume",
		"recovery replays the same deterministic operation id the original run used",
	);

	const journalAfter = readJournal(result.dir);
	assert.equal(journalAfter.stores[0].resume, "confirmed");
	assert.equal(journalAfter.state, "recovered");
});

test("recoverRun with the wrong owner is refused before any store is touched", async () => {
	const ws = makeWorkspace();
	const { state, result } = await makePausedRun(ws, { owner: "owner-1" });
	const recovery = { ctxs: [] };

	await assert.rejects(
		() =>
			recoverRun({
				rootDir: ws.rootDir,
				allowRoot: ws.allowRoot,
				runId: "run-recover",
				owner: "intruder",
				now: () => 1500,
				stores: [{ name: "s", adapter: recoveryAdapter(state, recovery) }],
			}),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "recovery-not-authorized",
	);
	assert.equal(recovery.ctxs.length, 0, "resume was never called");
	assert.equal(state.paused, true, "the store is still paused");
	assert.equal(readJournal(result.dir).stores[0].resume, "failed", "the journal is untouched");
});

test("recoverRun refuses an expired fence without resuming anything", async () => {
	const ws = makeWorkspace();
	// Clock is fixed at 1000 and the fence lives 1000ms -> expiresAt 2000.
	const { state } = await makePausedRun(ws, { owner: "owner-1", fenceTtlMs: 1000 });
	const recovery = { ctxs: [] };

	await assert.rejects(
		() =>
			recoverRun({
				rootDir: ws.rootDir,
				allowRoot: ws.allowRoot,
				runId: "run-recover",
				owner: "owner-1",
				now: () => 2001, // injected clock past the fence
				stores: [{ name: "s", adapter: recoveryAdapter(state, recovery) }],
			}),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "fence-expired",
	);
	assert.equal(recovery.ctxs.length, 0, "resume was never called");
	assert.equal(state.paused, true, "the store is still paused");
});

test("recoverRun requires an adapter for every resumable store before resuming any", async () => {
	const ws = makeWorkspace();
	const { state } = await makePausedRun(ws, { owner: "owner-1" });

	await assert.rejects(
		() =>
			recoverRun({
				rootDir: ws.rootDir,
				allowRoot: ws.allowRoot,
				runId: "run-recover",
				owner: "owner-1",
				now: () => 1500,
				stores: [],
			}),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "invalid-store",
	);
	assert.equal(state.paused, true, "the store is still paused");
});

test("SIGKILL mid-run: the journal survives, inspectRun shows the gap, recoverRun closes it", async () => {
	const ws = makeWorkspace();
	const owner = "owner-sigkill";
	const runId = "run-sigkill";
	const orchestratorUrl = new URL("../control-plane/snapshot-orchestrator.mjs", import.meta.url).href;
	// The child registers a store whose snapshotTo hangs forever, then starts a
	// run. Its owner and all paths arrive via argv (no environment, no network).
	const childScript = `
		const [owner, rootDir, allowRoot, runId, url] = process.argv.slice(1);
		const { createSnapshotOrchestrator } = await import(url);
		const orchestrator = createSnapshotOrchestrator({ rootDir, allowRoot, owner });
		orchestrator.registerStore({
			name: "hang",
			kind: "spy",
			adapter: {
				async quiesce() {},
				async snapshotTo() { await new Promise(() => {}); },
				async resume() {},
			},
		});
		// Keep the event loop busy so Node's unsettled-top-level-await watchdog
		// cannot exit the process: only our SIGKILL may end this run.
		setInterval(() => {}, 60000);
		await orchestrator.run({ runId });
	`;
	const child = spawn(
		process.execPath,
		["--input-type=module", "-e", childScript, owner, ws.rootDir, ws.allowRoot, runId, orchestratorUrl],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let childStderr = "";
	child.stderr.on("data", (chunk) => {
		childStderr += chunk;
	});
	const childExit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

	// Wait until the journal proves the quiesce was confirmed — the child is
	// then hanging inside snapshotTo with the store logically paused.
	const runDir = join(ws.rootDir, runId);
	const deadline = Date.now() + 15000;
	let confirmedJournal = null;
	while (Date.now() < deadline) {
		try {
			const parsed = JSON.parse(readFileSync(join(runDir, "journal.json"), "utf8"));
			if (parsed.stores?.[0]?.quiesce === "confirmed") {
				confirmedJournal = parsed;
				break;
			}
		} catch {
			// journal not written yet
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(confirmedJournal !== null, `child never journaled a confirmed quiesce; stderr: ${childStderr}`);

	child.kill("SIGKILL");
	const exit = await childExit;
	assert.equal(exit.signal, "SIGKILL", "the child died by our signal, not on its own");

	// The crash left an honest, inspectable record: quiesce confirmed, never resumed.
	const crashed = readJournal(runDir);
	assert.equal(crashed.state, "running");
	assert.equal(crashed.stores[0].quiesce, "confirmed");
	assert.equal(crashed.stores[0].resume, "not-attempted");
	const view = inspectRun({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, runId });
	assert.deepEqual(view.resumable, ["hang"]);
	assert.deepEqual(view.needsReview, []);

	// The same owner recovers the run; the replayed ctx matches the journal.
	const recovery = { ctxs: [] };
	const outcome = await recoverRun({
		rootDir: ws.rootDir,
		allowRoot: ws.allowRoot,
		runId,
		owner,
		stores: [
			{
				name: "hang",
				adapter: {
					async quiesce() {},
					async snapshotTo() {
						throw new Error("recoverRun must never re-run a snapshot");
					},
					async resume(ctx) {
						recovery.ctxs.push(ctx);
					},
				},
			},
		],
	});
	assert.deepEqual(outcome.resumed, ["hang"]);
	assert.deepEqual(outcome.failed, []);
	assert.equal(recovery.ctxs.length, 1);
	assert.equal(recovery.ctxs[0].owner, owner);
	assert.equal(recovery.ctxs[0].fence, crashed.fence.token);
	assert.equal(recovery.ctxs[0].operationId, `${runId}:hang:resume`);
	const recovered = readJournal(runDir);
	assert.equal(recovered.stores[0].resume, "confirmed");
	assert.equal(recovered.state, "recovered");
});

test("adapters receive { runId, owner, fence, operationId } ctx matching the journal", async () => {
	const ws = makeWorkspace();
	const ctxs = { quiesce: [], snapshot: [], resume: [] };
	const orchestrator = createSnapshotOrchestrator({
		rootDir: ws.rootDir,
		allowRoot: ws.allowRoot,
		owner: "owner-ctx",
	});
	orchestrator.registerStore({
		name: "s",
		kind: "spy",
		adapter: {
			async quiesce(ctx) {
				ctxs.quiesce.push(ctx);
			},
			async snapshotTo(targetDir, ctx) {
				ctxs.snapshot.push(ctx);
				mkdirSync(targetDir, { mode: 0o700 });
				writeFileSync(join(targetDir, "d"), "d");
				return { files: ["d"] };
			},
			async resume(ctx) {
				ctxs.resume.push(ctx);
			},
		},
	});
	const result = await orchestrator.run({ runId: "run-ctx" });
	assert.equal(result.status, "success");
	const journal = readJournal(result.dir);
	for (const [operation, list] of Object.entries(ctxs)) {
		assert.equal(list.length, 1, `${operation} ctx was delivered exactly once`);
		assert.equal(list[0].runId, "run-ctx");
		assert.equal(list[0].owner, "owner-ctx");
		assert.equal(list[0].owner, journal.owner);
		assert.equal(list[0].fence, journal.fence.token);
		assert.equal(list[0].operationId, `run-ctx:s:${operation}`);
	}
});

// --- SN-F003: error sanitization (canary sweep) -------------------------------

test("adapter canary secrets never reach the manifest, the journal, the disk or the run DTO", async () => {
	for (const stage of ["quiesce", "snapshot", "resume"]) {
		const ws = makeWorkspace();
		const canary = `canary-${stage}-sk_test_SYNTHETIC_SECRET_123`;
		const makeCanaryError = () => {
			const error = new Error(`adapter blew up: ${canary}`);
			error.name = `Canary${stage}Error`;
			error.cause = new Error(`nested cause ${canary}`);
			return error; // the stack carries the canary too (it embeds the message)
		};
		const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
		orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", []) });
		orchestrator.registerStore({
			name: "bad",
			kind: "spy",
			adapter: {
				async quiesce() {
					if (stage === "quiesce") throw makeCanaryError();
				},
				async snapshotTo(targetDir) {
					if (stage === "snapshot") throw makeCanaryError();
					mkdirSync(targetDir, { mode: 0o700 });
					writeFileSync(join(targetDir, "d"), "d");
					return { files: ["d"] };
				},
				async resume() {
					if (stage === "resume") throw makeCanaryError();
				},
			},
		});

		const result = await orchestrator.run({ runId: `run-canary-${stage}` });
		assert.equal(result.status, stage === "quiesce" ? "needs-review" : "failed");
		assert.deepEqual(result.error, { code: `${stage}-failed`, stage, store: "bad" });

		// Sweep every persisted byte (manifest, journal, leftover tmp files,
		// store evidence) plus the returned DTO for any canary substring.
		const diskText = readTreeText(result.dir);
		assert.ok(!diskText.includes(canary), `canary leaked to disk at stage ${stage}`);
		assert.ok(!diskText.includes(`Canary${stage}Error`), `custom error name leaked to disk at stage ${stage}`);
		assert.ok(!JSON.stringify(result).includes(canary), `canary leaked into the run DTO at stage ${stage}`);
	}
});

test("a failed manifest write is a fixed-code failure — no system error text or paths leak", async () => {
	const ws = makeWorkspace();
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({
		name: "saboteur",
		kind: "spy",
		adapter: {
			async quiesce() {},
			async snapshotTo(targetDir) {
				mkdirSync(targetDir, { mode: 0o700 });
				writeFileSync(join(targetDir, "d"), "d");
				// Occupy the manifest's final path with a directory (runDir is the
				// target's parent) so the atomic rename fails with a raw fs error.
				mkdirSync(join(dirname(targetDir), "manifest.json"), { mode: 0o700 });
				return { files: ["d"] };
			},
			async resume() {},
		},
	});

	const result = await orchestrator.run({ runId: "run-manifest-fail" });
	assert.equal(result.status, "failed");
	assert.deepEqual(result.error, { code: "manifest-write-failed", stage: "manifest-write" });
	assert.equal(result.manifestPath, null);
	// The occupying directory is still there and still empty (never replaced).
	assert.deepEqual(readdirSync(join(result.dir, "manifest.json")), []);

	const diskText = readTreeText(result.dir);
	const dtoText = JSON.stringify({
		error: result.error,
		stores: result.stores,
		resumeErrors: result.resumeErrors,
		manifest: result.manifest,
	});
	for (const needle of ["EACCES", "ENOTEMPTY", "EEXIST", "EISDIR", "EPERM"]) {
		assert.ok(!diskText.includes(needle), `system error text ${needle} leaked to disk`);
		assert.ok(!dtoText.includes(needle), `system error text ${needle} leaked into the DTO`);
	}
	assert.ok(!diskText.includes(ws.rootDir), "an absolute path leaked to disk");
	assert.ok(!dtoText.includes(ws.rootDir), "an absolute path leaked into the DTO");
});

test("persistent journal write failure after quiesce cannot skip required cleanup or expose filesystem errors", async () => {
	for (const stage of ["quiesce", "quiesce-throw", "next-intent", "snapshot", "snapshot-throw", "resume", "terminal"]) {
		const ws = makeWorkspace();
		const calls = [];
		const paused = new Set();
		let poison = false;
		const originalWrite = fs.writeFileSync;
		const injected = mock.method(fs, "writeFileSync", (path, data, ...args) => {
			if (String(path).endsWith("journal.json.tmp") && (poison ||
				(stage === "terminal" && JSON.parse(String(data)).state === "completed") ||
				(stage === "next-intent" && JSON.parse(String(data)).stores[1].quiesce === "intent"))) {
				const error = new Error("EIO /private/secret-storage-path");
				error.code = "EIO";
				error.path = "/private/secret-storage-path";
				throw error;
			}
			return originalWrite(path, data, ...args);
		});
		syncBuiltinESMExports();
		try {
			const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, owner: "journal-owner" });
			for (const name of ["a", "b", "c"]) orchestrator.registerStore({ name, kind: "synthetic", adapter: {
				async quiesce() {
					calls.push(`quiesce:${name}`);
					paused.add(name);
					if (name === "b" && stage.startsWith("quiesce")) {
						poison = true;
						if (stage.endsWith("throw")) throw new Error("pause acknowledgement lost");
					}
				},
				async snapshotTo(target) {
					calls.push(`snapshot:${name}`);
					if (name === "b" && stage.startsWith("snapshot")) {
						poison = true;
						if (stage.endsWith("throw")) throw new Error("copy acknowledgement lost");
					}
					mkdirSync(target);
					writeFileSync(join(target, "payload"), name);
				},
				async resume() {
					calls.push(`resume:${name}`);
					if (name === "c" && stage === "resume") {
						poison = true;
						throw new Error("resume uncertain");
					}
					paused.delete(name);
				},
			} });
			const result = await orchestrator.run({ runId: "journal-fault" });
			assert.equal(result.status, "needs-review", stage);
			assert.equal(result.journalPersistence, "uncertain");
			assert.deepEqual(result.error, { code: "journal-write-failed", stage: "journal-write" });
			const cleanup = calls.filter((call) => call.startsWith("resume:"));
			assert.deepEqual(cleanup, stage === "next-intent" ? ["resume:a"] : stage.startsWith("quiesce")
				? ["resume:b", "resume:a"] : ["resume:c", "resume:b", "resume:a"]);
			assert.deepEqual([...paused], stage === "resume" ? ["c"] : []);
			if (stage.startsWith("quiesce")) assert.ok(!calls.some((call) => call.startsWith("snapshot:")));
			if (stage === "next-intent") assert.deepEqual(calls, ["quiesce:a", "resume:a"]);
			if (stage.startsWith("snapshot")) assert.ok(!calls.includes("snapshot:c"));
			assert.equal(result.resumeErrors.length, stage === "resume" ? 1 : 0);
			assert.equal(readManifest(result.dir).journalPersistence, "uncertain");
			const dto = JSON.stringify({ error: result.error, stores: result.stores, resumeErrors: result.resumeErrors, manifest: result.manifest });
			for (const text of [dto, readTreeText(result.dir)]) {
				assert.ok(!text.includes("EIO"));
				assert.ok(!text.includes("/private/secret-storage-path"));
			}
			const view = inspectRun({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, runId: result.runId });
			assert.notEqual(view.state, "completed", "stale journal must not claim completion");
		} finally {
			injected.mock.restore();
			syncBuiltinESMExports();
		}
	}
});

test("persistent recovery journal failure still attempts every required resume and reports uncertainty", async () => {
	const ws = makeWorkspace();
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot,
		owner: "recover-owner", now: () => 1000 });
	for (const name of ["a", "b"]) orchestrator.registerStore({ name, kind: "synthetic",
		adapter: recordingAdapter(name, [], { resumeThrows: true }) });
	const run = await orchestrator.run({ runId: "recovery-write-fault" });
	assert.equal(run.status, "failed");
	const originalWrite = fs.writeFileSync;
	const injected = mock.method(fs, "writeFileSync", (path, ...args) => {
		if (String(path).endsWith("journal.json.tmp")) throw new Error("EIO /private/recovery-secret");
		return originalWrite(path, ...args);
	});
	syncBuiltinESMExports();
	try {
		const resumed = [];
		const recovery = await recoverRun({ rootDir: ws.rootDir, allowRoot: ws.allowRoot, runId: run.runId,
			owner: "recover-owner", now: () => 1001, stores: ["a", "b"].map((name) => ({ name,
				adapter: { async resume() { resumed.push(name); } } })) });
		assert.deepEqual(resumed, ["a", "b"]);
		assert.equal(recovery.status, "needs-review");
		assert.equal(recovery.journalPersistence, "uncertain");
		assert.deepEqual(recovery.error, { code: "journal-write-failed", stage: "journal-write" });
		assert.ok(!JSON.stringify(recovery).includes("EIO"));
		assert.ok(!JSON.stringify(recovery).includes("/private/recovery-secret"));
		assert.equal(readJournal(run.dir).state, "aborted", "durable journal still requires review");
	} finally {
		injected.mock.restore();
		syncBuiltinESMExports();
	}
});

test("failed initial journal write is redacted and invokes no adapter", async () => {
	const ws = makeWorkspace();
	const calls = [];
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "synthetic", adapter: recordingAdapter("a", calls) });
	const originalWrite = fs.writeFileSync;
	const injected = mock.method(fs, "writeFileSync", (path, ...args) => {
		if (String(path).endsWith("journal.json.tmp")) throw new Error("EIO /private/secret");
		return originalWrite(path, ...args);
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(() => orchestrator.run({ runId: "initial-fault" }), (error) => {
			assert.equal(error.code, "journal-write-failed");
			assert.ok(!error.message.includes("EIO"));
			assert.ok(!error.message.includes("/private/secret"));
			return true;
		});
		assert.deepEqual(calls, []);
	} finally {
		injected.mock.restore();
		syncBuiltinESMExports();
	}
});

test("exported snapshot Error subclass enforces stage allowlists even when code is modified", async () => {
	for (const stage of ["quiesce", "snapshot", "resume"]) {
		for (const supplied of ["secret-code-/private/credential", "invalid-config", "target-exists"]) {
			for (const mutate of [false, true]) {
				const ws = makeWorkspace();
				const calls = [];
				const adapter = recordingAdapter("a", calls);
				const error = new SnapshotOrchestratorError(supplied);
				if (supplied.startsWith("secret")) assert.equal(error.code, "adapter-failed");
				if (mutate) error.code = supplied;
				adapter[stage === "snapshot" ? "snapshotTo" : stage] = async () => { throw error; };
				const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
				orchestrator.registerStore({ name: "a", kind: "synthetic", adapter });
				const result = await orchestrator.run({ runId: "subclass-code" });
				assert.equal(result.error.code, stage === "snapshot" && supplied === "target-exists" ? supplied : `${stage}-failed`);
				assert.notEqual(result.status, "success");
				assert.ok(!JSON.stringify(result).includes("secret-code-/private/credential"));
				assert.ok(!readTreeText(result.dir).includes("secret-code-/private/credential"));
			}
		}
	}
});

test("adapter error code is captured once so a changing subclass getter cannot bypass redaction", async () => {
	const ws = makeWorkspace();
	const error = new SnapshotOrchestratorError("target-exists");
	let reads = 0;
	Object.defineProperty(error, "code", { get() { return ++reads === 1 ? "target-exists" : "secret-changing-code"; } });
	const adapter = recordingAdapter("a", []);
	adapter.snapshotTo = async () => { throw error; };
	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "synthetic", adapter });
	const result = await orchestrator.run({ runId: "changing-code" });
	assert.equal(result.status, "failed");
	assert.equal(result.stores[0].error.code, "target-exists");
	assert.equal(result.error.code, "target-exists");
	assert.equal(reads, 1, "the same captured failure is used in both DTO positions");
	assert.ok(!JSON.stringify(result).includes("secret-changing-code"));
	assert.ok(!readTreeText(result.dir).includes("secret-changing-code"));
});
