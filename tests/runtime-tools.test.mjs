import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { ControlPlaneStore } from '../control-plane/store.mjs';
import { openOwnedSqliteStorage } from '../runtime/owner-sqlite.mjs';
import { AdmissionDoc, PiRuntimeAdapter } from '../runtime/pi-adapter.mjs';
import { createChiefToolSuite, getChiefToolSuiteDescriptor } from '../runtime/chief-tools.mjs';
import { runToolsCanary, main as toolsCanaryMain } from '../scripts/runtime-tools-canary.mjs';

const MODEL = { provider: 'faux', modelId: 'faux-1' };
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-chief-tools-')); let adapter, owned;
  t.after(async () => { await adapter?.close(); await owned?.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const store = new ControlPlaneStore({ stateDir: path.join(dir, 'product') });
  const created = await store.createTask({ goal: 'synthetic current task', acceptanceCriteria: ['real tests', 'independent review'] }, { idempotencyKey: 'task' });
  const execution = await store.createExecution(created.task.id, { workerId: 'chief' }, { idempotencyKey: 'chief' });
  const binding = { ownerId: 'synthetic-owner', productTaskId: created.task.id, executionId: execution.execution.id, profileId: 'synthetic-profile', cwd: dir, authorizationDigest: 'reference-not-approval' };
  const suite = createChiefToolSuite({ store, binding, workerIds: ['codex', 'opencode'] });
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const file = path.join(dir, 'runtime.sqlite');
  const open = async (extra = {}) => {
    owned = await openOwnedSqliteStorage(file);
    try { adapter = await PiRuntimeAdapter.open(owned, { models, modelRef: MODEL, toolSuite: suite, allowUnbudgeted: true, ...extra }); return adapter; }
    catch (error) { await owned.close(); throw error; }
  };
  const request = { ...binding, sourceRequestId: 'request-1', content: 'synthetic planning only' };
  return { store, binding, suite, faux, models, file, open, request, current: () => ({ adapter, owned }) };
}

const TRUSTED_API = { taskId: 123, callId: 'synthetic-call' };
const trustedContext = () => ({ abortSignal: new AbortController().signal });
function requireTool(suite, name) {
  const row = suite.snapshot().tools().find(entry => entry.tool.name === name);
  assert.ok(row, `tool ${name} is not registered`);
  return row.tool;
}
function assertScopeRejected(result) {
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, []);
  assert.equal(result.diagnostics?.[0]?.code, 'aios_scope_rejected');
}

test('actual Pi tool round reads bound task, creates a queued child and plans without dispatch', async t => {
  const ctx = await setup(t); let childId;
  ctx.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('aios_get_current_task', {}, { id: 'query' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('aios_create_worker_execution', { workerId: 'codex' }, { id: 'create' }), { stopReason: 'toolUse' }),
    async () => {
      const aggregate = await ctx.store.getTask(ctx.binding.productTaskId);
      childId = aggregate.executions.find(exec => exec.parentExecutionId === ctx.binding.executionId)?.id;
      assert.ok(childId);
      return fauxAssistantMessage(fauxToolCall('aios_plan_native_prompt', { executionId: childId, source: 'codex', nativeSessionId: 'synthetic-native', cwd: ctx.binding.cwd, prompt: 'synthetic plan' }, { id: 'plan' }), { stopReason: 'toolUse' });
    }, fauxAssistantMessage('Planning ready, no worker started.'),
  ]);
  let adapter = await ctx.open();
  const submitted = await adapter.submit(ctx.request); const settled = await adapter.wait(submitted.submissionId);
  assert.equal(settled.status, 'done'); assert.equal(ctx.faux.state.callCount, 4);
  const { owned } = ctx.current();
  const transcript = (await owned.storage.scanEntries({ conversationId: submitted.conversationId }, 50, undefined, BACKGROUND_CONTEXT)).items;
  const toolMessages = transcript.filter(entry => entry.kind === 'pi.tool-result').flatMap(entry => entry.model ?? []).map(message => JSON.stringify(message));
  assert.equal(toolMessages.length, 3);
  assert.ok(toolMessages.some(text => text.includes('synthetic current task')));
  assert.ok(toolMessages.some(text => text.includes('requiresApproval')));
  const aggregate = await ctx.store.getTask(ctx.binding.productTaskId);
  assert.notEqual(aggregate.task.status, 'completed'); assert.equal(aggregate.evidence.length, 0);
  assert.equal(aggregate.executions.find(exec => exec.id === childId).status, 'queued');
  assert.equal(aggregate.executions.find(exec => exec.id === childId).engineRef, undefined);
  const duplicate = await adapter.submit(ctx.request); await adapter.wait(duplicate.submissionId);
  assert.equal(duplicate.submissionId, submitted.submissionId); assert.equal(ctx.faux.state.callCount, 4);
  await adapter.close(); adapter = await ctx.open();
  const reopened = await adapter.submit(ctx.request); await adapter.wait(reopened.submissionId);
  assert.equal(reopened.submissionId, submitted.submissionId); assert.equal(ctx.faux.state.callCount, 4);
  assert.equal((await ctx.store.getTask(ctx.binding.productTaskId)).executions.length, 2);
});

