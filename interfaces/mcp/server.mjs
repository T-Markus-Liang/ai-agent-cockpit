import { indexLocalSessions } from '../../control-plane/session-index.mjs'
import { getSessionMetadata } from '../../control-plane/session-adapters.mjs'
import { listNativeAcpSessions } from '../../control-plane/native-acp.mjs'
import { cezarCancelPlan, cezarDispatchPlan, cancelCezarExecution, dispatchCezar } from '../../control-plane/dispatcher.mjs'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'list_sessions',
    description: '只读列出本机 Agent 会话元数据；不读取凭据或消息正文。',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, limit: { type: 'number' } } },
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
    inputSchema: { type: 'object', required: ['goal', 'idempotencyKey'], properties: { goal: { type: 'string' }, chief: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'get_task',
    description: '读取 Task、Execution 和 Evidence 关联。',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
  },
  {
    name: 'create_execution',
    description: '为 Task 创建一个排队的 Execution；不启动外部 Agent。',
    inputSchema: { type: 'object', required: ['taskId', 'workerId', 'idempotencyKey'], properties: { taskId: { type: 'string' }, workerId: { type: 'string' }, sessionRefId: { type: 'string' }, parentExecutionId: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'update_execution_status',
    description: '按有限状态机推进 Execution；非法转移会被拒绝。',
    inputSchema: { type: 'object', required: ['executionId', 'status', 'idempotencyKey'], properties: { executionId: { type: 'string' }, status: { type: 'string' }, outcome: { type: 'string' }, idempotencyKey: { type: 'string' } } },
  },
  {
    name: 'add_evidence',
    description: '为 Execution 添加可追溯证据摘要。',
    inputSchema: { type: 'object', required: ['executionId', 'summary', 'source', 'idempotencyKey'], properties: { executionId: { type: 'string' }, kind: { type: 'string' }, summary: { type: 'string' }, source: { type: 'string' }, uri: { type: 'string' }, idempotencyKey: { type: 'string' } } },
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

export async function callTool(name, args = {}, { store } = {}) {
  if (name === 'list_sessions') return indexLocalSessions({ providers: args.provider ? [args.provider] : undefined, limit: args.limit })
  if (name === 'get_session') return getSessionMetadata({ source: args.source, nativeSessionId: args.nativeSessionId })
  if (name === 'list_native_sessions') return listNativeAcpSessions({ source: args.provider ?? 'codex', cwd: args.cwd ?? process.cwd() })
  if (!store) throw new Error('control-plane store is unavailable')
  if (name === 'create_task') return store.createTask(args, { idempotencyKey: args.idempotencyKey })
  if (name === 'get_task') return store.getTask(args.taskId)
  if (name === 'create_execution') return store.createExecution(args.taskId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'update_execution_status') return store.updateExecutionStatus(args.executionId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'add_evidence') return store.addEvidence(args.executionId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'create_approval') return store.createApproval(args, { idempotencyKey: args.idempotencyKey })
  if (name === 'decide_approval') return store.decideApproval(args.approvalId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'lock_session') return store.acquireSessionLock(args.sessionRefId, args, { idempotencyKey: args.idempotencyKey })
  if (name === 'plan_cezar_dispatch') return cezarDispatchPlan(args)
  if (name === 'dispatch_cezar') return dispatchCezar({ ...args, store, idempotencyKey: args.idempotencyKey })
  if (name === 'plan_cancel_cezar') return cezarCancelPlan(args)
  if (name === 'cancel_cezar') return cancelCezarExecution({ ...args, store, idempotencyKey: args.idempotencyKey })
  throw new Error(`unknown MCP tool: ${name}`)
}

export async function handleMcpRequest(request, deps = {}) {
  const id = request?.id ?? null
  const method = request?.method
  if (method === 'notifications/initialized') return null
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'personal-ai-os-control-plane', version: '0.1.0' } } }
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } }
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
