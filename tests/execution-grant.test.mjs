// S03b execution Grant tests (remediation plan docs/plans/0.3.0-remediation-2026-10-09.md
// §5 items 1/2/6 acceptance: 排队过期、重启过期、clock 非法、fallback 截止点不变、
// 两类取消边界、保持已通过的 FG/RO 原反例).
//
// Part 1 is the pure grant module (control-plane/execution-grant.mjs) across all
// branches: issuance validation, clock-invalid variants, the effectiveDeadlineAt
// minimum over every applicable limit, all five verify codes, and the
// inherit-do-not-restamp rule.
//
// Part 2 is the dispatch-admission integration through the REAL store +
// dispatcher + native executor (same fixture style as tests/control-plane.test.mjs
// and tests/native-acp-executor.test.mjs; the synthetic "adapter"/"agent" never
// touches the network or a production path).
//
// FG 前台超时只改通知 regression: that semantic lives in the vendor bridge and is
// covered by vendor/wechat-acp tests (grant-deadline-inherit / session-timeout-
// retention, see docs/handoffs/p3-foreground-background-r2.md). Per the design
// contract those suites are CITED, not re-asserted here; what this file pins is
// the control-plane half of the boundary: an expired Grant stops NEW dispatches
// and never cancels work already in flight.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GrantError, GRANT_VERSION, DEFAULT_MAX_EXECUTION_LIFETIME_MS, inheritDeadline, issueGrant, issueGrantForAdmission, verifyGrant } from '../control-plane/execution-grant.mjs'
import { ControlPlaneStore, StoreError, parametersDigest } from '../control-plane/store.mjs'
import { admittedParametersOf, cezarDispatchPlan, dispatchCezar, executionAdmissionInput, grantStoreCode } from '../control-plane/dispatcher.mjs'
import { executeNativeSessionPrompt, nativePromptPlan } from '../control-plane/native-acp-executor.mjs'
import { callTool } from '../interfaces/mcp/server.mjs'
import { executionGrantFixture } from './helpers/execution-grant.mjs'

const T0 = 1_700_000_000_000
const baseIssue = { taskId: 'task-1', executionId: 'execution-1', owner: 'owner-1', parametersDigest: 'sha256:abc', scope: ['cezar.dispatch'], expiresAt: T0 + 60_000, now: () => T0 }

// ---------------------------------------------------------------------------
// Part 1 — pure grant module
// ---------------------------------------------------------------------------

test('issueGrant returns a frozen record with effectiveDeadlineAt = expiresAt when no limits apply', () => {
  const grant = issueGrant(baseIssue)
  assert.equal(grant.version, GRANT_VERSION)
  assert.ok(grant.grantId.startsWith('grant_'))
  assert.equal(grant.issuedAt, T0)
  assert.equal(grant.expiresAt, T0 + 60_000)
  assert.equal(grant.effectiveDeadlineAt, T0 + 60_000)
  assert.deepEqual(grant.scope, ['cezar.dispatch'])
  assert.ok(Object.isFrozen(grant) && Object.isFrozen(grant.scope))
})

test('issueGrant requires taskId/executionId/owner/parametersDigest as non-empty strings', () => {
  for (const field of ['taskId', 'executionId', 'owner', 'parametersDigest']) {
    for (const bad of [undefined, '', '   ', 42]) {
      assert.throws(() => issueGrant({ ...baseIssue, [field]: bad }), (error) => error instanceof GrantError && error.code === 'grant-invalid', `${field}=${JSON.stringify(bad)} must be refused`)
    }
  }
})

test('issueGrant accepts a string or string-array scope, dedupes it, and refuses empty/blank scopes', () => {
  assert.deepEqual(issueGrant({ ...baseIssue, scope: 'cezar.dispatch' }).scope, ['cezar.dispatch'])
  assert.deepEqual(issueGrant({ ...baseIssue, scope: ['a', 'b', 'a'] }).scope, ['a', 'b'])
  for (const bad of [[], [''], ['  '], [42], {}, null]) {
    assert.throws(() => issueGrant({ ...baseIssue, scope: bad }), (error) => error.code === 'grant-invalid', `scope=${JSON.stringify(bad)} must be refused`)
  }
})

test('issueGrant refuses an unusable clock with clock-invalid (throwing, NaN, Infinity, negative, non-number, non-function)', () => {
  const clocks = [() => { throw new Error('broken') }, () => NaN, () => Infinity, () => -Infinity, () => -1, () => 'now', null, 42]
  for (const now of clocks) {
    assert.throws(() => issueGrant({ ...baseIssue, now }), (error) => error instanceof GrantError && error.code === 'clock-invalid', `clock ${String(now)} must be clock-invalid`)
  }
})

