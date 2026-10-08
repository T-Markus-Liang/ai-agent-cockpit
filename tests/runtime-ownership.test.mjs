// RuntimePort ownership / cancellation-scope tests for the M02/I03a slice.
//
// Scope: drive the REAL PiRuntimeAdapter over a REAL private OwnedStorage and
// the public faux provider + public pi-durable Harness. Every assertion observes
// actual SDK state (faux call counts, durable submission statuses, the durable
// admission mapping) — nothing here fabricates a "cancellation verifier".
//
// Contract under test:
//   - request.ownership is optional; absent reads back as {kind:"foreground"};
//   - a background request binds an executionId durably in the mapping;
//   - V10: cancelling a wait never aborts the generation;
//   - V11: a conversation-scope abort cancels foreground work only;
//   - execution-scope abort cancels only background submissions of that id, and
//     an unknown id fails closed; goal-wide stays refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";

import { AdmissionDoc, PiRuntimeAdapter, budgetScopeFor } from "../runtime/pi-adapter.mjs";
import { createBudgetPolicy, BudgetError } from "../runtime/budget-policy.mjs";
import { openOwnedSqliteStorage } from "../runtime/owner-sqlite.mjs";

const MODEL_REF = Object.freeze({ provider: "faux", modelId: "faux-1" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A generation that keeps streaming until the abort signal fires. `tokensPerSecond`
 * makes the faux stream yield between deltas and observe `signal.aborted`, so a run
 * task abort is honoured promptly — unlike a plain awaited gate, which the faux
 * provider cannot interrupt.
 */
const LONG_ANSWER = "x".repeat(6000);
const slowModels = (responses) => makeModels(responses, { tokensPerSecond: 80 });

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
	const dir = await mkdtemp(join(tmpdir(), ".port-ownership-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function openAdapter(file, models) {
	const owned = await openOwnedSqliteStorage(file);
	// Budget admission is mandatory; these ownership cases are not about budget,
	// so they opt out through the explicit escape hatch.
	const adapter = await PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, allowUnbudgeted: true });
	return { adapter, owned };
}

const recordFor = (observed, sourceRequestId) =>
	observed.requests.find((record) => record.sourceRequestId === sourceRequestId);
const statusOf = async (adapter, submissionId) => (await adapter.observe({ submissionId })).status;
const waitForCall = async (faux, count) => {
	while (faux.state.callCount < count) await sleep(5);
};

test("a request without ownership is persisted as foreground and survives reopen", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { models } = makeModels([fauxAssistantMessage("answer")]);
		let { adapter } = await openAdapter(file, models);
		try {
			const accepted = await adapter.submit(request());
			await adapter.wait(accepted.submissionId);
			assert.deepEqual(recordFor(await adapter.observe(), "req-1").ownership, { kind: "foreground" });
		} finally {
			await adapter.close();
		}

		({ adapter } = await openAdapter(file, models));
		try {
			assert.deepEqual(recordFor(await adapter.observe(), "req-1").ownership, { kind: "foreground" });
		} finally {
			await adapter.close();
		}
	});
});

test("an explicit background ownership binds its execution id durably across reopen", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { models } = makeModels([fauxAssistantMessage("answer")]);
		let { adapter } = await openAdapter(file, models);
		try {
			const accepted = await adapter.submit(request({ executionId: "exec-bg", ownership: { kind: "background", executionId: "exec-bg" } }));
			await adapter.wait(accepted.submissionId);
			assert.deepEqual(recordFor(await adapter.observe(), "req-1").ownership, { kind: "background", executionId: "exec-bg" });
		} finally {
			await adapter.close();
		}

		({ adapter } = await openAdapter(file, models));
		try {
			assert.deepEqual(recordFor(await adapter.observe(), "req-1").ownership, { kind: "background", executionId: "exec-bg" });
		} finally {
			await adapter.close();
		}
	});
});

test("invalid ownership is rejected before any admission record is written", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const invalid = [
				{ kind: "ownerless" },
				{ kind: "foreground", executionId: "exec-x" },
				{ kind: "foreground", goalId: "goal-x" },
				{ kind: "background", executionId: "" },
				{ kind: "background", executionId: 5 },
				{ kind: "background", executionId: "x".repeat(600) },
				{ kind: "background", bogus: "x" },
				{},
				"background",
			];
			for (const ownership of invalid) {
				await assert.rejects(
					() => adapter.submit(request({ ownership })),
					(error) => error?.code === "invalid-request-field",
					`ownership ${JSON.stringify(ownership)} must be rejected`,
				);
			}
			const observed = await adapter.observe();
			assert.equal(observed.requests.length, 0, "a rejected ownership must not leave a request record");
			assert.equal(observed.owners.length, 0, "a rejected ownership must not create an owner/conversation");
		} finally {
			await adapter.close();
		}
	});
});

