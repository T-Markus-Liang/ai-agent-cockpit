import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ControlPlaneStore, StoreError } from '../control-plane/store.mjs'
import { callTool, handleMcpRequest } from '../interfaces/mcp/server.mjs'
import { cezarDispatchPlan, dispatchCezar } from '../control-plane/dispatcher.mjs'
import { nativePromptPlan, executeNativeSessionPrompt } from '../control-plane/native-acp-executor.mjs'

const GIT_A = `git:${'a'.repeat(40)}`
const ROOT = process.cwd()
let counter = 0
const key = () => `key-${++counter}`
const tempDirs = []

async function newStore() {
  const dir = await fs.mkdtemp(path.join(ROOT, 'tmp-approval-authority-'))
  tempDirs.push(dir)
  return new ControlPlaneStore({ stateDir: dir })
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const operator = { authenticated: true, role: 'operator', id: 'operator-1' }
const coordinator = { authenticated: true, role: 'coordinator', id: 'coordinator-1' }

function textOf(response) {
  return response.result.content[0].text
}

async function call(request, deps) {
  return handleMcpRequest(request, deps)
}

test('createApproval rejects approved-on-create and prefilled approver before mutating', async () => {
  const store = await newStore()
  const base = { action: 'task.complete', target: 'task-1', parametersDigest: 'sha256:abc' }
  await assert.rejects(store.createApproval({ ...base, decision: 'approved' }, { idempotencyKey: key() }), (error) => error instanceof StoreError && error.code === 'APPROVAL_DECISION_FORBIDDEN')
  await assert.rejects(store.createApproval({ ...base, decision: 'rejected' }, { idempotencyKey: key() }), (error) => error instanceof StoreError && error.code === 'APPROVAL_DECISION_FORBIDDEN')
  await assert.rejects(store.createApproval({ ...base, approvedBy: 'self' }, { idempotencyKey: key() }), (error) => error instanceof StoreError && error.code === 'APPROVAL_APPROVER_FORBIDDEN')
  await assert.rejects(store.createApproval({ ...base, usedAt: new Date().toISOString() }, { idempotencyKey: key() }), (error) => error instanceof StoreError && error.code === 'APPROVAL_USED_AT_FORBIDDEN')
  assert.equal((await store.listApprovals()).length, 0)
  assert.equal((await store.listEvents()).length, 0)
})

test('pending creation then trusted operator decide and consume still works', async () => {
  const store = await newStore()
  const created = await store.createApproval({ action: 'task.complete', target: 'task-1', parametersDigest: 'sha256:abc' }, { idempotencyKey: key() })
  assert.equal(created.approval.decision, 'pending')
  assert.equal(created.approval.approvedBy, undefined)
  const decided = await store.decideApproval(created.approval.id, { decision: 'approved', approvedBy: 'trusted-test-operator' }, { idempotencyKey: key() })
  assert.equal(decided.approval.decision, 'approved')
  assert.equal(decided.approval.approvedBy, 'trusted-test-operator')
  const consumed = await store.consumeApproval(created.approval.id, { action: 'task.complete', target: 'task-1', parametersDigest: 'sha256:abc' }, { idempotencyKey: key() })
  assert.ok(consumed.approval.usedAt)
})

test('restricted authority tools are omitted from agent tools/list and guarded when called by name', async () => {
  const store = await newStore()
  const agentPrincipals = [
    undefined,
    { authenticated: true, role: 'chief', id: 'chief-1' },
    { authenticated: true, role: 'agent', id: 'agent-1' },
    { authenticated: true, role: 'unknown-role', id: 'x-1' },
    { authenticated: false, role: 'operator', id: 'forged-1' },
    { authenticated: true, role: 'operator' },
  ]
  const restricted = ['decide_approval', 'update_execution_status', 'add_evidence']
  for (const principal of agentPrincipals) {
    const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { store, principal })
    const names = listed.result.tools.map((tool) => tool.name)
    for (const toolName of restricted) assert.equal(names.includes(toolName), false, `${toolName} must stay hidden`)
    for (const toolName of restricted) {
      const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: {} } }, { store, principal })
      assert.equal(response.result.isError, true, `${toolName} must be rejected`)
    }
    await assert.rejects(callTool('decide_approval', { approvalId: 'approval-x', decision: 'approved', idempotencyKey: key() }, { store, principal }))
  }

  const task = await store.createTask({ goal: 'guard' }, { idempotencyKey: key() })
  const execution = await store.createExecution(task.task.id, { workerId: 'w1' }, { idempotencyKey: key() })
  const approval = await store.createApproval({ action: 'task.complete', target: 'task-legit', parametersDigest: 'sha256:z' }, { idempotencyKey: key() })
  for (const principal of agentPrincipals) {
    await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_execution_status', arguments: { executionId: execution.execution.id, status: 'running', idempotencyKey: key() } } }, { store, principal })
    await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_evidence', arguments: { executionId: execution.execution.id, summary: 'forged', source: 'model', idempotencyKey: key() } } }, { store, principal })
  }
  assert.equal((await store.getExecution(execution.execution.id)).status, 'queued')
  assert.equal((await store.getApproval(approval.approval.id)).decision, 'pending')
  assert.equal((await store.getTask(task.task.id)).evidence.length, 0)
  assert.equal((await store.snapshot()).evidenceCount, 0)
})

