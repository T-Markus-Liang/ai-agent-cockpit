// Focused tests for the Wave 5 shadow projection layer.
//
// Every fixture is either an in-memory synthetic state object or a self-built
// synthetic file under a private `os.tmpdir()/shadow-proj-*` directory. These
// tests never touch production state (~/.local/state/personal-ai-os/,
// ~/.wechat-acp/, ~/.local/state/ai-agent-cockpit), never launch a service, never
// use the network, credentials, a model or WeChat, and never invoke git.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runShadowProjection, ShadowProjectionError, SHADOW_PROJECTION_VERSION } from "../control-plane/shadow-projection.mjs";
import { convertState } from "../control-plane/state-converter.mjs";
import { goalSpecDigest, validateGoalSpec } from "../control-plane/goal-store.mjs";

const createdRoots = [];
after(() => {
	for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = () => FIXED_NOW;
const ts = "2025-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const sha = (char) => `sha256:${char.repeat(64)}`;
const clone = (value) => structuredClone(value);

function mismatches(report) {
	return report.projections.filter((entry) => !entry.match).map((entry) => entry.name);
}

function projectionNamed(report, name) {
	return report.projections.find((entry) => entry.name === name);
}

// --- synthetic states ------------------------------------------------------

function cpState() {
	return {
		version: 1,
		tasks: {
			task_1: { id: "task_1", status: "draft" },
			task_2: { id: "task_2", status: "running" },
		},
		executions: {
			execution_1: { id: "execution_1", status: "succeeded" },
			execution_2: { id: "execution_2", status: "running" },
		},
		evidence: {
			evidence_1: { id: "evidence_1", kind: "test", exitCode: 0, verdict: "passed" },
			evidence_2: { id: "evidence_2", kind: "log", exitCode: 1 },
		},
		approvals: {
			approval_1: { id: "approval_1", decision: "pending", parametersDigest: sha("a") },
			approval_2: { id: "approval_2", decision: "approved", parametersDigest: sha("b") },
		},
		locks: {
			session_1: { sessionRefId: "session_1", owner: "owner", token: "t", acquiredAt: ts, expiresAt: FUTURE },
		},
		idempotency: {
			k1: { operation: "a", fingerprint: "x", at: ts },
			k2: { operation: "b", fingerprint: "y", at: ts },
		},
		events: [
			{ id: "event_1", type: "a" },
			{ id: "event_2", type: "b" },
		],
	};
}

function goalsState() {
	return {
		version: 1,
		goals: {
			goal_1: { id: "goal_1", status: "ready", spec: { limits: { maxTokens: 80000, maxIterations: 10 } }, nextWakeAt: 1000 },
			goal_2: {
				id: "goal_2",
				status: "running",
				spec: { limits: { maxTokens: 20000, maxIterations: 5 } },
				nextWakeAt: 2000,
				recoveryCount: 2,
			},
		},
		requests: { [sha("d")]: { id: "goal_1", digest: sha("e") } },
		events: [{ goalId: "goal_1", type: "created", at: ts }],
	};
}

// --- happy paths / determinism ---------------------------------------------

test("identical control-plane states on both sides: every projection matches", () => {
	const report = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", now: fixedClock });
	assert.equal(report.version, SHADOW_PROJECTION_VERSION);
	assert.equal(report.kind, "control-plane");
	assert.equal(report.allMatch, true);
	assert.equal(report.projections.length, 9);
	for (const entry of report.projections) {
		assert.equal(entry.status, "ok");
		assert.equal(entry.match, true);
		assert.match(entry.legacyDigest, /^sha256:[0-9a-f]{64}$/);
		assert.equal(entry.legacyDigest, entry.convertedDigest);
		assert.equal(Object.hasOwn(entry, "detail"), false);
	}
	assert.match(report.reportDigest, /^sha256:[0-9a-f]{64}$/);
	assert.equal(report.generatedAt, new Date(FIXED_NOW).toISOString());
});

test("identical goals states on both sides: every projection matches", () => {
	const report = runShadowProjection({ legacyState: goalsState(), convertedState: goalsState(), kind: "goals", now: fixedClock });
	assert.equal(report.allMatch, true);
	assert.equal(report.projections.length, 5);
	assert.deepEqual(mismatches(report), []);
});

test("two runs on the same input produce the same reportDigest (determinism)", () => {
	const first = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", now: fixedClock });
	const second = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", now: fixedClock });
	assert.equal(first.reportDigest, second.reportDigest);
	assert.deepEqual(first, second);
});

test("reportDigest excludes generatedAt: changing only the clock keeps the digest", () => {
	const early = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", now: () => 1_000 });
	const late = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", now: () => 2_000 });
	assert.notEqual(early.generatedAt, late.generatedAt);
	assert.equal(early.reportDigest, late.reportDigest);
});

// --- per-projection divergences: exactly one projection is flagged ----------

const CP_CASES = [
	{ name: "collectionCounts", expected: ["collectionCounts"], mutate: (state) => state.events.splice(1, 1) },
	{ name: "taskStatusHistogram", expected: ["taskStatusHistogram"], mutate: (state) => { state.tasks.task_1.status = "planned"; } },
	{ name: "executionStatusHistogram", expected: ["executionStatusHistogram"], mutate: (state) => { state.executions.execution_1.status = "failed"; } },
	{ name: "approvalDecisions", expected: ["approvalDecisions"], mutate: (state) => { state.approvals.approval_1.decision = "rejected"; } },
	{ name: "approvalDigests", expected: ["approvalDigests"], mutate: (state) => { state.approvals.approval_1.parametersDigest = sha("c"); } },
	{ name: "idempotencyKeys", expected: ["idempotencyKeys"], mutate: (state) => { state.idempotency.k3 = state.idempotency.k2; delete state.idempotency.k2; } },
	{ name: "lockActivity", expected: ["lockActivity"], mutate: (state) => { state.locks.session_1.expiresAt = PAST; } },
	{ name: "evidenceKinds", expected: ["evidenceKinds"], mutate: (state) => { state.evidence.evidence_2.kind = "command"; } },
	{ name: "evidenceOutcomes", expected: ["evidenceOutcomes"], mutate: (state) => { state.evidence.evidence_1.exitCode = 2; } },
];

for (const { name, expected, mutate } of CP_CASES) {
	test(`control-plane: a divergence in ${name} flags exactly that projection`, () => {
		const legacy = cpState();
		const converted = clone(legacy);
		mutate(converted);
		const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "control-plane", now: fixedClock });
		assert.deepEqual(mismatches(report), expected);
		assert.equal(report.allMatch, false);
		const flagged = projectionNamed(report, name);
		assert.equal(flagged.status, "ok");
		assert.equal(flagged.match, false);
		assert.notEqual(flagged.legacyDigest, flagged.convertedDigest);
		assert.ok(flagged.detail && typeof flagged.detail.legacy === "string" && typeof flagged.detail.converted === "string");
		assert.notEqual(flagged.detail.legacy, flagged.detail.converted);
	});
}