test("V10: cancelling a parent wait does not kill an explicit background generation", async () => {
	await withTempDir(async (dir) => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { faux, models } = makeModels([
			async () => {
				await gate;
				return fauxAssistantMessage("slow background answer");
			},
		]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const submitted = await adapter.submit(request({ executionId: "exec-v10", ownership: { kind: "background", executionId: "exec-v10" } }));
			await waitForCall(faux, 1);

			const { context: waitContext, cancel } = withCancel(BACKGROUND_CONTEXT);
			const cancelledWait = adapter.wait(submitted.submissionId, waitContext);
			cancel();
			await assert.rejects(cancelledWait);

			release();
			const settled = await adapter.wait(submitted.submissionId);
			assert.equal(settled.status, "done");
			assert.equal(faux.state.callCount, 1, "cancelling the waiter must not abort or restart background work");
		} finally {
			await adapter.close();
		}
	});
});

test("V11: a conversation-scope abort cancels foreground work but not background work", async () => {
	await withTempDir(async (dir) => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		// The long-running background is the conversation's active run; the foreground
		// input queues behind it (followUp). Cancelling the conversation scope must drop
		// the queued foreground input and leave the background run untouched.
		const { faux, models } = makeModels([
			async () => {
				await gate;
				return fauxAssistantMessage("background answer");
			},
			fauxAssistantMessage("foreground answer"),
		]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const background = await adapter.submit(request({ ownerId: "owner-v11", sourceRequestId: "bg-1", executionId: "exec-v11", ownership: { kind: "background", executionId: "exec-v11" } }));
			await waitForCall(faux, 1);
			const foreground = await adapter.submit(request({ ownerId: "owner-v11", sourceRequestId: "fg-1", ownership: { kind: "foreground" } }));
			assert.equal(foreground.conversationId, background.conversationId, "one owner shares one conversation");
			assert.equal(await statusOf(adapter, foreground.submissionId), "queued");

			await adapter.abort({ kind: "conversation", conversationId: background.conversationId });

			assert.equal(await statusOf(adapter, foreground.submissionId), "unanswered", "the foreground input is cancelled");
			release();
			const settled = await adapter.wait(background.submissionId);
			assert.equal(settled.status, "done", "the background submission keeps running to a terminal state");
		} finally {
			await adapter.close();
		}
	});
});

test("an execution-scope abort cancels only the background submissions bound to that id", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = slowModels([fauxAssistantMessage(LONG_ANSWER), fauxAssistantMessage("exec-2 answer")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const first = await adapter.submit(request({ ownerId: "owner-6a", sourceRequestId: "exec-1-req", executionId: "exec-1", ownership: { kind: "background", executionId: "exec-1" } }));
			await waitForCall(faux, 1);
			const second = await adapter.submit(request({ ownerId: "owner-6b", sourceRequestId: "exec-2-req", executionId: "exec-2", ownership: { kind: "background", executionId: "exec-2" } }));
			await waitForCall(faux, 2);

			const result = await adapter.abort({ kind: "execution", executionId: "exec-1" });
			assert.equal(result, "aborted");

			assert.equal(await statusOf(adapter, first.submissionId), "unanswered", "exec-1's submission is cancelled");
			const settled = await adapter.wait(second.submissionId);
			assert.equal(settled.status, "done", "exec-2's submission is untouched");
		} finally {
			await adapter.close();
		}
	});
});

test("an execution-scope abort with an unknown id fails closed and aborts nothing", async () => {
	await withTempDir(async (dir) => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const slow = async () => {
			await gate;
			return fauxAssistantMessage("gated answer");
		};
		const { faux, models } = makeModels([slow, slow]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const first = await adapter.submit(request({ ownerId: "owner-7a", sourceRequestId: "r-7a", executionId: "exec-7a", ownership: { kind: "background", executionId: "exec-7a" } }));
			const second = await adapter.submit(request({ ownerId: "owner-7b", sourceRequestId: "r-7b", executionId: "exec-7b", ownership: { kind: "background", executionId: "exec-7b" } }));
			await waitForCall(faux, 2);

			await assert.rejects(
				() => adapter.abort({ kind: "execution", executionId: "exec-missing" }),
				(error) => error?.code === "unknown-execution",
			);
			assert.equal(await statusOf(adapter, first.submissionId), "placed", "an unknown execution id must not cancel anything");
			assert.equal(await statusOf(adapter, second.submissionId), "placed", "an unknown execution id must not cancel anything");

			release();
			assert.equal((await adapter.wait(first.submissionId)).status, "done");
			assert.equal((await adapter.wait(second.submissionId)).status, "done");
		} finally {
			await adapter.close();
		}
	});
});