test('authorized operator and coordinator use authoritative principal identity', async () => {
  const store = await newStore()
  const opList = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { store, principal: operator })
  const opNames = opList.result.tools.map((tool) => tool.name)
  for (const toolName of ['decide_approval', 'update_execution_status', 'add_evidence']) assert.ok(opNames.includes(toolName), `operator must see ${toolName}`)
  const coList = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { store, principal: coordinator })
  const coNames = coList.result.tools.map((tool) => tool.name)
  assert.equal(coNames.includes('decide_approval'), false)
  assert.ok(coNames.includes('update_execution_status'))
  assert.ok(coNames.includes('add_evidence'))

  const approval = await store.createApproval({ action: 'task.complete', target: 'task-1', parametersDigest: 'sha256:z' }, { idempotencyKey: key() })
  const decided = await callTool('decide_approval', { approvalId: approval.approval.id, decision: 'approved', idempotencyKey: key() }, { store, principal: operator })
  assert.equal(decided.approval.decision, 'approved')
  assert.equal(decided.approval.approvedBy, 'operator-1')

  const conflicting = await store.createApproval({ action: 'task.complete', target: 'task-2', parametersDigest: 'sha256:y' }, { idempotencyKey: key() })
  const forged = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId: conflicting.approval.id, decision: 'approved', approvedBy: 'forged-approver', idempotencyKey: key() } } }, { store, principal: operator })
  assert.equal(forged.result.isError, true)
  assert.equal((await store.getApproval(conflicting.approval.id)).decision, 'pending')

  const matching = await callTool('decide_approval', { approvalId: conflicting.approval.id, decision: 'approved', approvedBy: 'operator-1', idempotencyKey: key() }, { store, principal: operator })
  assert.equal(matching.approval.approvedBy, 'operator-1')

  const task = await store.createTask({ goal: 'coord' }, { idempotencyKey: key() })
  const execution = await store.createExecution(task.task.id, { workerId: 'w1' }, { idempotencyKey: key() })
  const updated = await callTool('update_execution_status', { executionId: execution.execution.id, status: 'running', idempotencyKey: key() }, { store, principal: coordinator })
  assert.equal(updated.execution.status, 'running')
  const evidence = await callTool('add_evidence', { executionId: execution.execution.id, summary: 'checks', source: 'coordinator', idempotencyKey: key() }, { store, principal: coordinator })
  assert.ok(evidence.evidence.id)
  const coApproval = await store.createApproval({ action: 'a', target: 't', parametersDigest: 'sha256:w' }, { idempotencyKey: key() })
  await assert.rejects(callTool('decide_approval', { approvalId: coApproval.approval.id, decision: 'approved', idempotencyKey: key() }, { store, principal: coordinator }), (error) => error.code === 'MCP_NOT_AUTHORIZED')
})

