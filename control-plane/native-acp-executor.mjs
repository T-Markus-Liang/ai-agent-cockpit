import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { nativeAcpCommand } from './native-acp.mjs'
import { wrapWithSandbox } from './native-sandbox.mjs'
import { parametersDigest, StoreError } from './store.mjs'

// Fixed denial codes for inbound client-side tool calls. These are stable,
// machine-readable identifiers surfaced in the JSON-RPC error the agent sees;
// tests and logs key off the code, never off a human message.
export const NATIVE_ACP_CLIENT_TOOL_DENIED = 'NATIVE_ACP_CLIENT_TOOL_DENIED'
export const NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED = 'NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED'
export const NATIVE_ACP_BROKER_ERROR = 'NATIVE_ACP_BROKER_ERROR'

// ACP client-side (agent -> client) request methods this executor understands,
// mapped to the tool kind the session permission broker adjudicates on. Any
// other method is mapped to a kind the broker does not know, so an unrecognized
// inbound request fails closed instead of being waved through.
const CLIENT_TOOL_KINDS = Object.freeze({ 'fs/read_text_file': 'read', 'fs/write_text_file': 'edit' })

function clientToolKind(method) {
  if (typeof method === 'string' && Object.hasOwn(CLIENT_TOOL_KINDS, method)) return CLIENT_TOOL_KINDS[method]
  if (typeof method === 'string' && method.startsWith('terminal/')) return 'execute'
  return 'other'
}

// The child environment is a minimal allow-list of host values plus the keys the
// caller passes explicitly through the sandbox grant. The full process.env is
// NEVER inherited: provider API keys and other host secrets must not reach a
// wrapped native CLI by default. This is a deliberate security tightening over
// the previous `{ ...process.env, ... }` spread.
const HOST_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'])

export function nativeAcpChildEnv(extraEnv = {}) {
  const fallback = { PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8', TERM: 'dumb', TMPDIR: os.tmpdir() }
  const env = {}
  for (const key of HOST_ENV_KEYS) env[key] = process.env[key] ?? fallback[key]
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [key, value] of Object.entries(extraEnv)) if (typeof value === 'string') env[key] = value
  }
  return env
}

// Derive the Seatbelt spec for a native ACP child: the workspace is the prompt
// cwd, the selected command (and its resolved path) is the only executable, and
// read/write/network come from the explicit grant.
//
// IMPORTANT (probe / deployment batch): the REAL read grant must eventually
// cover whatever the CLI itself reads to start and authenticate (its own config
// and auth directories, e.g. ~/.codex or ~/.opencode), and the real network /
// denyNetwork policy must be derived from the actual Grant. This slice only
// threads the port through with denyNetwork defaulting to false and the
// read/write literals defaulting to empty; it does NOT decide the production
// grant. See docs/handoffs/m02-native-acp-executor-r1.md.
export function nativeAcpSandboxSpec({ command, cwd, grant = {} } = {}) {
  const execLiterals = [...new Set([command, path.resolve(command)])]
  return {
    execLiterals,
    workspaceDir: cwd,
    readLiterals: Array.isArray(grant.readLiterals) ? [...grant.readLiterals] : [],
    writeLiterals: Array.isArray(grant.writeLiterals) ? [...grant.writeLiterals] : [],
    denyNetwork: grant.denyNetwork ?? false,
  }
}

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