test('issueGrant refuses a non-finite or non-future expiresAt and accepts a parseable timestamp string', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'not-a-date', T0, T0 - 1]) {
    assert.throws(() => issueGrant({ ...baseIssue, expiresAt: bad }), (error) => error.code === 'grant-invalid', `expiresAt=${String(bad)} must be refused`)
  }
  const grant = issueGrant({ ...baseIssue, expiresAt: new Date(T0 + 5_000).toISOString() })
  assert.equal(grant.expiresAt, T0 + 5_000)
})

test('effectiveDeadlineAt is the earliest of every applicable limit; missing limits do not participate', () => {
  // approval expiry earlier than the grant expiry -> approval expiry wins
  assert.equal(issueGrant({ ...baseIssue, limits: { approvalExpiresAt: T0 + 30_000 } }).effectiveDeadlineAt, T0 + 30_000)
  // lifetime cap earlier -> issuedAt + maxLifetimeMs wins (derived from the SINGLE issuedAt reading)
  assert.equal(issueGrant({ ...baseIssue, limits: { maxLifetimeMs: 10_000 } }).effectiveDeadlineAt, T0 + 10_000)
  // both later than expiresAt -> the grant's own expiry wins
  assert.equal(issueGrant({ ...baseIssue, limits: { approvalExpiresAt: T0 + 90_000, maxLifetimeMs: 120_000 } }).effectiveDeadlineAt, T0 + 60_000)
  // all three applicable -> the earliest of all
  assert.equal(issueGrant({ ...baseIssue, limits: { approvalExpiresAt: T0 + 45_000, maxLifetimeMs: 20_000 } }).effectiveDeadlineAt, T0 + 20_000)
  // the derivation reads the clock EXACTLY ONCE (no second now() call could make it non-deterministic)
  let reads = 0
  issueGrant({ ...baseIssue, now: () => { reads++; return T0 }, limits: { maxLifetimeMs: 10_000 } })
  assert.equal(reads, 1, 'issueGrant must read now() exactly once')
})

test('issueGrant refuses unknown limit keys and unusable limit values fail-closed', () => {
  assert.throws(() => issueGrant({ ...baseIssue, limits: { maxLifeMs: 1000 } }), (error) => error.code === 'grant-invalid', 'a misspelled limit key must never be silently dropped')
  for (const bad of [0, -5, NaN, Infinity, '1000']) {
    assert.throws(() => issueGrant({ ...baseIssue, limits: { maxLifetimeMs: bad } }), (error) => error.code === 'grant-invalid', `maxLifetimeMs=${String(bad)} must be refused`)
  }
  // an approval expiry at/before issue makes the derived deadline unusable
  assert.throws(() => issueGrant({ ...baseIssue, limits: { approvalExpiresAt: T0 } }), (error) => error.code === 'grant-invalid')
  assert.throws(() => issueGrant({ ...baseIssue, limits: 'lots' }), (error) => error.code === 'grant-invalid')
})

test('grantId is deterministic by default and injectable via random for reproducible tests', () => {
  const a = issueGrant(baseIssue)
  const b = issueGrant(baseIssue)
  assert.equal(a.grantId, b.grantId, 'same inputs + same clock must mint the same id')
  const c = issueGrant({ ...baseIssue, random: () => 'fixed-1' })
  assert.equal(c.grantId, 'grant_fixed-1')
})

test('verifyGrant refuses a missing grant and structurally illegal grants', () => {
  const grant = issueGrant(baseIssue)
  const ok = { taskId: 'task-1', executionId: 'execution-1', parametersDigest: 'sha256:abc', now: () => T0 + 1 }
  for (const missing of [undefined, null]) {
    assert.throws(() => verifyGrant(missing, ok), (error) => error.code === 'grant-missing' && error.httpStatus === 403)
  }
  const illegal = [
    { ...grant, version: 2 },
    (({ effectiveDeadlineAt, ...rest }) => rest)(grant),
    { ...grant, extra: 'field' },
    { ...grant, effectiveDeadlineAt: grant.expiresAt + 1 },
    { ...grant, expiresAt: grant.issuedAt },
    { ...grant, scope: [] },
    { ...grant, issuedAt: 'whenever' },
    'a string',
  ]
  for (const bad of illegal) {
    assert.throws(() => verifyGrant(bad, ok), (error) => error.code === 'grant-invalid' && error.httpStatus === 400, `illegal grant ${JSON.stringify(bad).slice(0, 80)} must be grant-invalid`)
  }
})

