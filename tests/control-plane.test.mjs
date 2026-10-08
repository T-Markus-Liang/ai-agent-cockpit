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
import { executeNativeSessionPrompt, nativePromptPlan, runNativeAcpPrompt } from '../control-plane/native-acp-executor.mjs'
import { buildRoutePlan } from '../control-plane/router.mjs'
import { createReviewerExecution } from '../control-plane/reviewer.mjs'

test('contracts keep Task, SessionRef and Execution separate', () => {
  const task = createTask({ goal: '检查本机 agent 状态', acceptanceCriteria: ['输出可追溯证据'] })
  const session = createSessionRef({ source: 'test', nativeSessionId: 'native-1', cwd: '/tmp', title: '测试会话' })
  const execution = createExecution({ taskId: task.id, workerId: 'test-worker', sessionRefId: session.id })
  assert.equal(task.type, 'Task')
  assert.equal(session.type, 'SessionRef')
  assert.equal(execution.type, 'Execution')
  assert.equal(execution.taskId, task.id)
  assert.equal(execution.sessionRefId, session.id)
  // accountId is optional and never fabricated: absent by default, a non-empty
  // string when a real account source supplies it, rejected when blank.
  assert.equal('accountId' in session, false, 'accountId must be absent when no real account source exists')
  assert.equal(createSessionRef({ source: 'test', nativeSessionId: 'n', cwd: '/tmp', accountId: 'acct-1' }).accountId, 'acct-1')
  assert.throws(() => createSessionRef({ source: 'test', nativeSessionId: 'n', cwd: '/tmp', accountId: '' }), ContractError)
})

test('contracts reject empty goals and invalid approvals', () => {
  assert.throws(() => createTask({ goal: '' }), ContractError)
  assert.throws(() => createApproval({ action: 'send', target: 'wechat', parametersDigest: 'x', decision: 'maybe' }), ContractError)
})

test('Execution.role is an optional worker|reviewer enum and is never fabricated', () => {
  const base = { taskId: 'task-1', workerId: 'w1' }
  assert.equal('role' in createExecution(base), false, 'role is absent by default (worker semantics; no back-fill)')
  assert.equal(createExecution({ ...base, role: 'worker' }).role, 'worker')
  assert.equal(createExecution({ ...base, role: 'reviewer' }).role, 'reviewer')
  assert.throws(() => createExecution({ ...base, role: 'chief' }), ContractError)
  assert.throws(() => createExecution({ ...base, role: '' }), ContractError)
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

    const artifactRef = `git:${'a'.repeat(40)}`
    const created = await store.createExecution(first.task.id, { workerId: 'test-worker', artifactRef }, { idempotencyKey: 'execution-1' })
    await store.updateExecutionStatus(created.execution.id, { status: 'running' }, { idempotencyKey: 'status-1' })
    await store.updateExecutionStatus(created.execution.id, { status: 'verifying' }, { idempotencyKey: 'status-2' })
    await store.updateExecutionStatus(created.execution.id, { status: 'reviewing' }, { idempotencyKey: 'status-3' })
    await store.addEvidence(created.execution.id, { kind: 'test', summary: '测试通过', source: 'node:test', exitCode: 0, artifactRef }, { idempotencyKey: 'evidence-1' })
    const succeeded = await store.updateExecutionStatus(created.execution.id, { status: 'succeeded', outcome: 'verified' }, { idempotencyKey: 'status-4' })
    assert.equal(succeeded.execution.status, 'succeeded')
    assert.equal((await store.getTask(first.task.id)).task.status, 'reviewing')
    const audit = await store.listEvents({ entityId: first.task.id })
    assert.ok(audit.some((event) => event.type === 'task.created'))
    const reviewer = await store.createExecution(first.task.id, { workerId: 'reviewer', parentExecutionId: created.execution.id, artifactRef }, { idempotencyKey: 'reviewer-1' })
    for (const status of ['running', 'verifying', 'reviewing', 'succeeded']) await store.updateExecutionStatus(reviewer.execution.id, { status }, { idempotencyKey: `reviewer-${status}` })
    await store.addEvidence(reviewer.execution.id, { kind: 'review', summary: '独立 review 通过', source: 'reviewer:test', verdict: 'passed', reviewOfExecutionId: created.execution.id, artifactRef }, { idempotencyKey: 'evidence-review-1' })
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
    assert.equal((await store.listApprovals({ decision: 'pending' })).length, 1)
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
    memoryProbe: async () => ({ status: 'unavailable' }),
  })
  assert.equal(featureMap.type, 'FeatureMapSnapshot')
  assert.ok(featureMap.capabilities.some((capability) => capability.agentId === 'cezar-local' && capability.capabilities.includes('dispatch')))
  const workbuddy = featureMap.capabilities.find((capability) => capability.agentId === 'workbuddy-local')
  assert.ok(workbuddy)
  assert.ok(['unknown', 'unavailable'].includes(workbuddy.status))
})

