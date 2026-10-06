#!/usr/bin/env node
import http from 'node:http'
import { indexLocalSessions } from '../control-plane/session-index.mjs'
import { getSessionMetadata } from '../control-plane/session-adapters.mjs'
import { listNativeAcpSessions } from '../control-plane/native-acp.mjs'
import { executeNativeSessionPrompt, nativePromptPlan } from '../control-plane/native-acp-executor.mjs'
import { probeFeatureMap } from '../control-plane/feature-map.mjs'
import { ControlPlaneStore, StoreError } from '../control-plane/store.mjs'
import { CezarAdapter } from '../adapters/engines/cezar.mjs'
import { cezarCancelPlan, cezarDispatchPlan, cancelCezarExecution, dispatchCezar, reconcileCezarExecution, watchCezarExecution } from '../control-plane/dispatcher.mjs'
import { handleMcpRequest } from '../interfaces/mcp/server.mjs'

const PORT = Number(process.env.CONTROL_PLANE_PORT ?? 4324)
const store = new ControlPlaneStore()
let cache = null
let cacheAt = 0
let startupRecovery = { recovered: false, blockedExecutionIds: [] }

function send(res, status, body) {
  if (status === 204) {
    res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key,X-Idempotency-Key' })
    return res.end()
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key,X-Idempotency-Key',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function idempotencyKey(req) {
  return req.headers['idempotency-key'] ?? req.headers['x-idempotency-key']
}

async function body(req) {
  const maxBytes = 1024 * 1024
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError('request body exceeds 1 MiB', 413)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError('request body must be valid JSON', 400)
  }
}

function segment(pathname, prefix, suffix = '') {
  if (!pathname.startsWith(prefix)) return null
  let value = pathname.slice(prefix.length)
  if (suffix) {
    if (!value.endsWith(suffix)) return null
    value = value.slice(0, -suffix.length)
  }
  if (!value || value.includes('/')) return null
  return decodeURIComponent(value)
}