test('verifyGrant refuses a grant ported onto another task, execution or parameter digest', () => {
  const grant = issueGrant(baseIssue)
  const base = { taskId: 'task-1', executionId: 'execution-1', parametersDigest: 'sha256:abc', now: () => T0 + 1 }
  for (const drift of [{ taskId: 'task-2' }, { executionId: 'execution-2' }, { parametersDigest: 'sha256:other' }, { parametersDigest: undefined }]) {
    assert.throws(() => verifyGrant(grant, { ...base, ...drift }), (error) => error.code === 'grant-mismatch' && error.httpStatus === 409, `drift ${JSON.stringify(drift)} must be grant-mismatch`)
  }
})

test('verifyGrant refuses an unusable clock and an expired grant; equality at effectiveDeadlineAt is expired', () => {
  const grant = issueGrant(baseIssue)
  const ok = { taskId: 'task-1', executionId: 'execution-1', parametersDigest: 'sha256:abc' }
  for (const now of [() => { throw new Error('x') }, () => NaN, () => Infinity, () => -1, undefined]) {
    assert.throws(() => verifyGrant(grant, { ...ok, now }), (error) => error.code === 'clock-invalid' && error.httpStatus === 500)
  }
  assert.throws(() => verifyGrant(grant, { ...ok, now: () => grant.effectiveDeadlineAt + 1 }), (error) => error.code === 'grant-expired' && error.httpStatus === 409)
  assert.throws(() => verifyGrant(grant, { ...ok, now: () => grant.effectiveDeadlineAt }), (error) => error.code === 'grant-expired' && error.httpStatus === 409)
  const beforeBoundary = verifyGrant(grant, { ...ok, now: () => grant.effectiveDeadlineAt - 1 })
  assert.equal(beforeBoundary, grant, 'success returns the SAME grant object — never a re-stamped copy')
})

test('a grant is never re-stamped: verification past the persisted effectiveDeadlineAt is expired even though a fresh grant would live', () => {
  const grant = issueGrant({ ...baseIssue, expiresAt: T0 + 100 })
  const ok = { taskId: 'task-1', executionId: 'execution-1', parametersDigest: 'sha256:abc' }
  assert.throws(() => verifyGrant(grant, { ...ok, now: () => T0 + 150 }), (error) => error.code === 'grant-expired', 'the persisted deadline governs; nothing extends from now')
  // a JSON round-trip (what a restart does) preserves the deadline verbatim
  const restored = JSON.parse(JSON.stringify(grant))
  assert.equal(inheritDeadline(restored), grant.effectiveDeadlineAt)
  assert.throws(() => verifyGrant(restored, { ...ok, now: () => T0 + 150 }), (error) => error.code === 'grant-expired')
})

test('inheritDeadline returns the persisted effectiveDeadlineAt verbatim — even for an expired grant — and never recomputes', () => {
  const grant = issueGrant({ ...baseIssue, limits: { maxLifetimeMs: 5_000 } })
  assert.equal(inheritDeadline(grant), T0 + 5_000)
  // no clock is consulted: "now" far past the deadline still inherits the same value
  assert.equal(inheritDeadline(JSON.parse(JSON.stringify(grant))), T0 + 5_000)
  assert.throws(() => inheritDeadline(undefined), (error) => error.code === 'grant-missing')
  assert.throws(() => inheritDeadline({ version: 2 }), (error) => error.code === 'grant-invalid')
})

test('grantStoreCode maps GrantError codes onto the control-plane StoreError style', () => {
  assert.equal(grantStoreCode('grant-expired'), 'GRANT_EXPIRED')
  assert.equal(grantStoreCode('clock-invalid'), 'CLOCK_INVALID')
})

// ---------------------------------------------------------------------------
// Part 2 — dispatch-admission integration (real store + dispatcher + executor)
// ---------------------------------------------------------------------------

async function cezarFixture({ grant = {}, withGrant = true, digestOverride } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-cezar-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'grant cezar fixture' }, { idempotencyKey: 'g-task' })
  const executionId = `execution_grant_${crypto.randomUUID()}`
  const grantFields = withGrant ? executionGrantFixture({ taskId: task.task.id, executionId, scope: ['cezar.dispatch'], ...grant }) : {}
  const execution = await store.createExecution(task.task.id, {
    id: executionId,
    workerId: 'w1',
    ...grantFields,
    ...(digestOverride === undefined ? {} : { parametersDigest: digestOverride }),
  }, { idempotencyKey: 'g-exec' })
  const plan = cezarDispatchPlan({ taskId: task.task.id, executionId })
  const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'g-approval' })
  await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'g-decide' })
  let starts = 0
  const adapter = { baseUrl: 'http://fake-cezar', start: async () => { starts++; return { id: 'run-1', status: 'queued' } } }
  return { stateDir, store, taskId: task.task.id, executionId, execution, approvalId: approval.approval.id, grant: grantFields.grant, adapter, starts: () => starts }
}