test("goal-wide abort stays explicitly refused", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			await assert.rejects(() => adapter.abort({ kind: "goal", goalId: "goal-1" }), (error) => error?.code === "unsupported-scope");
			await assert.rejects(() => adapter.abort({ kind: "goal-wide", goalId: "goal-1" }), (error) => error?.code === "unsupported-scope");
			await assert.rejects(() => adapter.abort("goal"), (error) => error?.code === "unsupported-scope");
			// A bare execution scope names no concrete execution and stays unsupported.
			await assert.rejects(() => adapter.abort({ kind: "execution" }), (error) => error?.code === "unsupported-scope");
		} finally {
			await adapter.close();
		}
	});
});

test("execution-scope abort still works after a close/reopen restore", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { faux, models } = slowModels([fauxAssistantMessage("first background answer"), fauxAssistantMessage(LONG_ANSWER)]);
		let { adapter } = await openAdapter(file, models);
		try {
			// The pre-restart background request finishes, so it is durable but settled.
			const completed = await adapter.submit(request({ sourceRequestId: "req-1", executionId: "exec-recover", ownership: { kind: "background", executionId: "exec-recover" } }));
			await adapter.wait(completed.submissionId);
			assert.equal(faux.state.callCount, 1);
		} finally {
			await adapter.close();
		}

		({ adapter } = await openAdapter(file, models));
		try {
			const recovery = await adapter.recover();
			assert.equal(recovery.recovered, true);
			assert.deepEqual(recordFor(await adapter.observe(), "req-1").ownership, { kind: "background", executionId: "exec-recover" });

			// A fresh live background request in the same execution, after the restart.
			const live = await adapter.submit(request({ ownerId: "owner-9b", sourceRequestId: "req-9b", executionId: "exec-recover", ownership: { kind: "background", executionId: "exec-recover" } }));
			await waitForCall(faux, 2);

			const result = await adapter.abort({ kind: "execution", executionId: "exec-recover" });
			assert.equal(result, "aborted");

			assert.equal(await statusOf(adapter, live.submissionId), "unanswered", "the restored binding still targets live background work");
		} finally {
			await adapter.close();
		}
	});
});

test("a same request id resubmitted with different ownership is rejected as a conflict", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("answer")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const accepted = await adapter.submit(request());
			await adapter.wait(accepted.submissionId);
			await assert.rejects(
				() => adapter.submit(request({ executionId: "exec-1", ownership: { kind: "background", executionId: "exec-1" } })),
				(error) => error?.code === "request-conflict",
			);
		} finally {
			await adapter.close();
		}
	});
});

test("a legacy mapping record without an ownership field keeps its stored shape", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { models } = makeModels([fauxAssistantMessage("answer")]);
		const { adapter } = await openAdapter(file, models);
		try {
			const accepted = await adapter.submit(request());
			await adapter.wait(accepted.submissionId);
		} finally {
			await adapter.close();
		}

		// Reopen and strip the ownership field through the public Harness + doc token,
		// simulating a mapping written before the ownership field existed.
		const owned = await openOwnedSqliteStorage(file);
		const fixture = await Harness.open(owned.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
		await fixture.commit(async (tx) => {
			const doc = await tx.doc(AdmissionDoc);
			for (const record of Object.values(doc.requests)) delete record.ownership;
		}, BACKGROUND_CONTEXT);
		await fixture.close(BACKGROUND_CONTEXT);
		await owned.close();

		const { adapter: reopened } = await openAdapter(file, models);
		try {
			assert.equal(recordFor(await reopened.observe(), "req-1").ownership, undefined, "the stored document keeps its legacy shape");
			// A conversation-scope abort treats the legacy record as foreground and must not throw.
			const conversationId = (await reopened.observe()).requests[0].conversationId;
			assert.equal(await reopened.abort({ kind: "conversation", conversationId }), "aborted");
		} finally {
			await reopened.close();
		}
	});
});

// ---------------------------------------------------------------------------
// M02-R2 rework: the three r1 audit findings (docs/audits/m02-runtime-ownership-r1.md).
//
// F001 — stopping an active foreground run must not strand the queued background
//        silently: the exact status is reported (stalled + reason) and the abort
//        return never implies the background will continue.
// F002 — a mixed run (foreground + background in one run) returns a structured
//        still-running/unsupported result, never a bare "aborted" that hides live work.
// F003 — a background ownership must resolve to an execution binding before any
//        effect, so no running task exists without a scoped cancel path.
// ---------------------------------------------------------------------------

/** Open an adapter with explicit settings (the shared helper pins none). */
async function openAdapterWith(file, models, settings) {
	const owned = await openOwnedSqliteStorage(file);
	const adapter = await PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, settings, allowUnbudgeted: true });
	return { adapter, owned };
}