test('feature map reflects Kimi conversation primary and memory health separately from workers', async () => {
  const featureMap = await probeFeatureMap({
    sessionSnapshot: { sources: [], sessions: [] }, conversationPreset: 'kimi-primary',
    cezar: { health: async () => ({ capabilities: {} }) },
    memoryProbe: async () => ({ status: 'ready', engine: 'mem0-oss', ingestion: { pending: 1, retrying: 0 } }),
  })
  assert.equal(featureMap.conversation.provider, 'kimi')
  assert.equal(featureMap.conversation.evidence, 'configuration')
  assert.equal(featureMap.capabilities.find(item => item.provider === 'kimi').role, 'chief')
  assert.equal(featureMap.capabilities.find(item => item.provider === 'codex').role, 'worker')
  assert.equal(featureMap.services.memory.status, 'ready')
  assert.equal(featureMap.services.memory.ingestion.pending, 1)
  assert.equal(featureMap.capabilities.some(item => item.provider === 'mem0'), false)
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

test('native ACP resume+prompt executor is approval-bound and ends in VERIFYING', async () => {
  const script = `
    const readline = require('node:readline'); const rl = readline.createInterface({input:process.stdin}); const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
    rl.on('line', line => { const m=JSON.parse(line); if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'fake'},agentCapabilities:{loadSession:true}}}); if(m.method==='session/load') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[]}}); if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'继续结果'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})} });
  `
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-native-exec-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: '继续原生会话' }, { idempotencyKey: 'native-task' })
    const execution = await store.createExecution(task.task.id, { workerId: 'codex:native', sessionRefId: 'session:codex:native-1' }, { idempotencyKey: 'native-execution' })
    const plan = nativePromptPlan({ taskId: task.task.id, executionId: execution.execution.id, source: 'codex', nativeSessionId: 'native-1', sessionRefId: 'session:codex:native-1', cwd: '/tmp', prompt: '继续' })
    const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'native-approval' })
    await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'test' }, { idempotencyKey: 'native-decision' })
    const result = await executeNativeSessionPrompt({ store, taskId: task.task.id, executionId: execution.execution.id, approvalId: approval.approval.id, source: 'codex', nativeSessionId: 'native-1', sessionRefId: 'session:codex:native-1', cwd: '/tmp', prompt: '继续', command: process.execPath, args: ['-e', script], idempotencyKey: 'native-run' })
    assert.equal(result.reply, '继续结果')
    assert.equal(result.execution.status, 'verifying')
    const evidence = (await store.getTask(task.task.id)).evidence
    const message = evidence.find((item) => item.kind === 'message')
    assert.equal(message.summary, '继续结果', 'the prompt text is recorded as a message Evidence')
    assert.ok(evidence.some((item) => item.kind === 'log' && item.summary.includes('外部占用探测')), 'the launch also records the occupancy observation (V41)')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('native ACP resume+prompt executor records non-empty evidence when the model refuses', async () => {
  const script = `
    const readline = require('node:readline'); const rl = readline.createInterface({input:process.stdin}); const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
    rl.on('line', line => { const m=JSON.parse(line); if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:'fake'},agentCapabilities:{loadSession:true}}}); if(m.method==='session/load') send({jsonrpc:'2.0',id:m.id,result:{configOptions:[]}}); if(m.method==='session/prompt') send({jsonrpc:'2.0',id:m.id,result:{stopReason:'refusal'}}); });
  `
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-native-refusal-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: '继续原生会话（拒答）' }, { idempotencyKey: 'native-refusal-task' })
    const execution = await store.createExecution(task.task.id, { workerId: 'workbuddy:native', sessionRefId: 'session:workbuddy:native-refusal' }, { idempotencyKey: 'native-refusal-execution' })
    const plan = nativePromptPlan({ taskId: task.task.id, executionId: execution.execution.id, source: 'workbuddy', nativeSessionId: 'native-refusal', sessionRefId: 'session:workbuddy:native-refusal', cwd: '/tmp', prompt: '继续' })
    const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: 'native-refusal-approval' })
    await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'test' }, { idempotencyKey: 'native-refusal-decision' })
    const result = await executeNativeSessionPrompt({ store, taskId: task.task.id, executionId: execution.execution.id, approvalId: approval.approval.id, source: 'workbuddy', nativeSessionId: 'native-refusal', sessionRefId: 'session:workbuddy:native-refusal', cwd: '/tmp', prompt: '继续', command: process.execPath, args: ['-e', script], idempotencyKey: 'native-refusal-run' })
    assert.equal(result.reply, '')
    assert.equal(result.stopReason, 'refusal')
    assert.equal(result.execution.status, 'verifying')
    const evidence = (await store.getTask(task.task.id)).evidence
    const message = evidence.find((item) => item.kind === 'message')
    assert.equal(typeof message.summary, 'string')
    assert.ok(message.summary.trim().length > 0)
    assert.equal(message.summary, 'native ACP prompt returned no text (stopReason=refusal)')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('route plan applies capability and policy gates without side effects', async () => {
  const plan = await buildRoutePlan({
    goal: '继续旧代码会话并运行测试',
    policy: { requireNativeResume: true, requireMcp: true, externalMessage: false },
    candidates: [
      { id: 'codex', provider: 'codex', status: 'ready', capabilities: ['native.session.load', 'acp', 'mcp'] },
      { id: 'devin', provider: 'devin', status: 'unknown', capabilities: ['native.session.list', 'acp', 'mcp'], limitations: ['auth unverified'] },
      { id: 'gui', provider: 'gui', status: 'ready', capabilities: ['external.message'] },
    ],
  })
  assert.equal(plan.selected.id, 'codex')
  assert.equal(plan.sideEffects, false)
  assert.equal(plan.requiresApproval, true)
  assert.equal(plan.candidates.find((candidate) => candidate.id === 'gui').eligible, false)
})

