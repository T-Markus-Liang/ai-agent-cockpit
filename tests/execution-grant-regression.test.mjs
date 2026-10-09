import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { issueGrant, verifyGrant } from '../control-plane/execution-grant.mjs'
import { createAdmittedExecution, cezarDispatchPlan, dispatchCezar, executionAdmissionInput } from '../control-plane/dispatcher.mjs'
import { executeNativeSessionPrompt, nativePromptPlan } from '../control-plane/native-acp-executor.mjs'
import { createReviewerExecution } from '../control-plane/reviewer.mjs'

const AT = 1_700_000_000_000

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-regression-'))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const store = new ControlPlaneStore({ stateDir })
  const { task } = await store.createTask({ goal: 'synthetic grant regression' }, { idempotencyKey: 'task' })
  const admission = { store, taskId: task.id, input: { workerId: 'synthetic' },
    owner: 'synthetic-owner', scope: ['cezar.dispatch', 'native.session.prompt'],
    expiresAt: AT + 100, now: () => AT, idempotencyKey: 'execution' }
  return { store, stateDir, taskId: task.id, admission }
}

async function approve(store, plan) {
  const { approval } = await store.createApproval({ action: plan.action, target: plan.target,
    parametersDigest: plan.parametersDigest }, { idempotencyKey: `approval:${plan.target}` })
  await store.decideApproval(approval.id, { decision: 'approved', approvedBy: 'synthetic' },
    { idempotencyKey: `decision:${plan.target}` })
  return approval.id
}

async function assertDenied(f, execution, { native = false, code, at = AT + 1, approvalPlan, expectedStatus = 'blocked' } = {}) {
  let starts = 0
  const input = { store: f.store, taskId: f.taskId, executionId: execution.id,
    source: 'fake', nativeSessionId: 'synthetic', sessionRefId: 'session:fake:synthetic',
    cwd: '/tmp', prompt: 'synthetic', now: () => at, idempotencyKey: 'dispatch' }
  const plan = approvalPlan ?? (native ? nativePromptPlan(input) : cezarDispatchPlan(input))
  const approvalId = await approve(f.store, plan)
  const sideEffect = () => { starts++; throw new Error('unexpected engine call') }
  await assert.rejects(() => native
    ? executeNativeSessionPrompt({ ...input, approvalId, command: process.execPath,
      args: ['-e', 'process.exit(99)'], sandbox: sideEffect })
    : dispatchCezar({ ...input, approvalId, role: 'worker', grant: { scope: ['cezar.dispatch'] },
      adapter: { start: sideEffect } }), error => error.code === code)
  assert.equal(starts, 0, 'denial must precede any adapter or sandbox call')
  const persisted = await f.store.getExecution(execution.id)
  assert.equal(persisted.status, expectedStatus)
  assert.equal(persisted.engineRef, undefined, 'denial must precede launch intent')
  assert.equal((await f.store.getApproval(approvalId)).usedAt, undefined,
    'matching approval remains unconsumed on grant denial')
}

test('scope regression: verifyGrant requires the exact requested action, without wildcard inference', () => {
  const grant = issueGrant({ taskId: 't', executionId: 'e', owner: 'o', parametersDigest: 'd',
    scope: ['native.session.prompt', 'cezar.*'], expiresAt: AT + 100, now: () => AT })
  const binding = { taskId: 't', executionId: 'e', parametersDigest: 'd', now: () => AT + 1 }
  assert.equal(verifyGrant(grant, { ...binding, requiredScope: 'native.session.prompt' }), grant)
  for (const requiredScope of ['cezar.dispatch', '', 'goal-runtime.execution']) {
    assert.throws(() => verifyGrant(grant, { ...binding, requiredScope }),
      error => error.code === 'grant-scope-denied' && error.httpStatus === 403)
  }
})

test('Cezar denies a stored native-only worker grant despite matching Approval and caller grant', async t => {
  const f = await fixture(t)
  const { execution } = await createAdmittedExecution({ ...f.admission, scope: ['native.session.prompt'] })
  await assertDenied(f, execution, { code: 'GRANT_SCOPE_DENIED' })
})

test('native gate denies a stored Cezar-only grant before launch intent, Approval consumption or spawn', async t => {
  const f = await fixture(t)
  const { execution } = await createAdmittedExecution({ ...f.admission,
    input: { workerId: 'synthetic', sessionRefId: 'session:fake:synthetic' }, scope: ['cezar.dispatch'] })
  await assertDenied(f, execution, { native: true, code: 'GRANT_SCOPE_DENIED' })
})

test('a reviewer created by the review entry cannot dispatch via Cezar with matching Approval', async t => {
  const f = await fixture(t)
  const { execution: source } = await createAdmittedExecution(f.admission)
  for (const status of ['running', 'verifying']) {
    await f.store.updateExecutionStatus(source.id, { status }, { idempotencyKey: status })
  }
  const { execution } = await createReviewerExecution({ store: f.store, taskId: f.taskId,
    sourceExecutionId: source.id, reviewerId: 'synthetic-reviewer', idempotencyKey: 'review' })
  assert.equal(execution.role, 'reviewer')
  assert.deepEqual(execution.grant.scope, ['native.session.prompt'])
  await assertDenied(f, execution, { code: 'GRANT_SCOPE_DENIED', at: execution.grant.issuedAt + 1 })
})