test("F001: stopping an active foreground reports queued background submissions as stalled", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = slowModels([fauxAssistantMessage(LONG_ANSWER), fauxAssistantMessage("bg-a"), fauxAssistantMessage("bg-b")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const foreground = await adapter.submit(request({ ownerId: "owner-f001", sourceRequestId: "fg", ownership: { kind: "foreground" } }));
			await waitForCall(faux, 1);
			const backgroundA = await adapter.submit(request({ ownerId: "owner-f001", sourceRequestId: "bg-a", executionId: "exec-a", ownership: { kind: "background", executionId: "exec-a" } }));
			const backgroundB = await adapter.submit(request({ ownerId: "owner-f001", sourceRequestId: "bg-b", executionId: "exec-b", ownership: { kind: "background", executionId: "exec-b" } }));
			assert.equal(await statusOf(adapter, backgroundA.submissionId), "queued");
			assert.equal(await statusOf(adapter, backgroundB.submissionId), "queued");

			const result = await adapter.abort({ kind: "conversation", conversationId: foreground.conversationId });
			// The return must not imply the queued background work will continue.
			assert.equal(typeof result, "object");
			assert.equal(result.result, "partial");
			assert.deepEqual(result.cancelled, [foreground.submissionId]);
			const stalled = result.stillRunning.filter((entry) => entry.state === "stalled").map((entry) => entry.submissionId).sort((a, b) => a - b);
			assert.deepEqual(stalled, [backgroundA.submissionId, backgroundB.submissionId].sort((a, b) => a - b));
			assert.ok(result.reason.includes("sdk-queue-not-advanced"));

			// observe() reports the exact state: foreground stopped, background honestly stalled.
			assert.equal(await statusOf(adapter, foreground.submissionId), "unanswered");
			assert.equal(await statusOf(adapter, backgroundA.submissionId), "stalled");
			assert.equal(await statusOf(adapter, backgroundB.submissionId), "stalled");
			assert.equal(faux.state.callCount, 1, "a stopped foreground must not spawn background generations");

			// No follow-up input arrives: the queued background never settles on its own.
			const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
			const timer = setTimeout(cancel, 150);
			let timedOut = false;
			try {
				await adapter.wait(backgroundA.submissionId, context);
			} catch {
				timedOut = true;
			} finally {
				clearTimeout(timer);
			}
			assert.equal(timedOut, true, "a stalled background never settles without a new boundary");
			assert.equal(faux.state.callCount, 1, "the stalled background does not start a generation");
		} finally {
			await adapter.close();
		}
	});
});

test("F001: a background already active keeps running when the foreground queues behind it", async () => {
	await withTempDir(async (dir) => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { faux, models } = makeModels([
			async () => {
				await gate;
				return fauxAssistantMessage("background answer");
			},
			fauxAssistantMessage("foreground answer"),
		]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const background = await adapter.submit(request({ ownerId: "owner-f001b", sourceRequestId: "bg", executionId: "exec-bg", ownership: { kind: "background", executionId: "exec-bg" } }));
			await waitForCall(faux, 1);
			const foreground = await adapter.submit(request({ ownerId: "owner-f001b", sourceRequestId: "fg", ownership: { kind: "foreground" } }));
			assert.equal(await statusOf(adapter, foreground.submissionId), "queued", "the foreground queues behind the active background run");

			const result = await adapter.abort({ kind: "conversation", conversationId: background.conversationId });
			assert.equal(result, "aborted", "the whole foreground scope was cancelled, so the historical result stands");
			assert.equal(await statusOf(adapter, foreground.submissionId), "unanswered");

			release();
			assert.equal((await adapter.wait(background.submissionId)).status, "done", "the active background is untouched");
		} finally {
			release();
			await adapter.close();
		}
	});
});

test("F001: cancellation then recover keeps the exact stalled state durably", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { faux, models } = slowModels([fauxAssistantMessage(LONG_ANSWER), fauxAssistantMessage("bg")]);
		let { adapter } = await openAdapter(file, models);
		let background;
		try {
			const foreground = await adapter.submit(request({ ownerId: "owner-f001r", sourceRequestId: "fg", ownership: { kind: "foreground" } }));
			await waitForCall(faux, 1);
			background = await adapter.submit(request({ ownerId: "owner-f001r", sourceRequestId: "bg", executionId: "exec-r", ownership: { kind: "background", executionId: "exec-r" } }));
			const result = await adapter.abort({ kind: "conversation", conversationId: foreground.conversationId });
			assert.equal(result.result, "partial");
			// The exact status is written into the durable mapping for recover to corroborate.
			assert.deepEqual(recordFor(await adapter.observe(), "bg").queueState, { state: "stalled", reason: "sdk-queue-not-advanced" });
		} finally {
			await adapter.close();
		}

		({ adapter } = await openAdapter(file, models));
		try {
			const recovery = await adapter.recover();
			assert.equal(recovery.recovered, true);
			assert.deepEqual(recovery.stalled.map((entry) => entry.submissionId), [background.submissionId], "recover reports the stranded submission, not a resumed one");
			assert.equal(await statusOf(adapter, background.submissionId), "stalled");
			assert.equal(faux.state.callCount, 1, "recover must not advance or restart the stalled background");
		} finally {
			await adapter.close();
		}
	});
});