async function nativeFixture({ grant = {} } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-native-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'grant native fixture' }, { idempotencyKey: 'gn-task' })
  const executionId = `execution_grant_${crypto.randomUUID()}`
  await store.createExecution(task.task.id, { id: executionId, workerId: 'w1', sessionRefId: 'session:fake:native-1', ...executionGrantFixture({ taskId: task.task.id, executionId, scope: ['native.session.prompt'], ...grant }) }, { idempotencyKey: 'gn-exec' })
  const plan = nativePromptPlan({ taskId: task.task.id, executionId, source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp', prompt: '继续' })
  const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'gn-approval' })
  await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'gn-decide' })
  const input = { taskId: task.task.id, executionId, source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp', prompt: '继续' }
  return { stateDir, store, taskId: task.task.id, executionId, approvalId: approval.approval.id, input }
}

const spySandbox = () => {
  const calls = []
  return { calls, sandbox: (command, args) => { calls.push({ command, args }); return { command, args } } }
}

test('a valid grant admits the real dispatch (control: the gate does not block legitimate work)', async () => {
  const f = await cezarFixture()
  try {
    const result = await dispatchCezar({ store: f.store, adapter: f.adapter, taskId: f.taskId, executionId: f.executionId, approvalId: f.approvalId, idempotencyKey: 'gc-ok' })
    assert.equal(result.execution.status, 'running')
    assert.equal(f.starts(), 1)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('排队过期: a grant whose effectiveDeadlineAt passed while queued refuses the dispatch (grant-expired), settles blocked, and never calls the engine', async () => {
  const issuedAt = Date.now()
  const f = await cezarFixture({ grant: { now: () => issuedAt, lifetimeMs: 60_000 } })
  try {
    const future = () => issuedAt + 120_000
    await assert.rejects(
      () => dispatchCezar({ store: f.store, adapter: f.adapter, taskId: f.taskId, executionId: f.executionId, approvalId: f.approvalId, now: future, idempotencyKey: 'gc-expired' }),
      (error) => error instanceof StoreError && error.code === 'GRANT_EXPIRED' && error.details?.grantCode === 'grant-expired',
    )
    assert.equal(f.starts(), 0, 'the engine must never be called for an expired grant')
    const settled = await f.store.getExecution(f.executionId)
    assert.equal(settled.status, 'blocked', 'the refused queue entry is settled honestly, not left stuck queued')
    assert.ok(settled.outcome.includes('grant-expired'))
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('重启过期: the persisted grant survives a restart verbatim; the restarted store refuses an expired one and admits a live one with the SAME deadline', async () => {
  const issuedAt = Date.now()
  const f = await cezarFixture({ grant: { now: () => issuedAt, lifetimeMs: 60_000 } })
  try {
    // "restart": a brand-new store instance over the same state directory
    const restarted = new ControlPlaneStore({ stateDir: f.stateDir })
    const recovered = await restarted.getExecution(f.executionId)
    assert.deepEqual(recovered.grant, JSON.parse(JSON.stringify(f.grant)), 'the grant round-trips through persistence byte-for-byte')
    assert.equal(inheritDeadline(recovered.grant), f.grant.effectiveDeadlineAt, 'recovery inherits the persisted deadline verbatim')
    // live under the original deadline -> admitted by the restarted store
    const live = await dispatchCezar({ store: restarted, adapter: f.adapter, taskId: f.taskId, executionId: f.executionId, approvalId: f.approvalId, now: () => issuedAt + 30_000, idempotencyKey: 'gr-live' })
    assert.equal(live.execution.status, 'running')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }

  const g = await cezarFixture({ grant: { now: () => issuedAt, lifetimeMs: 60_000 } })
  try {
    const restarted = new ControlPlaneStore({ stateDir: g.stateDir })
    await assert.rejects(
      () => dispatchCezar({ store: restarted, adapter: g.adapter, taskId: g.taskId, executionId: g.executionId, approvalId: g.approvalId, now: () => issuedAt + 120_000, idempotencyKey: 'gr-expired' }),
      (error) => error.code === 'GRANT_EXPIRED',
    )
    assert.equal(g.starts(), 0)
  } finally { await fs.rm(g.stateDir, { recursive: true, force: true }) }
})

test('恢复/fallback 截止点不变: recoverOnStartup keeps the grant untouched and inheritDeadline never re-stamps from now', async () => {
  const issuedAt = Date.now()
  const f = await cezarFixture({ grant: { now: () => issuedAt, lifetimeMs: 60_000 } })
  try {
    await f.store.updateExecutionStatus(f.executionId, { status: 'running' }, { idempotencyKey: 'gf-running' })
    const restarted = new ControlPlaneStore({ stateDir: f.stateDir })
    const recovery = await restarted.recoverOnStartup()
    assert.deepEqual(recovery.blockedExecutionIds, [f.executionId], 'startup recovery still settles in-flight work as blocked (existing certain/uncertain semantics)')
    const recovered = await restarted.getExecution(f.executionId)
    assert.deepEqual(recovered.grant, JSON.parse(JSON.stringify(f.grant)), 'recovery must not touch the persisted grant')
    // the fallback/recovery path can only INHERIT: the deadline is the persisted
    // value, not issuedAt+extension recomputed from the recovery time
    assert.equal(inheritDeadline(recovered.grant), f.grant.effectiveDeadlineAt)
    assert.notEqual(inheritDeadline(recovered.grant), Date.now() + 60_000, 'the deadline must not be re-derived from now')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('digest 移植: a grant minted for execution A cannot be persisted onto execution B, and a stored digest drift refuses dispatch (grant-mismatch)', async () => {
  const f = await cezarFixture()
  try {
    // A's grant handed to B's creation is refused at the store boundary
    await assert.rejects(
      () => f.store.createExecution(f.taskId, { id: `execution_other_${crypto.randomUUID()}`, workerId: 'w2', grant: f.grant, parametersDigest: 'sha256:whatever' }, { idempotencyKey: 'gp-port' }),
      (error) => error instanceof StoreError && error.code === 'GRANT_BINDING_MISMATCH',
    )
    // a record whose stored parametersDigest drifts from the grant's binding is refused at dispatch
    const g = await cezarFixture({ digestOverride: parametersDigest({ drifted: true }) })
    try {
      await assert.rejects(
        () => dispatchCezar({ store: g.store, adapter: g.adapter, taskId: g.taskId, executionId: g.executionId, approvalId: g.approvalId, idempotencyKey: 'gp-drift' }),
        (error) => error.code === 'GRANT_MISMATCH' && error.details?.grantCode === 'grant-mismatch',
      )
      assert.equal(g.starts(), 0)
      assert.equal((await g.store.getExecution(g.executionId)).status, 'blocked')
    } finally { await fs.rm(g.stateDir, { recursive: true, force: true }) }
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('缺失 Grant 的新 dispatch 被拒绝: a newly enqueued execution without a grant is refused (grant-missing) on both dispatch paths', async () => {
  const f = await cezarFixture({ withGrant: false })
  try {
    await assert.rejects(
      () => dispatchCezar({ store: f.store, adapter: f.adapter, taskId: f.taskId, executionId: f.executionId, approvalId: f.approvalId, idempotencyKey: 'gm-cezar' }),
      (error) => error.code === 'GRANT_MISSING' && error.details?.grantCode === 'grant-missing',
    )
    assert.equal(f.starts(), 0, 'no engine side effect without a grant')
    assert.equal((await f.store.getExecution(f.executionId)).status, 'blocked')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }

  // native path: build a grant-carrying fixture, then a second execution WITHOUT one
  const n = await nativeFixture()
  try {
    const noGrantExecution = await n.store.createExecution(n.taskId, { workerId: 'w2', sessionRefId: 'session:fake:native-2' }, { idempotencyKey: 'gn-nogrant' })
    const plan = nativePromptPlan({ taskId: n.taskId, executionId: noGrantExecution.execution.id, source: 'fake', nativeSessionId: 'native-2', sessionRefId: 'session:fake:native-2', cwd: '/tmp', prompt: '继续' })
    const approval = await n.store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'gn-nogrant-approval' })
    await n.store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'gn-nogrant-decide' })
    const spy = spySandbox()
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: n.store, taskId: n.taskId, executionId: noGrantExecution.execution.id, source: 'fake', nativeSessionId: 'native-2', sessionRefId: 'session:fake:native-2', cwd: '/tmp', prompt: '继续', approvalId: approval.approval.id, command: process.execPath, args: ['-e', 'process.exit(0)'], sandbox: spy.sandbox, idempotencyKey: 'gn-nogrant-run' }),
      (error) => error.code === 'GRANT_MISSING',
    )
    assert.equal(spy.calls.length, 0, 'the sandbox/spawn path is never reached without a grant')
    assert.equal((await n.store.getExecution(noGrantExecution.execution.id)).status, 'blocked')
  } finally { await fs.rm(n.stateDir, { recursive: true, force: true }) }
})

test('native 排队过期: an expired grant refuses the native launch before the launch intent, with zero spawn and no engine ref', async () => {
  const issuedAt = Date.now()
  const n = await nativeFixture({ grant: { now: () => issuedAt, lifetimeMs: 60_000 } })
  try {
    const spy = spySandbox()
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: n.store, ...n.input, approvalId: n.approvalId, command: process.execPath, args: ['-e', 'process.exit(0)'], sandbox: spy.sandbox, now: () => issuedAt + 120_000, idempotencyKey: 'gn-expired' }),
      (error) => error.code === 'GRANT_EXPIRED',
    )
    assert.equal(spy.calls.length, 0, 'no spawn for an expired grant')
    const settled = await n.store.getExecution(n.executionId)
    assert.equal(settled.status, 'blocked')
    assert.equal(settled.engineRef, undefined, 'the gate sits before the launch intent: no engine ref is ever attached')
  } finally { await fs.rm(n.stateDir, { recursive: true, force: true }) }
})

test('两类取消边界: Grant 到期只停新派发, 在飞工作不被 retroactive 取消并按既有语义结算', async () => {
  // Boundary 1 (vendor/FG side — CITED, not re-asserted): a foreground wait
  // timeout changes notification only and never cancels admitted background
  // work; covered by vendor/wechat-acp grant-deadline-inherit and
  // session-timeout-retention tests (docs/handoffs/p3-foreground-background-r2.md).
  //
  // Boundary 2 (control-plane side, asserted here): work dispatched while its
  // grant was alive keeps running after the deadline passes; only the NEXT
  // dispatch is refused, and the in-flight execution settles through the
  // ordinary status machine.
  const issuedAt = Date.now()
  const first = await cezarFixture({ grant: { now: () => issuedAt, lifetimeMs: 60_000 } })
  try {
    const dispatched = await dispatchCezar({ store: first.store, adapter: first.adapter, taskId: first.taskId, executionId: first.executionId, approvalId: first.approvalId, now: () => issuedAt + 1_000, idempotencyKey: 'cb-first' })
    assert.equal(dispatched.execution.status, 'running')

    // time passes beyond the first grant's deadline; a SECOND queued execution's
    // new dispatch is refused — but the in-flight one is untouched
    const second = await cezarFixture({ grant: { now: () => issuedAt, lifetimeMs: 30_000 } })
    try {
      await assert.rejects(
        () => dispatchCezar({ store: second.store, adapter: second.adapter, taskId: second.taskId, executionId: second.executionId, approvalId: second.approvalId, now: () => issuedAt + 120_000, idempotencyKey: 'cb-second' }),
        (error) => error.code === 'GRANT_EXPIRED',
      )
      const inFlight = await first.store.getExecution(first.executionId)
      assert.equal(inFlight.status, 'running', 'an expired grant must never retroactively cancel in-flight work')
      // the in-flight execution still settles through the ordinary semantics
      const settled = await first.store.updateExecutionStatus(first.executionId, { status: 'verifying', outcome: 'in-flight run completed normally' }, { idempotencyKey: 'cb-settle' })
      assert.equal(settled.execution.status, 'verifying')
    } finally { await fs.rm(second.stateDir, { recursive: true, force: true }) }
  } finally { await fs.rm(first.stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Part 3 — production enqueue entries issue the grant at admission (S03b gap
// closure): glue defaults/determinism, entry-level positive + negative probes.
// ---------------------------------------------------------------------------

test('issueGrantForAdmission derives expiry from the 30-minute default cap with a single shared clock reading', () => {
  assert.equal(DEFAULT_MAX_EXECUTION_LIFETIME_MS, 30 * 60_000, 'the default cap stays aligned with the bridge-side 30-minute grant deadline')
  let reads = 0
  const result = issueGrantForAdmission({ taskId: 'task-1', owner: 'owner-1', parametersDigest: 'sha256:abc', scope: ['cezar.dispatch'], now: () => { reads++; return T0 } })
  assert.equal(reads, 1, 'the expiry derivation and the issuance share ONE clock reading')
  assert.ok(result.id.startsWith('execution_'), 'an id is minted when the entry assigns none')
  assert.equal(result.grant.issuedAt, T0)
  assert.equal(result.grant.expiresAt, T0 + 30 * 60_000)
  assert.equal(result.grant.effectiveDeadlineAt, T0 + 30 * 60_000)
  assert.equal(result.grant.executionId, result.id)
  assert.equal(verifyGrant(result.grant, { taskId: 'task-1', executionId: result.id, parametersDigest: 'sha256:abc', now: () => T0 + 1 }), result.grant)
})

test('issueGrantForAdmission: explicit expiresAt narrows but never widens; authorizer expiry participates in the minimum', () => {
  const base = { taskId: 'task-1', owner: 'owner-1', parametersDigest: 'sha256:abc', scope: ['s'], now: () => T0 }
  // explicit request-level deadline earlier than the cap -> honored
  assert.equal(issueGrantForAdmission({ ...base, expiresAt: T0 + 60_000 }).grant.effectiveDeadlineAt, T0 + 60_000)
  // explicit deadline LATER than the cap -> the cap still wins (narrow-only)
  assert.equal(issueGrantForAdmission({ ...base, expiresAt: T0 + 3_600_000 }).grant.effectiveDeadlineAt, T0 + 30 * 60_000)
  // the authorizing artifact's expiry participates when known at admission
  assert.equal(issueGrantForAdmission({ ...base, authorizerExpiresAt: T0 + 120_000 }).grant.effectiveDeadlineAt, T0 + 120_000)
  assert.equal(issueGrantForAdmission({ ...base, authorizerExpiresAt: new Date(T0 + 90_000).toISOString() }).grant.effectiveDeadlineAt, T0 + 90_000)
  // deterministic ids from idSeed: same seed -> same id (idempotency-replay safety)
  const a = issueGrantForAdmission({ ...base, idSeed: { taskId: 'task-1', idempotencyKey: 'k', parameters: { workerId: 'w' } } })
  const b = issueGrantForAdmission({ ...base, idSeed: { taskId: 'task-1', idempotencyKey: 'k', parameters: { workerId: 'w' } } })
  const c = issueGrantForAdmission({ ...base, idSeed: { taskId: 'task-1', idempotencyKey: 'other', parameters: { workerId: 'w' } } })
  assert.equal(a.id, b.id)
  assert.notEqual(a.id, c.id)
  // negatives: illegal expiresAt / lifetime config refuse BEFORE anything persists
  assert.throws(() => issueGrantForAdmission({ ...base, expiresAt: 'not-a-timestamp' }), (error) => error.code === 'grant-invalid')
  assert.throws(() => issueGrantForAdmission({ ...base, maxLifetimeMs: Number('abc') }), (error) => error.code === 'grant-invalid')
  assert.throws(() => issueGrantForAdmission({ ...base, maxLifetimeMs: -1 }), (error) => error.code === 'grant-invalid')
})

test('executionAdmissionInput digests with the store parametersDigest and translates denials to StoreError shape', () => {
  const admission = executionAdmissionInput({ taskId: 'task-1', owner: 'o', parameters: { workerId: 'w', sessionRefId: 'session:x:1' }, scope: ['cezar.dispatch'], idempotencyKey: 'key-1', now: () => T0 })
  assert.equal(admission.parametersDigest, parametersDigest({ workerId: 'w', sessionRefId: 'session:x:1' }), 'the admission digest comes from the SAME parametersDigest source as approval matching')
  const again = executionAdmissionInput({ taskId: 'task-1', owner: 'o', parameters: { workerId: 'w', sessionRefId: 'session:x:1' }, scope: ['cezar.dispatch'], idempotencyKey: 'key-1', now: () => T0 + 5_000 })
  assert.equal(again.id, admission.id, 'the derived id is stable across a retry (only the clock moved)')
  // secret-adjacent material never enters the digest field set
  assert.deepEqual(admittedParametersOf({ workerId: 'w', sessionLockToken: 'secret-token', role: 'reviewer' }), { workerId: 'w', role: 'reviewer' })
  // GrantError -> StoreError translation at the boundary
  assert.throws(
    () => executionAdmissionInput({ taskId: 'task-1', owner: 'o', parameters: {}, scope: ['s'], expiresAt: 'garbage', idempotencyKey: 'k' }),
    (error) => error instanceof StoreError && error.code === 'GRANT_INVALID' && error.status === 400 && error.details?.grantCode === 'grant-invalid',
  )
})

test('store.createExecution idempotency excludes the host-issued grant: a retry replays, a real payload change still conflicts', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-idem-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'idempotency' }, { idempotencyKey: 'idem-task' })
    const executionId = `execution_idem_${crypto.randomUUID()}`
    const grantA = executionGrantFixture({ taskId: task.task.id, executionId })
    const first = await store.createExecution(task.task.id, { id: executionId, workerId: 'w1', ...grantA }, { idempotencyKey: 'idem-exec' })
    // a retry carries a freshly issued grant (different clock fields) but the
    // same logical payload -> replay, and the ORIGINAL grant is retained
    const grantB = executionGrantFixture({ taskId: task.task.id, executionId })
    const retry = await store.createExecution(task.task.id, { id: executionId, workerId: 'w1', ...grantB }, { idempotencyKey: 'idem-exec' })
    assert.equal(retry.replay, true)
    assert.equal(retry.execution.id, executionId)
    assert.equal(retry.execution.grant.grantId, first.execution.grant.grantId, 'the persisted grant is the first admission, never re-stamped by a retry')
    // a genuinely different payload under the same key is still a conflict
    await assert.rejects(
      () => store.createExecution(task.task.id, { id: executionId, workerId: 'w2', ...grantB }, { idempotencyKey: 'idem-exec' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    )
  } finally { await fs.rm(stateDir, { recursive: true, force: true }) }
})

test('MCP create_execution entry issues a valid grant at enqueue and the execution dispatches without GRANT_MISSING', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-mcp-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const created = await callTool('create_task', { goal: 'mcp grant entry', idempotencyKey: 'mcp-g-task' }, { store })
    const taskId = created.task.id
    const enqueued = await callTool('create_execution', { taskId, workerId: 'w1', idempotencyKey: 'mcp-g-exec' }, { store })
    const execution = enqueued.execution
    // the entry-created record carries a structurally valid, verifiable grant
    const grant = verifyGrant(execution.grant, { taskId, executionId: execution.id, parametersDigest: execution.parametersDigest, now: Date.now })
    assert.deepEqual(grant.scope, ['cezar.dispatch', 'native.session.prompt'])
    // a replayed tool call replays (derived id + grant excluded from fingerprint)
    const replay = await callTool('create_execution', { taskId, workerId: 'w1', idempotencyKey: 'mcp-g-exec' }, { store })
    assert.equal(replay.replay, true)
    assert.equal(replay.execution.id, execution.id)
    // and the same execution really dispatches (approval-bound, fake adapter)
    const plan = cezarDispatchPlan({ taskId, executionId: execution.id })
    const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'mcp-g-approval' })
    await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'mcp-g-decide' })
    let starts = 0
    const dispatched = await dispatchCezar({ store, adapter: { baseUrl: 'http://fake', start: async () => { starts++; return { id: 'run-1', status: 'queued' } } }, taskId, executionId: execution.id, approvalId: approval.approval.id, idempotencyKey: 'mcp-g-dispatch' })
    assert.equal(dispatched.execution.status, 'running')
    assert.equal(starts, 1, 'an entry-created execution is never refused GRANT_MISSING')
  } finally { await fs.rm(stateDir, { recursive: true, force: true }) }
})