async function snapshot(query) {
  const providers = query.get('provider')?.split(',').map((value) => value.trim()).filter(Boolean)
  const limit = query.get('limit') ? Number(query.get('limit')) : undefined
  const key = JSON.stringify({ providers, limit })
  if (cache && Date.now() - cacheAt < 30_000 && cache.key === key) return cache.value
  const value = await indexLocalSessions({ providers, limit })
  cache = { key, value }
  cacheAt = Date.now()
  return value
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204)
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { status: 'ok', service: 'personal-ai-os-control-plane', sessionIndexReadOnly: true, externalAgentsReadOnly: true, persistence: await store.snapshot(), startupRecovery })
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      const response = await handleMcpRequest(await body(req), { store })
      return response === null ? send(res, 202, { accepted: true }) : send(res, 200, response)
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/sessions') {
      return send(res, 200, await snapshot(url.searchParams))
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/sources') {
      return send(res, 200, (await snapshot(url.searchParams)).sources)
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/capabilities') {
      return send(res, 200, await probeFeatureMap({ sessionSnapshot: await snapshot(new URLSearchParams('limit=1')) }))
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/native-sessions') {
      return send(res, 200, await listNativeAcpSessions({ source: url.searchParams.get('provider') ?? 'codex', cwd: url.searchParams.get('cwd') ?? process.cwd() }))
    }
    const sessionDetail = url.pathname.match(/^\/api\/control-plane\/session\/([^/]+)\/([^/]+)$/)
    if (req.method === 'GET' && sessionDetail) {
      return send(res, 200, await getSessionMetadata({ source: decodeURIComponent(sessionDetail[1]), nativeSessionId: decodeURIComponent(sessionDetail[2]) }))
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/tasks') {
      return send(res, 200, { tasks: await store.listTasks({ status: url.searchParams.get('status') ?? undefined, limit: url.searchParams.get('limit') ?? undefined }) })
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/audit') {
      return send(res, 200, { events: await store.listEvents({ entityId: url.searchParams.get('entityId') ?? undefined, limit: url.searchParams.get('limit') ?? undefined }) })
    }
    if (req.method === 'POST' && url.pathname === '/api/control-plane/tasks') {
      const result = await store.createTask(await body(req), { idempotencyKey: idempotencyKey(req) })
      return send(res, result.replay ? 200 : 201, result)
    }
    if (req.method === 'POST' && url.pathname === '/api/control-plane/approvals') {
      const result = await store.createApproval(await body(req), { idempotencyKey: idempotencyKey(req) })
      return send(res, result.replay ? 200 : 201, result)
    }
    const approvalId = segment(url.pathname, '/api/control-plane/approvals/')
    if (approvalId && req.method === 'GET') return send(res, 200, await store.getApproval(approvalId))
    const decisionApprovalId = segment(url.pathname, '/api/control-plane/approvals/', '/decision')
    if (decisionApprovalId && req.method === 'POST') {
      const result = await store.decideApproval(decisionApprovalId, await body(req), { idempotencyKey: idempotencyKey(req) })
      return send(res, 200, result)
    }
    const taskId = segment(url.pathname, '/api/control-plane/tasks/')
    if (taskId && req.method === 'GET') return send(res, 200, await store.getTask(taskId))
    const completionPlanTaskId = segment(url.pathname, '/api/control-plane/tasks/', '/completion-plan')
    if (completionPlanTaskId && req.method === 'GET') return send(res, 200, await store.completionPlan(completionPlanTaskId))
    const completeTaskId = segment(url.pathname, '/api/control-plane/tasks/', '/complete')
    if (completeTaskId && req.method === 'POST') {
      return send(res, 200, await store.completeTask(completeTaskId, await body(req), { idempotencyKey: idempotencyKey(req) }))
    }
    const executionTaskId = segment(url.pathname, '/api/control-plane/tasks/', '/executions')
    if (executionTaskId && req.method === 'POST') {
      const result = await store.createExecution(executionTaskId, await body(req), { idempotencyKey: idempotencyKey(req) })
      return send(res, result.replay ? 200 : 201, result)
    }
    const statusExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/status')
    if (statusExecutionId && req.method === 'POST') {
      return send(res, 200, await store.updateExecutionStatus(statusExecutionId, await body(req), { idempotencyKey: idempotencyKey(req) }))
    }
    const evidenceExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/evidence')
    if (evidenceExecutionId && req.method === 'POST') {
      return send(res, 201, await store.addEvidence(evidenceExecutionId, await body(req), { idempotencyKey: idempotencyKey(req) }))
    }
    const nativePlanExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/native/plan')
    if (nativePlanExecutionId && req.method === 'POST') return send(res, 200, nativePromptPlan({ ...(await body(req)), executionId: nativePlanExecutionId }))
    const nativePromptExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/native/prompt')
    if (nativePromptExecutionId && req.method === 'POST') {
      const input = await body(req)
      return send(res, 202, await executeNativeSessionPrompt({ ...input, store, executionId: nativePromptExecutionId, idempotencyKey: idempotencyKey(req) }))
    }
    const cezarPlanExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/cezar/plan')
    if (cezarPlanExecutionId && req.method === 'POST') {
      const input = await body(req)
      return send(res, 200, cezarDispatchPlan({ ...input, executionId: cezarPlanExecutionId }))
    }
    const cezarDispatchExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/cezar/dispatch')
    if (cezarDispatchExecutionId && req.method === 'POST') {
      const input = await body(req)
      const adapter = new CezarAdapter()
      const result = await dispatchCezar({ ...input, store, adapter, executionId: cezarDispatchExecutionId, idempotencyKey: idempotencyKey(req) })
      if (!result.replay) void watchCezarExecution({ store, adapter, executionId: cezarDispatchExecutionId }).catch((error) => console.warn(`[control-plane] Cezar SSE watcher stopped: ${String(error)}`))
      return send(res, result.replay ? 200 : 202, result)
    }
    const cezarReconcileExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/cezar/reconcile')
    if (cezarReconcileExecutionId && req.method === 'POST') {
      return send(res, 200, await reconcileCezarExecution({ store, adapter: new CezarAdapter(), executionId: cezarReconcileExecutionId, idempotencyKey: idempotencyKey(req) }))
    }
    const cezarCancelPlanExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/cezar/cancel-plan')
    if (cezarCancelPlanExecutionId && req.method === 'POST') return send(res, 200, cezarCancelPlan({ executionId: cezarCancelPlanExecutionId }))
    const cezarCancelExecutionId = segment(url.pathname, '/api/control-plane/executions/', '/cezar/cancel')
    if (cezarCancelExecutionId && req.method === 'POST') {
      const input = await body(req)
      return send(res, 200, await cancelCezarExecution({ ...input, store, adapter: new CezarAdapter(), executionId: cezarCancelExecutionId, idempotencyKey: idempotencyKey(req) }))
    }
    const lockSessionId = segment(url.pathname, '/api/control-plane/sessions/', '/lock')
    if (lockSessionId && req.method === 'POST') {
      return send(res, 200, await store.acquireSessionLock(lockSessionId, await body(req), { idempotencyKey: idempotencyKey(req) }))
    }
    const unlockSessionId = segment(url.pathname, '/api/control-plane/sessions/', '/unlock')
    if (unlockSessionId && req.method === 'POST') {
      return send(res, 200, await store.releaseSessionLock(unlockSessionId, await body(req), { idempotencyKey: idempotencyKey(req) }))
    }
    return send(res, 404, { error: 'not found' })
  } catch (error) {
    if (error instanceof StoreError || error instanceof HttpError) {
      return send(res, error.status ?? 409, { error: error.code ?? 'BAD_REQUEST', message: error.message, details: error.details })
    }
    return send(res, 500, { error: 'INTERNAL_ERROR', message: String(error) })
  }
})

try {
  startupRecovery = await store.recoverOnStartup()
} catch (error) {
  startupRecovery = { recovered: false, blockedExecutionIds: [], error: String(error) }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[control-plane] session index + local task store at http://127.0.0.1:${PORT}`)
})