test("F002: a placed foreground inside a mixed run is reported still-running, never aborted", async () => {
	await withTempDir(async (dir) => {
		let releaseSeed, releaseMixed;
		const seedGate = new Promise((resolve) => {
			releaseSeed = resolve;
		});
		const mixedGate = new Promise((resolve) => {
			releaseMixed = resolve;
		});
		const { faux, models } = makeModels([
			async () => {
				await seedGate;
				return fauxAssistantMessage("seed done");
			},
			async () => {
				await mixedGate;
				return fauxAssistantMessage("mixed done");
			},
		]);
		const { adapter } = await openAdapterWith(join(dir, "session.sqlite"), models, { followUpMode: "all" });
		try {
			const seed = await adapter.submit(request({ ownerId: "owner-f002", sourceRequestId: "seed", executionId: "exec-seed", ownership: { kind: "background", executionId: "exec-seed" } }));
			await waitForCall(faux, 1);
			const foreground = await adapter.submit(request({ ownerId: "owner-f002", sourceRequestId: "fg", ownership: { kind: "foreground" } }));
			const background = await adapter.submit(request({ ownerId: "owner-f002", sourceRequestId: "bg", executionId: "exec-bg", ownership: { kind: "background", executionId: "exec-bg" } }));
			releaseSeed();
			await adapter.wait(seed.submissionId);
			await waitForCall(faux, 2);
			assert.equal(await statusOf(adapter, foreground.submissionId), "placed", "followUpMode 'all' places foreground and background into one run");
			assert.equal(await statusOf(adapter, background.submissionId), "placed");

			const result = await adapter.abort({ kind: "conversation", conversationId: foreground.conversationId });
			assert.equal(typeof result, "object", "a mixed run must not return a bare 'aborted'");
			assert.equal(result.result, "unsupported");
			assert.deepEqual(result.cancelled, []);
			assert.equal(result.stillRunning.length, 1);
			assert.equal(result.stillRunning[0].submissionId, foreground.submissionId);
			assert.equal(result.stillRunning[0].state, "placed");
			assert.ok(result.reason.includes("mixed-run-not-cancellable"));
			// The return value matches each item's actual terminal state.
			assert.equal(await statusOf(adapter, foreground.submissionId), "placed", "the target is genuinely still placed");
			assert.equal(await statusOf(adapter, background.submissionId), "placed", "the non-target background is NOT swept");

			releaseMixed();
			assert.equal((await adapter.wait(background.submissionId)).status, "done", "the non-target background continues under its original authorization");
			assert.equal((await adapter.wait(foreground.submissionId)).status, "done");
		} finally {
			releaseSeed();
			releaseMixed();
			await adapter.close();
		}
	});
});

test("F002: two executions placed in one mixed run resist a single-execution stop", async () => {
	await withTempDir(async (dir) => {
		let releaseSeed, releaseMixed;
		const seedGate = new Promise((resolve) => {
			releaseSeed = resolve;
		});
		const mixedGate = new Promise((resolve) => {
			releaseMixed = resolve;
		});
		const { faux, models } = makeModels([
			async () => {
				await seedGate;
				return fauxAssistantMessage("seed done");
			},
			async () => {
				await mixedGate;
				return fauxAssistantMessage("mixed done");
			},
		]);
		const { adapter } = await openAdapterWith(join(dir, "session.sqlite"), models, { followUpMode: "all" });
		try {
			const seed = await adapter.submit(request({ ownerId: "owner-f002e", sourceRequestId: "seed", executionId: "exec-seed", ownership: { kind: "background", executionId: "exec-seed" } }));
			await waitForCall(faux, 1);
			const execA = await adapter.submit(request({ ownerId: "owner-f002e", sourceRequestId: "a", executionId: "exec-a", ownership: { kind: "background", executionId: "exec-a" } }));
			const execB = await adapter.submit(request({ ownerId: "owner-f002e", sourceRequestId: "b", executionId: "exec-b", ownership: { kind: "background", executionId: "exec-b" } }));
			releaseSeed();
			await adapter.wait(seed.submissionId);
			await waitForCall(faux, 2);
			assert.equal(await statusOf(adapter, execA.submissionId), "placed");
			assert.equal(await statusOf(adapter, execB.submissionId), "placed");

			const result = await adapter.abort({ kind: "execution", executionId: "exec-a" });
			assert.equal(typeof result, "object");
			assert.equal(result.cancelled.length, 0);
			assert.equal(result.stillRunning[0].submissionId, execA.submissionId);
			assert.ok(result.reason.includes("mixed-run-not-cancellable"));
			assert.equal(await statusOf(adapter, execA.submissionId), "placed");
			assert.equal(await statusOf(adapter, execB.submissionId), "placed", "the co-placed execution is not swept");

			releaseMixed();
			assert.equal((await adapter.wait(execB.submissionId)).status, "done", "the non-target execution continues");
			assert.equal((await adapter.wait(execA.submissionId)).status, "done");
		} finally {
			releaseSeed();
			releaseMixed();
			await adapter.close();
		}
	});
});

