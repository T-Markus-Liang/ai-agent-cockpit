// Wave 5 joint verification — migration + rollback drill.
//
// This drill chains the two P6 halves into one end-to-end rehearsal:
//   snapshot-orchestrator.mjs (D64) captures a consistent per-store copy, and
//   state-converter.mjs (D65) converts that copy. Neither module is modified;
//   the drill *composes* them and then proves the two-sided conservation the
//   readiness map asked for:
//     forward  (source -> converted)  conserves every collection, and
//     reverse  (snapshot -> restored)  returns the store to its seeded state.
//
// It also injects a migration accident (garbage written over the working store
// files) and rehearses a rollback, then exercises the fail-closed negatives a
// production rollback orchestrator must honour: a tampered snapshot manifest, a
// snapshot file missing, and an untracked new file in the rollback target.
//
// Every fixture is a self-built synthetic tree under a private
// `os.tmpdir()/migration-drill-*` directory. These tests never touch production
// state (~/.local/state/personal-ai-os/, ~/.local/state/ai-agent-cockpit/,
// ~/.wechat-acp/), never launch a service, never use the network, credentials,
// a model or WeChat, and never invoke git.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
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
import { basename, dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSnapshotOrchestrator } from "../control-plane/snapshot-orchestrator.mjs";
import { convertState, verifyConversion } from "../control-plane/state-converter.mjs";
import { goalSpecDigest, validateGoalSpec } from "../control-plane/goal-store.mjs";

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;
const ts = "2025-01-01T00:00:00.000Z";
const sha = (char) => `sha256:${char.repeat(64)}`;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const createdRoots = [];

