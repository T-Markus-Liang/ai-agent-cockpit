import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createApproval, createExecution, createSessionRef, createTask, ContractError } from '../control-plane/contracts.mjs'
import { indexLocalSessions } from '../control-plane/session-index.mjs'
import { ControlPlaneStore, StoreError, parametersDigest } from '../control-plane/store.mjs'
import { getSessionMetadata } from '../control-plane/session-adapters.mjs'
import { handleMcpRequest } from '../interfaces/mcp/server.mjs'
import { cancelCezarExecution, cezarCancelPlan, dispatchCezar, reconcileCezarExecution, watchCezarExecution } from '../control-plane/dispatcher.mjs'
import { probeFeatureMap } from '../control-plane/feature-map.mjs'
import { listNativeAcpSessions } from '../control-plane/native-acp.mjs'
import { CezarAdapter } from '../adapters/engines/cezar.mjs'

test('contracts keep Task, SessionRef and Execution separate', () => {
  const task = createTask({ goal: '检查本机 agent 状态', acceptanceCriteria: ['输出可追溯证据'] })
  const session = createSessionRef({ source: 'test', nativeSessionId: 'native-1', cwd: '/tmp', title: '测试会话' })
  const execution = createExecution({ taskId: task.id, workerId: 'test-worker', sessionRefId: session.id })
  assert.equal(task.type, 'Task')
  assert.equal(session.type, 'SessionRef')
  assert.equal(execution.type, 'Execution')
  assert.equal(execution.taskId, task.id)
  assert.equal(execution.sessionRefId, session.id)
})

test('contracts reject empty goals and invalid approvals', () => {
  assert.throws(() => createTask({ goal: '' }), ContractError)
  assert.throws(() => createApproval({ action: 'send', target: 'wechat', parametersDigest: 'x', decision: 'maybe' }), ContractError)
})

test('session index is read-only and returns normalized metadata', async () => {
  const snapshot = await indexLocalSessions({ home: os.homedir(), providers: ['kimi'], limit: 2 })
  assert.equal(snapshot.type, 'SessionIndexSnapshot')
  assert.equal(snapshot.privacy.readOnly, true)
  assert.equal(snapshot.privacy.secretsRead, false)
  assert.equal(snapshot.privacy.messageBodiesRead, false)
  for (const session of snapshot.sessions) {
    assert.equal(session.source, 'kimi')
    assert.equal(session.capabilities.write, 'unavailable')
    assert.ok(session.nativeSessionId)
    assert.ok(session.cwd)
  }
})

test('session detail preserves the metadata-only boundary', async () => {
  const snapshot = await indexLocalSessions({ home: os.homedir(), providers: ['opencode'], limit: 1 })
  if (!snapshot.sessions.length) return
  const detail = await getSessionMetadata({ source: 'opencode', nativeSessionId: snapshot.sessions[0].nativeSessionId })
  assert.equal(detail.retrieval.level, 'metadata')
  assert.equal(detail.retrieval.messageBodiesRead, false)
  assert.equal(detail.retrieval.credentialsRead, false)
  assert.equal(detail.resume.requiresApproval, true)
  assert.equal(detail.resume.verified, false)
})

test('session index does not create control-plane state', async () => {
  const before = await fs.readdir(path.join(os.homedir(), '.local/state')).catch(() => [])
  await indexLocalSessions({ home: os.homedir(), providers: ['workbuddy'] })
  const after = await fs.readdir(path.join(os.homedir(), '.local/state')).catch(() => [])
  assert.deepEqual(after, before)
})

