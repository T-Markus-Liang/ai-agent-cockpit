// RuntimePort contract tests for the P2-B thin Pi adapter.
//
// Scope: these tests drive the REAL PiRuntimeAdapter over a REAL private
// OwnedStorage and the public pi-ai faux provider / public pi-durable Harness.
// Nothing here fabricates a "runtime verifier": every assertion observes actual
// SDK state (faux call counts, durable submissions, admission documents).
//
// The adapter source is read-only for this handoff; a failure below is a
// reported source defect, not something these tests work around.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";

import { CONTRACT_VERSION, assertAdmissionDoc, initialAdmissionDoc } from "../runtime/contracts.mjs";
import { AdmissionDoc, PiRuntimeAdapter } from "../runtime/pi-adapter.mjs";
import { openOwnedSqliteStorage } from "../runtime/owner-sqlite.mjs";

const MODEL_REF = Object.freeze({ provider: "faux", modelId: "faux-1" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Actual faux provider wired into an explicit Models collection. */
function makeModels(responses, options = {}) {
	const faux = fauxProvider(options);
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

/** Canonical caller request: caller references only, no approval authority. */
function request(overrides = {}) {
	return {
		ownerId: "owner-1",
		sourceRequestId: "req-1",
		content: "hello",
		productTaskId: "product-1",
		executionId: "exec-1",
		profileId: "profile-1",
		authorizationDigest: "auth-ref-1",
		...overrides,
	};
}

async function withTempDir(run) {
	const dir = await mkdtemp(join(tmpdir(), ".port-state-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function openAdapter(dir, models, options = {}) {
	const file = join(dir, "session.sqlite");
	const owned = await openOwnedSqliteStorage(file);
	const adapter = await PiRuntimeAdapter.open(owned, {
		models,
		modelRef: options.modelRef ?? MODEL_REF,
		...(options.registry === undefined ? {} : { registry: options.registry }),
		allowUnbudgeted: true,
	});
	return { adapter, owned, file };
}

const conflict = (error) => error?.code === "request-conflict";

test("corrupt mapping orphan/cross-owner keys are rejected", () => {
  const empty = initialAdmissionDoc();
  empty.submissions.orphan = 1;
  assert.throws(() => assertAdmissionDoc(empty), error => error.code === "malformed-mapping");
});

test("recover restores a lost submission link without replaying the input", async () => {
  await withTempDir(async dir => {
    const file = join(dir, "session.sqlite");
    const { faux, models } = makeModels([fauxAssistantMessage("saved")]);
    let owned = await openOwnedSqliteStorage(file);
    let adapter = await PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, allowUnbudgeted: true });
    const accepted = await adapter.submit(request());
    await adapter.wait(accepted.submissionId);
    await adapter.close();
    owned = await openOwnedSqliteStorage(file);
    const fixture = await Harness.open(owned.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    await fixture.commit(async tx => {
      const doc = await tx.doc(AdmissionDoc);
      delete doc.submissions[accepted.requestKey];
    }, BACKGROUND_CONTEXT);
    await fixture.close(BACKGROUND_CONTEXT);
    owned = await openOwnedSqliteStorage(file);
    adapter = await PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, allowUnbudgeted: true });
    try {
      const recovery = await adapter.recover();
      assert.deepEqual(recovery.restored, [accepted.requestKey]);
      const observed = await adapter.observe();
      assert.equal(observed.submissions[accepted.requestKey], accepted.submissionId);
      assert.equal(faux.state.callCount, 1);
    } finally { await adapter.close(); }
  });
});

test("recover rejects unresolved models before scheduling new work", async () => {
  await withTempDir(async dir => {
    const { models } = makeModels([fauxAssistantMessage("saved")]);
    const { adapter } = await openAdapter(dir, models);
    try {
      const accepted = await adapter.submit(request());
      await adapter.wait(accepted.submissionId);
      models.clearProviders();
      await assert.rejects(() => adapter.recover(), error => error.code === "unresolved-models");
    } finally { await adapter.close(); }
  });
});

test("same request id reuses one faux submission and one model call", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("first")]);
		const { adapter } = await openAdapter(dir, models);
		try {
			const first = await adapter.submit(request());
			assert.equal(first.reused, false);
			const settled = await adapter.wait(first.submissionId);
			assert.equal(settled.status, "done");
			assert.equal(faux.state.callCount, 1);

			const second = await adapter.submit(request());
			assert.equal(second.reused, true);
			assert.equal(second.submissionId, first.submissionId);
			assert.equal(second.conversationId, first.conversationId);
			assert.equal(faux.state.callCount, 1, "a duplicate request id must not start a second generation");
		} finally {
			await adapter.close();
		}
	});
});