test('unknown command/args/env and hidden authority args reject before effects and never leak values', async () => {
  const store = await newStore()
  const SENTINEL = 'SENTINEL-do-not-leak-9f3a'
  const task = await store.createTask({ goal: 'hidden-args' }, { idempotencyKey: key() })
  const execution = await store.createExecution(task.task.id, { workerId: 'w1' }, { idempotencyKey: key() })
  const before = await store.snapshot()

  const cases = [
    { name: 'prompt_native_session', arguments: { taskId: task.task.id, executionId: execution.execution.id, approvalId: 'approval-x', source: SENTINEL, nativeSessionId: SENTINEL, cwd: '/tmp', prompt: SENTINEL, command: SENTINEL, args: [SENTINEL], env: { [SENTINEL]: SENTINEL }, idempotencyKey: key() } },
    { name: 'plan_route', arguments: { goal: SENTINEL, candidates: [], jevCommand: SENTINEL } },
    { name: 'create_task', arguments: { goal: SENTINEL, idempotencyKey: key(), store: SENTINEL, principal: SENTINEL, role: SENTINEL, approvedBy: SENTINEL } },
    { name: 'create_execution', arguments: { taskId: task.task.id, workerId: SENTINEL, idempotencyKey: key(), command: SENTINEL, env: SENTINEL } },
    { name: `exfil_${SENTINEL}`, arguments: { goal: SENTINEL } },
  ]
  for (const [index, item] of cases.entries()) {
    const response = await call({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: item.name, arguments: item.arguments } }, { store })
    assert.equal(response.result.isError, true)
    assert.equal(textOf(response).includes(SENTINEL), false)
  }

  const badShape = await call({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'create_task', arguments: SENTINEL } }, { store })
  assert.equal(badShape.result.isError, true)
  assert.equal(textOf(badShape).includes(SENTINEL), false)

  const after = await store.snapshot()
  assert.deepEqual({ tasks: after.taskCount, executions: after.executionCount, evidence: after.evidenceCount }, { tasks: before.taskCount, executions: before.executionCount, evidence: before.evidenceCount })
  assert.equal((await store.listApprovals()).length, 0)
})

test('legitimate create/get/plan flow is preserved for the default agent channel', async () => {
  const store = await newStore()
  const created = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { goal: 'legit', idempotencyKey: key() } } }, { store })
  const payload = JSON.parse(textOf(created))
  assert.equal(payload.task.goal, 'legit')
  const got = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task', arguments: { taskId: payload.task.id } } }, { store })
  assert.equal(JSON.parse(textOf(got)).task.id, payload.task.id)
  const plan = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'plan_task_completion', arguments: { taskId: payload.task.id } } }, { store })
  assert.equal(JSON.parse(textOf(plan)).ready, false)
  const exec = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_execution', arguments: { taskId: payload.task.id, workerId: 'w1', artifactRef: GIT_A, idempotencyKey: key() } } }, { store })
  assert.equal(JSON.parse(textOf(exec)).execution.artifactRef, GIT_A)
})

test('viewer and unknown identities cannot call unadvertised mutating tools', async () => {
  const store = await newStore()
  for (const principal of [{ authenticated: true, role: 'viewer', id: 'viewer-1' }, { authenticated: true, role: 'invented', id: 'invented-1' }]) {
    const listing = await handleMcpRequest({ id: 1, method: 'tools/list' }, { store, principal })
    assert.equal(listing.result.tools.some(tool => tool.name === 'create_task'), false)
    await assert.rejects(() => callTool('create_task', { goal: 'never-create', idempotencyKey: key() }, { store, principal }), error => error.code === 'MCP_NOT_AUTHORIZED')
  }
  assert.equal((await store.snapshot()).taskCount, 0)
})