test('CLI entry (scripts/control-plane.mjs) issues a grant at enqueue; an illegal --expires-at refuses and enqueues nothing', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-cli-'))
  try {
    const env = { ...process.env, PERSONAL_AI_OS_STATE_DIR: stateDir }
    const run = (cliArgs) => spawnSync(process.execPath, ['scripts/control-plane.mjs', ...cliArgs, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' })
    const task = run(['task', 'create', '--goal', 'cli grant entry', '--idempotency', 'cli-g-task'])
    assert.equal(task.status, 0, task.stderr)
    const taskId = JSON.parse(task.stdout).task.id
    const created = run(['execution', 'create', '--task', taskId, '--worker', 'w1', '--idempotency', 'cli-g-exec'])
    assert.equal(created.status, 0, created.stderr)
    const execution = JSON.parse(created.stdout).execution
    const grant = verifyGrant(execution.grant, { taskId, executionId: execution.id, parametersDigest: execution.parametersDigest, now: Date.now })
    assert.equal(grant.owner, 'w1', 'the CLI defaults the grant owner to the worker id')
    // negative: an illegal --expires-at exits non-zero and nothing is enqueued
    const refused = run(['execution', 'create', '--task', taskId, '--worker', 'w1', '--expires-at', 'not-a-timestamp', '--idempotency', 'cli-g-bad'])
    assert.notEqual(refused.status, 0, 'an illegal expiresAt must fail the CLI')
    assert.ok(refused.stderr.includes('expiresAt'), `the refusal names the cause: ${refused.stderr}`)
    const store = new ControlPlaneStore({ stateDir })
    assert.equal((await store.snapshot()).executionCount, 1, 'the refused admission never enqueued')
  } finally { await fs.rm(stateDir, { recursive: true, force: true }) }
})
