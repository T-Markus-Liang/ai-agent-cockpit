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

// Stable, machine-readable marker recording that a reviewer execution's sandbox
// grant was forced to read-only. It is surfaced BOTH in the run result and (for
// the store-backed path) as an Evidence log line, so the constraint is visible
// and auditable rather than silently applied. Tests and logs key off the code,
// never off a human message.
export const REVIEWER_READONLY_APPLIED = 'REVIEWER_READONLY_APPLIED'

// Grace window between asking an in-flight agent to stop (ACP `session/cancel`)
// and escalating to SIGTERM. The agent gets this long to wind the prompt down
// itself; anything slower is force-terminated. Exported so tests can assert the
// production value and inject a shorter one.
export const NATIVE_CANCEL_GRACE_MS = 2000

// In-flight native ACP runs, keyed by executionId. A run registers itself BEFORE
// it spawns the native CLI and deregisters in its finally, so a cancel arriving
// while the prompt is live always finds a handle to the real child process. The
// registry is process-local on purpose: a control-plane restart loses it, which
// is exactly why startup recovery (store.recoverOnStartup) still marks every
// `running` execution `blocked` rather than pretending it can cancel a process
// it never owned.
const inFlightNativeExecutions = new Map()

// Read-only observability into the in-flight registry. Used by the cancel
// channel and by tests to prove a run is deregistered once it settles.
export function nativeInFlightExecutionIds() {
  return [...inFlightNativeExecutions.keys()]
}