test("changed text/task/execution/profile/cwd/authorization reject before another call", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("bound")]);
		const { adapter } = await openAdapter(dir, models);
		try {
			const base = request();
			const bound = await adapter.submit(base);
			await adapter.wait(bound.submissionId);
			assert.equal(faux.state.callCount, 1);

			const mutations = [
				["content", { content: "different text" }],
				["productTaskId", { productTaskId: "product-2" }],
				["executionId", { executionId: "exec-2" }],
				["profileId", { profileId: "profile-2" }],
				["cwd", { cwd: join(tmpdir(), "elsewhere") }],
				["authorizationDigest", { authorizationDigest: "auth-ref-2" }],
			];
			for (const [field, mutation] of mutations) {
				await assert.rejects(
					() => adapter.submit({ ...base, ...mutation }),
					conflict,
					`changed ${field} must be rejected`,
				);
				assert.equal(faux.state.callCount, 1, `changed ${field} must not reach the model`);
			}

			await assert.rejects(
				() => adapter.submit({ ...base, payloadDigest: "a".repeat(64) }),
				(error) => error?.code === "payload-digest-mismatch",
			);
			assert.equal(faux.state.callCount, 1, "a mismatched payloadDigest must not reach the model");
		} finally {
			await adapter.close();
		}
	});
});

test("reopened adapter rejects reuse when the default model drifted", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const bound = makeModels([fauxAssistantMessage("bound to faux-1")]);
		const firstOwned = await openOwnedSqliteStorage(file);
		const firstAdapter = await PiRuntimeAdapter.open(firstOwned, { models: bound.models, modelRef: MODEL_REF, allowUnbudgeted: true });
		const submitted = await firstAdapter.submit(request());
		await firstAdapter.wait(submitted.submissionId);
		await firstAdapter.close();

		const drifted = makeModels([fauxAssistantMessage("drifted")], { models: [{ id: "faux-2" }] });
		const secondOwned = await openOwnedSqliteStorage(file);
		const secondAdapter = await PiRuntimeAdapter.open(secondOwned, {
			models: drifted.models,
			modelRef: { provider: "faux", modelId: "faux-2" },
			allowUnbudgeted: true,
		});
		try {
			await assert.rejects(() => secondAdapter.submit(request()), conflict);
			assert.equal(drifted.faux.state.callCount, 0, "a drifted default must not dispatch the old profile");
		} finally {
			await secondAdapter.close();
		}
	});
});

test("distinct owners and prototype-like ids stay isolated", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([
			fauxAssistantMessage("a"),
			fauxAssistantMessage("b"),
			fauxAssistantMessage("c"),
			fauxAssistantMessage("d"),
		]);
		const { adapter } = await openAdapter(dir, models);
		try {
			const first = await adapter.submit(request({ ownerId: "owner-a" }));
			const second = await adapter.submit(request({ ownerId: "owner-b" }));
			const proto = await adapter.submit(request({ ownerId: "__proto__" }));
			const ctor = await adapter.submit(request({ ownerId: "constructor" }));
			await adapter.wait(first.submissionId);
			await adapter.wait(second.submissionId);
			await adapter.wait(proto.submissionId);
			await adapter.wait(ctor.submissionId);

			const conversations = new Set([first.conversationId, second.conversationId, proto.conversationId, ctor.conversationId]);
			assert.equal(conversations.size, 4, "each owner must get its own conversation");

			assert.equal(Object.prototype.polluted, undefined);
			assert.equal({}.ownerId, undefined);

			const reuse = await adapter.submit(request({ ownerId: "owner-a" }));
			assert.equal(reuse.reused, true);
			assert.equal(reuse.conversationId, first.conversationId);

			const owners = (await adapter.observe()).owners;
			assert.equal(owners.length, 4);
			assert.ok(owners.some((owner) => owner.ownerId === "__proto__"));
		} finally {
			await adapter.close();
		}
	});
});

test("close and reopen reuses the same submission with zero extra model calls", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { faux, models } = makeModels([fauxAssistantMessage("once")]);
		const firstOwned = await openOwnedSqliteStorage(file);
		const firstAdapter = await PiRuntimeAdapter.open(firstOwned, { models, modelRef: MODEL_REF, allowUnbudgeted: true });
		const submitted = await firstAdapter.submit(request());
		await firstAdapter.wait(submitted.submissionId);
		assert.equal(faux.state.callCount, 1);
		await firstAdapter.close();

		const secondOwned = await openOwnedSqliteStorage(file);
		const secondAdapter = await PiRuntimeAdapter.open(secondOwned, { models, modelRef: MODEL_REF, allowUnbudgeted: true });
		try {
			const again = await secondAdapter.submit(request());
			assert.equal(again.reused, true);
			assert.equal(again.submissionId, submitted.submissionId);
			const settled = await secondAdapter.wait(again.submissionId);
			assert.equal(settled.status, "done");
			assert.equal(faux.state.callCount, 1, "reuse across a full close/reopen must not call the model again");
		} finally {
			await secondAdapter.close();
		}
	});
});