test("F002: a queued target is withdrawn exactly and a settled target reports aborted", async () => {
	await withTempDir(async (dir) => {
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const { faux, models } = makeModels([
			async () => {
				await gate;
				return fauxAssistantMessage("background answer");
			},
			fauxAssistantMessage("settled foreground"),
		]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			// "not placed": the target queues behind an active non-target run and is withdrawn.
			const background = await adapter.submit(request({ ownerId: "owner-f002q", sourceRequestId: "bg", executionId: "exec-bg", ownership: { kind: "background", executionId: "exec-bg" } }));
			await waitForCall(faux, 1);
			const queued = await adapter.submit(request({ ownerId: "owner-f002q", sourceRequestId: "q", ownership: { kind: "foreground" } }));
			assert.equal(await statusOf(adapter, queued.submissionId), "queued");
			const queuedResult = await adapter.abort({ kind: "conversation", conversationId: background.conversationId });
			assert.equal(queuedResult, "aborted", "a withdrawn queued target is fully cancelled");
			assert.equal(await statusOf(adapter, queued.submissionId), "unanswered");
			assert.equal(await statusOf(adapter, background.submissionId), "placed", "the active non-target run is untouched");
			release();
			assert.equal((await adapter.wait(background.submissionId)).status, "done");

			// "already done": nothing is running, so the result stays the historical "aborted".
			const done = await adapter.submit(request({ ownerId: "owner-f002d", sourceRequestId: "d", ownership: { kind: "foreground" } }));
			assert.equal((await adapter.wait(done.submissionId)).status, "done");
			assert.equal(await adapter.abort({ kind: "submission", submissionId: done.submissionId }), "settled");
			assert.equal(await adapter.abort({ kind: "conversation", conversationId: done.conversationId }), "aborted");
		} finally {
			release();
			await adapter.close();
		}
	});
});

test("F003: a background request with no resolvable execution binding is refused before any effect", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const missing = { ownerId: "owner-f003m", sourceRequestId: "m1", content: "c", productTaskId: "p", profileId: "p", authorizationDigest: "a", ownership: { kind: "background" } };
			await assert.rejects(() => adapter.submit(missing), (error) => error?.code === "missing-execution-binding");
			await assert.rejects(
				() => adapter.submit({ ...missing, sourceRequestId: "m2", ownership: { kind: "background", goalId: "goal-only" } }),
				(error) => error?.code === "missing-execution-binding",
			);
			const observed = await adapter.observe();
			assert.equal(observed.requests.length, 0, "a refused background leaves no request record");
			assert.equal(observed.owners.length, 0, "a refused background creates no owner/conversation");
			assert.equal(await adapter.inspect().then((i) => i.tasks), 0, "no task is started for a refused background");
		} finally {
			await adapter.close();
		}
	});
});

test("F003: a nested executionId contradicting the top-level id is refused", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			await assert.rejects(
				() => adapter.submit(request({ executionId: "top-level", ownership: { kind: "background", executionId: "nested-other" } })),
				(error) => error?.code === "ownership-execution-conflict",
			);
			assert.equal((await adapter.observe()).requests.length, 0);
		} finally {
			await adapter.close();
		}
	});
});

test("F003: a background without a nested executionId is normalized to the top-level id and is cancellable", async () => {
	await withTempDir(async (dir) => {
		// A streaming generation so the run-task abort is honoured promptly.
		const { faux, models } = slowModels([fauxAssistantMessage(LONG_ANSWER)]);
		const { adapter } = await openAdapter(join(dir, "session.sqlite"), models);
		try {
			const accepted = await adapter.submit(request({ ownerId: "owner-f003d", sourceRequestId: "derived", executionId: "exec-derived", ownership: { kind: "background" } }));
			await waitForCall(faux, 1);
			assert.deepEqual(recordFor(await adapter.observe(), "derived").ownership, { kind: "background", executionId: "exec-derived", executionIdSource: "top-level" });
			assert.equal(await adapter.abort({ kind: "execution", executionId: "exec-derived" }), "aborted", "the derived binding is found by an execution-scope cancel");
			assert.equal(await statusOf(adapter, accepted.submissionId), "unanswered");
		} finally {
			await adapter.close();
		}
	});
});