// A per-run cancellation handle. `cancel()` sends the ACP `session/cancel`
// notification exactly once and, if the child has not exited within the grace
// window, escalates to SIGTERM. It is idempotent: a repeated call never
// re-signals, so replaying a cancel can never double-kill a process.
function createNativeCancelHandle({ nativeSessionId, graceMs = NATIVE_CANCEL_GRACE_MS } = {}) {
  let child = null
  let requested = false
  let graceTimer = null
  return {
    attach(process_) { child = process_ },
    get requested() { return requested },
    cancel() {
      if (requested) return { requested: true, replay: true, delivered: false }
      requested = true
      if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable) {
        // Nothing to signal (already gone, or never attached): report honestly.
        return { requested: true, replay: false, delivered: false }
      }
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: nativeSessionId } })}\n`)
      } catch { /* the child may already be gone; the grace timer below still applies */ }
      graceTimer = setTimeout(() => {
        graceTimer = null
        if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGTERM') } catch { /* already gone */ } }
      }, graceMs)
      graceTimer.unref?.()
      return { requested: true, replay: false, delivered: true }
    },
    dispose() { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null } },
  }
}

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

// Reviewer read-only enforcement (P4 gap 8). A reviewer execution exists to READ
// and judge an artifact, never to rewrite it, so its sandbox spec's writeLiterals
// is FORCED empty — even when the caller's grant explicitly supplied write paths.
// This is a deliberate forced downgrade WITH an audit trail, not a silent accept:
// the stripped paths are reported back so the operator can see exactly what was
// dropped. Read access (the artifact under review) and the network policy are
// left untouched. A caller passing an explicit write grant to a reviewer is NOT
// rejected — the run proceeds read-only and the downgrade is recorded.
export function applyReviewerReadonlyConstraint(spec, role) {
  if (role !== 'reviewer') return { spec, readonly: { code: REVIEWER_READONLY_APPLIED, applied: false } }
  const strippedWriteLiterals = Array.isArray(spec?.writeLiterals) ? [...spec.writeLiterals] : []
  return {
    spec: { ...spec, writeLiterals: [] },
    readonly: { code: REVIEWER_READONLY_APPLIED, applied: true, strippedWriteLiterals },
  }
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}

function responseError(method, source, message, status = 502) {
  return new StoreError('NATIVE_ACP_ERROR', `${source} ${method} failed: ${message}`, status)
}

// Structurally bind an inbound sessionRefId to the (source, nativeSessionId) it
// is about. EVERY provider in control-plane/session-index.mjs mints its SessionRef
// id with one convention — `session:<provider>:<nativeSessionId>` — and the native
// prompt hot path receives that id alongside the source/nativeSessionId it names.
// This proves the ref is shaped for EXACTLY this pair, so a well-formed ref minted
// for session A can never be silently used to drive a prompt against session B
// (the classic mis-wire: the same native id under a different provider, or a
// near-miss id such as `native-1` vs `native-10`). It is the honest, landable
// half of the D56 "session index consistency" residual: a STRUCTURAL binding —
// never an existence or freshness proof. Scanning a real CLI home on the prompt
// hot path to prove the session still exists was rejected (latency, privacy,
// unsynthesizable tests); that belongs to a deployment batch. See
// docs/handoffs/p4-sessionref-consistency-r1.md.
//
// Two refusal classes, split by severity so a caller can tell them apart:
//   - a reference that is not a `session:<provider>:<native>` triple at all is a
//     malformed parameter → SESSION_REF_MALFORMED (400), raised with zero effects;
//   - a well-formed reference whose provider or native segment disagrees with the
//     request's source/nativeSessionId is a scope conflict → SESSION_REF_MISMATCH
//     (409), the same "two things that must agree, disagree" shape as the existing
//     EXECUTION_SESSION_MISMATCH / EXECUTION_SCOPE_CHANGED. Matching is literal:
//     source and nativeSessionId must agree verbatim.
export function assertSessionRefMatches(sessionRefId, { source, nativeSessionId } = {}) {
  const malformed = () => new StoreError(
    'SESSION_REF_MALFORMED',
    `sessionRefId must be "session:<provider>:<nativeSessionId>"; got ${JSON.stringify(sessionRefId)}`,
    400,
  )
  if (typeof sessionRefId !== 'string' || !sessionRefId.startsWith('session:')) throw malformed()
  const rest = sessionRefId.slice('session:'.length)
  const breakAt = rest.indexOf(':')
  // A single non-empty provider segment followed by a non-empty native segment is
  // required. `breakAt === -1` means there is no provider:native split at all, and
  // `breakAt === 0` means the provider segment is empty.
  if (breakAt <= 0) throw malformed()
  const provider = rest.slice(0, breakAt)
  const native = rest.slice(breakAt + 1)
  if (native.length === 0) throw malformed()
  if (provider !== source || native !== nativeSessionId) {
    throw new StoreError(
      'SESSION_REF_MISMATCH',
      `sessionRefId ${sessionRefId} does not describe source ${source ?? '(none)'} / nativeSessionId ${nativeSessionId ?? '(none)'}`,
      409,
    )
  }
  return { source, nativeSessionId }
}

// sessionRefId is part of the immutable approval scope: it is carried into the
// plan parameters (and therefore the parametersDigest) so an approval bound to
// one session can never authorize a prompt on another. It is REQUIRED and never
// defaulted/fabricated — a plan without it would not bind the very session the
// SESSION_LOCKED / SESSION_BUSY guards key on, so a missing value is refused
// fail-closed here (400) rather than silently dropped.
export function nativePromptPlan({ taskId, executionId, source, nativeSessionId, sessionRefId, cwd, prompt } = {}) {
  if (!taskId || !executionId || !source || !nativeSessionId || !sessionRefId || !cwd || !prompt?.trim()) {
    throw new StoreError('NATIVE_PROMPT_PLAN_INVALID', 'taskId, executionId, source, nativeSessionId, sessionRefId, cwd and prompt are required', 400)
  }
  if (!path.isAbsolute(cwd)) throw new StoreError('ABSOLUTE_CWD_REQUIRED', 'native ACP prompt requires an absolute cwd', 400)
  const parameters = { taskId, executionId, source, nativeSessionId, sessionRefId, cwd, promptDigest: parametersDigest(prompt) }
  return { action: 'native.session.prompt', target: `${source}/${nativeSessionId}`, parameters, parametersDigest: parametersDigest(parameters), requiresApproval: true }
}

export async function runNativeAcpPrompt({ source = 'codex', cwd, nativeSessionId, prompt, command, args, timeoutMs = 120_000, sandbox, sandboxGrant = {}, permissionBroker, executionId, cancelGraceMs, role } = {}) {
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
  // The spec is derived from the selected command, cwd and grant, then passed
  // through the reviewer read-only constraint: a reviewer run has writeLiterals
  // forced empty (with the stripped paths reported in `reviewerReadonly`), while
  // every other role passes the grant through unchanged.
  const { spec, readonly } = applyReviewerReadonlyConstraint(nativeAcpSandboxSpec({ command: selected.command, cwd, grant: sandboxGrant }), role)
  const wrapped = wrap(selected.command, selected.args, spec)
  // The in-flight run is registered BEFORE the spawn (and deregistered in the
  // finally below), so a cancel that arrives while the prompt is live always
  // finds a handle to the real child process. `attach` links the child in.
  const cancelHandle = createNativeCancelHandle({ nativeSessionId, graceMs: cancelGraceMs })
  if (executionId) inFlightNativeExecutions.set(executionId, cancelHandle)
  let child
  try {
    child = spawn(wrapped.command, wrapped.args, {
      cwd,
      env: nativeAcpChildEnv(sandboxGrant.extraEnv),
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch (error) {
    // A synchronous spawn failure must not leak the registry entry.
    if (executionId) inFlightNativeExecutions.delete(executionId)
    cancelHandle.dispose()
    throw responseError('spawn', source, error.message, 502)
  }
  cancelHandle.attach(child)
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
  // A cancel the agent ignored is escalated to SIGTERM; when the child then
  // exits with the prompt request still pending, settle that request honestly
  // (NATIVE_ACP_CANCELLED) instead of letting it hang until the request timeout.
  // Only the cancel path is handled here: an unexpected death keeps its prior
  // (timeout-bounded) behaviour, so the existing spawn-failure NATIVE_ACP_ERROR
  // path is byte-for-byte unchanged.
  child.once('close', () => {
    if (!cancelHandle.requested) return
    for (const [id, resolver] of pending) {
      pending.delete(id)
      resolver.reject(new StoreError('NATIVE_ACP_CANCELLED', `${source} process was terminated after the ACP session/cancel was not honoured`, 502))
    }
  })
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
    let timer
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => { pending.delete(id); reject(new StoreError('NATIVE_ACP_TIMEOUT', `${source} ${method} timed out after ${timeoutMs}ms`, 504)) }, timeoutMs)
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    try {
      return await Promise.race([response, processFailure])
    } finally {
      // Always drop the timeout timer and the pending resolver: on the process-
      // failure path the response promise never settles, and a leaked 120s timer
      // would keep the event loop (and any test process) alive until it fires.
      clearTimeout(timer)
      pending.delete(id)
    }
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
    return { source, nativeSessionId, cwd, agentInfo: initialized?.agentInfo, agentCapabilities, stopReason: promptResult?.stopReason, text: textParts.join(''), notifications, brokerErrors, reviewerReadonly: readonly }
  } finally {
    if (executionId) inFlightNativeExecutions.delete(executionId)
    cancelHandle.dispose()
    rl.close()
    // Let any inbound client-request adjudications that are still writing their
    // response finish before the child is torn down.
    if (clientRequests.size > 0) await Promise.allSettled([...clientRequests])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForClose(child)
  }
}

// Launch-intent-first native session prompt.
//
// Order is fixed and load-bearing (aligned with the legacy-adapter示范: durable
// intent BEFORE the effect):
//   1. validate + build the immutable prompt plan (no side effects);
//   2. register the launch intent in the store BEFORE any spawn — attach the
//      native engine ref and move the execution to `running`, so a crash after
//      this point is still traceable to a stored engine ref;
//   3. consume the approval bound to the EXACT execution scope via
//      `executionGuard` (the store refuses a scope the execution is not bound to
//      with EXECUTION_SCOPE_CHANGED, and refuses a non-running execution);
//   4. only once the approval is consumed does the native CLI actually run.
//
// accountId / profileId are OPTIONAL scope fields. They are carried only when a
// real source supplies them; when absent they are simply not written, so the
// guard compares `undefined` to `undefined` on both sides (a legitimate match).
// They are enforced through the execution guard, not (yet) through the approval
// parameter digest — see docs/handoffs/p4-launch-intent-guard-r1.md.
//
// sessionRefId is a REQUIRED scope field (P4 gap 7). It is written into the plan
// parameters (so it is part of the approval parametersDigest), into the durable
// engine ref, and into the execution guard — all from the same resolved scope —
// so an approval the operator granted for one session can never launch another,
// and the SESSION_LOCKED / SESSION_BUSY guards (keyed on execution.sessionRefId)
// guard exactly the session this prompt is bound to. See
// docs/handoffs/p4-plan-scope-sessionref-r1.md.
//
// Reviewer read-only (P4 gap 8): the role is read from the STORED execution and
// passed to runNativeAcpPrompt, where a `reviewer` run has its sandbox
// writeLiterals forced empty regardless of the grant. The downgrade is recorded
// in the run result and as an Evidence log line — never silently accepted. See
// docs/handoffs/p4-reviewer-readonly-r1.md.
//
// The engine ref is attached exactly ONCE (step 2); the previous post-spawn
// second attach is intentionally dropped, so there is a single idempotency-
// keyed attach step. Each store step keeps its own `${idempotencyKey ?? executionId}:<step>`
// key, so replaying one step never collides with another.
export async function executeNativeSessionPrompt({ store, taskId, executionId, approvalId, source, nativeSessionId, sessionRefId, cwd, prompt, accountId, profileId, command, args, sandbox, sandboxGrant, permissionBroker, idempotencyKey, requireOperator = false, cancelGraceMs } = {}) {
  if (!store) throw new StoreError('STORE_REQUIRED', 'control-plane store is required', 500)
  const aggregate = await store.getTask(taskId)
  const execution = aggregate.executions.find((candidate) => candidate.id === executionId)
  if (!execution) throw new StoreError('EXECUTION_TASK_MISMATCH', `execution ${executionId} is not attached to task ${taskId}`, 409)
  if (execution.status !== 'queued') throw new StoreError('EXECUTION_NOT_QUEUED', `execution is ${execution.status}; only queued executions may prompt`, 409)
  // The prompt MUST name the same session the execution is bound to: a missing
  // sessionRefId is never defaulted (fail-closed 400) and a value that differs
  // from execution.sessionRefId is a scope conflict (409). Without this the two
  // SESSION_LOCKED / SESSION_BUSY defences (keyed on execution.sessionRefId)
  // would guard a different session than the one actually prompted.
  if (!sessionRefId) throw new StoreError('SESSION_REF_REQUIRED', 'native session prompt requires the execution sessionRefId (no default is invented)', 400)
  if (execution.sessionRefId !== sessionRefId) throw new StoreError('EXECUTION_SESSION_MISMATCH', `execution ${executionId} is bound to session ${execution.sessionRefId ?? '(none)'}, not ${sessionRefId}`, 409)
  const plan = nativePromptPlan({ taskId, executionId, source, nativeSessionId, sessionRefId, cwd, prompt })
  // (P4 gap-7 residual) The ref must structurally describe exactly THIS session
  // before anything durable happens. Placement is deliberate and load-bearing:
  // it runs AFTER nativePromptPlan — a PURE function with zero effects — so the
  // plan's own required-field refusal (400 NATIVE_PROMPT_PLAN_INVALID) still fires
  // first when source/nativeSessionId are genuinely absent, and the ref check only
  // judges the provider/native relationship once both are known present (rather
  // than blaming a well-formed ref for an unrelated missing field). Either way it
  // sits strictly before any store write, approval consumption or spawn, so a
  // refusal has confirmed zero side effects.
  assertSessionRefMatches(sessionRefId, { source, nativeSessionId })
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'native session prompt requires an approved approval id', 403)

  const step = (name) => `${idempotencyKey ?? executionId}:${name}`
  // The single launch scope is shared by the engine ref and the execution guard,
  // so an absent account/profile is consistently absent on both sides. sessionRefId
  // is always present and binds the launch to one session on both sides.
  const scope = { source, nativeSessionId, sessionRefId, cwd, ...(accountId === undefined ? {} : { accountId }), ...(profileId === undefined ? {} : { profileId }) }

  // (2) launch intent FIRST: durable ref + running state before any spawn.
  await store.attachExecutionRef(executionId, { engine: 'native-acp', id: `${source}:${nativeSessionId}`, ...scope }, { idempotencyKey: step('attach') })
  await store.updateExecutionStatus(executionId, { status: 'running', outcome: 'launch intent registered' }, { idempotencyKey: step('running') })

  let launched = false
  try {
    // (3) the approval must cover this exact execution scope and a running execution.
    await store.consumeApproval(approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, {
      executionGuard: { executionId, taskId, ...scope },
      idempotencyKey: step('approval'),
      requireOperator,
    })
    // (4) approved: only now is the native CLI actually spawned. The executionId
    // is threaded through so the live run registers itself in the in-flight
    // registry and an operator cancel can reach the child process.
    launched = true
    const result = await runNativeAcpPrompt({ source, nativeSessionId, cwd, prompt, command, args, sandbox, sandboxGrant, permissionBroker, executionId, cancelGraceMs, role: execution.role })
    // The role comes from the STORED execution (authoritative), never from the
    // caller, so a reviewer can never launder away its read-only constraint by
    // omitting an argument. When the constraint fired, record it once as a
    // durable, auditable Evidence log line (the run result carries it too).
    if (result.reviewerReadonly?.applied) {
      const stripped = result.reviewerReadonly.strippedWriteLiterals ?? []
      const summary = stripped.length > 0
        ? `${REVIEWER_READONLY_APPLIED}: reviewer execution forced read-only; stripped caller-supplied writeLiterals [${stripped.join(', ')}]`
        : `${REVIEWER_READONLY_APPLIED}: reviewer execution forced read-only; no writeLiterals were granted`
      await store.addEvidence(executionId, { kind: 'log', summary, source: `${source}:acp`, redacted: true }, { idempotencyKey: step('readonly') })
    }
    // A cancelled prompt is a terminal, honest outcome — never a completed one.
    // The operator cancel path (cancelNativeExecution) also marks the execution
    // cancelled; whichever writes first, the other is an idempotent no-op.
    if (result.stopReason === 'cancelled') {
      await store.addEvidence(executionId, { kind: 'message', summary: 'native ACP prompt was cancelled (stopReason=cancelled)', source: `${source}:acp`, redacted: true }, { idempotencyKey: step('evidence') })
      const cancelled = await store.updateExecutionStatus(executionId, { status: 'cancelled', outcome: 'native ACP prompt was cancelled through ACP session/cancel' }, { idempotencyKey: step('cancelled') })
      return { execution: cancelled.execution, reply: result.text, stopReason: 'cancelled', cancelled: true, agentInfo: result.agentInfo, reviewerReadonly: result.reviewerReadonly }
    }
    const text = result.text ?? ''
    const summary = text.trim().length > 0
      ? (text.length > 4000 ? `${text.slice(0, 3997)}...` : text)
      : `native ACP prompt returned no text (stopReason=${result.stopReason ?? 'unknown'})`
    await store.addEvidence(executionId, { kind: 'message', summary, source: `${source}:acp`, redacted: true }, { idempotencyKey: step('evidence') })
    const updated = await store.updateExecutionStatus(executionId, { status: 'verifying', outcome: `native ACP prompt completed (${result.stopReason ?? 'unknown'})` }, { idempotencyKey: step('verifying') })
    return { execution: updated.execution, reply: result.text, stopReason: result.stopReason, agentInfo: result.agentInfo, reviewerReadonly: result.reviewerReadonly }
  } catch (error) {
    // A cancel the agent ignored (the process was force-terminated) is recorded
    // honestly as cancelled, never as a generic failure and never as a success.
    if (error?.code === 'NATIVE_ACP_CANCELLED') {
      await store.updateExecutionStatus(executionId, { status: 'cancelled', outcome: 'native ACP prompt was cancelled; the agent did not honour session/cancel and the process was terminated' }, { idempotencyKey: step('cancelled') }).catch(() => {})
      throw error
    }
    // The outcome is honest about the phase: an unlaunched failure is an
    // unauthorized/refused launch (the stored engine ref is retained exactly as
    // the un-authorized launch-intent record it is), a post-spawn failure is an
    // uncertain run. Neither is deleted or disguised.
    const outcome = launched
      ? `native ACP prompt failed or is uncertain: ${error.message}`
      : `native ACP launch was not authorized (${error.code ?? 'NATIVE_ACP_ERROR'}): ${error.message}`
    await store.updateExecutionStatus(executionId, { status: 'blocked', outcome }, { idempotencyKey: step('blocked') }).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Native ACP cancellation channel
//
// Mirrors cancelCezarExecution: the cancellation is bound to an approval that
// covers the EXACT native cancel plan (action `native.session.cancel`, target
// `<source>:<nativeSessionId>`, digest over {executionId, target, sessionRefId}).
// Once the
// approval is consumed, an in-flight run is asked to stop over ACP
// (`session/cancel`, escalating to SIGTERM after NATIVE_CANCEL_GRACE_MS). When
// there is no live process the cancellation is recorded HONESTLY from store
// state — no kill is ever faked.
// ---------------------------------------------------------------------------

const TERMINAL_EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked'])
const CANCELLABLE_EXECUTION_STATUSES = new Set(['queued', 'running'])

// The cancel plan carries the SAME session scope as the prompt plan: the
// sessionRefId is part of the parameters (and therefore the parametersDigest),
// so a cancel approval granted for one session can never cancel another — the
// same one-session-one-approval rule as nativePromptPlan.
export function nativeCancelPlan({ executionId, engineRef, sessionRefId } = {}) {
  if (!executionId || typeof executionId !== 'string' || !engineRef || typeof engineRef.id !== 'string' || !engineRef.id || !sessionRefId || typeof sessionRefId !== 'string') {
    throw new StoreError('NATIVE_CANCEL_PLAN_INVALID', 'executionId, engineRef.id and sessionRefId are required', 400)
  }
  const parameters = { executionId, target: engineRef.id, sessionRefId }
  return { action: 'native.session.cancel', target: engineRef.id, parameters, parametersDigest: parametersDigest(parameters), requiresApproval: true }
}

export async function cancelNativeExecution({ store, executionId, approvalId, idempotencyKey, requireOperator = false } = {}) {
  if (!store) throw new StoreError('STORE_REQUIRED', 'control-plane store is required', 500)
  const execution = await store.getExecution(executionId)
  if (execution.engineRef?.engine !== 'native-acp') throw new StoreError('NATIVE_REF_REQUIRED', 'execution has no native ACP engine reference', 409)
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'cancellation requires an approved approval id', 403)
  // An already-terminal execution has nothing to cancel. Return honestly rather
  // than burning the approval or faking a kill, so a replay of the same request
  // is a pure read and never re-signals a (long gone) process.
  if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
    return {
      replay: true,
      alreadyTerminal: true,
      cancelled: execution.status === 'cancelled',
      liveProcess: false,
      delivered: false,
      execution,
      outcome: `execution is already ${execution.status}; no cancel was performed`,
    }
  }
  const live = inFlightNativeExecutions.get(executionId)
  // A non-terminal execution that is neither live nor queued/running cannot move
  // to `cancelled` under the store state machine (e.g. a `verifying` run with no
  // process). Refuse honestly instead of forcing an illegal transition.
  if (!live && !CANCELLABLE_EXECUTION_STATUSES.has(execution.status)) {
    throw new StoreError('EXECUTION_NOT_CANCELLABLE', `execution is ${execution.status}; only queued or running native executions may be cancelled`, 409)
  }
  // (P4 gap-7 residual) The cancel scope's sessionRefId is DERIVED from the stored
  // execution (D55: cancel carries no sessionRefId in its input), so bind that
  // derived ref to the engine ref's OWN source/nativeSessionId: a cancel whose
  // stored session names a different session than the ref being cancelled is
  // refused here — before the approval is consumed, so the refusal has zero
  // effects. A native launch always records source + nativeSessionId on the engine
  // ref; a ref attached before those fields existed falls back to splitting the
  // `<source>:<nativeSessionId>` engine id, so legacy refs still bind correctly.
  const engineId = typeof execution.engineRef.id === 'string' ? execution.engineRef.id : ''
  const idBreak = engineId.indexOf(':')
  assertSessionRefMatches(execution.sessionRefId, {
    source: typeof execution.engineRef.source === 'string' ? execution.engineRef.source : (idBreak === -1 ? undefined : engineId.slice(0, idBreak)),
    nativeSessionId: typeof execution.engineRef.nativeSessionId === 'string' ? execution.engineRef.nativeSessionId : (idBreak === -1 ? undefined : engineId.slice(idBreak + 1)),
  })
  const plan = nativeCancelPlan({ executionId, engineRef: execution.engineRef, sessionRefId: execution.sessionRefId })
  await store.consumeApproval(approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: `${idempotencyKey ?? executionId}:approval`, requireOperator })
  const signal = live ? live.cancel() : null
  const outcome = signal?.delivered
    ? 'native ACP session/cancel delivered to the in-flight process; execution marked cancelled'
    : live
      ? 'in-flight process found but session/cancel could not be delivered; execution marked cancelled'
      : 'no live process found; marked cancelled from store state (no process kill was performed)'
  const updated = await store.updateExecutionStatus(executionId, { status: 'cancelled', outcome }, { idempotencyKey: `${idempotencyKey ?? executionId}:cancel` })
  return { replay: false, alreadyTerminal: false, liveProcess: Boolean(live), delivered: Boolean(signal?.delivered), execution: updated.execution, outcome }
}