test('scope drift fails before any model/tool call', async t => {
  const ctx = await setup(t); const adapter = await ctx.open();
  for (const field of ['ownerId', 'productTaskId', 'executionId', 'profileId', 'cwd', 'authorizationDigest']) {
    await assert.rejects(() => adapter.submit({ ...ctx.request, [field]: 'changed' }), error => error.code === 'tool-scope-mismatch');
  }
  assert.equal(ctx.faux.state.callCount, 0); assert.equal((await ctx.store.getTask(ctx.binding.productTaskId)).executions.length, 1);
});

test('forged suites and suites combined with raw registries are rejected', async t => {
  const ctx = await setup(t);
  await assert.rejects(() => ctx.open({ toolSuite: { snapshot: () => ctx.suite.snapshot(), subscribe: () => () => {} } }), error => error.code === 'unsafe-registry');
  await assert.rejects(() => ctx.open({ registry: ctx.suite }), error => error.code === 'unsafe-registry');
  assert.equal(getChiefToolSuiteDescriptor({ ...ctx.suite }), undefined);
});

test('stored tools cannot silently disappear or change on reopen', async t => {
  const ctx = await setup(t); ctx.faux.setResponses([fauxAssistantMessage('synthetic')]);
  const adapter = await ctx.open(); const submitted = await adapter.submit(ctx.request); await adapter.wait(submitted.submissionId); await adapter.close();
  await assert.rejects(() => ctx.open({ toolSuite: undefined }), error => error.code === 'tool-profile-mismatch');
  const drift = createChiefToolSuite({ store: ctx.store, binding: ctx.binding, workerIds: ['codex'] });
  await assert.rejects(() => ctx.open({ toolSuite: drift }), error => error.code === 'tool-profile-mismatch');
  assert.equal(ctx.faux.state.callCount, 1);
});