test('persistent store is idempotent and keeps execution state auditable', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-store-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const first = await store.createTask({ goal: '验证幂等任务' }, { idempotencyKey: 'task-1' })
    await assert.rejects(() => store.createTask({ goal: '不能伪造完成', status: 'completed' }, { idempotencyKey: 'task-completed' }), (error) => error instanceof StoreError && error.code === 'INVALID_INITIAL_STATUS')
    const replay = await store.createTask({ goal: '验证幂等任务' }, { idempotencyKey: 'task-1' })
    assert.equal(replay.replay, true)
    assert.equal(replay.task.id, first.task.id)
    await assert.rejects(() => store.createTask({ goal: '不同请求' }, { idempotencyKey: 'task-1' }), (error) => error instanceof StoreError && error.code === 'IDEMPOTENCY_CONFLICT')

    const created = await store.createExecution(first.task.id, { workerId: 'test-worker' }, { idempotencyKey: 'execution-1' })
    await store.updateExecutionStatus(created.execution.id, { status: 'running' }, { idempotencyKey: 'status-1' })
    await store.updateExecutionStatus(created.execution.id, { status: 'verifying' }, { idempotencyKey: 'status-2' })
    await store.updateExecutionStatus(created.execution.id, { status: 'reviewing' }, { idempotencyKey: 'status-3' })
    await store.addEvidence(created.execution.id, { kind: 'test', summary: '测试通过', source: 'node:test' }, { idempotencyKey: 'evidence-1' })
    const succeeded = await store.updateExecutionStatus(created.execution.id, { status: 'succeeded', outcome: 'verified' }, { idempotencyKey: 'status-4' })
    assert.equal(succeeded.execution.status, 'succeeded')
    assert.equal((await store.getTask(first.task.id)).task.status, 'reviewing')
    const audit = await store.listEvents({ entityId: first.task.id })
    assert.ok(audit.some((event) => event.type === 'task.created'))
    await store.addEvidence(created.execution.id, { kind: 'review', summary: '独立 review 通过', source: 'reviewer:test' }, { idempotencyKey: 'evidence-review-1' })
    const completionPlan = await store.completionPlan(first.task.id)
    assert.equal(completionPlan.ready, true)
    const completionApproval = await store.createApproval({ action: completionPlan.action, target: completionPlan.target, parametersDigest: completionPlan.parametersDigest }, { idempotencyKey: 'completion-approval' })
    await store.decideApproval(completionApproval.approval.id, { decision: 'approved', approvedBy: 'wechat:test' }, { idempotencyKey: 'completion-decision' })
    const completed = await store.completeTask(first.task.id, { approvalId: completionApproval.approval.id }, { idempotencyKey: 'completion-1' })
    assert.equal(completed.task.status, 'completed')

    const second = await store.createTask({ goal: '验证重启恢复' }, { idempotencyKey: 'task-2' })
    const running = await store.createExecution(second.task.id, { workerId: 'test-worker' }, { idempotencyKey: 'execution-2' })
    await store.updateExecutionStatus(running.execution.id, { status: 'running' }, { idempotencyKey: 'status-5' })
    const restarted = new ControlPlaneStore({ stateDir })
    const recovery = await restarted.recoverOnStartup()
    assert.deepEqual(recovery.blockedExecutionIds, [running.execution.id])
    assert.equal((await restarted.getTask(second.task.id)).task.status, 'blocked')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('session locks prevent overlapping executions and require owner/token to release', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-lock-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const sessionRefId = 'session:test:native-1'
    const lock = await store.acquireSessionLock(sessionRefId, { owner: 'chief', ttlMs: 10_000 }, { idempotencyKey: 'lock-1' })
    await assert.rejects(() => store.acquireSessionLock(sessionRefId, { owner: 'other', ttlMs: 10_000 }, { idempotencyKey: 'lock-2' }), (error) => error instanceof StoreError && error.code === 'SESSION_LOCKED')
    const task = await store.createTask({ goal: '验证会话锁' }, { idempotencyKey: 'lock-task' })
    await assert.rejects(() => store.createExecution(task.task.id, { workerId: 'worker', sessionRefId }, { idempotencyKey: 'locked-execution' }), (error) => error instanceof StoreError && error.code === 'SESSION_LOCKED')
    const lockedExecution = await store.createExecution(task.task.id, { workerId: 'worker', sessionRefId, sessionLockToken: lock.lock.token }, { idempotencyKey: 'owner-execution' })
    assert.equal(lockedExecution.execution.sessionRefId, sessionRefId)
    await assert.rejects(() => store.releaseSessionLock(sessionRefId, { owner: 'wrong' }, { idempotencyKey: 'unlock-wrong' }), (error) => error instanceof StoreError && error.code === 'LOCK_OWNER_MISMATCH')
    const released = await store.releaseSessionLock(sessionRefId, { token: lock.lock.token }, { idempotencyKey: 'unlock-1' })
    assert.equal(released.lock, undefined)
    await assert.rejects(() => store.createExecution(task.task.id, { workerId: 'worker', sessionRefId }, { idempotencyKey: 'unlocked-execution' }), (error) => error instanceof StoreError && error.code === 'SESSION_BUSY')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('approvals are scoped, expiring and single-use', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-approval-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const approval = await store.createApproval({
      action: 'cezar.dispatch',
      target: 'execution:test-1',
      parametersDigest: 'sha256:demo',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, { idempotencyKey: 'approval-1' })
    await assert.rejects(() => store.consumeApproval(approval.approval.id, { action: 'cezar.dispatch', target: 'execution:other', parametersDigest: 'sha256:demo' }, { idempotencyKey: 'consume-wrong' }), (error) => error instanceof StoreError && error.code === 'APPROVAL_NOT_APPROVED')
    await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'wechat:user-1' }, { idempotencyKey: 'decision-1' })
    const consumed = await store.consumeApproval(approval.approval.id, { action: 'cezar.dispatch', target: 'execution:test-1', parametersDigest: 'sha256:demo' }, { idempotencyKey: 'consume-1' })
    assert.ok(consumed.approval.usedAt)
    await assert.rejects(() => store.consumeApproval(approval.approval.id, { action: 'cezar.dispatch', target: 'execution:test-1', parametersDigest: 'sha256:demo' }, { idempotencyKey: 'consume-2' }), (error) => error instanceof StoreError && error.code === 'APPROVAL_ALREADY_USED')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('MCP exposes the same contracts without launching an external agent', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-mcp-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const initialized = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { store })
    assert.equal(initialized.result.serverInfo.name, 'personal-ai-os-control-plane')
    const tools = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { store })
    assert.ok(tools.result.tools.some((tool) => tool.name === 'create_task'))
    const created = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { goal: 'MCP task', idempotencyKey: 'mcp-task-1' } } }, { store })
    const payload = JSON.parse(created.result.content[0].text)
    assert.equal(payload.task.goal, 'MCP task')
    assert.equal((await store.snapshot()).executionCount, 0)
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('Cezar adapter dispatch is approval-bound and reconciles done to verifying', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-cezar-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'Cezar adapter test' }, { idempotencyKey: 'cezar-task' })
    const execution = await store.createExecution(task.task.id, { workerId: 'cezar:codex' }, { idempotencyKey: 'cezar-execution' })
    const dispatchParameters = { taskId: task.task.id, executionId: execution.execution.id, runner: 'codex', workflow: 'quick-task', worktree: true }
    const approval = await store.createApproval({ action: 'cezar.dispatch', target: execution.execution.id, parametersDigest: parametersDigest(dispatchParameters) }, { idempotencyKey: 'cezar-approval' })
    await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'test' }, { idempotencyKey: 'cezar-decision' })
    const fakeAdapter = {
      baseUrl: 'http://fake-cezar',
      start: async () => ({ id: 'run-cezar-1', status: 'queued' }),
      getRun: async () => ({ id: 'run-cezar-1', status: 'done' }),
    }
    const dispatched = await dispatchCezar({ store, adapter: fakeAdapter, taskId: task.task.id, executionId: execution.execution.id, approvalId: approval.approval.id, idempotencyKey: 'cezar-dispatch' })
    assert.equal(dispatched.execution.status, 'running')
    assert.equal(dispatched.execution.engineRef.id, 'run-cezar-1')
    const reconciled = await reconcileCezarExecution({ store, adapter: fakeAdapter, executionId: execution.execution.id, idempotencyKey: 'cezar-reconcile' })
    assert.equal(reconciled.execution.status, 'verifying')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('feature map separates detected capability from verified session support', async () => {
  const featureMap = await probeFeatureMap({
    sessionSnapshot: { sources: [{ provider: 'workbuddy', limitations: ['history unavailable'] }, { provider: 'devin', limitations: ['auth unverified'] }], sessions: [] },
    cezar: { health: async () => ({ capabilities: { dispatch: true } }) },
  })
  assert.equal(featureMap.type, 'FeatureMapSnapshot')
  assert.ok(featureMap.capabilities.some((capability) => capability.agentId === 'cezar-local' && capability.capabilities.includes('dispatch')))
  const workbuddy = featureMap.capabilities.find((capability) => capability.agentId === 'workbuddy-local')
  assert.ok(workbuddy)
  assert.ok(['unknown', 'unavailable'].includes(workbuddy.status))
})