export async function runNativeAcpPrompt({ source = 'codex', cwd, nativeSessionId, prompt, command, args, timeoutMs = 120_000, sandbox, sandboxGrant = {}, permissionBroker } = {}) {
  if (!path.isAbsolute(cwd)) throw new StoreError('ABSOLUTE_CWD_REQUIRED', 'native ACP prompt requires an absolute cwd', 400)
  if (!nativeSessionId || !prompt?.trim()) throw new StoreError('NATIVE_PROMPT_REQUIRED', 'nativeSessionId and prompt are required', 400)
  const selected = command ? { command, args: args ?? [] } : nativeAcpCommand(source)
  if (!selected) throw new StoreError('NATIVE_ACP_UNSUPPORTED', `no native ACP executor is configured for ${source}`, 501)
  // The spawn goes through the sandbox port. Default is the real Seatbelt
  // wrapper (native-sandbox.mjs), which fails closed with SANDBOX_REQUIRED when
  // Seatbelt is unavailable; there is no unsandboxed fallback. Tests inject a
  // passthrough spy. The spec's exec whitelist is derived from the selected
  // command, the workspace from cwd, and read/write/network from the grant.
  const wrap = sandbox ?? wrapWithSandbox
  const spec = nativeAcpSandboxSpec({ command: selected.command, cwd, grant: sandboxGrant })
  const wrapped = wrap(selected.command, selected.args, spec)
  const child = spawn(wrapped.command, wrapped.args, {
    cwd,
    env: nativeAcpChildEnv(sandboxGrant.extraEnv),
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const rl = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  const notifications = []
  const textParts = []
  const clientRequests = new Set()
  const brokerErrors = []
  let nextId = 1
  let toolCallSeq = 0
  let agentCapabilities

  // Adjudicate one inbound client-side (agent -> client) tool call. The
  // executor advertises fs:false and never performs fs/terminal work on the
  // agent's behalf, so there is no capability to satisfy:
  //   - with no broker (or a broker that denies / throws) the call is refused
  //     with the broker's denial code (or a fixed code) in the JSON-RPC error;
  //   - with a broker that allows, the call is STILL refused as honestly
  //     unsupported — "allow" only means the permission layer does not object,
  //     it does not make this executor able to run the tool.
  // Every adjudication uses a freshly generated toolCallId, never a reused one,
  // so the broker's one-shot "any decision burns the id" contract holds even if
  // the agent replays the same inbound request id.
  const handleClientRequest = async (message) => {
    const toolCallId = `${nativeSessionId}:${String(message.id)}:${toolCallSeq++}`
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {}
    let decision
    if (permissionBroker && typeof permissionBroker.handlePermissionRequest === 'function') {
      try {
        decision = await permissionBroker.handlePermissionRequest({
          sessionId: nativeSessionId,
          toolCallId,
          tool: { kind: clientToolKind(message.method) },
          rawInput: params,
          options: [{ kind: 'allow_once', optionId: 'once', name: 'once' }],
        })
      } catch (error) {
        // A broker that fails is a denial, never a silent pass-through.
        brokerErrors.push(String(error?.message ?? error))
        decision = { outcome: 'denied', reason: NATIVE_ACP_BROKER_ERROR }
      }
    } else {
      decision = { outcome: 'denied', reason: NATIVE_ACP_CLIENT_TOOL_DENIED }
    }
    const code = decision?.outcome === 'allow_once'
      ? NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED
      : (typeof decision?.reason === 'string' && decision.reason ? decision.reason : NATIVE_ACP_CLIENT_TOOL_DENIED)
    const response = {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `native prompt executor does not grant client-side tool calls (${code})`, data: { code } },
    }
    try { child.stdin.write(`${JSON.stringify(response)}\n`) } catch { /* the child may already be gone; nothing to answer */ }
  }

  const processFailure = new Promise((_, reject) => child.once('error', (error) => reject(responseError('spawn', source, error.message, 502))))
  rl.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method && message.id !== undefined) {
      const handled = handleClientRequest(message).catch(() => {})
      clientRequests.add(handled)
      handled.then(() => clientRequests.delete(handled))
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
    return { source, nativeSessionId, cwd, agentInfo: initialized?.agentInfo, agentCapabilities, stopReason: promptResult?.stopReason, text: textParts.join(''), notifications, brokerErrors }
  } finally {
    rl.close()
    // Let any inbound client-request adjudications that are still writing their
    // response finish before the child is torn down.
    if (clientRequests.size > 0) await Promise.allSettled([...clientRequests])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForClose(child)
  }
}

export async function executeNativeSessionPrompt({ store, taskId, executionId, approvalId, source, nativeSessionId, cwd, prompt, command, args, sandbox, sandboxGrant, permissionBroker, idempotencyKey, requireOperator = false } = {}) {
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
    const result = await runNativeAcpPrompt({ source, nativeSessionId, cwd, prompt, command, args, sandbox, sandboxGrant, permissionBroker })
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