test("F003: legacy records without ownership stay foreground and are unaffected", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "session.sqlite");
		const { models } = makeModels([fauxAssistantMessage("answer")]);
		const { adapter } = await openAdapter(file, models);
		try {
			const accepted = await adapter.submit(request());
			await adapter.wait(accepted.submissionId);
		} finally {
			await adapter.close();
		}

		// Strip the ownership field to simulate a mapping written before it existed.
		const owned = await openOwnedSqliteStorage(file);
		const fixture = await Harness.open(owned.storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
		await fixture.commit(async (tx) => {
			const doc = await tx.doc(AdmissionDoc);
			for (const record of Object.values(doc.requests)) delete record.ownership;
		}, BACKGROUND_CONTEXT);
		await fixture.close(BACKGROUND_CONTEXT);
		await owned.close();

		const { adapter: reopened } = await openAdapter(file, models);
		try {
			const mapping = await reopened.observe();
			assert.equal(recordFor(mapping, "req-1").ownership, undefined, "the stored document keeps its legacy shape");
			// Not treated as a background that needs an execution binding.
			assert.equal(await reopened.abort({ kind: "conversation", conversationId: mapping.requests[0].conversationId }), "aborted");
		} finally {
			await reopened.close();
		}
	});
});

// ---------------------------------------------------------------------------
// M02 budget admission wiring (V31). The adapter takes an injected budget port;
// submit() fails closed without one and charges exactly one CALL per NEW
// admission. A budget refusal must leave zero admission side effects (no
// conversation, no mapping row, no SDK call), and a charge that throws inside
// the admission is never reported as success.
// ---------------------------------------------------------------------------

/** A fixed, advanceable epoch-ms clock for the injected budget policy. */
function budgetClock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms) => { t += ms; }, set: (value) => { t = value; } };
}

/** Open an adapter whose budget port / escape hatch is chosen by the caller. */
async function openBudgeted(file, models, options = {}) {
	const owned = await openOwnedSqliteStorage(file);
	const adapter = await PiRuntimeAdapter.open(owned, {
		models,
		modelRef: MODEL_REF,
		...(options.budgetPolicy === undefined ? {} : { budgetPolicy: options.budgetPolicy }),
		...(options.allowUnbudgeted === undefined ? {} : { allowUnbudgeted: options.allowUnbudgeted }),
	});
	return { adapter, owned };
}

/** Assert nothing was admitted: no owner/request row, no task and no model call. */
async function assertNoAdmissionEffects(adapter, faux) {
	const observed = await adapter.observe();
	assert.equal(observed.requests.length, 0, "a refused admission writes no request row");
	assert.equal(observed.owners.length, 0, "a refused admission creates no owner/conversation");
	assert.equal((await adapter.inspect()).tasks, 0, "a refused admission starts no task");
	assert.equal(faux.state.callCount, 0, "a refused admission never calls the model");
}

test("budget: submit without a budgetPolicy and without allowUnbudgeted is refused", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models);
		try {
			await assert.rejects(() => adapter.submit(request()), (error) => error?.code === "budget-unconfigured");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: the explicit allowUnbudgeted escape admits without a policy", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("answer")]);
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { allowUnbudgeted: true });
		try {
			const accepted = await adapter.submit(request());
			assert.equal(accepted.reused, false);
			assert.equal((await adapter.wait(accepted.submissionId)).status, "done");
			assert.equal(faux.state.callCount, 1, "the unbudgeted escape still performs the real submission");
		} finally {
			await adapter.close();
		}
	});
});

test("budget: the scope derivation prefers the execution id, falls back to the task, else none", () => {
	assert.equal(budgetScopeFor({ executionId: "exec-1", productTaskId: "task-1" }), "exec:exec-1");
	assert.equal(budgetScopeFor({ productTaskId: "task-1" }), "task:task-1");
	assert.equal(budgetScopeFor({}), undefined);
	assert.equal(budgetScopeFor(undefined), undefined);
	// Under the current validateRequest contract BOTH references are mandatory, so
	// a request that reaches admission always resolves an `exec:` scope and the
	// `budget-scope-missing` branch stays defense-in-depth (see the schema test below).
});

test("budget: a malformed budget port or a non-boolean escape is refused at construction", async () => {
	await withTempDir(async (dir) => {
		const { models } = makeModels([fauxAssistantMessage("unused")]);
		const badPolicies = [{}, { assertActive() {} }, { charge() {} }, "policy", 5];
		for (const [index, budgetPolicy] of badPolicies.entries()) {
			const owned = await openOwnedSqliteStorage(join(dir, `bad-policy-${index}.sqlite`));
			try {
				await assert.rejects(
					() => PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, budgetPolicy }),
					(error) => error?.code === "invalid-budget-policy",
					`budgetPolicy ${JSON.stringify(budgetPolicy)} must be refused`,
				);
			} finally {
				await owned.close();
			}
		}
		const owned = await openOwnedSqliteStorage(join(dir, "bad-allow.sqlite"));
		try {
			await assert.rejects(
				() => PiRuntimeAdapter.open(owned, { models, modelRef: MODEL_REF, allowUnbudgeted: "yes" }),
				(error) => error?.code === "invalid-allow-unbudgeted",
			);
		} finally {
			await owned.close();
		}
	});
});

