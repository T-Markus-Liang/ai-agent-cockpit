// Focused tests for the Wave 5 versioned state converter (control-plane + goals).
//
// Every fixture is a self-built synthetic file under a private
// `os.tmpdir()/state-conv-*` directory. These tests never touch production state
// (~/.local/state/personal-ai-os/, ~/.wechat-acp/, ~/.local/state/ai-agent-cockpit),
// never launch a service, never use the network, credentials, a model or WeChat,
// and never invoke git.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { convertState, verifyConversion, StateConverterError } from "../control-plane/state-converter.mjs";
import { goalSpecDigest, validateGoalSpec } from "../control-plane/goal-store.mjs";

const createdRoots = [];

/** A private workspace: `base` is the allow-root; returns source/target helpers. */
function makeWorkspace() {
	const base = mkdtempSync(join(tmpdir(), "state-conv-"));
	createdRoots.push(base);
	const srcDir = join(base, "src");
	mkdirSync(srcDir, { recursive: true, mode: 0o700 });
	return {
		base,
		allowRoot: base,
		srcDir,
		writeSource(name, state) {
			const file = join(srcDir, name);
			writeFileSync(file, typeof state === "string" ? state : `${JSON.stringify(state, null, 2)}\n`);
			return file;
		},
		target(name = "out") {
			return join(base, name);
		},
	};
}

after(() => {
	for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;
const ts = "2025-01-01T00:00:00.000Z";
const sha = (char) => `sha256:${char.repeat(64)}`;

// --- fixtures --------------------------------------------------------------

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

function allRecords(plan) {
	return plan.collections.flatMap((collection) => collection.records);
}

// --- happy paths -----------------------------------------------------------

test("control-plane 0.2.2 shape: every record is kept verbatim and conservation holds", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", controlPlaneV022State());
	const target = ws.target();

	const result = convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock });
	assert.equal(result.ok, true);
	assert.equal(result.written, true);
	assert.equal(result.kind, "control-plane");

	// Every record kept; nothing rejected; counts balance.
	assert.ok(allRecords(result.plan).every((record) => record.disposition === "kept"));
	assert.deepEqual(result.plan.conservation, {
		ok: true,
		sourceRecords: 7,
		targetRecords: 7,
		kept: 7,
		migrated: 0,
		rejected: 0,
	});
	for (const collection of result.plan.collections) {
		assert.equal(collection.sourceCount, collection.targetCount);
		assert.equal(collection.sha256, result.manifest.collections.find((c) => c.name === collection.name).sha256);
	}

	// The output preserves the source bytes exactly (kept means verbatim).
	const written = JSON.parse(readFileSync(join(target, "control-plane.json"), "utf8"));
	assert.deepEqual(written, controlPlaneV022State());

	// Manifest carries provenance and the two-dry-run declaration.
	assert.equal(result.manifest.converterVersion, "state-converter-v1");
	assert.equal(result.manifest.twoDryRunsIdentical, true);
	assert.equal(result.manifest.network_calls, 0);
	assert.equal(result.manifest.source.sha256, result.source.sha256);
	assert.equal(result.manifest.target.sha256, result.target.sha256);

	// The manifest is independently re-verifiable.
	const verified = verifyConversion({ targetDir: target });
	assert.equal(verified.ok, true);
	assert.equal(verified.collections, 7);
});

test("goals state: every record is kept and conservation holds", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("goals.json", goalsState(ws.base));
	const target = ws.target();

	const result = convertState({ sourceFile: source, targetDir: target, kind: "goals", allowRoot: ws.allowRoot, now: fixedClock });
	assert.equal(result.written, true);
	assert.ok(allRecords(result.plan).every((record) => record.disposition === "kept"));
	assert.equal(result.plan.conservation.rejected, 0);
	assert.equal(result.plan.conservation.kept, 3);

	const written = JSON.parse(readFileSync(join(target, "goals.json"), "utf8"));
	assert.deepEqual(written, goalsState(ws.base));
	assert.equal(verifyConversion({ targetDir: target }).ok, true);
});

// --- migrated disposition --------------------------------------------------