test('accessors/non-JSON arguments are rejected without executing code or creating rows', async () => {
  const store = await newStore(); let reads = 0
  const args = { idempotencyKey: key() }
  Object.defineProperty(args, 'goal', { enumerable: true, get() { reads++; return 'unexpected'; } })
  await assert.rejects(() => callTool('create_task', args, { store }), error => error.code === 'MCP_INVALID_ARGUMENTS')
  assert.equal(reads, 0); assert.equal((await store.snapshot()).taskCount, 0)
})

test('strict Cezar dispatch rejects legacy-looking approvals before calling the engine', async () => {
  const store = await newStore(), task = await store.createTask({ goal: 'strict dispatch' }, { idempotencyKey: key() })
  const exec = await store.createExecution(task.task.id, { workerId: 'synthetic' }, { idempotencyKey: key() })
  const input = { taskId: task.task.id, executionId: exec.execution.id }
  const plan = cezarDispatchPlan(input)
  const created = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest, expiresAt: new Date(Date.now() + 60000).toISOString() }, { idempotencyKey: key() })
  await store.decideApproval(created.approval.id, { decision: 'approved', approvedBy: operator.id }, { idempotencyKey: key() })
  let starts = 0
  const adapter = { start: async () => { starts++; return { id: 'synthetic', status: 'queued' } } }
  await assert.rejects(() => dispatchCezar({ ...input, store, adapter, approvalId: created.approval.id, requireOperator: true, idempotencyKey: key() }), error => error.code === 'APPROVAL_AUTHORITY_REQUIRED')
  assert.equal(starts, 0); assert.equal((await store.getExecution(exec.execution.id)).status, 'queued')
  await store.decideApproval(created.approval.id, { decision: 'approved', approvedBy: operator.id }, { idempotencyKey: key(), principal: operator })
  const result = await dispatchCezar({ ...input, store, adapter, approvalId: created.approval.id, requireOperator: true, idempotencyKey: key() })
  assert.equal(starts, 1); assert.equal(result.execution.status, 'running')
})

test('strict native prompt rejects an unverified approval before any process starts', async () => {
  const store = await newStore(), task = await store.createTask({ goal: 'strict native' }, { idempotencyKey: key() })
  const exec = await store.createExecution(task.task.id, { workerId: 'synthetic', sessionRefId: 'session:codex:synthetic' }, { idempotencyKey: key() })
  const input = { taskId: task.task.id, executionId: exec.execution.id, source: 'codex', nativeSessionId: 'synthetic', sessionRefId: 'session:codex:synthetic', cwd: ROOT, prompt: 'synthetic' }
  const plan = nativePromptPlan(input)
  const created = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest, expiresAt: new Date(Date.now() + 60000).toISOString() }, { idempotencyKey: key() })
  await store.decideApproval(created.approval.id, { decision: 'approved', approvedBy: operator.id }, { idempotencyKey: key() })
  await assert.rejects(() => executeNativeSessionPrompt({ ...input, store, approvalId: created.approval.id, command: '/does-not-exist-never-spawn', requireOperator: true, idempotencyKey: key() }), error => error.code === 'APPROVAL_AUTHORITY_REQUIRED')
  // Launch-intent-first ordering (P4 gap 2): the engine ref + `running` are
  // registered BEFORE the approval is consumed, so an unauthorized launch is
  // honestly `blocked` with the (un-authorized) launch-intent ref retained —
  // never left `queued` and never spawned. No process starts either way.
  const refused = await store.getExecution(exec.execution.id)
  assert.equal(refused.status, 'blocked')
  assert.deepEqual(refused.engineRef, { engine: 'native-acp', id: 'codex:synthetic', source: 'codex', nativeSessionId: 'synthetic', sessionRefId: 'session:codex:synthetic', cwd: ROOT })
  assert.equal((await store.getApproval(created.approval.id)).usedAt, undefined)
})