test('reviewer execution is an independent auditable child', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-review-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'review test' }, { idempotencyKey: 'review-task' })
    const source = await store.createExecution(task.task.id, { workerId: 'codex' }, { idempotencyKey: 'review-source' })
    for (const [index, status] of ['running', 'verifying', 'reviewing', 'succeeded'].entries()) await store.updateExecutionStatus(source.execution.id, { status }, { idempotencyKey: `review-status-${index}` })
    const review = await createReviewerExecution({ store, taskId: task.task.id, sourceExecutionId: source.execution.id, reviewerId: 'opencode-reviewer', idempotencyKey: 'review-child' })
    assert.equal(review.reviewOf, source.execution.id)
    assert.equal(review.independent, true)
    assert.equal(review.execution.parentExecutionId, source.execution.id)
    assert.equal(review.execution.role, 'reviewer', 'a reviewer child is marked with the reviewer role')
    assert.equal('role' in source.execution, false, 'the source worker execution carries no role (worker is implicit)')
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('store.createExecution passes role through and rejects an illegal role', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-role-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'role passthrough' }, { idempotencyKey: 'role-task' })
    const worker = await store.createExecution(task.task.id, { workerId: 'w1' }, { idempotencyKey: 'role-worker' })
    assert.equal('role' in worker.execution, false, 'an execution without a role keeps worker semantics (no fabrication)')
    const reviewer = await store.createExecution(task.task.id, { workerId: 'r1', role: 'reviewer' }, { idempotencyKey: 'role-reviewer' })
    assert.equal(reviewer.execution.role, 'reviewer')
    await assert.rejects(
      () => store.createExecution(task.task.id, { workerId: 'x1', role: 'chief' }, { idempotencyKey: 'role-bad' }),
      (error) => error instanceof ContractError,
      'an illegal role is refused by the contract even through the store',
    )
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})
