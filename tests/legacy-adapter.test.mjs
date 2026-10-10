// Tests for runtime/legacy-adapter.mjs (M02/I03c third slice).
//
// Term-limited legacy adapter shell with the RuntimePort shape, driven by an
// injected FakeDriver — no real ACP/model is ever started, no network, and every
// test uses a throwaway temp directory. No existing module is modified.
//
// Fixed acceptance pinned here: "先存 intent 再 effect，未知 native 启动不重派，
// 不永久双活".
//
// Coverage (14):
//   1  normal submit: binding + intent exist BEFORE driver.startSession
//   2  out-of-scope taskId -> legacy-scope-violation, driver never called
//   3  expired identity -> binding-expired, driver never called
//   4  idempotent re-submit -> same submissionId, one startSession
//   5  driver.startSession throws -> driver-failure, intent durable, uncertain;
//      re-submit is idempotent (no re-dispatch)
//   6  wait returns the right status/output for done and failed
//   7  abort submission -> kill called + cancelled; unknown requestKey refused
//   8  abort goal-wide/execution/conversation -> unsupported-scope
//   9  recover: alive kept, gone -> uncertain, prompt count unchanged (no re-dispatch)
//   10 mapping DB 0600 / dir 0700; reopen restores the mapping intact
//   11 V01: repeated submit -> prompt real-execution count stays 1
//   12 no dual-alive: a pi-durable binding for the same request -> binding-conflict, driver 0
//   13 observe() snapshot (runtime/status counts + secret-free identity)
//   14 unknown mapping schema version -> fail-closed refusal

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createLegacyAdapter, LegacyAdapterError } from "../runtime/legacy-adapter.mjs";
import { openBindingStore } from "../runtime/route-binding-store.mjs";
import { RouteBindingError } from "../runtime/route-binding.mjs";

const BASE_IDENTITY = Object.freeze({
	codeVersion: "0.3.0",
	interfaceVersion: "1",
	modelRef: { provider: "kimi", modelId: "kimi-k2" },
	profileId: "profile-legacy",
	cwd: "/Users/markus/legacy-work",
	authorizationDigest: "auth-legacy",
	expiresAt: 5000,
	allowedTaskIds: ["task-1", "task-2"],
});

const REQ = Object.freeze({
	ownerId: "owner-1",
	sourceRequestId: "req-1",
	effectKey: "effect-1",
	taskId: "task-1",
	text: "hello",
});

function keyOf(request) {
	return { ownerId: request.ownerId, sourceRequestId: request.sourceRequestId };
}

/** A complete, valid pi-durable binding for the SAME request key (durable owner). */
function piBinding(requestKey) {
	return {
		requestKey,
		runtime: "pi-durable",
		codeVersion: "0.3.0",
		interfaceVersion: "1",
		modelRef: { provider: "openai", modelId: "gpt-4o" },
		profileId: "profile-pi",
		cwd: "/Users/markus/pi-work",
		authorizationDigest: "auth-pi",
		effectKey: "effect-1",
		legacyScope: null,
		createdAt: 1000,
	};
}

/**
 * A hand-written execution driver. Records every call, tracks mock native
 * sessions, and (in startSession) snapshots the shared store so the test can prove
 * the binding + intent were durable BEFORE any effect ran.
 */
class FakeDriver {
	constructor({ store, behavior = {} } = {}) {
		this.store = store;
		this.behavior = behavior;
		this.calls = { startSession: 0, prompt: 0, kill: 0, status: 0 };
		this.startParams = [];
		this.prompts = [];
		this.killed = [];
		this.preEffect = []; // store { size, intentCount } at each startSession
		this.seq = 0;
		this.sessions = new Map();
	}

	async startSession(params) {
		this.calls.startSession += 1;
		this.startParams.push(params);
		if (this.store) this.preEffect.push({ size: this.store.size, intentCount: this.store.intentCount });
		if (typeof this.behavior.startSession === "function") return this.behavior.startSession(params);
		if (this.behavior.startSessionError) throw new Error(this.behavior.startSessionError);
		this.seq += 1;
		const nativeSessionId = `native-${this.seq}`;
		this.sessions.set(nativeSessionId, { alive: true });
		return { nativeSessionId };
	}

