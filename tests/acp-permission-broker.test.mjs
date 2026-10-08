import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneStore } from '../control-plane/store.mjs';
import { acpPermissionPlan, createAcpPermissionBroker } from '../control-plane/acp-permission-broker.mjs';
import { WeChatAcpClient } from '../vendor/wechat-acp/dist/src/acp/client.js';

const OPERATOR = { id: 'operator-synthetic', role: 'operator', authenticated: true };
const request = () => ({ sessionId: 'native-synthetic', toolCall: { toolCallId: 'call-1', kind: 'read', title: 'synthetic read', rawInput: { path: 'example.txt' } },
  options: [{ kind: 'allow_once', optionId: 'once', name: 'once' }, { kind: 'allow_always', optionId: 'always', name: 'always' }] });

function client(extra = {}) {
  return new WeChatAcpClient({ sendTyping: async () => {}, onThoughtFlush: async () => {}, onMessageFlush: async () => {}, log: () => {}, showThoughts: false, ...extra });
}

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-acp-permission-'));
  try {
    const store = new ControlPlaneStore({ stateDir: path.join(dir, 'state') });
    const task = await store.createTask({ goal: 'synthetic scope' }, { idempotencyKey: 'task' });
    const exec = await store.createExecution(task.task.id, { workerId: 'synthetic-worker' }, { idempotencyKey: 'execution' });
    const binding = { ownerId: 'owner-synthetic', source: 'codex', accountId: 'account-synthetic', profileId: 'profile-synthetic', nativeSessionId: 'native-synthetic', cwd: dir, taskId: task.task.id, executionId: exec.execution.id };
    await store.attachExecutionRef(exec.execution.id, { engine: 'native-acp', id: 'native-synthetic', ...binding }, { idempotencyKey: 'bind' });
    await store.updateExecutionStatus(exec.execution.id, { status: 'running' }, { idempotencyKey: 'running' });
    let counter = 0;
    const approval = async (params, { authenticated = true, expiresAt = new Date(Date.now() + 60000).toISOString(), alter = {} } = {}) => {
      const plan = acpPermissionPlan(binding, params);
      const created = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest, ...(expiresAt ? { expiresAt } : {}), ...alter }, { idempotencyKey: `approval-${++counter}` });
      await store.decideApproval(created.approval.id, { decision: 'approved', approvedBy: OPERATOR.id }, { idempotencyKey: `decision-${counter}`, ...(authenticated ? { principal: OPERATOR } : {}) });
      return created.approval.id;
    };
    await run({ store, binding, approval });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('ACP defaults to cancelled and no filesystem capability, never first-option allow', async () => {
  const target = client();
  assert.deepEqual(await target.requestPermission(request()), { outcome: { outcome: 'cancelled' } });
  assert.equal(target.hasUsedTools, true);
  assert.deepEqual(target.filesystemCapabilities, { readTextFile: false, writeTextFile: false });
  await assert.rejects(() => target.readTextFile({ sessionId: 'native-synthetic', path: '/synthetic/private' }), /broker required/);
  await assert.rejects(() => target.writeTextFile({ sessionId: 'native-synthetic', path: '/synthetic/private', content: 'never-write' }), /broker required/);
});

test('real authenticated approval + execution binding permits exactly one allow_once response', async () => {
  await fixture(async ({ store, binding, approval }) => {
    const params = request(), id = await approval(params);
    const broker = createAcpPermissionBroker({ store, binding, findApprovalId: async () => id });
    const target = client({ permissionBroker: broker });
    assert.deepEqual(await target.requestPermission(params), { outcome: { outcome: 'selected', optionId: 'once' } });
    assert.ok((await store.getApproval(id)).usedAt);
    assert.deepEqual(await target.requestPermission(params), { outcome: { outcome: 'cancelled' } });
  });
});

test('missing, legacy-unverified, expired, deadline-free and wrong-digest approvals deny', async () => {
  for (const mode of ['missing', 'legacy', 'expired', 'no-deadline', 'wrong-digest']) await fixture(async ({ store, binding, approval }) => {
    const params = request();
    const id = mode === 'missing' ? undefined : await approval(params, { authenticated: mode !== 'legacy',
      expiresAt: mode === 'expired' ? new Date(Date.now() - 1000).toISOString() : mode === 'no-deadline' ? '' : new Date(Date.now() + 60000).toISOString(),
      alter: mode === 'wrong-digest' ? { parametersDigest: 'sha256:different' } : {} });
    const target = client({ permissionBroker: createAcpPermissionBroker({ store, binding, findApprovalId: async () => id }) });
    assert.deepEqual(await target.requestPermission(params), { outcome: { outcome: 'cancelled' } }, mode);
    if (id) assert.equal((await store.getApproval(id)).usedAt, undefined);
  });
});