test("budget: a scope with no grant is refused with unknown-budget and zero effects", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:other-execution", maxTokens: 100, maxDurationMs: 60_000 });
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(() => adapter.submit(request({ executionId: "exec-1" })), (error) => error?.code === "unknown-budget");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: an expired scope is refused with budget-expired and zero effects", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		const clock = budgetClock(1000);
		const policy = createBudgetPolicy({ now: clock.now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 100, maxDurationMs: 5000 }); // expiresAt 6000
		clock.set(6000);
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(() => adapter.submit(request()), (error) => error?.code === "budget-expired");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: an exhausted scope is refused with budget-exhausted and zero effects", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 100, maxDurationMs: 60_000, maxCalls: 1 });
		policy.charge("exec:exec-1", { calls: 1 }); // the call cap is now full
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(() => adapter.submit(request()), (error) => error?.code === "budget-exhausted");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a settled scope is refused with budget-settled and zero effects", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 100, maxDurationMs: 60_000 });
		policy.settle("exec:exec-1");
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(() => adapter.submit(request()), (error) => error?.code === "budget-settled");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a faulty clock is refused with clock-invalid and zero effects", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		let mode = { kind: "value", value: 1000 };
		const policy = createBudgetPolicy({ now: () => {
			if (mode.kind === "throw") throw new Error("synthetic clock failure");
			return mode.value;
		} });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 100, maxDurationMs: 5000 });
		mode = { kind: "value", value: NaN }; // the clock breaks AFTER a valid grant
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(() => adapter.submit(request()), (error) => error?.code === "clock-invalid");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a valid grant admits the request and charges exactly one call", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("answer")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 1000, maxDurationMs: 60_000, maxCalls: 5 });
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			const accepted = await adapter.submit(request());
			assert.equal(accepted.reused, false);
			assert.equal(policy.remaining("exec:exec-1").remainingCalls, 4, "exactly one admission call is charged");
			assert.equal(policy.toJSON().grants[0].chargedCalls, 1, "the durable scope shows a single call");
			assert.equal(policy.toJSON().grants[0].chargedTokens, 0, "no token dimension is charged on the admission path");
			assert.equal((await adapter.wait(accepted.submissionId)).status, "done");
			assert.equal(faux.state.callCount, 1);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a same-request replay reuses the admission and is not charged again", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("answer")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 1000, maxDurationMs: 60_000, maxCalls: 5 });
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			const first = await adapter.submit(request());
			await adapter.wait(first.submissionId);
			const second = await adapter.submit(request());
			assert.equal(second.reused, true);
			assert.equal(second.submissionId, first.submissionId);
			assert.equal(policy.toJSON().grants[0].chargedCalls, 1, "an idempotent replay is not a second admission");
			assert.equal(faux.state.callCount, 1, "a replayed request never reaches the model twice");
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a request conflict is rejected without charging the scope", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("answer")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 1000, maxDurationMs: 60_000, maxCalls: 5 });
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			const accepted = await adapter.submit(request());
			await adapter.wait(accepted.submissionId);
			await assert.rejects(() => adapter.submit(request({ content: "different body" })), (error) => error?.code === "request-conflict");
			assert.equal(policy.toJSON().grants[0].chargedCalls, 1, "a conflict charges nothing");
			assert.equal(faux.state.callCount, 1, "a conflicting request never reaches the model");
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a charge that throws inside the admission is never reported as success", async () => {
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		// A port whose read-only precondition passes but whose charge fails models a
		// race between assertActive and the mapping landing; the failed charge must
		// roll the admission back, not report a false success.
		const policy = {
			assertActive: () => ({ remainingTokens: 1, remainingCalls: 1, remainingMs: 1000 }),
			charge: () => { throw new BudgetError("budget-exhausted", "synthetic charge failure"); },
		};
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(() => adapter.submit(request()), (error) => error?.code === "budget-exhausted");
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});

test("budget: a request missing a scope reference is refused before admission (schema is stricter)", async () => {
	// validateRequest makes BOTH executionId and productTaskId mandatory, so a
	// scope-less request never reaches the budget guard: it fails closed earlier
	// with invalid-request-field and zero effects. `budget-scope-missing` therefore
	// stays defense-in-depth; its derivation is pinned by the scope test above.
	await withTempDir(async (dir) => {
		const { faux, models } = makeModels([fauxAssistantMessage("unused")]);
		const policy = createBudgetPolicy({ now: budgetClock().now });
		policy.grant({ scopeKey: "exec:exec-1", maxTokens: 100, maxDurationMs: 60_000 });
		const { adapter } = await openBudgeted(join(dir, "session.sqlite"), models, { budgetPolicy: policy });
		try {
			await assert.rejects(
				() => adapter.submit({ ...request(), executionId: undefined }),
				(error) => error?.code === "invalid-request-field",
			);
			await assertNoAdmissionEffects(adapter, faux);
		} finally {
			await adapter.close();
		}
	});
});