const GOAL_CASES = [
	{ name: "collectionCounts", expected: ["collectionCounts"], mutate: (state) => state.events.splice(0, 1) },
	{ name: "goalStatusHistogram", expected: ["goalStatusHistogram"], mutate: (state) => { state.goals.goal_1.status = "paused"; } },
	{ name: "limitsTotals", expected: ["limitsTotals"], mutate: (state) => { state.goals.goal_1.spec.limits.maxTokens = 90000; } },
	{ name: "nextWakeBounds", expected: ["nextWakeBounds"], mutate: (state) => { state.goals.goal_1.nextWakeAt = 5000; } },
	{ name: "recoveryCounts", expected: ["recoveryCounts"], mutate: (state) => { state.goals.goal_2.recoveryCount = 3; } },
];

for (const { name, expected, mutate } of GOAL_CASES) {
	test(`goals: a divergence in ${name} flags exactly that projection`, () => {
		const legacy = goalsState();
		const converted = clone(legacy);
		mutate(converted);
		const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "goals", now: fixedClock });
		assert.deepEqual(mismatches(report), expected);
		assert.equal(report.allMatch, false);
		const flagged = projectionNamed(report, name);
		assert.equal(flagged.status, "ok");
		assert.equal(flagged.match, false);
		assert.equal(flagged.detail.legacy === flagged.detail.converted, false);
	});
}

test("a mismatch is never reported as a match, and detail is truthful", () => {
	const legacy = cpState();
	const converted = clone(legacy);
	converted.tasks.task_1.status = "planned";
	const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "control-plane", now: fixedClock });
	const flagged = projectionNamed(report, "taskStatusHistogram");
	assert.equal(flagged.match, false);
	assert.match(flagged.detail.legacy, /draft/);
	assert.match(flagged.detail.converted, /planned/);
});

test("reordering a map does not by itself cause a mismatch (semantic, not byte-wise)", () => {
	const legacy = cpState();
	const converted = clone(legacy);
	// Rebuild the tasks map in a different insertion order: same records, new order.
	converted.tasks = { task_2: converted.tasks.task_2, task_1: converted.tasks.task_1 };
	const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "control-plane", now: fixedClock });
	assert.equal(report.allMatch, true);
});