	async prompt(nativeSessionId, text) {
		this.calls.prompt += 1;
		this.prompts.push({ nativeSessionId, text });
		if (typeof this.behavior.prompt === "function") return this.behavior.prompt(nativeSessionId, text, this);
		if (this.behavior.promptError) throw new Error(this.behavior.promptError);
		return this.behavior.promptResult ?? { status: "done", output: `echo:${text}` };
	}

	async kill(nativeSessionId) {
		this.calls.kill += 1;
		this.killed.push(nativeSessionId);
		const session = this.sessions.get(nativeSessionId);
		if (session) session.alive = false;
		return "killed";
	}

	async status(nativeSessionId) {
		this.calls.status += 1;
		if (this.behavior.statusById && nativeSessionId in this.behavior.statusById) return this.behavior.statusById[nativeSessionId];
		const session = this.sessions.get(nativeSessionId);
		return session && session.alive ? "alive" : "gone";
	}
}

/** A macrotask tick, so an awaited async submit can advance past `startSession`. */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Spin up a temp dir, an opened binding store, a FakeDriver and the adapter, with
 * automatic cleanup. Submission DB lives in a nested `private/` dir so the 0700
 * parent-creation path is exercised.
 */
async function makeAdapter(t, { now, identity, behavior, driver } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "aios-legacy-adapter-"));
	const storePath = join(dir, "bindings.sqlite");
	const dbPath = join(dir, "private", "submissions.sqlite");
	const clock = now ?? (() => 1000);
	const finalIdentity = { ...BASE_IDENTITY, ...(identity ?? {}) };
	const store = openBindingStore(storePath, { now: clock });
	const finalDriver = driver ?? new FakeDriver({ store, behavior });
	const adapter = createLegacyAdapter({ store, driver: finalDriver, now: clock, identity: finalIdentity, dbPath });
	t.after(async () => {
		try {
			adapter.close();
		} catch {
			/* already closed */
		}
		try {
			store.close();
		} catch {
			/* already closed */
		}
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, storePath, dbPath, now: clock, identity: finalIdentity, store, driver: finalDriver, adapter };
}

/** Assert a RouteBindingError with the given code is thrown. */
function rejectsRouteBinding(promise, code) {
	return assert.rejects(promise, (error) => error instanceof RouteBindingError && error.code === code, `expected RouteBindingError(${code})`);
}

/** Assert a LegacyAdapterError with the given code is thrown. */
function rejectsLegacy(promise, code) {
	return assert.rejects(promise, (error) => error instanceof LegacyAdapterError && error.code === code, `expected LegacyAdapterError(${code})`);
}

test("1: a normal submit persists binding + intent before driver.startSession", async (t) => {
	const { adapter, driver, store } = await makeAdapter(t);
	const out = await adapter.submit(REQ);

	assert.equal(driver.calls.startSession, 1);
	assert.equal(driver.preEffect.length, 1);
	assert.equal(driver.preEffect[0].size, 1, "the durable binding existed before startSession");
	assert.equal(driver.preEffect[0].intentCount, 1, "the durable EffectIntent existed before startSession");
	assert.equal(store.resolve(keyOf(REQ)).runtime, "legacy");
	assert.equal(out.status, "done");
	assert.equal(out.output, "echo:hello");
	assert.equal(out.nativeSessionId, "native-1");
});

test("2: an out-of-scope taskId is refused with legacy-scope-violation and never calls the driver", async (t) => {
	const { adapter, driver } = await makeAdapter(t);
	await rejectsRouteBinding(adapter.submit({ ...REQ, taskId: "task-99" }), "legacy-scope-violation");
	assert.equal(driver.calls.startSession, 0);
	assert.equal(driver.calls.prompt, 0);
});

