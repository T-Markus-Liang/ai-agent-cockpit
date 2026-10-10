import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { verifyGrant } from '../control-plane/execution-grant.mjs'

const PORT = 4397

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('control-plane HTTP test server did not start')
}

async function request(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, options)
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = text }
  return { response, body }
}

test('HTTP control plane covers task lifecycle, approval, audit and MCP boundaries', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-http-suite-'))
  const child = spawn(process.execPath, ['gateway/control-plane.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, CONTROL_PLANE_PORT: String(PORT), PERSONAL_AI_OS_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForHealth()

    const health = await request('/health')
    assert.equal(health.body.status, 'ok')
    assert.equal(health.body.persistence.taskCount, 0)

    const missingKey = await request('/api/control-plane/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'missing key' }),
    })
    assert.equal(missingKey.response.status, 400)
    assert.equal(missingKey.body.error, 'IDEMPOTENCY_REQUIRED')

    const create = await request('/api/control-plane/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-task-1' },
      body: JSON.stringify({ goal: 'HTTP lifecycle test', acceptanceCriteria: ['test', 'review'] }),
    })
    assert.equal(create.response.status, 201)
    const taskId = create.body.task.id
    const replay = await request('/api/control-plane/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-task-1' },
      body: JSON.stringify({ goal: 'HTTP lifecycle test', acceptanceCriteria: ['test', 'review'] }),
    })
    assert.equal(replay.response.status, 200)
    assert.equal(replay.body.replay, true)
    assert.equal(replay.body.task.id, taskId)

    const conflict = await request('/api/control-plane/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-task-1' },
      body: JSON.stringify({ goal: 'different request' }),
    })
    assert.equal(conflict.response.status, 409)
    assert.equal(conflict.body.error, 'IDEMPOTENCY_CONFLICT')

    const execution = await request(`/api/control-plane/tasks/${taskId}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-execution-1' },
      body: JSON.stringify({ workerId: 'codex', artifactRef: `git:${'a'.repeat(40)}` }),
    })
    assert.equal(execution.response.status, 201)
    const executionId = execution.body.execution.id
    // (S03b) the HTTP entry issues the admission Grant before enqueue and
    // persists it with the record: structurally valid, bound to this
    // task/execution/digest, and verifiable under the real clock — so a later
    // dispatch is never refused GRANT_MISSING for an entry-created execution.
    const httpGrant = verifyGrant(execution.body.execution.grant, { taskId, executionId, parametersDigest: execution.body.execution.parametersDigest, now: Date.now })
    assert.equal(httpGrant.effectiveDeadlineAt <= Date.now() + 30 * 60_000, true, 'the default lifetime cap participates in the effective deadline')
    // a retry with the same Idempotency-Key replays (deterministic derived id,
    // clock fields excluded from the fingerprint) instead of conflicting
    const executionReplay = await request(`/api/control-plane/tasks/${taskId}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-execution-1' },
      body: JSON.stringify({ workerId: 'codex', artifactRef: `git:${'a'.repeat(40)}` }),
    })
    assert.equal(executionReplay.response.status, 200)
    assert.equal(executionReplay.body.replay, true)
    assert.equal(executionReplay.body.execution.id, executionId)
    // caller-supplied grant material is stripped and re-issued by the host
    // (probed on a SEPARATE task so the lifecycle task above stays completable)
    const probeTask = await request('/api/control-plane/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-task-grant-probes' },
      body: JSON.stringify({ goal: 'grant probe task' }),
    })
    const probeTaskId = probeTask.body.task.id
    const forged = await request(`/api/control-plane/tasks/${probeTaskId}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-execution-forged' },
      body: JSON.stringify({ workerId: 'codex', grant: { version: 1, grantId: 'grant_forged' }, parametersDigest: 'sha256:forged' }),
    })
    assert.equal(forged.response.status, 201)
    assert.notEqual(forged.body.execution.grant.grantId, 'grant_forged', 'a caller can never supply its own admission artifact')
    verifyGrant(forged.body.execution.grant, { taskId: probeTaskId, executionId: forged.body.execution.id, parametersDigest: forged.body.execution.parametersDigest, now: Date.now })
    // negative: an illegal request-level expiresAt is refused and nothing is enqueued
    const countBefore = (await request('/health')).body.persistence.executionCount
    const badDeadline = await request(`/api/control-plane/tasks/${probeTaskId}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-execution-bad-expiry' },
      body: JSON.stringify({ workerId: 'codex', expiresAt: 'not-a-timestamp' }),
    })
    assert.equal(badDeadline.response.status, 400)
    assert.equal(badDeadline.body.error, 'GRANT_INVALID')
    assert.equal((await request('/health')).body.persistence.executionCount, countBefore, 'a refused admission never enqueues')

    const invalidStatus = await request(`/api/control-plane/executions/${executionId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-invalid-status' },
      body: JSON.stringify({ status: 'succeeded' }),
    })
    assert.equal(invalidStatus.response.status, 409)
    assert.equal(invalidStatus.body.error, 'INVALID_TRANSITION')

    for (const [index, status] of ['running', 'verifying', 'reviewing', 'succeeded'].entries()) {
      const changed = await request(`/api/control-plane/executions/${executionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `http-status-${index}` },
        body: JSON.stringify({ status }),
      })
      assert.equal(changed.response.status, 200)
      assert.equal(changed.body.execution.status, status)
    }

    const reviewer = await request(`/api/control-plane/tasks/${taskId}/executions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-reviewer' },
      body: JSON.stringify({ workerId: 'kimi', parentExecutionId: executionId, artifactRef: `git:${'a'.repeat(40)}` }),
    })
    const reviewerId = reviewer.body.execution.id
    for (const status of ['running', 'verifying', 'reviewing', 'succeeded']) await request(`/api/control-plane/executions/${reviewerId}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `http-reviewer-${status}` }, body: JSON.stringify({ status }),
    })
    for (const [index, [kind, summary]] of [['test', 'node:test passed'], ['review', 'independent reviewer passed']].entries()) {
      const evidence = await request(`/api/control-plane/executions/${kind === 'review' ? reviewerId : executionId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `http-evidence-${index}` },
        body: JSON.stringify({ kind, summary, source: 'http-suite', artifactRef: `git:${'a'.repeat(40)}`, ...(kind === 'test' ? { exitCode: 0 } : { verdict: 'passed', reviewOfExecutionId: executionId }) }),
      })
      assert.equal(evidence.response.status, 201)
    }

    const plan = await request(`/api/control-plane/tasks/${taskId}/completion-plan`)
    assert.equal(plan.body.ready, true)
    const approval = await request('/api/control-plane/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-approval-create' },
      body: JSON.stringify({ action: plan.body.action, target: plan.body.target, parametersDigest: plan.body.parametersDigest }),
    })
    const decision = await request(`/api/control-plane/approvals/${approval.body.approval.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-approval-decision' },
      body: JSON.stringify({ decision: 'approved', approvedBy: 'http-suite' }),
    })
    assert.equal(decision.body.approval.decision, 'approved')

    const completed = await request(`/api/control-plane/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-complete' },
      body: JSON.stringify({ approvalId: approval.body.approval.id }),
    })
    assert.equal(completed.body.task.status, 'completed')

    const audit = await request(`/api/control-plane/audit?entityId=${encodeURIComponent(taskId)}`)
    assert.ok(audit.body.events.some((event) => event.type === 'task.completed'))

    const connectorEvent = await request('/api/control-plane/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-connector-event' },
      body: JSON.stringify({ type: 'wechat.message_received', entityType: 'WeChatUser', entityId: 'wechat:test-hash', details: { kind: 'text' } }),
    })
    assert.equal(connectorEvent.response.status, 201)
    const connectorAudit = await request('/api/control-plane/audit?entityId=wechat%3Atest-hash')
    assert.equal(connectorAudit.body.events[0].type, 'wechat.message_received')

    const mcpInit = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    assert.equal(mcpInit.body.result.serverInfo.name, 'personal-ai-os-control-plane')
    const mcpTools = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    const toolNames = mcpTools.body.result.tools.map((tool) => tool.name)
    assert.ok(toolNames.includes('plan_route'))
    assert.ok(toolNames.includes('prompt_native_session'))
    assert.ok(toolNames.includes('cancel_native_session'))
    assert.ok(toolNames.includes('complete_task'))

    const route = await request('/api/control-plane/route-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'HTTP route test', policy: { requireMcp: true }, candidates: [{ id: 'codex', status: 'ready', capabilities: ['acp', 'mcp'] }, { id: 'gui', status: 'ready', capabilities: ['external.message'] }] }),
    })
    assert.equal(route.body.selected.id, 'codex')
    assert.equal(route.body.sideEffects, false)

    const unsupportedNative = await request('/api/control-plane/native-sessions?provider=unknown&cwd=%2Ftmp')
    assert.equal(unsupportedNative.response.status, 501)
    assert.equal(unsupportedNative.body.error, 'NATIVE_ACP_UNSUPPORTED')
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('close', resolve))
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})
