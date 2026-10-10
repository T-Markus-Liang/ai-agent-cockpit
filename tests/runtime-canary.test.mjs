// Focused tests for the bounded P0 runtime canary.
//
// These tests use only local, isolated private state under `.canary-state-*` in
// this workdir. They never use the network, the `--live` probe, credentials,
// tools, or a real model.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";

import { createPaseoClient } from "@getpaseo/client";

import { openSqliteStorageSynchronousFull } from "../runtime/full-sqlite.mjs";
import { main, parseArgs, runCanary, runLiveProbe } from "../scripts/runtime-canary.mjs";

const privateDirMode = 0o700;
const privateFileMode = 0o600;
const statePrefix = ".canary-state-";

const createdDirs = [];

test("live probe validates payload and HTTP evidence using fake transport only", async () => {
	const models = {
		setProvider() {}, getModel() { return {}; },
		async completeSimple(_model, _input, options) {
			const payload = options.onPayload({ model: "kimi-k3" });
			assert.deepEqual(payload.thinking, { type: "disabled" });
			assert.equal(payload.max_tokens, 96);
			options.onResponse({ status: 200 });
			return { stopReason: "stop", content: [{ type: "text", text: "CANARY_OK" }], usage: { input: 1, output: 1, totalTokens: 2 } };
		},
	};
	const report = await runLiveProbe({ models });
	assert.equal(report.ok, true);
	assert.equal(report.preparedPayloads, 1);
	assert.equal(report.httpStatus, 200);
	models.completeSimple = async () => ({ stopReason: "error", content: [], usage: { totalTokens: 0 } });
	const failed = await runLiveProbe({ models });
	assert.equal(failed.responseReceived, false);
	assert.equal(failed.ok, false);
});

async function makeStateDir(mode) {
	const dir = await mkdtemp(join(process.cwd(), statePrefix));
	createdDirs.push(dir);
	if (mode !== undefined) await chmod(dir, mode);
	return dir;
}

function modeBits(info) {
	return info.mode & 0o777;
}

function stateDirs() {
	return readdirSync(process.cwd())
		.filter((name) => name.startsWith(statePrefix))
		.sort();
}

after(async () => {
	await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("fake default returns ok with no network or real inference", async () => {
	const stateDir = await makeStateDir();
	const report = await runCanary({ stateDir });
	assert.equal(report.ok, true);
	assert.equal(report.mode, "fake");
	assert.equal(report.scope.realInference, 0);
	assert.equal(report.scope.tools, 0);
	assert.equal(report.scope.networkAttempted, false);
	assert.equal(report.scope.liveTouched, false);
	assert.equal(report.versions.paseoClient, "0.10.3");
	assert.equal(report.paseo.createPaseoClientIsFunction, true);
	assert.equal(report.paseo.clientConnected, false);
});

test("preserves answer and submission across a real SQLite reopen", async () => {
	const stateDir = await makeStateDir();
	const report = await runCanary({ stateDir });
	assert.equal(report.submission.responseText, "canary-response");
	assert.equal(report.submission.status, "done");
	assert.ok(report.submission.answer !== undefined);
	assert.equal(report.reopened.sameId, true);
	assert.equal(report.reopened.status, "done");
	assert.equal(report.reopened.requestId, report.submission.requestId);
	assert.equal(report.reopened.answer, report.submission.answer);
});

test("exactly one fake model call; duplicate, changed body and reopen add zero", async () => {
	const stateDir = await makeStateDir();
	const report = await runCanary({ stateDir });
	assert.equal(report.faux.callCountAfterFirst, 1);
	assert.equal(report.duplicateRequest.extraModelCalls, 0);
	assert.equal(report.changedBodySameRequestId.extraModelCalls, 0);
	assert.equal(report.reopened.extraModelCalls, 0);
	assert.equal(report.faux.callCountAfterReopen, 1);
});

test("changed-body reuse is explicit as an upstream limitation", async () => {
	const stateDir = await makeStateDir();
	const report = await runCanary({ stateDir });
	assert.equal(report.changedBodySameRequestId.reusesSubmission, true);
	assert.match(report.changedBodySameRequestId.limitation, /requestId/);
	assert.match(report.changedBodySameRequestId.limitation, /digest/);
	assert.ok(report.limitations.some((line) => /body-blind/.test(line)));
});

test("sqlite storage reports FULL, WAL and private file/parent modes", async () => {
	const stateDir = await makeStateDir();
	const file = join(stateDir, "canary.sqlite");
	const opened = await openSqliteStorageSynchronousFull(file);
	try {
		assert.equal(opened.synchronous, 2);
		assert.equal(opened.journalMode, "wal");
		assert.equal(opened.fileMode, privateFileMode);
		assert.equal(opened.parentMode, privateDirMode);
		assert.equal(modeBits(await stat(file)), privateFileMode);
		assert.equal(modeBits(await lstat(stateDir)), privateDirMode);
	} finally {
		await opened.storage.close();
	}
});

test("public Paseo SDK import exposes createPaseoClient without connecting", async () => {
	const module = await import("@getpaseo/client");
	assert.equal(typeof module.createPaseoClient, "function");
	assert.equal(module.createPaseoClient, createPaseoClient);
	// The canary only reads the export; a client connection would require calling
	// createPaseoClient and then connect(). No client is ever constructed here.
});

test("unknown CLI flags fail before creating any state", async () => {
	assert.equal(parseArgs(["--bogus"]).error, "Unknown argument: --bogus");
	const before = stateDirs();
	const code = await main(["--bogus"]);
	assert.equal(code, 2);
	assert.deepEqual(stateDirs(), before);
});

test("helper refuses symlink and broad/public parent without mutating them", async () => {
	// Broad/public parent: refuse and leave its mode unchanged.
	const publicParent = await makeStateDir(0o755);
	const publicFile = join(publicParent, "canary.sqlite");
	const publicModeBefore = modeBits(await lstat(publicParent));
	await assert.rejects(() => openSqliteStorageSynchronousFull(publicFile), /broad\/public parent/);
	assert.equal(modeBits(await lstat(publicParent)), publicModeBefore);
	assert.equal(existsSync(publicFile), false);

	// Symlinked database target: refuse and leave the link target's mode intact.
	const stateDir = await makeStateDir();
	const target = join(stateDir, "target.txt");
	await writeFile(target, "not-a-database");
	await chmod(target, 0o640);
	const link = join(stateDir, "linked.sqlite");
	await symlink(target, link);
	const targetModeBefore = modeBits(await lstat(target));
	await assert.rejects(() => openSqliteStorageSynchronousFull(link), /symlink database target/);
	assert.equal((await lstat(link)).isSymbolicLink(), true);
	assert.equal(modeBits(await lstat(target)), targetModeBefore);
});