test('source/account/profile/session/cwd/task drift cannot reuse an approval', async () => {
  for (const field of ['source', 'accountId', 'profileId', 'nativeSessionId', 'cwd', 'taskId']) await fixture(async ({ store, binding, approval }) => {
    const params = request(), id = await approval(params);
    const drift = { ...binding, [field]: field === 'cwd' ? path.join(binding.cwd, 'other') : 'different' };
    const target = client({ permissionBroker: createAcpPermissionBroker({ store, binding: drift, findApprovalId: async () => id }) });
    assert.deepEqual(await target.requestPermission(params), { outcome: { outcome: 'cancelled' } }, field);
    assert.equal((await store.getApproval(id)).usedAt, undefined);
  });
});

test('cancellation while resolving approval is checked atomically before consumption', async () => {
  await fixture(async ({ store, binding, approval }) => {
    const params = request(), id = await approval(params);
    const broker = createAcpPermissionBroker({ store, binding, findApprovalId: async () => {
      await store.updateExecutionStatus(binding.executionId, { status: 'cancelled' }, { idempotencyKey: 'cancel' }); return id;
    } });
    assert.deepEqual(await client({ permissionBroker: broker }).requestPermission(params), { outcome: { outcome: 'cancelled' } });
    assert.equal((await store.getApproval(id)).usedAt, undefined);
  });
});

test('unknown tool kind, no raw arguments, ambiguous IDs and allow_always-only options deny', async () => {
  await fixture(async ({ store, binding }) => {
    const broker = createAcpPermissionBroker({ store, binding, findApprovalId: async () => { throw Error('must not resolve unverifiable requests'); } });
    const cases = [request(), request(), request(), request()];
    cases[0].toolCall.kind = 'other'; delete cases[1].toolCall.rawInput;
    cases[2].options = [cases[2].options[0], { ...cases[2].options[0] }]; cases[3].options = [cases[3].options[1]];
    for (const params of cases) assert.deepEqual(await client({ permissionBroker: broker }).requestPermission(params), { outcome: { outcome: 'cancelled' } });
  });
});

test('client rejects stale broker responses, unknown IDs and always grants', async () => {
  for (const optionId of ['missing', 'always']) assert.deepEqual(await client({ permissionBroker: { authorizePermission: async () => optionId } }).requestPermission(request()), { outcome: { outcome: 'cancelled' } });
  let release;
  const target = client({ permissionBroker: { authorizePermission: () => new Promise(resolve => { release = resolve; }) } });
  const waiting = target.requestPermission(request());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await target.beginTurn({ sendTyping: async () => {}, onThoughtFlush: async () => {}, onMessageFlush: async () => {} });
  release('once'); assert.deepEqual(await waiting, { outcome: { outcome: 'cancelled' } });
});

test('filesystem capabilities advertise only configured host callbacks', async () => {
  let reads = 0;
  const target = client({ filesystemBroker: { readTextFile: async () => { reads++; return { content: 'synthetic' }; } } });
  assert.deepEqual(target.filesystemCapabilities, { readTextFile: true, writeTextFile: false });
  assert.deepEqual(await target.readTextFile({ sessionId: 'native-synthetic', path: 'synthetic' }), { content: 'synthetic' });
  assert.equal(reads, 1);
});

test('consumed decisions cannot be relabeled with a new authenticated approver', async () => {
  await fixture(async ({ store, binding, approval }) => {
    const params = request(), id = await approval(params);
    await client({ permissionBroker: createAcpPermissionBroker({ store, binding, findApprovalId: async () => id }) }).requestPermission(params);
    await assert.rejects(() => store.decideApproval(id, { decision: 'approved', approvedBy: OPERATOR.id }, { principal: OPERATOR, idempotencyKey: 'relabel' }), error => error.code === 'APPROVAL_ALREADY_USED');
  });
});