test("3: an expired identity is refused with binding-expired and never calls the driver", async (t) => {
	const { adapter, driver } = await makeAdapter(t, { now: () => 6000 }); // expiresAt 5000
	await rejectsRouteBinding(adapter.submit(REQ), "binding-expired");
	assert.equal(driver.calls.startSession, 0);
	assert.equal(driver.calls.prompt, 0);
});

test("4: a re-submit of the same request key is idempotent (same id, one startSession)", async (t) => {
	const { adapter, driver } = await makeAdapter(t);
	const first = await adapter.submit(REQ);
	const second = await adapter.submit(REQ);

	assert.equal(first.submissionId, second.submissionId);
	assert.equal(driver.calls.startSession, 1, "the driver was started exactly once");
	assert.equal(driver.calls.prompt, 1);
});

test("5: a driver startSession failure marks the intent uncertain; re-submit never re-dispatches", async (t) => {
	const { adapter, driver, store } = await makeAdapter(t, { behavior: { startSessionError: "boom" } });

	await rejectsLegacy(adapter.submit(REQ), "driver-failure");
	assert.equal(store.intentCount, 1, "the intent was persisted before the effect");

	const held = await adapter.wait(keyOf(REQ));
	assert.equal(held.status, "uncertain");

	const again = await adapter.submit(REQ);
	assert.equal(again.submissionId, held.submissionId, "the existing submission is returned");
	assert.equal(driver.calls.startSession, 1, "no silent re-dispatch");
});

test("6: wait returns the right status and output for done and failed", async (t) => {
	const behavior = {
		prompt: (_id, text) => (text === "fail" ? { status: "failed", output: "err" } : { status: "done", output: `ok:${text}` }),
	};
	const { adapter } = await makeAdapter(t, { behavior });

	const okReq = { ownerId: "owner-1", sourceRequestId: "req-ok", effectKey: "effect-1", taskId: "task-1", text: "fine" };
	const badReq = { ownerId: "owner-1", sourceRequestId: "req-bad", effectKey: "effect-1", taskId: "task-1", text: "fail" };
	await adapter.submit(okReq);
	await adapter.submit(badReq);

	const ok = await adapter.wait(keyOf(okReq));
	assert.equal(ok.status, "done");
	assert.equal(ok.output, "ok:fine");

	const bad = await adapter.wait(keyOf(badReq));
	assert.equal(bad.status, "failed");
	assert.equal(bad.output, "err");
});

test("7: aborting a submission kills it; an unknown requestKey is refused", async (t) => {
	const { adapter, driver } = await makeAdapter(t);
	await adapter.submit(REQ);

	const aborted = await adapter.abort({ kind: "submission", requestKey: keyOf(REQ) });
	assert.equal(driver.calls.kill, 1);
	assert.deepEqual(driver.killed, ["native-1"]);
	assert.equal(aborted.status, "cancelled");

	await rejectsLegacy(
		adapter.abort({ kind: "submission", requestKey: { ownerId: "ghost", sourceRequestId: "nope" } }),
		"unknown-submission",
	);
});

test("8: abort scopes owned elsewhere are refused with unsupported-scope", async (t) => {
	const { adapter } = await makeAdapter(t);
	for (const kind of ["goal-wide", "execution", "conversation"]) {
		await rejectsLegacy(adapter.abort({ kind }), "unsupported-scope");
	}
});

