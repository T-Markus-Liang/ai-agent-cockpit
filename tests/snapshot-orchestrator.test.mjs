// Focused tests for the Wave 5 consistent quiesced snapshot orchestrator.
//
// Every fixture is a self-built synthetic tree under a private
// `os.tmpdir()/snapshot-orch-*` directory. These tests never touch production
// state (~/.local/state/personal-ai-os/, ~/.wechat-acp/), never launch a service,
// never use the network, credentials, a model or WeChat, and never invoke git.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
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
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSnapshotOrchestrator, SnapshotOrchestratorError } from "../control-plane/snapshot-orchestrator.mjs";

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
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.orchestratorVersion, "snapshot-orchestrator-v1");
	assert.equal(manifest.network_calls, 0);
	assert.equal(manifest.stores.length, 2);
	assert.deepEqual(manifest.quiesceOrder, ["mem0", "goals"]);
	assert.deepEqual(manifest.resumeOrder, ["goals", "mem0"]);

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
	assert.match(manifest.error.reason, /boom-bad/);
	const stores = byName(manifest);
	assert.equal(stores.a.status, "ok");
	assert.equal(stores.bad.status, "failed");
	assert.match(stores.bad.error, /boom-bad/);
	assert.equal(stores.c.status, "skipped");
	assert.equal(stores.c.sha256, undefined, "an unattempted store carries no evidence");
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
	assert.equal(result.resumeErrors[0].name, "b");
	assert.match(result.resumeErrors[0].error, /resume-fail-b/);

	// All snapshots themselves succeeded.
	const manifest = readManifest(result.dir);
	assert.equal(manifest.status, "failed");
	assert.equal(manifest.resumeErrors.length, 1);
	assert.ok(manifest.stores.every((store) => store.status === "ok"));
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

test("refuses an existing run directory and leaves it byte- and entry-identical", async () => {
	const ws = makeWorkspace();
	const runId = "run-fixed";
	const existing = join(ws.rootDir, runId);
	mkdirSync(existing, { mode: 0o700 });
	writeFileSync(join(existing, "keep.txt"), "keep");
	const entriesBefore = readdirSync(existing).sort();
	const bytesBefore = readFileSync(join(existing, "keep.txt"), "utf8");

	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.rootDir, allowRoot: ws.allowRoot });
	orchestrator.registerStore({ name: "a", kind: "spy", adapter: recordingAdapter("a", []) });

	await assert.rejects(
		() => orchestrator.run({ runId }),
		(error) => error instanceof SnapshotOrchestratorError && error.code === "target-exists",
	);
	assert.deepEqual(readdirSync(existing).sort(), entriesBefore);
	assert.equal(readFileSync(join(existing, "keep.txt"), "utf8"), bytesBefore);
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