test("a record the validator must supplement is migrated, with the added fields listed", () => {
	const ws = makeWorkspace();
	const state = controlPlaneV022State();
	const { contractVersion, type, constraints, acceptanceCriteria, executionIds, ...legacyTask } = state.tasks.task_1;
	state.tasks = { task_1: legacyTask };
	const source = ws.writeSource("control-plane.json", state);
	const target = ws.target();

	const result = convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock });
	const tasks = result.plan.collections.find((collection) => collection.name === "tasks");
	assert.equal(tasks.records.length, 1);
	assert.equal(tasks.records[0].disposition, "migrated");
	assert.deepEqual(tasks.records[0].addedFields, ["acceptanceCriteria", "constraints", "contractVersion", "executionIds", "type"]);
	assert.equal(result.plan.conservation.migrated, 1);

	// The supplied fields are the contract defaults; source fields are untouched.
	const written = JSON.parse(readFileSync(join(target, "control-plane.json"), "utf8")).tasks.task_1;
	assert.equal(written.contractVersion, 1);
	assert.equal(written.type, "Task");
	assert.deepEqual(written.constraints, []);
	assert.equal(written.goal, "ship it");
	assert.equal(written.id, "task_1");
	assert.equal(verifyConversion({ targetDir: target }).ok, true);
});

test("the source contractVersion is preserved and its observed values recorded", () => {
	const ws = makeWorkspace();
	const state = controlPlaneV022State();
	state.tasks.task_1.contractVersion = 0; // an older stamp is kept, never overwritten
	const source = ws.writeSource("control-plane.json", state);

	const result = convertState({ sourceFile: source, targetDir: ws.target(), kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock });
	assert.deepEqual(result.plan.sourceContractVersions, [0, 1]);
	assert.equal(result.manifest.contractVersion, 1);
	const tasks = result.plan.collections.find((collection) => collection.name === "tasks");
	assert.equal(tasks.records[0].disposition, "kept");
});

// --- dry-run determinism ---------------------------------------------------

test("two dry-runs are byte-identical and write nothing", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", controlPlaneV022State());
	const target = ws.target();

	const first = convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock, dryRun: true });
	const second = convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock, dryRun: true });

	assert.equal(first.dryRun, true);
	assert.equal(first.written, false);
	assert.equal(first.target, null);
	assert.ok(first.plan.collections.length > 0, "dry-run returns the full plan");
	assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan), "dry-runs must be byte-identical");
	assert.equal(existsSync(target), false, "a dry-run must not create the target directory");
});

test("the injected clock fixes the plan's timestamps", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", controlPlaneV022State());
	const result = convertState({ sourceFile: source, targetDir: ws.target(), kind: "control-plane", allowRoot: ws.allowRoot, now: () => 4242, dryRun: true });
	assert.equal(result.plan.startedAt, 4242);
});

// --- refusals: source ------------------------------------------------------

test("corrupt JSON is refused and no target is created", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", "{ not json ");
	const target = ws.target();
	assert.throws(
		() => convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock }),
		(error) => error instanceof StateConverterError && error.code === "invalid-json",
	);
	assert.equal(existsSync(target), false);
});