test("an optional field added on the converted side does not change any projection", () => {
	const legacy = cpState();
	const converted = clone(legacy);
	converted.tasks.task_1.chief = "planner"; // a newer optional field the converter may carry
	converted.executions.execution_1.role = "worker";
	const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "control-plane", now: fixedClock });
	assert.equal(report.allMatch, true);
});

// --- fail-closed -----------------------------------------------------------

test("an unknown kind is refused", () => {
	assert.throws(
		() => runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "carrier-pigeon" }),
		(error) => error instanceof ShadowProjectionError && error.code === "unknown-kind",
	);
});

test("a state that is not an object is refused", () => {
	for (const bad of [null, [], "nope", 42]) {
		assert.throws(
			() => runShadowProjection({ legacyState: bad, convertedState: cpState(), kind: "control-plane" }),
			(error) => error instanceof ShadowProjectionError && error.code === "invalid-state",
		);
		assert.throws(
			() => runShadowProjection({ legacyState: cpState(), convertedState: bad, kind: "control-plane" }),
			(error) => error instanceof ShadowProjectionError && error.code === "invalid-state",
		);
	}
});

test("a collection missing from the CONVERTED side fails closed", () => {
	const converted = cpState();
	delete converted.tasks;
	assert.throws(
		() => runShadowProjection({ legacyState: cpState(), convertedState: converted, kind: "control-plane" }),
		(error) => error instanceof ShadowProjectionError && error.code === "missing-collection",
	);
});

test("a goals collection missing from either side fails closed", () => {
	const converted = goalsState();
	delete converted.events;
	assert.throws(
		() => runShadowProjection({ legacyState: goalsState(), convertedState: converted, kind: "goals" }),
		(error) => error instanceof ShadowProjectionError && error.code === "missing-collection",
	);
});

test("a collection with the wrong shape fails closed", () => {
	const converted = cpState();
	converted.tasks = [];
	assert.throws(
		() => runShadowProjection({ legacyState: cpState(), convertedState: converted, kind: "control-plane" }),
		(error) => error instanceof ShadowProjectionError && error.code === "invalid-collection",
	);
});

test("an optionally-absent collection on the LEGACY control-plane side is tolerated", () => {
	const legacy = cpState();
	delete legacy.locks;
	delete legacy.idempotency;
	const converted = cpState();
	converted.locks = {};
	converted.idempotency = {};
	const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "control-plane", now: fixedClock });
	assert.equal(report.allMatch, true);
	assert.deepEqual(projectionNamed(report, "idempotencyKeys").legacyDigest, projectionNamed(report, "idempotencyKeys").convertedDigest);
	assert.equal(projectionNamed(report, "lockActivity").match, true);
});

test("invalid projection configuration fails closed", () => {
	const base = { legacyState: cpState(), convertedState: cpState(), kind: "control-plane" };
	assert.throws(
		() => runShadowProjection({ ...base, projections: [] }),
		(error) => error instanceof ShadowProjectionError && error.code === "invalid-config",
	);
	assert.throws(
		() => runShadowProjection({ ...base, projections: ["not a function"] }),
		(error) => error instanceof ShadowProjectionError && error.code === "invalid-config",
	);
	assert.throws(
		() => runShadowProjection({ ...base, projections: [() => 1], now: 123 }),
		(error) => error instanceof ShadowProjectionError && error.code === "invalid-config",
	);
});

// --- injected projections --------------------------------------------------

test("an injected projection set replaces the built-ins", () => {
	function taskCount(state) {
		return Object.keys(state.tasks).length;
	}
	const report = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", projections: [taskCount] });
	assert.equal(report.projections.length, 1);
	assert.equal(report.projections[0].name, "taskCount");
	assert.equal(report.projections[0].match, true);
	assert.equal(report.allMatch, true);
});

test("a projection that throws is reported failed and does not abort the batch", () => {
	function boom() {
		throw new Error("kaboom");
	}
	function ok(state) {
		return Object.keys(state.tasks).length;
	}
	const report = runShadowProjection({ legacyState: cpState(), convertedState: cpState(), kind: "control-plane", projections: [ok, boom] });
	assert.equal(report.projections.length, 2);
	const bad = projectionNamed(report, "boom");
	assert.equal(bad.status, "failed");
	assert.equal(bad.match, false);
	assert.equal(bad.legacyDigest, null);
	assert.equal(bad.convertedDigest, null);
	assert.match(bad.detail.error, /kaboom/);
	assert.equal(projectionNamed(report, "ok").match, true);
	assert.equal(report.allMatch, false);
});