test('unapproved worker and hidden scope arguments cannot create product rows', async t => {
  const ctx = await setup(t); ctx.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('aios_create_worker_execution', { workerId: 'unapproved' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('aios_create_worker_execution', { workerId: 'codex', taskId: 'foreign', status: 'succeeded' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Rejected.'),
  ]);
  const adapter = await ctx.open(); const accepted = await adapter.submit(ctx.request); await adapter.wait(accepted.submissionId);
  assert.equal((await ctx.store.getTask(ctx.binding.productTaskId)).executions.length, 1);
  assert.equal((await ctx.store.snapshot()).evidenceCount, 0);
  assert.ok(!getChiefToolSuiteDescriptor(ctx.suite).toolNames.some(name => /approve|evidence|complete|dispatch|bash|file/.test(name)));
});

test('same trusted call replays one child while changed args conflict without a row', async t => {
  const ctx = await setup(t); const create = requireTool(ctx.suite, 'aios_create_worker_execution');
  const first = await create.execute({ workerId: 'codex' }, TRUSTED_API, trustedContext());
  const firstBody = JSON.parse(first.content[0].text);
  assert.equal(firstBody.status, 'queued'); assert.equal(firstBody.replay, false); assert.equal(firstBody.dispatched, false);
  const replay = await create.execute({ workerId: 'codex' }, TRUSTED_API, trustedContext());
  const replayBody = JSON.parse(replay.content[0].text);
  assert.equal(replayBody.replay, true); assert.equal(replayBody.executionId, firstBody.executionId);
  assert.equal((await ctx.store.getTask(ctx.binding.productTaskId)).executions.length, 2);
  const conflict = await create.execute({ workerId: 'opencode' }, TRUSTED_API, trustedContext());
  assertScopeRejected(conflict);
  const aggregate = await ctx.store.getTask(ctx.binding.productTaskId);
  assert.equal(aggregate.executions.length, 2);
  assert.equal(aggregate.executions.filter(exec => exec.parentExecutionId === ctx.binding.executionId).length, 1);
  assert.equal((await ctx.store.snapshot()).evidenceCount, 0);
});

test('task-scoped descriptors and returned tools cannot be mutated or gain install/uninstall', async t => {
  const ctx = await setup(t); const descriptor = getChiefToolSuiteDescriptor(ctx.suite);
  assert.ok(descriptor); assert.ok(Object.isFrozen(ctx.suite));
  assert.equal(typeof ctx.suite.install, 'undefined'); assert.equal(typeof ctx.suite.uninstall, 'undefined');
  const snapshot = ctx.suite.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(typeof snapshot.install, 'undefined'); assert.equal(typeof snapshot.uninstall, 'undefined');
  const rows = snapshot.tools();
  assert.ok(Object.isFrozen(rows));
  assert.ok(rows.every(row => Object.isFrozen(row) && Object.isFrozen(row.tool)));
  assert.throws(() => { rows[0].tool.name = 'aios_install'; }, TypeError);
  assert.throws(() => { ctx.suite.install = () => {}; }, TypeError);
  assert.throws(() => { snapshot.tools = () => []; }, TypeError);
  descriptor.toolNames.push('aios_install'); descriptor.digest = 'tampered';
  const fresh = getChiefToolSuiteDescriptor(ctx.suite);
  assert.deepEqual(fresh.toolNames, ['aios_get_current_task', 'aios_create_worker_execution', 'aios_plan_native_prompt']);
  assert.notEqual(fresh.digest, 'tampered');
});

test('planning a foreign or parent execution is denied and creates no approvals, dispatch or evidence', async t => {
  const ctx = await setup(t); const create = requireTool(ctx.suite, 'aios_create_worker_execution'); const plan = requireTool(ctx.suite, 'aios_plan_native_prompt');
  const created = await create.execute({ workerId: 'codex' }, TRUSTED_API, trustedContext());
  const childId = JSON.parse(created.content[0].text).executionId;
  const valid = await plan.execute({ executionId: childId, source: 'codex', nativeSessionId: 'synthetic-native', cwd: ctx.binding.cwd, prompt: 'synthetic plan' }, TRUSTED_API, trustedContext());
  const validBody = JSON.parse(valid.content[0].text);
  assert.equal(validBody.requiresApproval, true); assert.equal(validBody.dispatched, false); assert.equal(validBody.nativeIdentityVerified, false);
  const foreign = await ctx.store.createTask({ goal: 'synthetic foreign task', acceptanceCriteria: ['synthetic'] }, { idempotencyKey: 'foreign-task' });
  const foreignExec = await ctx.store.createExecution(foreign.task.id, { workerId: 'codex' }, { idempotencyKey: 'foreign-exec' });
  const foreignDenied = await plan.execute({ executionId: foreignExec.execution.id, source: 'codex', nativeSessionId: 'foreign-native', cwd: ctx.binding.cwd, prompt: 'foreign plan' }, TRUSTED_API, trustedContext());
  assertScopeRejected(foreignDenied);
  const parentDenied = await plan.execute({ executionId: ctx.binding.executionId, source: 'codex', nativeSessionId: 'parent-native', cwd: ctx.binding.cwd, prompt: 'parent plan' }, TRUSTED_API, trustedContext());
  assertScopeRejected(parentDenied);
  assert.equal((await ctx.store.listApprovals()).length, 0);
  assert.equal((await ctx.store.snapshot()).evidenceCount, 0);
  const aggregate = await ctx.store.getTask(ctx.binding.productTaskId);
  assert.equal(aggregate.executions.length, 2);
  assert.ok(aggregate.executions.every(exec => exec.engineRef === undefined));
  assert.equal(aggregate.evidence.length, 0);
});

test('an already cancelled parent denies child creation', async t => {
  const ctx = await setup(t);
  await ctx.store.updateExecutionStatus(ctx.binding.executionId, { status: 'cancelled' }, { idempotencyKey: 'cancel-parent' });
  const denied = await requireTool(ctx.suite, 'aios_create_worker_execution').execute({ workerId: 'codex' }, TRUSTED_API, trustedContext());
  assertScopeRejected(denied);
  const aggregate = await ctx.store.getTask(ctx.binding.productTaskId);
  assert.equal(aggregate.executions.length, 1); assert.equal(aggregate.executions[0].status, 'cancelled');
});

test('cancellation after the scope read is fenced atomically by product creation', async t => {
  const ctx = await setup(t);
  const suite = createChiefToolSuite({ binding: ctx.binding, workerIds: ['codex'], store: {
    getTask: id => ctx.store.getTask(id),
    async createExecution(...args) {
      await ctx.store.updateExecutionStatus(ctx.binding.executionId, { status: 'cancelled' }, { idempotencyKey: 'cancel-between-read-and-write' });
      return ctx.store.createExecution(...args);
    },
  } });
  const denied = await requireTool(suite, 'aios_create_worker_execution').execute({ workerId: 'codex' }, TRUSTED_API, trustedContext());
  assertScopeRejected(denied);
  const state = await ctx.store.read();
  assert.equal(Object.keys(state.executions).length, 1);
  assert.equal(state.events.filter(event => event.type === 'execution.created').length, 1);
  assert.ok(!Object.keys(state.idempotency).some(key => key.startsWith('pi-chief:')));
});

test('an existing no-tools conversation cannot acquire a tool suite on reopen', async t => {
  const ctx = await setup(t); ctx.faux.setResponses([fauxAssistantMessage('synthetic')]);
  const adapter = await ctx.open({ toolSuite: undefined }); const submitted = await adapter.submit(ctx.request);
  await adapter.wait(submitted.submissionId); await adapter.close();
  await assert.rejects(() => ctx.open(), error => error.code === 'tool-profile-mismatch');
  assert.equal(ctx.faux.state.callCount, 1);
});

test('unknown stored tool profiles and request scope drift fail before scheduling', async t => {
  for (const variant of ['unknown-profile', 'request-scope']) await t.test(variant, async sub => {
    const ctx = await setup(sub); ctx.faux.setResponses([fauxAssistantMessage('synthetic')]);
    const adapter = await ctx.open(); const submitted = await adapter.submit(ctx.request);
    await adapter.wait(submitted.submissionId); await adapter.close();
    const owned = await openOwnedSqliteStorage(ctx.file);
    const fixture = await Harness.open(owned.storage, { models: ctx.models, registry: ctx.suite }, BACKGROUND_CONTEXT);
    try {
      await fixture.commit(async tx => {
        const doc = await tx.doc(AdmissionDoc);
        if (variant === 'unknown-profile') Object.values(doc.owners)[0].toolProfile.version = 2;
        else doc.requests[submitted.requestKey].executionId = 'foreign-parent';
      }, BACKGROUND_CONTEXT);
    } finally { await fixture.close(BACKGROUND_CONTEXT); await owned.close(); }
    await assert.rejects(() => ctx.open(), error => error.code === (variant === 'unknown-profile' ? 'unknown-tool-profile' : 'tool-scope-mismatch'));
    assert.equal(ctx.faux.state.callCount, 1);
  });
});

test('read-only suites expose only the bound query and cannot widen on reopen', async t => {
  const ctx = await setup(t);
  const readOnly = createChiefToolSuite({ store: ctx.store, binding: ctx.binding, workerIds: ['codex', 'opencode'], readOnly: true });
  assert.deepEqual(getChiefToolSuiteDescriptor(readOnly).toolNames, ['aios_get_current_task']);
  assert.deepEqual(readOnly.snapshot().tools().map(row => row.tool.name), ['aios_get_current_task']);
  assert.throws(() => createChiefToolSuite({ store: ctx.store, binding: ctx.binding, workerIds: ['codex'], readOnly: 'yes' }));
  ctx.faux.setResponses([fauxAssistantMessage('synthetic')]);
  const adapter = await ctx.open({ toolSuite: readOnly }); const submitted = await adapter.submit(ctx.request);
  await adapter.wait(submitted.submissionId); await adapter.close();
  await assert.rejects(() => ctx.open(), error => error.code === 'tool-profile-mismatch');
  assert.equal(ctx.faux.state.callCount, 1);
});

test('query-tool canary saves actual results, reopens without inference and never mutates product state', async () => {
  const report = await runToolsCanary();
  assert.equal(report.ok, true); assert.equal(report.mode, 'fake');
  assert.equal(report.savedQueryResults, 1); assert.equal(report.querySawBoundGoal, true);
  assert.equal(report.unchangedProductState, true); assert.equal(report.counters.modelCalls, 2);
  assert.equal(report.duplicateExtraCalls, 0); assert.equal(report.reopenExtraCalls, 0);
  assert.equal(report.scope.networkAttempted, false); assert.equal(report.scope.workerDispatches, 0);
  assert.deepEqual(report.scope.tools, ['aios_get_current_task']);
});

test('unknown tool-canary flags never launch a model, including when combined with --live', async () => {
  assert.equal(await toolsCanaryMain(['--bogus']), 2);
  assert.equal(await toolsCanaryMain(['--live', '--bogus']), 2);
  assert.equal(await toolsCanaryMain(['--isolated-shim']), 2);
});

test('Kimi-compatible HTTP payload and tool results are tested with synthetic SSE and zero network', async t => {
  const payloads = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const body = input instanceof Request ? await input.text() : init.body;
    const payload = JSON.parse(body); payloads.push(payload);
    assert.equal(payload.tools.length, 1);
    assert.equal(payload.tools[0].function.name, 'aios_get_current_task');
    assert.equal(payload.tools[0].function.strict, undefined);
    assert.equal(payload.max_tokens, 96); assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.equal(payload.tool_choice, payloads.length === 1 ? 'auto' : 'none');
    const first = payloads.length === 1;
    if (!first) assert.ok(payload.messages.some(message => message.role === 'tool' && message.content.includes('SYNTHETIC_TOOL_CANARY_GOAL')));
    const frame = { id: 'synthetic', object: 'chat.completion.chunk', model: 'kimi-k3', created: 1,
      choices: [{ index: 0, delta: first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'query-once', type: 'function', function: { name: 'aios_get_current_task', arguments: '{}' } }] } : { role: 'assistant', content: 'TOOL_CANARY_OK' }, finish_reason: null }] };
    const ending = { ...frame, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: ${JSON.stringify(ending)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const report = await runToolsCanary({ live: true });
  assert.equal(report.ok, true); assert.equal(payloads.length, 2);
  assert.equal(report.counters.transportHttpStatus, 200); assert.equal(report.counters.queryToolMatches, true);
  assert.equal(report.querySawBoundGoal, true); assert.equal(report.unchangedProductState, true);
});

test('non-2xx Kimi errors keep only numeric diagnostics and are not retried or resubmitted', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return new Response('{"error":{"message":"SYNTHETIC_SECRET_NOT_FOR_LOGS"}}', { status: 502, headers: { 'content-type': 'application/json', 'x-kimi-upstream-status': '400' } });
  });
  const report = await runToolsCanary({ live: true });
  assert.equal(report.ok, false); assert.equal(report.status, 'unanswered'); assert.equal(requests, 1);
  assert.equal(report.counters.transportHttpStatus, 502); assert.equal(report.counters.upstreamHttpStatus, 400);
  assert.equal(report.unchangedProductState, true); assert.equal(report.duplicateExtraCalls, 0); assert.equal(report.reopenExtraCalls, 0);
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET_NOT_FOR_LOGS'));
});