test("cancelled Chord wait rejects the waiter while the generation continues", async () => {
	await withTempDir(async (dir) => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { faux, models } = makeModels([
			async () => {
				await gate;
				return fauxAssistantMessage("slow answer");
			},
		]);
		const { adapter } = await openAdapter(dir, models);
		try {
			const submitted = await adapter.submit(request());
			while (faux.state.callCount < 1) await sleep(5);

			const { context: waitContext, cancel } = withCancel(BACKGROUND_CONTEXT);
			const cancelledWait = adapter.wait(submitted.submissionId, waitContext);
			cancel();
			await assert.rejects(cancelledWait);

			release();
			const settled = await adapter.wait(submitted.submissionId);
			assert.equal(settled.status, "done");
			assert.equal(faux.state.callCount, 1, "cancelling the waiter must not abort or restart the work");
		} finally {
			await adapter.close();
		}
	});
});

test("a nonempty tool registry is rejected before the harness starts", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const echo = defineTool({
			name: "echo",
			description: "echo a value",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "unsafe-tools", tools: [echo] }));

		const owned = await openOwnedSqliteStorage(join(dir, "session.sqlite"));
		try {
			await assert.rejects(
				() => PiRuntimeAdapter.open(owned, { models, registry }),
				(error) => error?.code === "unsafe-registry",
			);
		} finally {
			await owned.close();
		}
	});
});

test("inspect, usage and observe return actual SDK state", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("answer")]);
		const { adapter } = await openAdapter(dir, models);
		try {
			const submitted = await adapter.submit(request());
			await adapter.wait(submitted.submissionId);

			const inspection = await adapter.inspect();
			assert.equal(inspection.contractVersion, CONTRACT_VERSION);
			assert.ok(["paused", "running", "closing"].includes(inspection.scheduling));
			assert.equal(inspection.tasks, 0);
			assert.deepEqual(inspection.registry, { extensions: [], tools: [] });
			assert.equal(inspection.requests.length, 1);
			assert.equal(inspection.requests[0].submissionId, submitted.submissionId);
			assert.equal(inspection.requests[0].conversationId, submitted.conversationId);
			assert.equal(inspection.lease.current, true);

			const usage = await adapter.usage();
			assert.ok(usage.models !== null && typeof usage.models === "object");
			assert.ok(usage.tools !== null && typeof usage.tools === "object");

			const observed = await adapter.observe();
			assert.equal(observed.contractVersion, CONTRACT_VERSION);
			assert.equal(observed.requests.length, 1);
			assert.equal(observed.owners.length, 1);

			const status = await adapter.observe({ submissionId: submitted.submissionId });
			assert.equal(status.status, "done");
		} finally {
			await adapter.close();
		}
	});
});

test("unsupported execution and goal-wide abort scopes are explicitly rejected", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openAdapter(dir, models);
		try {
			await assert.rejects(() => adapter.abort({ kind: "execution" }), (error) => error?.code === "unsupported-scope");
			await assert.rejects(() => adapter.abort("goal"), (error) => error?.code === "unsupported-scope");
			await assert.rejects(() => adapter.abort(undefined), (error) => error?.code === "scope-required");
			await assert.rejects(
				() => adapter.abort({ kind: "submission", submissionId: "not-an-id" }),
				(error) => error?.code === "invalid-submission-id",
			);
		} finally {
			await adapter.close();
		}
	});
});

test("a closed adapter denies every operation", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openAdapter(dir, models);
		await adapter.close();
		await adapter.close(); // idempotent

		const denied = (error) => error?.code === "adapter-closed";
		await assert.rejects(() => adapter.submit(request()), denied);
		await assert.rejects(() => adapter.wait(1), denied);
		await assert.rejects(() => adapter.observe(), denied);
		await assert.rejects(() => adapter.observe(1), denied);
		await assert.rejects(() => adapter.recover(), denied);
		await assert.rejects(() => adapter.abort({ kind: "conversation", conversationId: 1 }), denied);
		await assert.rejects(() => adapter.inspect(), denied);
		await assert.rejects(() => adapter.usage(), denied);
	});
});

test("an unknown admission mapping version is rejected and not erased", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { models } = makeModels([fauxAssistantMessage("unused")]);

		// Seed a durable mapping whose stored schemaVersion is unknown, through
		// the public Harness and the public AdmissionDoc token only.
		const seedOwned = await openOwnedSqliteStorage(file);
		const seedHarness = await Harness.open(seedOwned.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
		await seedHarness.commit(async (tx) => {
			const doc = await tx.doc(AdmissionDoc);
			doc.schemaVersion = 99;
		}, BACKGROUND_CONTEXT);
		await seedHarness.close(BACKGROUND_CONTEXT);

		const owned = await openOwnedSqliteStorage(file);
		await assert.rejects(
			() => PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, allowUnbudgeted: true }),
			(error) => error?.code === "unknown-mapping-version",
		);

		// The refused open must not have reset or erased the unknown value.
		const verifyOwned = await openOwnedSqliteStorage(file);
		const verifyHarness = await Harness.open(verifyOwned.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
		try {
			const value = await verifyHarness.snapshot(AdmissionDoc, BACKGROUND_CONTEXT);
			assert.equal(value.schemaVersion, 99);
		} finally {
			await verifyHarness.close(BACKGROUND_CONTEXT);
			await verifyOwned.close();
		}
	});
});