test('Cezar cancellation is approval-bound', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-cezar-cancel-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'Cezar cancel test' }, { idempotencyKey: 'cancel-task' })
    const execution = await store.createExecution(task.task.id, { workerId: 'cezar:codex' }, { idempotencyKey: 'cancel-execution' })
    await store.updateExecutionStatus(execution.execution.id, { status: 'running' }, { idempotencyKey: 'cancel-running' })
    await store.attachExecutionRef(execution.execution.id, { engine: 'cezar', id: 'run-cancel-1', baseUrl: 'http://fake-cezar' }, { idempotencyKey: 'cancel-attach' })
    const plan = cezarCancelPlan({ executionId: execution.execution.id })
    const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'cancel-approval' })
    await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'test' }, { idempotencyKey: 'cancel-decision' })
    const cancelled = await cancelCezarExecution({ store, executionId: execution.execution.id, approvalId: approval.approval.id, adapter: { cancel: async () => ({ cancelled: true }) }, idempotencyKey: 'cancel-dispatch' })
    assert.equal(cancelled.execution.status, 'cancelled')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('native ACP probe lists sessions without loading or prompting', async () => {
  const script = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => { const m = JSON.parse(line); if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'fake-acp'},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{}}}}})+'\\n'); if (m.method === 'session/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessions:[{sessionId:'native-1',cwd:'/tmp',title:'fake',updatedAt:'2026-10-06T00:00:00.000Z'}]}})+'\\n'); if (m.method === 'session/load') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{modes:[]}})+'\\n'); });
  `
  const probe = await listNativeAcpSessions({ source: 'fake', command: process.execPath, args: ['-e', script], cwd: '/tmp' })
  assert.equal(probe.verified, true)
  assert.equal(probe.sessions.length, 1)
  assert.equal(probe.sessions[0].nativeSessionId, 'native-1')
  assert.equal(probe.sessions[0].capabilities.resume, 'available')
  const loaded = await listNativeAcpSessions({ source: 'fake', command: process.execPath, args: ['-e', script], cwd: '/tmp', loadSessionId: 'native-1' })
  assert.deepEqual(loaded.loadProbe, { sessionId: 'native-1', succeeded: true, responseKeys: ['modes'] })
})

test('Cezar adapter parses run SSE events', async () => {
  const adapter = new CezarAdapter({
    baseUrl: 'http://fake-cezar',
    fetchImpl: async () => new Response('id: 3\nevent: run\ndata: {"id":"run-1","status":"done"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  const events = []
  for await (const event of adapter.events('run-1')) events.push(event)
  assert.deepEqual(events, [{ id: '3', event: 'run', data: { id: 'run-1', status: 'done' } }])
})

test('Cezar SSE watcher maps terminal done to VERIFYING', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-cezar-watch-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'watch test' }, { idempotencyKey: 'watch-task' })
    const execution = await store.createExecution(task.task.id, { workerId: 'cezar:codex' }, { idempotencyKey: 'watch-execution' })
    await store.updateExecutionStatus(execution.execution.id, { status: 'running' }, { idempotencyKey: 'watch-running' })
    await store.attachExecutionRef(execution.execution.id, { engine: 'cezar', id: 'run-watch-1' }, { idempotencyKey: 'watch-attach' })
    const watched = await watchCezarExecution({ store, executionId: execution.execution.id, adapter: { events: async function* () { yield { id: '1', event: 'run', data: { status: 'done' } } } } })
    assert.equal(watched.execution.status, 'verifying')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})