// --- integration with the D65 state converter ------------------------------

function makeWorkspace() {
	const base = mkdtempSync(join(tmpdir(), "shadow-proj-"));
	createdRoots.push(base);
	const srcDir = join(base, "src");
	mkdirSync(srcDir, { recursive: true, mode: 0o700 });
	return {
		base,
		allowRoot: base,
		srcDir,
		writeSource(name, state) {
			const file = join(srcDir, name);
			writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
			return file;
		},
	};
}

function controlPlaneConvertibleState() {
	// A 0.2.2-era state: `locks` and `idempotency` are absent, which the converter
	// supplies as empty scaffolds — exercising the legacy tolerance end to end.
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
			task_2: {
				contractVersion: 1,
				type: "Task",
				id: "task_2",
				goal: "ship it too",
				status: "running",
				constraints: [],
				acceptanceCriteria: [],
				executionIds: ["execution_2"],
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
			},
			execution_2: {
				contractVersion: 1,
				type: "Execution",
				id: "execution_2",
				taskId: "task_2",
				workerId: "worker",
				status: "running",
				attempt: 1,
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
				verdict: "passed",
			},
			evidence_2: {
				contractVersion: 1,
				type: "Evidence",
				id: "evidence_2",
				executionId: "execution_2",
				kind: "log",
				summary: "still running",
				source: "agent",
				capturedAt: ts,
				redacted: true,
				exitCode: 1,
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
		events: [{ id: "event_1", type: "task.created", entityType: "Task", entityId: "task_1", details: {}, at: ts }],
	};
}

function goalRecord(base) {
	const spec = validateGoalSpec({
		title: "T",
		objective: "O",
		sourceDir: join(base, "project"),
		readPaths: ["a.mjs", "a.test.mjs"],
		writePaths: ["a.mjs"],
		checks: [{ name: "accept", args: ["--test", "a.test.mjs"] }],
		limits: { maxIterations: 10, maxTokens: 80000, maxDurationMs: 86400000, maxNoProgress: 3, intervalMs: 5000 },
		recovery: { enabled: true, maxAttempts: 3 },
	});
	return {
		id: "goal_1",
		spec,
		specDigest: goalSpecDigest(spec),
		owner: "local",
		generation: 1,
		status: "ready",
		iterations: 0,
		tokensUsed: 0,
		noProgress: 0,
		history: [],
		workspaceDir: join(base, "ws", "goal_1"),
		createdAt: ts,
		nextWakeAt: FIXED_NOW,
	};
}

test("D65 integration: a real control-plane conversion projects to an all-match report", () => {
	const ws = makeWorkspace();
	const legacy = controlPlaneConvertibleState();
	const source = ws.writeSource("control-plane.json", legacy);
	const target = join(ws.base, "out");
	const conversion = convertState({ sourceFile: source, targetDir: target, kind: "control-plane", allowRoot: ws.allowRoot, now: fixedClock });
	assert.equal(conversion.written, true);
	assert.deepEqual(conversion.plan.addedCollections, ["idempotency", "locks"]);

	const converted = JSON.parse(readFileSync(join(target, "control-plane.json"), "utf8"));
	const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "control-plane", now: fixedClock });
	assert.equal(report.allMatch, true);
	assert.deepEqual(mismatches(report), []);
	assert.equal(projectionNamed(report, "taskStatusHistogram").match, true);
	assert.equal(projectionNamed(report, "evidenceOutcomes").match, true);
});

test("D65 integration: a real goals conversion projects to an all-match report", () => {
	const ws = makeWorkspace();
	const legacy = {
		version: 1,
		goals: { goal_1: goalRecord(ws.base) },
		requests: { [sha("d")]: { id: "goal_1", digest: sha("e") } },
		events: [{ goalId: "goal_1", type: "created", at: ts, generation: 1 }],
	};
	const source = ws.writeSource("goals.json", legacy);
	const target = join(ws.base, "out");
	const conversion = convertState({ sourceFile: source, targetDir: target, kind: "goals", allowRoot: ws.allowRoot, now: fixedClock });
	assert.equal(conversion.written, true);

	const converted = JSON.parse(readFileSync(join(target, "goals.json"), "utf8"));
	const report = runShadowProjection({ legacyState: legacy, convertedState: converted, kind: "goals", now: fixedClock });
	assert.equal(report.allMatch, true);
	assert.deepEqual(mismatches(report), []);
});