test("9: recover keeps an alive session and marks a gone one uncertain without re-dispatching", async (t) => {
	const behavior = {
		prompt: (_id, text) => {
			if (text === "hang") return new Promise(() => {}); // never resolves -> stays running
			throw new Error("boom"); // -> uncertain, but a native session exists
		},
	};
	const { adapter, driver } = await makeAdapter(t, { behavior });

	const hangReq = { ownerId: "owner-1", sourceRequestId: "req-hang", effectKey: "effect-1", taskId: "task-1", text: "hang" };
	const boomReq = { ownerId: "owner-1", sourceRequestId: "req-boom", effectKey: "effect-1", taskId: "task-1", text: "boom" };

	void adapter.submit(hangReq); // never resolves; runs in the background
	await tick();
	const hang = await adapter.wait(keyOf(hangReq));
	assert.equal(hang.status, "running");
	assert.equal(hang.nativeSessionId, "native-1");

	await rejectsLegacy(adapter.submit(boomReq), "driver-failure");
	const boom = await adapter.wait(keyOf(boomReq));
	assert.equal(boom.status, "uncertain");
	assert.equal(boom.nativeSessionId, "native-2");

	// The driver now reports the running session alive and the failed session gone.
	driver.behavior.statusById = { "native-1": "alive", "native-2": "gone" };
	const promptsBefore = driver.calls.prompt;

	const report = await adapter.recover();
	assert.equal(report.checked, 2);
	assert.equal(report.alive, 1);
	assert.equal(report.gone, 1);
	assert.equal((await adapter.wait(keyOf(hangReq))).status, "running", "alive kept exactly as-is");
	assert.equal((await adapter.wait(keyOf(boomReq))).status, "uncertain", "gone -> uncertain");
	assert.equal(driver.calls.prompt, promptsBefore, "recover never re-dispatches");
	assert.equal(driver.calls.startSession, 2, "recover never starts a new session");
});

test("10: the mapping DB is 0600 (/dir 0700) and a reopen restores the mapping", async (t) => {
	const { adapter, driver, store, now, identity, dbPath } = await makeAdapter(t);
	const sub = await adapter.submit({ ...REQ, text: "hi" });

	assert.equal((await stat(dbPath)).mode & 0o777, 0o600, "mapping file mode");
	assert.equal((await stat(dirname(dbPath))).mode & 0o777, 0o700, "created parent directory mode");

	adapter.close();
	const reopened = createLegacyAdapter({ store, driver: new FakeDriver({ store }), now, identity, dbPath });
	t.after(() => reopened.close());

	const restored = await reopened.wait(keyOf(REQ));
	assert.equal(restored.submissionId, sub.submissionId);
	assert.equal(restored.status, "done");
	assert.equal(restored.output, "echo:hi");
	assert.equal(restored.nativeSessionId, "native-1");
});

test("11: V01 - repeated submission runs the real prompt exactly once", async (t) => {
	const { adapter, driver } = await makeAdapter(t);
	await adapter.submit(REQ);
	await adapter.submit(REQ);
	assert.equal(driver.calls.prompt, 1, "the real execution count stayed at 1");
});

test("12: a request already bound to pi-durable fails closed with binding-conflict (no dual-alive)", async (t) => {
	const { adapter, driver, store } = await makeAdapter(t);
	store.bind(piBinding(keyOf(REQ)));

	await rejectsRouteBinding(adapter.submit(REQ), "binding-conflict");
	assert.equal(driver.calls.startSession, 0);
	assert.equal(driver.calls.prompt, 0);
	assert.equal(store.resolve(keyOf(REQ)).runtime, "pi-durable", "the durable owner is untouched");
});

test("13: observe() reports status counts and a secret-free identity summary", async (t) => {
	const { adapter } = await makeAdapter(t);
	await adapter.submit(REQ);

	const snapshot = adapter.observe();
	assert.equal(snapshot.runtime, "legacy");
	assert.equal(snapshot.submissions, 1);
	assert.equal(snapshot.byStatus.done, 1);
	assert.equal(snapshot.byStatus.uncertain, 0);
	assert.equal(snapshot.identity.codeVersion, "0.3.0");
	assert.deepEqual(snapshot.identity.allowedTaskIds, ["task-1", "task-2"]);
	assert.equal(snapshot.identity.expiresAt, 5000);
	assert.equal(snapshot.identity.authorizationDigest, undefined, "the authorization digest is not exposed");
});

test("14: an unknown mapping schema version is refused fail-closed", async (t) => {
	const { store, driver, now, identity, dbPath } = await makeAdapter(t);
	const raw = new DatabaseSync(dbPath);
	raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run("99", "schema_version");
	raw.close();

	assert.throws(
		() => createLegacyAdapter({ store, driver, now, identity, dbPath }),
		(error) => error instanceof LegacyAdapterError && error.code === "unsupported-schema-version",
	);
});