test("a wrong top-level shape / unsupported version is refused before any write", () => {
	const ws = makeWorkspace();

	const badVersion = ws.writeSource("cp-version.json", { ...controlPlaneV022State(), version: 2 });
	assert.throws(
		() => convertState({ sourceFile: badVersion, targetDir: ws.target("a"), kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "unsupported-version",
	);
	assert.equal(existsSync(ws.target("a")), false);

	const badCollection = ws.writeSource("cp-collection.json", { ...controlPlaneV022State(), tasks: [] });
	assert.throws(
		() => convertState({ sourceFile: badCollection, targetDir: ws.target("b"), kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "invalid-shape",
	);
	assert.equal(existsSync(ws.target("b")), false);
});

test("a record that fails its validator rejects the whole conversion with a truthful reason", () => {
	const ws = makeWorkspace();
	const state = controlPlaneV022State();
	state.tasks.task_1.status = "not-a-status";
	const source = ws.writeSource("control-plane.json", state);
	const target = ws.target();

	assert.throws(
		() => convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock }),
		(error) => {
			assert.ok(error instanceof StateConverterError && error.code === "record-rejected");
			const tasks = error.plan.collections.find((collection) => collection.name === "tasks");
			assert.equal(tasks.records[0].disposition, "rejected");
			assert.match(tasks.records[0].reason, /status/);
			return true;
		},
	);
	assert.equal(existsSync(target), false, "a rejected record must not produce a target");
});

test("a goal whose specDigest does not match its spec is rejected", () => {
	const ws = makeWorkspace();
	const state = goalsState(ws.base);
	state.goals.goal_1.specDigest = sha("f");
	const source = ws.writeSource("goals.json", state);
	const target = ws.target();
	assert.throws(
		() => convertState({ sourceFile: source, targetDir: target, kind: "goals", allowRoot: ws.allowRoot }),
		(error) => {
			assert.ok(error instanceof StateConverterError && error.code === "record-rejected");
			assert.match(error.plan.collections.find((c) => c.name === "goals").records[0].reason, /specDigest/);
			return true;
		},
	);
	assert.equal(existsSync(target), false);
});

// --- refusals: conservation / identity -------------------------------------

test("a duplicated identity is a conservation violation and is refused", () => {
	const ws = makeWorkspace();
	const state = controlPlaneV022State();
	state.events = [
		{ id: "event_dup", type: "a", entityType: "Task", entityId: "task_1", details: {}, at: ts },
		{ id: "event_dup", type: "b", entityType: "Task", entityId: "task_1", details: {}, at: ts },
	];
	const source = ws.writeSource("control-plane.json", state);
	const target = ws.target();
	assert.throws(
		() => convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "duplicate-identity",
	);
	assert.equal(existsSync(target), false);
});

test("a record whose id does not match its map key is refused", () => {
	const ws = makeWorkspace();
	const state = controlPlaneV022State();
	state.tasks.task_1.id = "task_other";
	const source = ws.writeSource("control-plane.json", state);
	assert.throws(
		() => convertState({ sourceFile: source, targetDir: ws.target(), kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "identity-key-mismatch",
	);
});

// --- refusals: filesystem guards -------------------------------------------

test("a symlinked source is refused without touching the tree", () => {
	const ws = makeWorkspace();
	const real = ws.writeSource("real.json", controlPlaneV022State());
	const link = join(ws.srcDir, "link.json");
	symlinkSync(real, link);
	const target = ws.target();
	const before = readdirSync(ws.srcDir).sort();
	assert.throws(
		() => convertState({ sourceFile: link, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "source-symlink",
	);
	assert.deepEqual(readdirSync(ws.srcDir).sort(), before);
	assert.equal(existsSync(target), false);
});

test("a directory passed as the source is refused", () => {
	const ws = makeWorkspace();
	assert.throws(
		() => convertState({ sourceFile: ws.srcDir, targetDir: ws.target(), kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "source-not-regular",
	);
});

test("a missing source is refused", () => {
	const ws = makeWorkspace();
	assert.throws(
		() => convertState({ sourceFile: join(ws.srcDir, "nope.json"), targetDir: ws.target(), kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "source-missing",
	);
});

test("a target outside the explicit allow root is refused with zero change", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", controlPlaneV022State());
	const outside = mkdtempSync(join(tmpdir(), "state-conv-out-"));
	createdRoots.push(outside);
	const target = join(outside, "out");
	assert.throws(
		() => convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "target-outside-allow-root",
	);
	assert.equal(existsSync(target), false);
});

test("an existing target directory is refused and left untouched", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", controlPlaneV022State());
	const target = ws.target();
	mkdirSync(target, { mode: 0o700 });
	writeFileSync(join(target, "keep.txt"), "keep");
	const before = readdirSync(target).sort();
	assert.throws(
		() => convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot }),
		(error) => error instanceof StateConverterError && error.code === "target-exists",
	);
	assert.deepEqual(readdirSync(target).sort(), before);
	assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "keep");
});

test("invalid configuration (missing allowRoot / relative allowRoot / bad kind) fails closed", () => {
	const ws = makeWorkspace();
	const source = ws.writeSource("control-plane.json", controlPlaneV022State());
	const target = ws.target();
	for (const options of [
		{ sourceFile: source, targetDir: target, kind: "control-plane" },
		{ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: "relative/root" },
		{ sourceFile: source, targetDir: target, kind: "carrier-pigeon", allowRoot: ws.allowRoot },
	]) {
		assert.throws(
			() => convertState(options),
			(error) => error instanceof StateConverterError && error.code === "invalid-config",
		);
	}
	assert.equal(existsSync(target), false);
});
