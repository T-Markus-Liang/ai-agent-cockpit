import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { nativeAcpCommand } from './native-acp.mjs'
import { parametersDigest, StoreError } from './store.mjs'

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}

function responseError(method, source, message, status = 502) {
  return new StoreError('NATIVE_ACP_ERROR', `${source} ${method} failed: ${message}`, status)
}

export function nativePromptPlan({ taskId, executionId, source, nativeSessionId, cwd, prompt } = {}) {
  if (!taskId || !executionId || !source || !nativeSessionId || !cwd || !prompt?.trim()) {
    throw new StoreError('NATIVE_PROMPT_PLAN_INVALID', 'taskId, executionId, source, nativeSessionId, cwd and prompt are required', 400)
  }
  if (!path.isAbsolute(cwd)) throw new StoreError('ABSOLUTE_CWD_REQUIRED', 'native ACP prompt requires an absolute cwd', 400)
  const parameters = { taskId, executionId, source, nativeSessionId, cwd, promptDigest: parametersDigest(prompt) }
  return { action: 'native.session.prompt', target: `${source}/${nativeSessionId}`, parameters, parametersDigest: parametersDigest(parameters), requiresApproval: true }
}

export async function runNativeAcpPrompt({ source = 'codex', cwd, nativeSessionId, prompt, command, args, timeoutMs = 120_000 } = {}) {
  if (!path.isAbsolute(cwd)) throw new StoreError('ABSOLUTE_CWD_REQUIRED', 'native ACP prompt requires an absolute cwd', 400)
  if (!nativeSessionId || !prompt?.trim()) throw new StoreError('NATIVE_PROMPT_REQUIRED', 'nativeSessionId and prompt are required', 400)
  const selected = command ? { command, args: args ?? [] } : nativeAcpCommand(source)
  if (!selected) throw new StoreError('NATIVE_ACP_UNSUPPORTED', `no native ACP executor is configured for ${source}`, 501)
  const child = spawn(selected.command, selected.args, {
    cwd,
    env: { ...process.env, HOME: process.env.HOME ?? '/Users/markus', PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  const notifications = []
  const textParts = []
  let nextId = 1
  let agentCapabilities
  const processFailure = new Promise((_, reject) => child.once('error', (error) => reject(responseError('spawn', source, error.message, 502))))
  rl.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method && message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'native prompt executor does not grant client-side tool calls' } })}\n`)
      return
    }
    if (message.method && message.method === 'session/update') {
      const update = message.params?.update ?? message.params
      notifications.push(update)
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') textParts.push(update.content.text)
      return
    }
    if (message.id === undefined || message.id === null) return
    const resolver = pending.get(message.id)
    if (!resolver) return
    pending.delete(message.id)
    if (message.error) resolver.reject(responseError(message.method ?? 'request', source, message.error.message ?? JSON.stringify(message.error), 502))
    else resolver.resolve(message.result)
  })
  const request = async (method, params) => {
    const id = nextId++
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new StoreError('NATIVE_ACP_TIMEOUT', `${source} ${method} timed out after ${timeoutMs}ms`, 504)) }, timeoutMs)
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return Promise.race([response, processFailure])
  }
  try {
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'personal-ai-os-control-plane', title: 'Personal AI OS control plane', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    agentCapabilities = initialized?.agentCapabilities ?? {}
    if (!agentCapabilities.loadSession) throw new StoreError('NATIVE_ACP_LOAD_UNSUPPORTED', `${source} did not advertise session/load`, 501)
    await request('session/load', { cwd, mcpServers: [], sessionId: nativeSessionId })
    const promptResult = await request('session/prompt', { sessionId: nativeSessionId, prompt: [{ type: 'text', text: prompt }] })
    return { source, nativeSessionId, cwd, agentInfo: initialized?.agentInfo, agentCapabilities, stopReason: promptResult?.stopReason, text: textParts.join(''), notifications }
  } finally {
    rl.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForClose(child)
  }
}

export async function executeNativeSessionPrompt({ store, taskId, executionId, approvalId, source, nativeSessionId, cwd, prompt, command, args, idempotencyKey, requireOperator = false } = {}) {
  if (!store) throw new StoreError('STORE_REQUIRED', 'control-plane store is required', 500)
  const aggregate = await store.getTask(taskId)
  const execution = aggregate.executions.find((candidate) => candidate.id === executionId)
  if (!execution) throw new StoreError('EXECUTION_TASK_MISMATCH', `execution ${executionId} is not attached to task ${taskId}`, 409)
  if (execution.status !== 'queued') throw new StoreError('EXECUTION_NOT_QUEUED', `execution is ${execution.status}; only queued executions may prompt`, 409)
  const plan = nativePromptPlan({ taskId, executionId, source, nativeSessionId, cwd, prompt })
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'native session prompt requires an approved approval id', 403)
  await store.consumeApproval(approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: `${idempotencyKey ?? executionId}:approval`, requireOperator })
  await store.updateExecutionStatus(executionId, { status: 'running', outcome: 'native ACP session/load + prompt in flight' }, { idempotencyKey: `${idempotencyKey ?? executionId}:running` })
  try {
    const result = await runNativeAcpPrompt({ source, nativeSessionId, cwd, prompt, command, args })
    await store.attachExecutionRef(executionId, { engine: 'native-acp', id: `${source}:${nativeSessionId}`, source, nativeSessionId, cwd }, { idempotencyKey: `${idempotencyKey ?? executionId}:attach` })
    const text = result.text ?? ''
    const summary = text.trim().length > 0
      ? (text.length > 4000 ? `${text.slice(0, 3997)}...` : text)
      : `native ACP prompt returned no text (stopReason=${result.stopReason ?? 'unknown'})`
    await store.addEvidence(executionId, { kind: 'message', summary, source: `${source}:acp`, redacted: true }, { idempotencyKey: `${idempotencyKey ?? executionId}:evidence` })
    const updated = await store.updateExecutionStatus(executionId, { status: 'verifying', outcome: `native ACP prompt completed (${result.stopReason ?? 'unknown'})` }, { idempotencyKey: `${idempotencyKey ?? executionId}:verifying` })
    return { execution: updated.execution, reply: result.text, stopReason: result.stopReason, agentInfo: result.agentInfo }
  } catch (error) {
    await store.updateExecutionStatus(executionId, { status: 'blocked', outcome: `native ACP prompt failed or is uncertain: ${error.message}` }, { idempotencyKey: `${idempotencyKey ?? executionId}:blocked` }).catch(() => {})
    throw error
  }
}
