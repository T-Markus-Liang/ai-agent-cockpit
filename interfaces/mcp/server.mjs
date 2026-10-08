import { copyJson } from '@earendil-works/chord'
import { indexLocalSessions } from '../../control-plane/session-index.mjs'
import { getSessionMetadata } from '../../control-plane/session-adapters.mjs'
import { listNativeAcpSessions } from '../../control-plane/native-acp.mjs'
import { executeNativeSessionPrompt, cancelNativeExecution, nativePromptPlan } from '../../control-plane/native-acp-executor.mjs'
import { buildRoutePlan } from '../../control-plane/router.mjs'
import { createReviewerExecution } from '../../control-plane/reviewer.mjs'
import { cezarCancelPlan, cezarDispatchPlan, cancelCezarExecution, dispatchCezar, watchCezarExecution } from '../../control-plane/dispatcher.mjs'
import { CezarAdapter } from '../../adapters/engines/cezar.mjs'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_sessions',
    description: '只读列出本机 Agent 会话元数据；不读取凭据或消息正文。',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'plan_route',
    description: '根据能力证据生成无副作用的 Worker RoutePlan；Jev 只提供 advisory，不能授权执行。',
    inputSchema: { type: 'object', required: ['goal', 'candidates'], properties: { goal: { type: 'string' }, candidates: { type: 'array' }, policy: { type: 'object' }, useJev: { type: 'boolean' } } },
  },
  {
    name: 'get_session',
    description: '读取一个明确来源和原生 ID 的会话元数据与恢复限制，不静默创建新会话。',
    inputSchema: { type: 'object', required: ['source', 'nativeSessionId'], properties: { source: { type: 'string' }, nativeSessionId: { type: 'string' } } },
  },
  {
    name: 'list_native_sessions',
    description: '显式调用 Agent 原生 ACP session/list（当前已配置 Codex）；只读，不 load、不 prompt。',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, cwd: { type: 'string' } } },
  },
  {
    name: 'create_task',
    description: '创建控制面 Task；只写入 Personal AI OS 自己的状态。',
    inputSchema: { type: 'object', required: ['goal', 'idempotencyKey'], properties: { goal: { type: 'string' }, chief: { type: 'string' }, sourceRequestId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, constraints: { type: 'array', items: { type: 'string' } }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'get_task',
    description: '读取 Task、Execution 和 Evidence 关联。',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
  },
  {
    name: 'plan_task_completion',
    description: '检查 Verification/Review/Evidence 是否齐备并生成完成审批摘要；只读。',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
  },
  {
    name: 'complete_task',
    description: '在 Evidence 齐备且 Approval 精确匹配后将 Task 标为 completed。',
    inputSchema: { type: 'object', required: ['taskId', 'approvalId', 'idempotencyKey'], properties: { taskId: { type: 'string' }, approvalId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'list_audit_events',
    description: '读取控制面审计事件；不包含外部 Agent 消息正文或凭据。',
    inputSchema: { type: 'object', properties: { entityId: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'create_execution',
    description: '为 Task 创建一个排队的 Execution；不启动外部 Agent。',
    inputSchema: { type: 'object', required: ['taskId', 'workerId', 'idempotencyKey'], properties: { taskId: { type: 'string' }, workerId: { type: 'string' }, sessionRefId: { type: 'string' }, parentExecutionId: { type: 'string' }, artifactRef: { type: 'string' }, sessionLockToken: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'create_review_execution',
    description: '为已完成/验证中的 Worker Execution 创建独立 Reviewer Execution；只创建队列项，不启动 Agent。',
    inputSchema: { type: 'object', required: ['taskId', 'sourceExecutionId', 'reviewerId', 'idempotencyKey'], properties: { taskId: { type: 'string' }, sourceExecutionId: { type: 'string' }, reviewerId: { type: 'string' }, sessionRefId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'update_execution_status',
    description: '按有限状态机推进 Execution；非法转移会被拒绝。',
    inputSchema: { type: 'object', required: ['executionId', 'status', 'idempotencyKey'], properties: { executionId: { type: 'string' }, status: { type: 'string' }, artifactRef: { type: 'string' }, outcome: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'plan_native_prompt',
    description: '生成恢复旧 ACP 会话的审批摘要；只规划，不 load 或 prompt。',
    inputSchema: { type: 'object', required: ['taskId', 'executionId', 'source', 'nativeSessionId', 'sessionRefId', 'cwd', 'prompt'], properties: { taskId: { type: 'string' }, executionId: { type: 'string' }, source: { type: 'string' }, nativeSessionId: { type: 'string' }, sessionRefId: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' } } },
  },
  {
    name: 'prompt_native_session',
    description: '在精确 Approval 下 load 并 prompt 一个已有 ACP 会话；完成后进入 VERIFYING。',
    inputSchema: { type: 'object', required: ['taskId', 'executionId', 'approvalId', 'source', 'nativeSessionId', 'sessionRefId', 'cwd', 'prompt', 'idempotencyKey'], properties: { taskId: { type: 'string' }, executionId: { type: 'string' }, approvalId: { type: 'string' }, source: { type: 'string' }, nativeSessionId: { type: 'string' }, sessionRefId: { type: 'string' }, cwd: { type: 'string' }, prompt: { type: 'string' }, accountId: { type: 'string' }, profileId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'cancel_native_session',
    description: '使用精确匹配且未消费的 Approval 取消一个在途 native ACP 会话：先发 ACP session/cancel，未收尾再 SIGTERM。',
    inputSchema: { type: 'object', required: ['executionId', 'approvalId', 'idempotencyKey'], properties: { executionId: { type: 'string' }, approvalId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'add_evidence',
    description: '为 Execution 添加可追溯证据摘要。',
    inputSchema: { type: 'object', required: ['executionId', 'summary', 'source', 'idempotencyKey'], properties: { executionId: { type: 'string' }, kind: { type: 'string' }, summary: { type: 'string' }, source: { type: 'string' }, uri: { type: 'string' }, exitCode: { type: 'integer' }, artifactRef: { type: 'string' }, verdict: { enum: ['passed', 'failed'] }, reviewOfExecutionId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'create_approval',
    description: '创建绑定动作、目标和参数摘要的审批。',
    inputSchema: { type: 'object', required: ['action', 'target', 'parametersDigest', 'idempotencyKey'], properties: { action: { type: 'string' }, target: { type: 'string' }, parametersDigest: { type: 'string' }, expiresAt: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'decide_approval',
    description: '批准、拒绝或使审批过期。批准必须提供 approvedBy。',
    inputSchema: { type: 'object', required: ['approvalId', 'decision', 'idempotencyKey'], properties: { approvalId: { type: 'string' }, decision: { type: 'string' }, approvedBy: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'list_approvals',
    description: '读取当前控制面审批状态。',
    inputSchema: { type: 'object', properties: { decision: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'lock_session',
    description: '为外部 SessionRef 建立短期写入锁，避免控制面并发恢复。',
    inputSchema: { type: 'object', required: ['sessionRefId', 'owner', 'idempotencyKey'], properties: { sessionRefId: { type: 'string' }, owner: { type: 'string' }, ttlMs: { type: 'number' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'plan_cezar_dispatch',
    description: '生成 Cezar 派单参数摘要；只规划，不启动外部 Agent。',
    inputSchema: { type: 'object', required: ['taskId', 'executionId'], properties: { taskId: { type: 'string' }, executionId: { type: 'string' }, runner: { type: 'string' }, workflow: { type: 'string' }, worktree: { type: 'boolean' } } },
  },
  {
    name: 'dispatch_cezar',
    description: '使用精确匹配且未消费的 Approval 启动 Cezar；没有审批不会启动。',
    inputSchema: { type: 'object', required: ['taskId', 'executionId', 'approvalId', 'idempotencyKey'], properties: { taskId: { type: 'string' }, executionId: { type: 'string' }, approvalId: { type: 'string' }, runner: { type: 'string' }, workflow: { type: 'string' }, worktree: { type: 'boolean' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'plan_cancel_cezar',
    description: '生成 Cezar 取消审批摘要；只规划，不取消。',
    inputSchema: { type: 'object', required: ['executionId'], properties: { executionId: { type: 'string' } } },
  },
  {
    name: 'cancel_cezar',
    description: '使用精确匹配且未消费的 Approval 取消 Cezar run。',
    inputSchema: { type: 'object', required: ['executionId', 'approvalId', 'idempotencyKey'], properties: { executionId: { type: 'string' }, approvalId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
])

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.code ?? 'MCP_TOOL_ERROR', message: error.message }) }] }
}

// Restricted authority operations are host-only. MCP is an agent channel by
// default, so these are neither advertised nor accepted without a trusted HOST
// principal. `deps` is trusted host wiring: it is not a JS code sandbox and is
// not a substitute for HTTP bearer authentication.
const RESTRICTED_TOOL_ROLES = Object.freeze({
  decide_approval: Object.freeze(['operator']),
  update_execution_status: Object.freeze(['operator', 'coordinator']),
  add_evidence: Object.freeze(['operator', 'coordinator']),
})

const TOOL_ARGUMENT_ALLOWLIST = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema?.properties ?? {}))]))
const HOST_ROLES = new Set(['operator', 'coordinator', 'chief', 'agent', 'viewer'])
const READ_ONLY_TOOLS = new Set(['list_sessions', 'get_session', 'get_task', 'plan_task_completion', 'list_audit_events', 'list_approvals'])
const COORDINATOR_TOOLS = new Set([...READ_ONLY_TOOLS, 'update_execution_status', 'add_evidence', 'complete_task'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidArgumentsError() {
  const error = new Error('invalid MCP tool arguments')
  error.code = 'MCP_INVALID_ARGUMENTS'
  return error
}

function notAuthorizedError() {
  const error = new Error('not authorized')
  error.code = 'MCP_NOT_AUTHORIZED'
  return error
}

function trustedPrincipal(principal) {
  if (!isPlainObject(principal) || principal.authenticated !== true ||
      typeof principal.id !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(principal.id) ||
      !HOST_ROLES.has(principal.role)) return null
  return principal
}

function isToolAuthorized(name, principal) {
  const trusted = principal === undefined ? undefined : trustedPrincipal(principal)
  if (principal !== undefined && !trusted) return false
  if (trusted?.role === 'viewer') return READ_ONLY_TOOLS.has(name)
  if (trusted?.role === 'coordinator') return COORDINATOR_TOOLS.has(name)
  const roles = RESTRICTED_TOOL_ROLES[name]
  return !roles || Boolean(trusted && roles.includes(trusted.role))
}

export function listVisibleTools(principal) {
  return TOOL_DEFINITIONS.filter(tool => isToolAuthorized(tool.name, principal))
}

function validateArguments(name, args) {
  let safe
  try {
    // ponytail: reuse the existing strict JSON clone; don't maintain a second walker.
    safe = copyJson(args)
  } catch { throw invalidArgumentsError() }
  if (!isPlainObject(safe)) throw invalidArgumentsError()
  const allowed = TOOL_ARGUMENT_ALLOWLIST.get(name)
  if (!allowed || Object.keys(safe).some(key => !allowed.has(key))) throw invalidArgumentsError()
  const schema = TOOL_DEFINITIONS.find(tool => tool.name === name).inputSchema
  if ((schema.required ?? []).some(key => !Object.hasOwn(safe, key))) throw invalidArgumentsError()
  for (const [key, value] of Object.entries(safe)) {
    const type = schema.properties[key].type
    if (type === 'string' && typeof value !== 'string' || type === 'boolean' && typeof value !== 'boolean' ||
        type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) ||
        type === 'integer' && !Number.isSafeInteger(value) || type === 'array' && !Array.isArray(value) ||
        type === 'object' && !isPlainObject(value)) throw invalidArgumentsError()
  }
  return safe
}

export async function callTool(name, args = {}, { store, principal, requireOperator = true } = {}) {
  if (typeof name !== 'string' || !TOOL_ARGUMENT_ALLOWLIST.has(name)) throw invalidArgumentsError()
  args = validateArguments(name, args)
  if (!isToolAuthorized(name, principal)) throw notAuthorizedError()

  if (name === 'list_sessions') return indexLocalSessions({ providers: args.provider ? [args.provider] : undefined, limit: args.limit })
  if (name === 'plan_route') return buildRoutePlan(args)
  if (name === 'get_session') return getSessionMetadata({ source: args.source, nativeSessionId: args.nativeSessionId })
  if (name === 'list_native_sessions') return listNativeAcpSessions({ source: args.provider ?? 'codex', cwd: args.cwd ?? process.cwd() })
  if (!store) throw new Error('control-plane store is unavailable')
  if (name === 'create_task') return store.createTask(args, { idempotencyKey: args.idempotencyKey })
  if (name === 'get_task') return store.getTask(args.taskId)
  if (name === 'plan_task_completion') return store.completionPlan(args.taskId)
  if (name === 'complete_task') return store.completeTask(args.taskId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'list_audit_events') return store.listEvents(args)
  if (name === 'create_execution') return store.createExecution(args.taskId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'create_review_execution') return createReviewerExecution({ ...args, store })
  if (name === 'update_execution_status') return store.updateExecutionStatus(args.executionId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'plan_native_prompt') return nativePromptPlan(args)
  if (name === 'prompt_native_session') return executeNativeSessionPrompt({ ...args, store, requireOperator, idempotencyKey: args.idempotencyKey })
  if (name === 'cancel_native_session') return cancelNativeExecution({ ...args, store, requireOperator, idempotencyKey: args.idempotencyKey })
  if (name === 'add_evidence') return store.addEvidence(args.executionId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'create_approval') return store.createApproval(args, { idempotencyKey: args.idempotencyKey })
  if (name === 'decide_approval') {
    const trusted = trustedPrincipal(principal)
    const claimed = args.approvedBy
    if (claimed !== undefined && claimed !== trusted.id) throw notAuthorizedError()
    const decision = { ...args, approvedBy: trusted.id }
    return store.decideApproval(decision.approvalId, decision, { idempotencyKey: decision.idempotencyKey, principal: trusted })
  }
  if (name === 'list_approvals') return store.listApprovals(args)
  if (name === 'lock_session') return store.acquireSessionLock(args.sessionRefId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'plan_cezar_dispatch') return cezarDispatchPlan(args)
  if (name === 'dispatch_cezar') {
    const adapter = new CezarAdapter()
    const value = await dispatchCezar({ ...args, store, adapter, requireOperator, idempotencyKey: args.idempotencyKey })
    if (!value.replay) void watchCezarExecution({ store, adapter, executionId: args.executionId }).catch(() => {})
    return value
  }
  if (name === 'plan_cancel_cezar') return cezarCancelPlan(args)
  if (name === 'cancel_cezar') return cancelCezarExecution({ ...args, store, requireOperator, idempotencyKey: args.idempotencyKey })
  throw invalidArgumentsError()
}

export async function handleMcpRequest(request, deps = {}) {
  const id = request?.id ?? null
  const method = request?.method
  if (method === 'notifications/initialized') return null
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'personal-ai-os-control-plane', version: '0.2.0' } } }
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: listVisibleTools(deps.principal) } }
  if (method === 'tools/call') {
    try {
      const value = await callTool(request.params?.name, request.params?.arguments ?? {}, deps)
      return { jsonrpc: '2.0', id, result: result(value) }
    } catch (error) {
      return { jsonrpc: '2.0', id, result: errorResult(error) }
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
}
