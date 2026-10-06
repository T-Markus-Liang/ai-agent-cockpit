import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

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
      body: JSON.stringify({ workerId: 'codex' }),
    })
    assert.equal(execution.response.status, 201)
    const executionId = execution.body.execution.id

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

    for (const [index, [kind, summary]] of [['test', 'node:test passed'], ['review', 'independent reviewer passed']].entries()) {
      const evidence = await request(`/api/control-plane/executions/${executionId}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `http-evidence-${index}` },
        body: JSON.stringify({ kind, summary, source: 'http-suite' }),
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