// ---------------------------------------------------------------------------
// the rollback prototype
// ---------------------------------------------------------------------------
//
// `restoreStores()` is deliberately written as a *minimal but fail-closed*
// stand-in for the future production rollback orchestrator. Its shape is the
// interface contract that orchestrator should keep:
//
//   * two phases, both over the whole run: phase 1 verifies EVERY store's
//     evidence read-only, phase 2 only then writes anything back. A single
//     mismatch aborts before the first byte is written (fail-closed), so a
//     partially-trusted snapshot can never half-restore a live store.
//   * the snapshot's own manifest is the source of truth for what to restore:
//     each file's recorded sha256 + byte count is recomputed and compared, and
//     the per-store combined digest is re-derived, so a tampered manifest or a
//     drifted snapshot is refused rather than trusted.
//   * a rollback never silently deletes: files present in the target but absent
//     from the snapshot are reported as `extraFiles` and left in place for a
//     human to disposition.
//   * writes are atomic (tmp + fsync + rename + dir fsync), matching the
//     atomic-write convention of store.mjs / state-converter.mjs.
export class RollbackError extends Error {
	constructor(code, message) {
		super(message ?? code);
		this.name = "RollbackError";
		this.code = code;
	}
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir, acc = []) {
	for (const name of readdirSync(dir).sort()) {
		const child = join(dir, name);
		const stats = lstatSync(child);
		if (stats.isDirectory()) walkFiles(child, acc);
		else if (stats.isFile()) acc.push(child);
	}
	return acc;
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The orchestrator's combined per-store digest: sorted `path\0sha256\n` lines. */
function combinedDigest(files) {
	const hasher = createHash("sha256");
	for (const file of [...files].sort(byPath)) {
		hasher.update(file.path);
		hasher.update("\0");
		hasher.update(file.sha256);
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

/** Recompute a store's snapshot evidence from the bytes on disk. */
function recomputeEvidence(dir) {
	const files = walkFiles(dir)
		.map((absolute) => ({
			path: relative(dir, absolute),
			sha256: sha256File(absolute),
			bytes: statSync(absolute).size,
		}))
		.sort(byPath);
	return { files, sha256: combinedDigest(files), bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

function fsyncPath(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is not portable; a failure never invalidates the write.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeFileAtomic(destination, bytes) {
	const dir = dirname(destination);
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const tmp = join(dir, `.${basename(destination)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
	writeFileSync(tmp, bytes, { mode: FILE_MODE });
	fsyncPath(tmp);
	renameSync(tmp, destination);
	fsyncPath(dir);
	return destination;
}

/** Verify one store's snapshot dir against its manifest entry; throws on drift. */
function verifyStoreEvidence(snapshotDir, store) {
	const onDisk = walkFiles(snapshotDir)
		.map((absolute) => ({
			path: relative(snapshotDir, absolute),
			sha256: sha256File(absolute),
			bytes: statSync(absolute).size,
		}))
		.sort(byPath);
	const recorded = [...store.files].sort(byPath);
	const recordedPaths = new Set(recorded.map((file) => file.path));
	const onDiskPaths = new Set(onDisk.map((file) => file.path));

	for (const file of recorded) {
		if (!onDiskPaths.has(file.path)) {
			throw new RollbackError("snapshot-file-missing", `snapshot is missing ${store.name}/${file.path}`);
		}
	}
	for (const file of onDisk) {
		if (!recordedPaths.has(file.path)) {
			throw new RollbackError("snapshot-file-unexpected", `snapshot has an unaccounted file ${store.name}/${file.path}`);
		}
	}
	for (const file of onDisk) {
		const rec = recorded.find((candidate) => candidate.path === file.path);
		if (file.sha256 !== rec.sha256) {
			throw new RollbackError("snapshot-hash-mismatch", `${store.name}/${file.path} sha256 does not match the snapshot manifest`);
		}
		if (file.bytes !== rec.bytes) {
			throw new RollbackError("snapshot-size-mismatch", `${store.name}/${file.path} byte count does not match the snapshot manifest`);
		}
	}
	if (combinedDigest(onDisk) !== store.sha256) {
		throw new RollbackError("snapshot-digest-mismatch", `${store.name} combined digest drifted from the snapshot manifest`);
	}
	return onDisk;
}

/** Files present in the rollback target but not accounted for by the snapshot. */
function listExtraFiles(target, store, files) {
	const known = new Set(files.map((file) => file.path));
	const extra = [];
	if (store.kind === "filedir") {
		if (existsSync(target.path) && statSync(target.path).isDirectory()) {
			for (const absolute of walkFiles(target.path)) {
				const rel = relative(target.path, absolute);
				if (!known.has(rel)) extra.push({ name: store.name, path: rel, bytes: statSync(absolute).size });
			}
		}
	} else if (store.kind === "sqlite") {
		// A stale WAL/shm sidecar is an unaccounted file too; report it, never delete it.
		for (const sidecar of [`${target.path}-wal`, `${target.path}-shm`]) {
			if (existsSync(sidecar)) extra.push({ name: store.name, path: basename(sidecar), bytes: statSync(sidecar).size });
		}
	}
	return extra;
}

/**
 * Restore the stores a snapshot captured back into their working locations.
 *
 * @param {object} options
 * @param {string} options.runDir  an orchestrator run directory (holds manifest.json).
 * @param {Record<string, {kind: string, path: string}>} options.targets
 *        rollback destination per store name: for `sqlite` a file path, for
 *        `filedir` a directory path.
 */
function restoreStores({ runDir, targets } = {}) {
	const manifestPath = join(runDir, "manifest.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		throw new RollbackError("manifest-missing", "snapshot manifest is missing or unreadable");
	}
	if (manifest.status !== "success") {
		throw new RollbackError("snapshot-not-successful", `snapshot status is ${manifest.status}; refusing to restore`);
	}

	// Phase 1 — verify everything read-only, before writing anything.
	const plans = [];
	for (const store of manifest.stores) {
		const target = targets[store.name];
		if (!target) throw new RollbackError("no-rollback-target", `no rollback target for store ${store.name}`);
		if (target.kind !== store.kind) {
			throw new RollbackError("target-kind-mismatch", `rollback target kind for ${store.name} does not match the snapshot`);
		}
		const snapshotDir = join(runDir, store.name);
		const files = verifyStoreEvidence(snapshotDir, store);
		const extra = listExtraFiles(target, store, files);
		plans.push({ store, target, snapshotDir, files, extra });
	}

	// Phase 2 — atomic write-back (only reached once every store verified).
	const report = { ok: true, runId: manifest.runId, stores: [], extraFiles: [] };
	for (const plan of plans) {
		for (const file of plan.files) {
			const source = join(plan.snapshotDir, file.path);
			const destination = plan.target.kind === "sqlite" ? plan.target.path : join(plan.target.path, file.path);
			writeFileAtomic(destination, readFileSync(source));
		}
		report.stores.push({
			name: plan.store.name,
			kind: plan.store.kind,
			restoredFiles: plan.files.length,
			extraFiles: plan.extra.map((entry) => entry.path),
		});
		report.extraFiles.push(...plan.extra);
	}
	return report;
}

// ---------------------------------------------------------------------------
// fixtures (kept in step with the snapshot-orchestrator / state-converter tests)
// ---------------------------------------------------------------------------
function makeDrillWorkspace() {
	const base = mkdtempSync(join(tmpdir(), "migration-drill-"));
	createdRoots.push(base);
	const snapshots = join(base, "snapshots");
	mkdirSync(snapshots, { recursive: true, mode: DIR_MODE });
	return { base, allowRoot: base, snapshots };
}

/** A live WAL-mode SQLite store whose committed rows are still in the -wal sidecar. */
function seedSqlite(path) {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("CREATE TABLE turns(event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
	db.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL)");
	const insertTurn = db.prepare("INSERT INTO turns(event_id,payload) VALUES(?,?)");
	insertTurn.run("e1", JSON.stringify({ role: "user", text: "hello" }));
	insertTurn.run("e2", JSON.stringify({ role: "assistant", text: "hi" }));
	db.prepare("INSERT INTO sessions(session_id,owner) VALUES(?,?)").run("s1", "markus");
	db.close();
}

/** A content-level dump (per-table, sorted rows) for sqlite equality checks. */
function dumpSqlite(path) {
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
}

function tableCounts(dump) {
	return Object.fromEntries(Object.entries(dump).map(([table, rows]) => [table, rows.length]));
}

/** A 0.2.2-era control-plane state: every base scaffold present, newer optional
 * fields (chief, sourceRequestId, role, verdict, expiresAt, …) simply absent. */
function controlPlaneV022State() {
	return {
		version: 1,
		tasks: {
			task_1: {
				contractVersion: 1,
				type: "Task",
				id: "task_1",
				goal: "ship it",
				status: "draft",
				constraints: [],
				acceptanceCriteria: [],
				executionIds: ["execution_1"],
				createdAt: ts,
				updatedAt: ts,
			},
		},
		executions: {
			execution_1: {
				contractVersion: 1,
				type: "Execution",
				id: "execution_1",
				taskId: "task_1",
				workerId: "worker",
				status: "succeeded",
				attempt: 1,
				artifactRef: sha("a"),
				evidenceIds: [],
			},
		},
		evidence: {
			evidence_1: {
				contractVersion: 1,
				type: "Evidence",
				id: "evidence_1",
				executionId: "execution_1",
				kind: "test",
				summary: "node --test green",
				source: "node --test",
				capturedAt: ts,
				redacted: true,
				exitCode: 0,
				artifactRef: sha("a"),
			},
		},
		approvals: {
			approval_1: {
				contractVersion: 1,
				type: "Approval",
				id: "approval_1",
				action: "task.complete",
				target: "task_1",
				parametersDigest: sha("b"),
				decision: "pending",
				createdAt: ts,
			},
		},
		idempotency: {
			key1: { operation: "task.create", fingerprint: "c".repeat(64), result: { taskId: "task_1" }, at: ts },
		},
		locks: {
			session_1: { sessionRefId: "session_1", owner: "owner", token: "lock_1", acquiredAt: ts, expiresAt: ts },
		},
		events: [
			{ id: "event_1", type: "task.created", entityType: "Task", entityId: "task_1", details: {}, at: ts },
		],
	};
}

function goalSpec(base) {
	return validateGoalSpec({
		title: "T",
		objective: "O",
		sourceDir: join(base, "project"),
		readPaths: ["a.mjs", "a.test.mjs"],
		writePaths: ["a.mjs"],
		checks: [{ name: "accept", args: ["--test", "a.test.mjs"] }],
		limits: { maxIterations: 10, maxTokens: 80000, maxDurationMs: 86400000, maxNoProgress: 3, intervalMs: 5000 },
		recovery: { enabled: true, maxAttempts: 3 },
	});
}

function goalRecord(base, id, overrides = {}) {
	const spec = goalSpec(base);
	return {
		id,
		spec,
		specDigest: goalSpecDigest(spec),
		owner: "local",
		generation: 1,
		status: "ready",
		iterations: 0,
		tokensUsed: 0,
		noProgress: 0,
		history: [],
		workspaceDir: join(base, "ws", id),
		createdAt: ts,
		nextWakeAt: FIXED_NOW,
		...overrides,
	};
}

function goalsState(base) {
	return {
		version: 1,
		goals: { goal_1: goalRecord(base, "goal_1") },
		requests: { [sha("d")]: { id: "goal_1", digest: sha("e") } },
		events: [{ goalId: "goal_1", type: "created", at: ts, generation: 1 }],
	};
}

// ---------------------------------------------------------------------------
// the drill report (structured evidence of every step)
// ---------------------------------------------------------------------------
const report = {
	drill: "wave5-migration-rollback-drill",
	version: 1,
	clock: FIXED_NOW,
	network_calls: 0,
	allowRoot: null,
	steps: {},
	negatives: [],
};
const drillState = { base: null };

function writeReport() {
	const path = join(drillState.base, "drill-report.json");
	writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`DRILL_REPORT ${JSON.stringify(report)}`);
	return path;
}

/** Seed the three synthetic stores and take one consistent snapshot of them. */
async function seedAndSnapshot() {
	const ws = makeDrillWorkspace();

	const memDir = join(ws.base, "stores", "memory");
	mkdirSync(memDir, { recursive: true, mode: DIR_MODE });
	const dbPath = join(memDir, "ingest.sqlite");
	seedSqlite(dbPath);

	const cpDir = join(ws.base, "stores", "controlplane");
	mkdirSync(cpDir, { recursive: true, mode: DIR_MODE });
	const cpFile = join(cpDir, "control-plane.json");
	writeFileSync(cpFile, `${JSON.stringify(controlPlaneV022State(), null, 2)}\n`);

	const goalsDir = join(ws.base, "stores", "goals");
	mkdirSync(goalsDir, { recursive: true, mode: DIR_MODE });
	const goalsFile = join(goalsDir, "goals.json");
	writeFileSync(goalsFile, `${JSON.stringify(goalsState(ws.base), null, 2)}\n`);

	const orchestrator = createSnapshotOrchestrator({ rootDir: ws.snapshots, allowRoot: ws.allowRoot, now: fixedClock });
	orchestrator.registerStore({ name: "memory", kind: "sqlite", path: dbPath });
	orchestrator.registerStore({ name: "controlplane", kind: "filedir", path: cpDir });
	orchestrator.registerStore({ name: "goals", kind: "filedir", path: goalsDir });
	const snapshot = await orchestrator.run({ runId: "drill-run" });

	return {
		ws,
		snapshot,
		dbPath,
		cpDir,
		cpFile,
		goalsDir,
		goalsFile,
		targets: {
			memory: { kind: "sqlite", path: dbPath },
			controlplane: { kind: "filedir", path: cpDir },
			goals: { kind: "filedir", path: goalsDir },
		},
	};
}

after(() => {
	for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the drill: seed -> snapshot -> convert -> fault -> rollback (both ways)
// ---------------------------------------------------------------------------
test("positive drill: snapshot -> convert -> fault -> rollback conserves the source in both directions", async () => {
	const h = await seedAndSnapshot();
	const { ws, snapshot, dbPath, cpFile, goalsFile, targets } = h;
	drillState.base = ws.base;
	report.allowRoot = ws.base;

	// --- step 1: seed three stores and record the full content baseline -----
	const baseline = {
		memory: { kind: "sqlite", path: dbPath, sha256: sha256File(dbPath), content: dumpSqlite(dbPath) },
		controlplane: { kind: "filedir", path: cpFile, sha256: sha256File(cpFile) },
		goals: { kind: "filedir", path: goalsFile, sha256: sha256File(goalsFile) },
	};
	report.steps.seed = {
		stores: [
			{ name: "memory", kind: "sqlite", sha256: baseline.memory.sha256, tables: tableCounts(baseline.memory.content) },
			{ name: "controlplane", kind: "filedir", sha256: baseline.controlplane.sha256 },
			{ name: "goals", kind: "filedir", sha256: baseline.goals.sha256 },
		],
	};

	// --- step 2: snapshot; manifest success + hashes re-verifiable ----------
	// The orchestrator's terminal-success status literal is "success" (there is
	// no separate "completed"); the design prose "status completed" maps to it.
	assert.equal(snapshot.status, "success");
	const manifest = JSON.parse(readFileSync(join(snapshot.dir, "manifest.json"), "utf8"));
	assert.equal(manifest.status, "success");
	assert.equal(manifest.network_calls, 0);
	for (const store of manifest.stores) {
		assert.equal(store.status, "ok");
		const evidence = recomputeEvidence(join(snapshot.dir, store.name));
		assert.equal(evidence.sha256, store.sha256, `${store.name} combined digest is re-verifiable`);
		assert.equal(evidence.bytes, store.bytes);
		for (const file of store.files) {
			assert.equal(file.sha256, sha256File(join(snapshot.dir, store.name, file.path)));
		}
	}
	report.steps.snapshot = {
		status: manifest.status,
		runId: manifest.runId,
		dir: snapshot.dir,
		stores: manifest.stores.map((store) => ({ name: store.name, kind: store.kind, status: store.status, sha256: store.sha256, bytes: store.bytes, files: store.files.map((file) => file.path) })),
		hashesReverified: true,
	};

	// --- step 3: convert the two JSON snapshot copies -----------------------
	const conversions = {};
	for (const [kind, storeName, fileName, outName] of [
		["control-plane", "controlplane", "control-plane.json", "control-plane"],
		["goals", "goals", "goals.json", "goals"],
	]) {
		const sourceFile = join(snapshot.dir, storeName, fileName);
		const targetDir = join(ws.base, "converted", outName);
		const result = convertState({ sourceFile, targetDir, kind, allowRoot: ws.base, now: fixedClock });
		assert.equal(result.written, true);
		assert.equal(result.plan.conservation.ok, true);
		assert.equal(result.plan.conservation.rejected, 0);
		assert.equal(result.plan.conservation.sourceRecords, result.plan.conservation.targetRecords);
		for (const collection of result.plan.collections) {
			assert.equal(collection.sourceCount, collection.targetCount, `${kind}.${collection.name} count conserved`);
		}
		assert.equal(result.manifest.twoDryRunsIdentical, true);
		assert.equal(verifyConversion({ targetDir }).ok, true);
		conversions[kind] = result;
	}
	report.steps.conversion = {
		"control-plane": {
			written: true,
			conservation: conversions["control-plane"].plan.conservation,
			twoDryRunsIdentical: true,
			verified: true,
			collections: conversions["control-plane"].plan.collections.map((c) => ({ name: c.name, sourceCount: c.sourceCount, targetCount: c.targetCount })),
		},
		goals: {
			written: true,
			conservation: conversions.goals.plan.conservation,
			twoDryRunsIdentical: true,
			verified: true,
			collections: conversions.goals.plan.collections.map((c) => ({ name: c.name, sourceCount: c.sourceCount, targetCount: c.targetCount })),
		},
	};

	// --- step 4: fault injection — wreck the working store files ------------
	// Simulate a migration accident: the working copies are overwritten with
	// garbage. For the sqlite store the WAL/shm sidecars are removed too, as a
	// truncated/lost database would be.
	writeFileSync(dbPath, "CORRUPTED-NOT-A-DATABASE", { mode: FILE_MODE });
	for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
		if (existsSync(sidecar)) rmSync(sidecar, { force: true });
	}
	writeFileSync(cpFile, "GARBAGE", { mode: FILE_MODE });
	writeFileSync(goalsFile, "GARBAGE", { mode: FILE_MODE });
	assert.notEqual(sha256File(cpFile), baseline.controlplane.sha256);
	assert.notEqual(sha256File(goalsFile), baseline.goals.sha256);
	report.steps.faultInjection = {
		corrupted: ["memory", "controlplane", "goals"],
		note: "working copies overwritten with garbage; sqlite wal/shm sidecars removed",
	};

	// --- step 5: rollback from the snapshot --------------------------------
	const rollback = restoreStores({ runDir: snapshot.dir, targets });
	assert.equal(rollback.ok, true);
	for (const store of rollback.stores) assert.equal(store.extraFiles.length, 0);

	// JSON stores: byte-for-byte equal to the baseline.
	assert.equal(sha256File(cpFile), baseline.controlplane.sha256, "control-plane.json restored byte-identical");
	assert.equal(sha256File(goalsFile), baseline.goals.sha256, "goals.json restored byte-identical");

	// SQLite store: content-level equal to the baseline. The file bytes need not
	// match (the snapshot is normalised to a DELETE-mode single file), so the
	// equality is proven by dumping every table and comparing rows.
	const restoredDump = dumpSqlite(dbPath);
	assert.deepEqual(tableCounts(restoredDump), tableCounts(baseline.memory.content));
	assert.deepEqual(restoredDump, baseline.memory.content);
	const memoryBytes = { baseline: baseline.memory.sha256, restored: sha256File(dbPath), bytesIdentical: sha256File(dbPath) === baseline.memory.sha256 };

	report.steps.rollback = {
		ok: true,
		runId: rollback.runId,
		stores: rollback.stores,
		extraFiles: rollback.extraFiles,
		jsonByteIdentical: {
			controlplane: sha256File(cpFile) === baseline.controlplane.sha256,
			goals: sha256File(goalsFile) === baseline.goals.sha256,
		},
		sqliteContentIdentical: true,
		sqliteBytes: memoryBytes,
	};

	// --- step 7: two-sided conservation ------------------------------------
	const forward = {};
	for (const kind of ["control-plane", "goals"]) {
		const plan = conversions[kind].plan;
		forward[kind] = {
			collections: plan.collections.map((c) => ({ name: c.name, sourceCount: c.sourceCount, targetCount: c.targetCount, equal: c.sourceCount === c.targetCount })),
			conservation: plan.conservation,
			ok: plan.collections.every((c) => c.sourceCount === c.targetCount) && plan.conservation.ok,
		};
	}
	const reverse = {
		memory: {
			tables: Object.keys(baseline.memory.content).map((table) => ({
				name: table,
				baselineRows: baseline.memory.content[table].length,
				restoredRows: restoredDump[table] ? restoredDump[table].length : 0,
			})),
			contentEqual: JSON.stringify(restoredDump) === JSON.stringify(baseline.memory.content),
		},
		controlplane: { snapshotFiles: 1, restoredFiles: rollback.stores.find((s) => s.name === "controlplane").restoredFiles, byteEqual: sha256File(cpFile) === baseline.controlplane.sha256 },
		goals: { snapshotFiles: 1, restoredFiles: rollback.stores.find((s) => s.name === "goals").restoredFiles, byteEqual: sha256File(goalsFile) === baseline.goals.sha256 },
	};
	const bidirectional =
		forward["control-plane"].ok &&
		forward.goals.ok &&
		reverse.memory.tables.every((t) => t.baselineRows === t.restoredRows) &&
		reverse.memory.contentEqual &&
		reverse.controlplane.byteEqual &&
		reverse.goals.byteEqual;
	assert.equal(bidirectional, true);
	report.steps.conservation = { forward, reverse, bidirectional };

	writeReport();
});

// ---------------------------------------------------------------------------
// negatives: the rollback must refuse a snapshot it cannot trust
// ---------------------------------------------------------------------------
test("negative: a tampered snapshot manifest is detected and the rollback is refused", async () => {
	const h = await seedAndSnapshot();
	const manifestPath = join(h.snapshot.dir, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const cp = manifest.stores.find((store) => store.name === "controlplane");
	cp.files[0].sha256 = sha("0"); // recorded digest now disagrees with the bytes on disk
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	const before = sha256File(h.cpFile);
	assert.throws(
		() => restoreStores({ runDir: h.snapshot.dir, targets: h.targets }),
		(error) => error instanceof RollbackError && error.code === "snapshot-hash-mismatch",
	);
	assert.equal(sha256File(h.cpFile), before, "a refused rollback leaves the target untouched");
	report.negatives.push({ probe: "tampered-manifest", code: "snapshot-hash-mismatch", refused: true, targetUnchanged: true });
});

test("negative: a snapshot missing a recorded file is detected and the rollback is refused", async () => {
	const h = await seedAndSnapshot();
	rmSync(join(h.snapshot.dir, "goals", "goals.json"), { force: true });

	const before = sha256File(h.goalsFile);
	assert.throws(
		() => restoreStores({ runDir: h.snapshot.dir, targets: h.targets }),
		(error) => error instanceof RollbackError && error.code === "snapshot-file-missing",
	);
	assert.equal(sha256File(h.goalsFile), before, "a refused rollback leaves the target untouched");
	report.negatives.push({ probe: "snapshot-file-missing", code: "snapshot-file-missing", refused: true, targetUnchanged: true });
});

test("negative: an untracked new file in the rollback target is reported, never silently deleted", async () => {
	const h = await seedAndSnapshot();
	// A migration accident wrecked the working copy AND a foreign file appeared.
	writeFileSync(h.goalsFile, "GARBAGE", { mode: FILE_MODE });
	const stray = join(h.goalsDir, "stray.txt");
	writeFileSync(stray, "stray\n", { mode: FILE_MODE });

	const rollback = restoreStores({ runDir: h.snapshot.dir, targets: h.targets });
	assert.equal(rollback.ok, true);
	assert.ok(
		rollback.extraFiles.some((entry) => entry.name === "goals" && entry.path === "stray.txt"),
		"the untracked file is reported in extraFiles",
	);
	assert.ok(existsSync(stray), "the untracked file is left in place, not deleted");
	assert.equal(readFileSync(stray, "utf8"), "stray\n");
	assert.equal(readFileSync(h.goalsFile, "utf8"), `${JSON.stringify(goalsState(h.ws.base), null, 2)}\n`, "the tracked file is still restored");
	report.negatives.push({ probe: "untracked-target-file", reported: true, fileKept: true, trackedFileRestored: true });
});

// ---------------------------------------------------------------------------
// final: assemble the drill report
// ---------------------------------------------------------------------------
test("drill report: both directions conserve the source and the report is written", () => {
	assert.ok(drillState.base, "the positive drill must run before the report is assembled");
	assert.equal(report.steps.conservation.bidirectional, true);
	assert.equal(report.steps.conversion["control-plane"].conservation.rejected, 0);
	assert.equal(report.steps.conversion.goals.conservation.rejected, 0);
	assert.ok(report.negatives.length >= 3, "every negative must be exercised");
	const path = writeReport();
	assert.ok(existsSync(path));
});