test('even a reviewer with Cezar scope is rejected because that path cannot enforce read-only', async t => {
  const f = await fixture(t)
  const { execution } = await createAdmittedExecution({ ...f.admission,
    input: { workerId: 'synthetic-reviewer', role: 'reviewer' }, scope: ['cezar.dispatch'] })
  await assertDenied(f, execution, { code: 'REVIEWER_READONLY_REQUIRED' })
})

test('explicit deadline intent conflicts on change, removal or addition independently of generated fields', async t => {
  const f = await fixture(t)
  const first = await createAdmittedExecution(f.admission)
  for (const expiresAt of [AT + 101, AT + 50, undefined, 'invalid']) {
    await assert.rejects(() => createAdmittedExecution({ ...f.admission, expiresAt,
      now: () => { throw new Error('conflict must precede signing') } }),
    error => error.code === 'IDEMPOTENCY_CONFLICT')
  }
  const generated = await createAdmittedExecution({ ...f.admission, expiresAt: undefined, idempotencyKey: 'default' })
  await assert.rejects(() => createAdmittedExecution({ ...f.admission,
    expiresAt: generated.execution.grant.expiresAt, idempotencyKey: 'default' }),
  error => error.code === 'IDEMPOTENCY_CONFLICT')
  const retry = await createAdmittedExecution({ ...f.admission, now: () => AT + 5 })
  assert.equal(retry.replay, true)
  assert.deepEqual(retry.execution.grant, first.execution.grant)
  assert.equal((await f.store.getTask(f.taskId)).executions.length, 2)
})

test('identical explicit-expiry request safely replays after restart and expiry without re-signing or authorizing dispatch', async t => {
  const f = await fixture(t)
  const first = await createAdmittedExecution(f.admission)
  const before = await f.store.listEvents({})
  const store = new ControlPlaneStore({ stateDir: f.stateDir })
  let clockReads = 0
  const retry = await createAdmittedExecution({ ...f.admission, store,
    now: () => { clockReads++; return AT + 101 } })
  assert.equal(retry.replay, true)
  assert.deepEqual(retry.execution, JSON.parse(JSON.stringify(first.execution)))
  assert.equal(clockReads, 0, 'replay must not try to sign a new grant')
  assert.deepEqual(await store.listEvents({}), before, 'replay creates no new execution or admission event')
  assert.equal((await store.getTask(f.taskId)).executions.length, 1)
  await assertDenied({ ...f, store }, retry.execution, { code: 'GRANT_EXPIRED', at: AT + 101 })
  await assert.rejects(() => createAdmittedExecution({ ...f.admission, store,
    idempotencyKey: 'new-expired', now: () => AT + 101 }), error => error.code === 'GRANT_INVALID')
  assert.equal((await store.getTask(f.taskId)).executions.length, 1)
})

test('legacy fingerprints without explicit admission intent fail closed rather than guessing the caller deadline', async t => {
  const f = await fixture(t)
  const issued = executionAdmissionInput({ ...f.admission, parameters: f.admission.input })
  const first = await f.store.createExecution(f.taskId, { ...f.admission.input, ...issued },
    { idempotencyKey: f.admission.idempotencyKey })
  await assert.rejects(() => createAdmittedExecution({ ...f.admission,
    now: () => { throw new Error('legacy conflict must not sign') } }),
  error => error.code === 'IDEMPOTENCY_CONFLICT')
  assert.deepEqual((await f.store.getExecution(first.execution.id)).grant, first.execution.grant)
  assert.equal((await f.store.getTask(f.taskId)).executions.length, 1)
})

test('deadline boundary is exclusive even when a lifetime cap is earlier than explicit expiry', () => {
  const grant = issueGrant({ taskId: 't', executionId: 'e', owner: 'o', parametersDigest: 'd',
    scope: ['cezar.dispatch'], expiresAt: AT + 200, limits: { maxLifetimeMs: 100 }, now: () => AT })
  const binding = { taskId: 't', executionId: 'e', parametersDigest: 'd', requiredScope: 'cezar.dispatch' }
  assert.equal(verifyGrant(grant, { ...binding, now: () => AT + 99 }), grant)
  for (const at of [AT + 100, AT + 101]) {
    assert.throws(() => verifyGrant(grant, { ...binding, now: () => at }), error => error.code === 'grant-expired')
  }
})

for (const native of [false, true]) {
  test(`${native ? 'native' : 'Cezar'} dispatch expires exactly at effectiveDeadlineAt`, async t => {
    const f = await fixture(t)
    const { execution } = await createAdmittedExecution({ ...f.admission, expiresAt: AT + 200,
      maxLifetimeMs: 100, input: { workerId: 'synthetic', ...(native ? { sessionRefId: 'session:fake:synthetic' } : {}) } })
    await assertDenied(f, execution, { native, code: 'GRANT_EXPIRED', at: AT + 100 })
  })
}

test('a live correctly scoped grant still cannot bypass matching Approval', async t => {
  const f = await fixture(t)
  const { execution } = await createAdmittedExecution(f.admission)
  await assertDenied(f, execution, { code: 'APPROVAL_SCOPE_MISMATCH', expectedStatus: 'queued',
    approvalPlan: { ...cezarDispatchPlan({ taskId: f.taskId, executionId: execution.id }), parametersDigest: 'sha256:wrong' } })
})
