// Module-level tests for control-plane/native-acp-executor.mjs: the sandbox port
// (V25), the child env allow-list, and the inbound client tool-call adjudication
// bridge to the session permission broker (V47).
//
// Everything here is synthetic. The "agent" is a small Node script written by
// this test that speaks the JSON-RPC line protocol over stdio; it is NOT a real
// Codex/OpenCode/any real Agent CLI. No network is used, no production service
// is started, and no real user file is touched. The genuine OS-level Seatbelt
// evidence lives in tests/native-sandbox.test.mjs and is not duplicated here.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  NATIVE_ACP_BROKER_ERROR,
  NATIVE_ACP_CLIENT_TOOL_DENIED,
  NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED,
  NATIVE_CANCEL_GRACE_MS,
  OCCUPANCY_PROBE_UNCONFIGURED,
  OCCUPANCY_SUMMARY_MAX,
  REVIEWER_READONLY_APPLIED,
  applyReviewerReadonlyConstraint,
  assertSessionRefMatches,
  cancelNativeExecution,
  defaultOccupancyProbe,
  executeNativeSessionPrompt,
  nativeAcpChildEnv,
  nativeAcpSandboxSpec,
  nativeCancelPlan,
  nativeInFlightExecutionIds,
  nativePromptPlan,
  occupancyEvidenceSummary,
  resolveOccupancy,
  runNativeAcpPrompt,
} from '../control-plane/native-acp-executor.mjs'
import { ControlPlaneStore, parametersDigest } from '../control-plane/store.mjs'
import { executionGrantFixture } from './helpers/execution-grant.mjs'

const MAC = { skip: process.platform !== 'darwin' }

// A tiny synthetic ACP agent. On session/prompt it issues each configured
// inbound client request, waits for the executor's JSON-RPC reply, then reports
// the replies plus the environment it actually inherited as a text message chunk.
// It understands only just enough of the protocol to exercise the executor.
function fakeAgentScript(inbound = []) {
  const payload = JSON.stringify(inbound)
  return `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const inbound = ${payload}
const pendingInbound = new Map()
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === undefined && m.id !== undefined) { const r = pendingInbound.get(m.id); if (r) { pendingInbound.delete(m.id); r(m) } return }
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp-agent' }, agentCapabilities: { loadSession: true } } }); return }
  if (m.method === 'session/load') { send({ jsonrpc: '2.0', id: m.id, result: { configOptions: [] } }); return }
  if (m.method === 'session/prompt') {
    void (async () => {
      const responses = []
      for (const request of inbound) {
        const reply = await new Promise((resolve) => { pendingInbound.set(request.id, resolve); send({ jsonrpc: '2.0', id: request.id, method: request.method, params: request.params }) })
        responses.push({ method: request.method, id: request.id, error: reply.error ?? null, result: reply.result ?? null })
      }
      const env = { secret: process.env.SECRET_MARKER ?? null, extra: process.env.EXTRA_FLAG ?? null, path: process.env.PATH ?? null }
      send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ env, responses }) } } } })
      send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
    })()
  }
})
`
}

// A spy sandbox that records every wrap call and then passes the command through
// unchanged, so the fake agent still runs (no real Seatbelt in the injected tests).
const makeSandbox = () => {
  const calls = []
  const sandbox = (command, args, spec) => { calls.push({ command, args: [...args], spec }); return { command, args } }
  return { calls, sandbox }
}

const runPrompt = (overrides = {}) => runNativeAcpPrompt({
  source: 'fake',
  cwd: '/tmp',
  nativeSessionId: 'native-test',
  prompt: 'hello',
  command: process.execPath,
  args: ['-e', fakeAgentScript([])],
  sandbox: makeSandbox().sandbox,
  sandboxGrant: {},
  ...overrides,
})

const reportOf = (result) => JSON.parse(result.text)

test('runNativeAcpPrompt spawns through the sandbox port with a spec derived from cwd, command and grant', async () => {
  const { calls, sandbox } = makeSandbox()
  const result = await runPrompt({
    nativeSessionId: 'native-spy',
    sandbox,
    sandboxGrant: { readLiterals: ['/tmp/read.txt'], writeLiterals: ['/tmp/write.txt'], denyNetwork: true, extraEnv: { EXTRA_FLAG: 'yes' } },
  })
  assert.equal(calls.length, 1, 'the sandbox port must be invoked exactly once')
  assert.equal(calls[0].command, process.execPath)
  assert.deepEqual(calls[0].args, ['-e', calls[0].args[1]])
  assert.equal(calls[0].spec.workspaceDir, '/tmp', 'the workspace is the prompt cwd')
  assert.deepEqual(calls[0].spec.execLiterals, [process.execPath], 'the exec whitelist holds the selected command (deduped with its resolved path)')
  assert.deepEqual(calls[0].spec.readLiterals, ['/tmp/read.txt'])
  assert.deepEqual(calls[0].spec.writeLiterals, ['/tmp/write.txt'])
  assert.equal(calls[0].spec.denyNetwork, true)
  assert.equal(result.stopReason, 'end_turn')
})

test('nativeAcpSandboxSpec defaults read/write to empty, opts the workspace in for write, and passes a grant scratchDir through', () => {
  const spec = nativeAcpSandboxSpec({ command: '/bin/echo', cwd: '/synthetic/ws' })
  assert.deepEqual(spec, { execLiterals: ['/bin/echo'], workspaceDir: '/synthetic/ws', workspaceWrite: true, readLiterals: [], writeLiterals: [], denyNetwork: false })
  // A grant-level scratch dir is threaded through verbatim (its strict validation,
  // including the no-overlap-with-workspace rule, lives in native-sandbox).
  const withScratch = nativeAcpSandboxSpec({ command: '/bin/echo', cwd: '/synthetic/ws', grant: { scratchDir: '/synthetic/scratch' } })
  assert.equal(withScratch.scratchDir, '/synthetic/scratch')
  assert.equal('scratchDir' in spec, false, 'an absent scratchDir is not fabricated')
})

test('the child env is a minimal host allow-list plus explicit grant keys, never the full process.env', async () => {
  process.env.SECRET_MARKER = 'TESTONLY'
  try {
    // Pure shape check.
    const env = nativeAcpChildEnv({ EXTRA_FLAG: 'yes', PATH: '/opt/override', IGNORED: 42 })
    assert.deepEqual(Object.keys(env).sort(), ['EXTRA_FLAG', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR'])
    assert.equal(env.EXTRA_FLAG, 'yes')
    assert.equal(env.PATH, '/opt/override', 'an explicit grant key overrides the host value')
    assert.equal('SECRET_MARKER' in env, false, 'a host secret must not be inherited')
    assert.equal('IGNORED' in env, false, 'non-string grant values are ignored, not coerced')

    // And prove it end-to-end: the spawned agent cannot see the host secret.
    const result = await runPrompt({ sandboxGrant: { extraEnv: { EXTRA_FLAG: 'yes' } } })
    const report = reportOf(result)
    assert.equal(report.env.secret, null, 'the child must not inherit SECRET_MARKER')
    assert.equal(report.env.extra, 'yes')
    assert.equal(typeof report.env.path, 'string')
  } finally { delete process.env.SECRET_MARKER }
})

test('with no permission broker an inbound client tool call is denied with the fixed code', async () => {
  const inbound = [{ id: 100, method: 'fs/read_text_file', params: { path: '/etc/hosts' } }]
  const result = await runPrompt({ args: ['-e', fakeAgentScript(inbound)] })
  const report = reportOf(result)
  assert.equal(report.responses.length, 1)
  assert.equal(report.responses[0].error.data.code, NATIVE_ACP_CLIENT_TOOL_DENIED)
  assert.ok(report.responses[0].error.message.includes(NATIVE_ACP_CLIENT_TOOL_DENIED))
  assert.equal(report.responses[0].error.code, -32601)
  assert.equal(report.responses[0].result, null, 'no result is fabricated for a denied call')
  assert.deepEqual(result.brokerErrors, [])
})

test('a broker denial is surfaced verbatim as the JSON-RPC error code', async () => {
  const calls = []
  const permissionBroker = { handlePermissionRequest: async (request) => { calls.push(request); return { outcome: 'denied', reason: 'session-closed' } } }
  const inbound = [{ id: 7, method: 'fs/read_text_file', params: { path: 'a.txt' } }]
  const result = await runPrompt({ nativeSessionId: 'native-broker', permissionBroker, args: ['-e', fakeAgentScript(inbound)] })
  const report = reportOf(result)
  assert.equal(report.responses[0].error.data.code, 'session-closed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'native-broker', 'the broker sees the native session id')
  assert.equal(calls[0].tool.kind, 'read', 'fs/read_text_file maps to the "read" tool kind')
  assert.equal(typeof calls[0].toolCallId, 'string')
  assert.ok(calls[0].toolCallId.length > 0)
  assert.deepEqual(calls[0].options, [{ kind: 'allow_once', optionId: 'once', name: 'once' }])
  assert.deepEqual(calls[0].rawInput, { path: 'a.txt' })
})

test('a broker allow still returns an honest unsupported error (no capability is faked)', async () => {
  const permissionBroker = { handlePermissionRequest: async () => ({ outcome: 'allow_once' }) }
  const inbound = [{ id: 8, method: 'fs/read_text_file', params: {} }]
  const result = await runPrompt({ permissionBroker, args: ['-e', fakeAgentScript(inbound)] })
  const report = reportOf(result)
  assert.equal(report.responses[0].error.data.code, NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED)
  assert.equal(report.responses[0].error.code, -32601, 'the allow path is reported as unsupported, never as a result')
  assert.equal(report.responses[0].result, null)
})

test('a broker that throws is treated as a denial and is recorded, never silently allowed', async () => {
  const permissionBroker = { handlePermissionRequest: async () => { throw new Error('broker exploded') } }
  const inbound = [{ id: 9, method: 'terminal/create', params: {} }]
  const result = await runPrompt({ permissionBroker, args: ['-e', fakeAgentScript(inbound)] })
  const report = reportOf(result)
  assert.equal(report.responses[0].error.data.code, NATIVE_ACP_BROKER_ERROR)
  assert.equal(report.responses[0].result, null)
  assert.equal(result.brokerErrors.length, 1)
  assert.equal(result.brokerErrors[0], 'broker exploded')
  assert.equal(result.stopReason, 'end_turn', 'a broker failure does not abort the prompt itself')
})

test('a replayed inbound request id never reuses a toolCallId', async () => {
  const calls = []
  const permissionBroker = { handlePermissionRequest: async (request) => { calls.push({ ...request }); return { outcome: 'denied', reason: 'replay' } } }
  const inbound = [
    { id: 7, method: 'fs/write_text_file', params: { path: 'same.txt' } },
    { id: 7, method: 'fs/write_text_file', params: { path: 'same.txt' } },
  ]
  const result = await runPrompt({ permissionBroker, args: ['-e', fakeAgentScript(inbound)] })
  const report = reportOf(result)
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].toolCallId, calls[1].toolCallId, 'a reused inbound id must get a fresh toolCallId')
  assert.equal(report.responses.length, 2)
  for (const response of report.responses) assert.equal(response.error.data.code, 'replay')
})

test('inbound methods map to broker tool kinds and unknown methods fail closed', async () => {
  const kinds = []
  const permissionBroker = { handlePermissionRequest: async (request) => { kinds.push(request.tool.kind); return { outcome: 'denied', reason: 'x' } } }
  const inbound = [
    { id: 1, method: 'fs/read_text_file', params: {} },
    { id: 2, method: 'fs/write_text_file', params: {} },
    { id: 3, method: 'terminal/create', params: {} },
    { id: 4, method: 'mystery/method', params: {} },
  ]
  await runPrompt({ permissionBroker, args: ['-e', fakeAgentScript(inbound)] })
  assert.deepEqual(kinds, ['read', 'edit', 'execute', 'other'])
})

test('the default sandbox port is the real Seatbelt wrapper, which refuses a non-absolute command', MAC, async () => {
  await assert.rejects(
    () => runNativeAcpPrompt({ source: 'fake', cwd: '/tmp', nativeSessionId: 'n', prompt: 'p', command: 'relative-command', args: [] }),
    (error) => error?.code === 'INVALID_SPEC',
  )
})

test('a synthetic prompt completes through the real Seatbelt wrapper (no spy injected)', MAC, async () => {
  const inbound = [{ id: 5, method: 'fs/read_text_file', params: { path: '/etc/hosts' } }]
  const result = await runNativeAcpPrompt({
    source: 'fake', cwd: '/tmp', nativeSessionId: 'native-real-sandbox', prompt: 'hi',
    command: process.execPath, args: ['-e', fakeAgentScript(inbound)],
    sandboxGrant: { denyNetwork: false },
  })
  assert.equal(result.stopReason, 'end_turn')
  const report = reportOf(result)
  assert.equal(report.responses[0].error.data.code, NATIVE_ACP_CLIENT_TOOL_DENIED, 'a default-deny inbound call is refused under the real sandbox too')
})

// ---------------------------------------------------------------------------
// Launch-intent + execution-guard wiring (P4 gaps 2/3/4)
//
// These exercise the real ControlPlaneStore joined to the executor over a
// synthetic ACP agent and a spy sandbox: no real CLI, no network, no user files,
// everything under a scratch state dir. They prove (a) the native engine ref and
// the `running` transition are durably registered BEFORE the spawn, (b) the
// approval is consumed against the exact execution scope, and (c) every refusal
// is left honestly `blocked` with the launch ref retained.
// ---------------------------------------------------------------------------

// Build a fresh store with one queued execution and one approval bound to the
// plan for the canonical synthetic prompt. Overrides let a case pre-decide the
// approval differently or extend the plan (e.g. a different cwd).
async function launchFixture({ decision = 'approved', expiresAt, promptCwd = '/tmp', planCwd = '/tmp', sessionRefId = 'session:fake:native-1', executionSessionRefId = sessionRefId, role } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-launch-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'launch intent guard' }, { idempotencyKey: 'li-task' })
  const executionId = `execution_li_${crypto.randomUUID()}`
  const created = await store.createExecution(task.task.id, { id: executionId, workerId: 'fake:native', ...(role === undefined ? {} : { role }), sessionRefId: executionSessionRefId, ...executionGrantFixture({ taskId: task.task.id, executionId, scope: ['native.session.prompt'] }) }, { idempotencyKey: 'li-exec' })
  const plan = nativePromptPlan({ taskId: task.task.id, executionId, source: 'fake', nativeSessionId: 'native-1', sessionRefId, cwd: planCwd, prompt: '继续' })
  const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest, ...(expiresAt ? { expiresAt } : {}) }, { idempotencyKey: 'li-approval' })
  await store.decideApproval(approval.approval.id, { decision, approvedBy: 'tester' }, { idempotencyKey: 'li-decide' })
  return {
    stateDir,
    store,
    taskId: task.task.id,
    executionId,
    approvalId: approval.approval.id,
    plan,
    sessionRefId,
    input: { taskId: task.task.id, executionId, source: 'fake', nativeSessionId: 'native-1', sessionRefId, cwd: promptCwd, prompt: '继续' },
  }
}

const FAKE_OK = ['-e', fakeAgentScript([])]

// Record the order of the store mutations and the spawn, then delegate to the
// real store (private fields stay bound to the target instance).
function recordingStore(store, events) {
  const watched = new Set(['attachExecutionRef', 'updateExecutionStatus', 'consumeApproval', 'addEvidence'])
  return new Proxy(store, {
    get(target, prop) {
      if (typeof target[prop] !== 'function') return target[prop]
      if (!watched.has(prop)) return target[prop].bind(target)
      return (...args) => { events.push({ op: prop, args }); return target[prop].apply(target, args) }
    },
  })
}

const trackingSandbox = (events) => (command, args) => { events.push({ op: 'spawn' }); return { command, args } }

test('the launch intent (engine ref + running) is durably registered before the native CLI is spawned', async () => {
  const f = await launchFixture()
  try {
    const events = []
    await executeNativeSessionPrompt({
      store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox: trackingSandbox(events), idempotencyKey: 'li-order',
    })
    const ops = events.map((event) => event.op)
    assert.ok(ops.indexOf('attachExecutionRef') < ops.indexOf('updateExecutionStatus'), 'the engine ref must be attached before the running transition')
    assert.ok(ops.indexOf('updateExecutionStatus') < ops.indexOf('consumeApproval'), 'the execution must be running before the approval is consumed')
    assert.ok(ops.indexOf('consumeApproval') < ops.indexOf('spawn'), 'the approval must be consumed before the spawn')
    assert.equal(ops.filter((op) => op === 'attachExecutionRef').length, 1, 'the engine ref is attached exactly once (no post-spawn re-attach)')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('the executor passes a fully-populated execution guard that matches the registered engine ref', async () => {
  const f = await launchFixture()
  try {
    const events = []
    await executeNativeSessionPrompt({
      store: recordingStore(f.store, events), ...f.input, accountId: 'acct-1', profileId: 'prof-1', approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'li-guard',
    })
    const attach = events.find((event) => event.op === 'attachExecutionRef')
    assert.deepEqual(attach.args[1], { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp', accountId: 'acct-1', profileId: 'prof-1' })
    const consume = events.find((event) => event.op === 'consumeApproval')
    assert.deepEqual(consume.args[2].executionGuard, { executionId: f.executionId, taskId: f.taskId, source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp', accountId: 'acct-1', profileId: 'prof-1' })
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('an absent account/profile stays absent on both sides and the prompt still completes', async () => {
  const f = await launchFixture()
  try {
    const result = await executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'li-absent' })
    assert.equal(result.execution.status, 'verifying')
    assert.deepEqual(JSON.parse(result.reply).responses, [])
    const execution = await f.store.getExecution(f.executionId)
    assert.deepEqual(execution.engineRef, { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp' }, 'no accountId/profileId is fabricated; the sessionRefId is present')
    assert.equal('accountId' in execution.engineRef, false)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('a rejected approval leaves the execution blocked with the launch ref retained and an honest outcome', async () => {
  const f = await launchFixture({ decision: 'rejected' })
  try {
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'li-reject' }),
      (error) => error.code === 'APPROVAL_NOT_APPROVED',
    )
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.status, 'blocked')
    assert.match(execution.outcome, /not authorized/)
    assert.match(execution.outcome, /APPROVAL_NOT_APPROVED/, 'the outcome names the real refusal code')
    assert.deepEqual(execution.engineRef, { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp' }, 'the un-authorized launch-intent ref is retained, not deleted')
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined, 'a refused approval is never marked used')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('an expired approval is refused and honestly blocks the execution', async () => {
  const f = await launchFixture({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
  try {
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'li-expired' }),
      (error) => error.code === 'APPROVAL_EXPIRED',
    )
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.status, 'blocked')
    assert.match(execution.outcome, /APPROVAL_EXPIRED/)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('an approval that does not cover the prompt scope is refused and blocks the execution', async () => {
  const f = await launchFixture({ planCwd: '/tmp/approved-elsewhere' })
  try {
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, cwd: '/tmp', approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'li-scope' }),
      (error) => error.code === 'APPROVAL_SCOPE_MISMATCH',
    )
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.status, 'blocked')
    assert.match(execution.outcome, /APPROVAL_SCOPE_MISMATCH/)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('a spawn failure after the launch intent is registered keeps a traceable engine ref and blocks honestly', async () => {
  const f = await launchFixture()
  try {
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: ['-e', 'process.exit(3)'], sandbox: (command, args) => ({ command: '/nonexistent/never-run-this', args }), idempotencyKey: 'li-crash' }),
      (error) => error.code === 'NATIVE_ACP_ERROR',
    )
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.status, 'blocked')
    assert.match(execution.outcome, /failed or is uncertain/)
    assert.equal(execution.engineRef.engine, 'native-acp', 'a crash after the launch intent is still traceable to a stored ref')
    assert.equal(execution.engineRef.id, 'fake:native-1')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

// Simulate a concurrent actor re-binding the execution to a DIFFERENT native
// scope in the window between the launch intent and the approval consumption.
// The store's guard compares the persisted engine ref against the executor's
// guard, so the drift is refused with EXECUTION_SCOPE_CHANGED and the execution
// is blocked rather than spawned.
function rebindingStore(store, rebind) {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'updateExecutionStatus') {
        return async (executionId, input, options) => {
          const result = await target.updateExecutionStatus(executionId, input, options)
          if (input?.status === 'running') await rebind(target, executionId)
          return result
        }
      }
      return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
    },
  })
}

test('a scope drift between the launch intent and the approval is refused with EXECUTION_SCOPE_CHANGED', async () => {
  for (const [field, ref] of [
    ['cwd', { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp/tampered' }],
    ['nativeSessionId', { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-evil', sessionRefId: 'session:fake:native-1', cwd: '/tmp' }],
    ['sessionRefId', { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:other', cwd: '/tmp' }],
  ]) {
    const f = await launchFixture()
    try {
      const store = rebindingStore(f.store, (target, executionId) => target.attachExecutionRef(executionId, ref, { idempotencyKey: `tamper-${field}` }))
      await assert.rejects(
        () => executeNativeSessionPrompt({ store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: `li-tamper-${field}` }),
        (error) => error.code === 'EXECUTION_SCOPE_CHANGED',
        `a drifted ${field} must be refused`,
      )
      assert.equal((await f.store.getExecution(f.executionId)).status, 'blocked', `a drifted ${field} must block the execution`)
    } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
  }
})

test('consumeApproval executionGuard refuses a non-running execution and a mismatched scope', async () => {
  const base = { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp' }
  // (a) execution not running
  {
    const f = await launchFixture()
    try {
      await f.store.attachExecutionRef(f.executionId, base, { idempotencyKey: 'g-nr-attach' })
      await assert.rejects(
        () => f.store.consumeApproval(f.approvalId, { action: f.plan.action, target: f.plan.target, parametersDigest: f.plan.parametersDigest }, { executionGuard: { executionId: f.executionId, taskId: f.taskId, ...base }, idempotencyKey: 'g-nr-consume' }),
        (error) => error.code === 'EXECUTION_SCOPE_CHANGED',
      )
    } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
  }
  // (b) a scope field present on only ONE side (ref or guard) is refused; both
  // sides must agree — checked for accountId and for sessionRefId.
  for (const [label, engineRef, guardExtra] of [
    ['ref-only', { ...base, accountId: 'acct-1' }, {}],
    ['guard-only', base, { accountId: 'acct-1' }],
    ['sessionref-mismatch', base, { sessionRefId: 'session:evil' }],
  ]) {
    const f = await launchFixture()
    try {
      await f.store.attachExecutionRef(f.executionId, engineRef, { idempotencyKey: `g-${label}-attach` })
      await f.store.updateExecutionStatus(f.executionId, { status: 'running' }, { idempotencyKey: `g-${label}-running` })
      await assert.rejects(
        () => f.store.consumeApproval(f.approvalId, { action: f.plan.action, target: f.plan.target, parametersDigest: f.plan.parametersDigest }, { executionGuard: { executionId: f.executionId, taskId: f.taskId, ...base, ...guardExtra }, idempotencyKey: `g-${label}-consume` }),
        (error) => error.code === 'EXECUTION_SCOPE_CHANGED',
        `a scope on only the ${label} side must be refused`,
      )
    } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
  }
})

// ---------------------------------------------------------------------------
// Native ACP cancellation channel (P4 Wave3 step 6)
//
// A synthetic ACP agent that stays in flight on `session/prompt` until it is
// cancelled: on `session/cancel` it either finishes the prompt with
// `stopReason: 'cancelled'` (graceful) or ignores it, forcing the executor's
// SIGTERM escalation. Still no real CLI, no network, no user files, and the
// store lives under a scratch state dir.
// ---------------------------------------------------------------------------

function fakeCancelAgentScript({ behavior = 'graceful' } = {}) {
  return `
const readline = require('node:readline')
const fs = require('node:fs')
const rl = readline.createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const behavior = ${JSON.stringify(behavior)}
let promptRequest = null
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-cancel-agent' }, agentCapabilities: { loadSession: true } } }); return }
  if (m.method === 'session/load') { send({ jsonrpc: '2.0', id: m.id, result: { configOptions: [] } }); return }
  if (m.method === 'session/prompt') {
    promptRequest = m.id
    if (process.env.PROMPT_SENTINEL) fs.writeFileSync(process.env.PROMPT_SENTINEL, 'prompting\\n')
    return
  }
  if (m.method === 'session/cancel') {
    if (process.env.CANCEL_SENTINEL) fs.writeFileSync(process.env.CANCEL_SENTINEL, 'session/cancel\\n')
    if (behavior === 'graceful' && promptRequest !== null) send({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'cancelled' } })
    return
  }
})
`
}

async function waitFor(predicate, { timeout = 4000, interval = 10 } = {}) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeout) throw new Error('waitFor: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

const fileHas = async (file, needle) => { try { return (await fs.readFile(file, 'utf8')).includes(needle) } catch { return false } }

// A fresh store with one queued execution and the two approvals a cancel flow
// needs: the prompt approval (for the in-flight run) and the cancel approval
// (bound to nativeCancelPlan for the engine ref the run will attach).
async function cancelFixture({ nativeSessionId = 'native-1' } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-cancel-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'native cancel' }, { idempotencyKey: 'nc-task' })
  const executionId = `execution_nc_${crypto.randomUUID()}`
  const created = await store.createExecution(task.task.id, { id: executionId, workerId: 'fake:native', sessionRefId: `session:fake:${nativeSessionId}`, ...executionGrantFixture({ taskId: task.task.id, executionId, scope: ['native.session.prompt'] }) }, { idempotencyKey: 'nc-exec' })
  const promptPlan = nativePromptPlan({ taskId: task.task.id, executionId, source: 'fake', nativeSessionId, sessionRefId: `session:fake:${nativeSessionId}`, cwd: '/tmp', prompt: '继续' })
  const promptApproval = await store.createApproval({ action: promptPlan.action, target: promptPlan.target, parametersDigest: promptPlan.parametersDigest }, { idempotencyKey: 'nc-prompt-approval' })
  await store.decideApproval(promptApproval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'nc-prompt-decide' })
  const cancelPlan = nativeCancelPlan({ executionId, engineRef: { id: `fake:${nativeSessionId}` }, sessionRefId: `session:fake:${nativeSessionId}` })
  const cancelApproval = await store.createApproval({ action: cancelPlan.action, target: cancelPlan.target, parametersDigest: cancelPlan.parametersDigest }, { idempotencyKey: 'nc-cancel-approval' })
  await store.decideApproval(cancelApproval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'nc-cancel-decide' })
  return {
    stateDir, store, taskId: task.task.id, executionId,
    promptApprovalId: promptApproval.approval.id,
    cancelApprovalId: cancelApproval.approval.id,
    promptPlan, cancelPlan,
    promptInput: { taskId: task.task.id, executionId, source: 'fake', nativeSessionId, sessionRefId: `session:fake:${nativeSessionId}`, cwd: '/tmp', prompt: '继续' },
    promptArgs: ['-e', fakeCancelAgentScript({ behavior: 'graceful' })],
  }
}

// A native execution that is `running` in the store with NO live process, so the
// "not in flight" honest paths can be exercised without spawning anything.
async function idleNativeExecution() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-cancel-idle-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'native cancel idle' }, { idempotencyKey: 'idle-task' })
  const created = await store.createExecution(task.task.id, { workerId: 'fake:native', sessionRefId: 'session:fake:native-1' }, { idempotencyKey: 'idle-exec' })
  const executionId = created.execution.id
  await store.attachExecutionRef(executionId, { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-1', cwd: '/tmp' }, { idempotencyKey: 'idle-attach' })
  await store.updateExecutionStatus(executionId, { status: 'running' }, { idempotencyKey: 'idle-running' })
  return { stateDir, store, executionId, plan: nativeCancelPlan({ executionId, engineRef: { id: 'fake:native-1' }, sessionRefId: 'session:fake:native-1' }) }
}

async function approveCancel(store, plan, { idempotencyKey, action = plan.action, target = plan.target, digest = plan.parametersDigest } = {}) {
  const approval = await store.createApproval({ action, target, parametersDigest: digest }, { idempotencyKey })
  await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: `${idempotencyKey}-decision` })
  return approval.approval.id
}

// Count how many times the executor touches specific store methods, so a replayed
// cancel can be shown to neither re-consume the approval nor re-write state.
function countingStore(store, counts) {
  const names = ['getExecution', 'consumeApproval', 'updateExecutionStatus']
  return new Proxy(store, {
    get(target, prop) {
      if (typeof target[prop] !== 'function') return target[prop]
      if (!names.includes(prop)) return target[prop].bind(target)
      return (...args) => { counts[prop] = (counts[prop] ?? 0) + 1; return target[prop].apply(target, args) }
    },
  })
}

test('nativeCancelPlan binds the cancel action to the native engine ref id and the session', () => {
  const plan = nativeCancelPlan({ executionId: 'exec-1', engineRef: { id: 'fake:native-1' }, sessionRefId: 'session:fake:native-1' })
  assert.equal(plan.action, 'native.session.cancel')
  assert.equal(plan.target, 'fake:native-1')
  assert.deepEqual(plan.parameters, { executionId: 'exec-1', target: 'fake:native-1', sessionRefId: 'session:fake:native-1' })
  assert.equal(plan.parametersDigest, parametersDigest({ executionId: 'exec-1', target: 'fake:native-1', sessionRefId: 'session:fake:native-1' }))
  assert.equal(plan.requiresApproval, true)
  assert.equal(NATIVE_CANCEL_GRACE_MS, 2000, 'the production grace window is 2s')
  assert.throws(() => nativeCancelPlan({ executionId: 'exec-1' }), (error) => error.code === 'NATIVE_CANCEL_PLAN_INVALID')
  // A missing sessionRefId is refused fail-closed: the cancel scope must bind a session.
  assert.throws(() => nativeCancelPlan({ executionId: 'exec-1', engineRef: { id: 'fake:native-1' } }), (error) => error.code === 'NATIVE_CANCEL_PLAN_INVALID')
})

test('cancelNativeExecution requires a native engine ref and an approval id', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-cancel-ref-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'wrong engine' }, { idempotencyKey: 'ref-task' })
    const created = await store.createExecution(task.task.id, { workerId: 'cezar:codex' }, { idempotencyKey: 'ref-exec' })
    await store.attachExecutionRef(created.execution.id, { engine: 'cezar', id: 'run-1' }, { idempotencyKey: 'ref-attach' })
    await assert.rejects(
      () => cancelNativeExecution({ store, executionId: created.execution.id, approvalId: 'irrelevant' }),
      (error) => error.code === 'NATIVE_REF_REQUIRED',
    )
  } finally { await fs.rm(stateDir, { recursive: true, force: true }) }

  const f = await idleNativeExecution()
  try {
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId }),
      (error) => error.code === 'APPROVAL_REQUIRED',
    )
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution refuses an approval that does not cover the exact cancel plan', async () => {
  const f = await idleNativeExecution()
  try {
    const wrong = await approveCancel(f.store, f.plan, { idempotencyKey: 'scope-approval', target: 'fake:some-other-session' })
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId: wrong, idempotencyKey: 'scope-cancel' }),
      (error) => error.code === 'APPROVAL_SCOPE_MISMATCH',
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'running', 'a refused cancel leaves the execution untouched')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution refuses an approval that has already been consumed', async () => {
  const f = await idleNativeExecution()
  try {
    const approvalId = await approveCancel(f.store, f.plan, { idempotencyKey: 'used-approval' })
    await f.store.consumeApproval(approvalId, { action: f.plan.action, target: f.plan.target, parametersDigest: f.plan.parametersDigest }, { idempotencyKey: 'used-consume' })
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId, idempotencyKey: 'used-cancel' }),
      (error) => error.code === 'APPROVAL_ALREADY_USED',
    )
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution records an honest cancelled state when there is no live process', async () => {
  const f = await idleNativeExecution()
  try {
    const approvalId = await approveCancel(f.store, f.plan, { idempotencyKey: 'nolive-approval' })
    const result = await cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId, idempotencyKey: 'nolive-cancel' })
    assert.equal(result.liveProcess, false, 'no process was found')
    assert.equal(result.delivered, false)
    assert.match(result.outcome, /no live process found/, 'the outcome is honest about not killing anything')
    assert.equal(result.execution.status, 'cancelled')
    assert.equal((await f.store.getExecution(f.executionId)).status, 'cancelled')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution refuses to force a non-terminal execution with no live process', async () => {
  const f = await idleNativeExecution()
  try {
    await f.store.updateExecutionStatus(f.executionId, { status: 'verifying' }, { idempotencyKey: 'nc-verifying' })
    const approvalId = await approveCancel(f.store, f.plan, { idempotencyKey: 'verifying-approval' })
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId, idempotencyKey: 'verifying-cancel' }),
      (error) => error.code === 'EXECUTION_NOT_CANCELLABLE',
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'verifying', 'the execution is not forced into an illegal transition')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution on an already-terminal execution returns idempotently without consuming the approval', async () => {
  const f = await idleNativeExecution()
  try {
    const approvalId = await approveCancel(f.store, f.plan, { idempotencyKey: 'term-approval' })
    await cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId, idempotencyKey: 'term-cancel' })
    assert.equal((await f.store.getExecution(f.executionId)).status, 'cancelled')
    // A second call (with a fresh, unused approval) is a pure read: the terminal
    // guard returns before any consumption, so nothing is burned or re-signalled.
    const replayApproval = await approveCancel(f.store, f.plan, { idempotencyKey: 'term-replay-approval' })
    const replay = await cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId: replayApproval, idempotencyKey: 'term-replay-cancel' })
    assert.equal(replay.replay, true)
    assert.equal(replay.alreadyTerminal, true)
    assert.equal(replay.liveProcess, false)
    assert.equal((await f.store.getApproval(replayApproval)).usedAt, undefined, 'a terminal replay never consumes the approval')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution cancels an in-flight prompt over ACP and drains the registry', async () => {
  const f = await cancelFixture()
  try {
    const cancelSentinel = path.join(f.stateDir, 'cancel-sentinel')
    const promptSentinel = path.join(f.stateDir, 'prompt-sentinel')
    const promptPromise = executeNativeSessionPrompt({
      store: f.store, ...f.promptInput, approvalId: f.promptApprovalId,
      command: process.execPath, args: f.promptArgs, sandbox: makeSandbox().sandbox,
      sandboxGrant: { extraEnv: { CANCEL_SENTINEL: cancelSentinel, PROMPT_SENTINEL: promptSentinel } },
      idempotencyKey: 'nc-live-prompt',
    })
    await waitFor(async () => nativeInFlightExecutionIds().includes(f.executionId))
    await waitFor(() => fileHas(promptSentinel, 'prompting'))
    assert.equal((await f.store.getExecution(f.executionId)).status, 'running')

    const result = await cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId: f.cancelApprovalId, idempotencyKey: 'nc-live-cancel' })
    assert.equal(result.liveProcess, true)
    assert.equal(result.delivered, true, 'the ACP session/cancel was delivered to the live process')
    assert.equal(result.execution.status, 'cancelled')

    await waitFor(() => fileHas(cancelSentinel, 'session/cancel'))
    const promptResult = await promptPromise
    assert.equal(promptResult.stopReason, 'cancelled')
    assert.equal(promptResult.cancelled, true)
    assert.equal(promptResult.execution.status, 'cancelled', 'a cancelled prompt never reports a verifying/completed transition')

    await waitFor(async () => nativeInFlightExecutionIds().length === 0)
    assert.equal((await f.store.getExecution(f.executionId)).status, 'cancelled')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('a cancel the agent ignores escalates to SIGTERM and is recorded as cancelled, never as a failure', async () => {
  const f = await cancelFixture()
  try {
    const cancelSentinel = path.join(f.stateDir, 'cancel-sentinel')
    const promptSentinel = path.join(f.stateDir, 'prompt-sentinel')
    const promptPromise = executeNativeSessionPrompt({
      store: f.store, ...f.promptInput, approvalId: f.promptApprovalId,
      command: process.execPath, args: ['-e', fakeCancelAgentScript({ behavior: 'ignore' })], sandbox: makeSandbox().sandbox,
      sandboxGrant: { extraEnv: { CANCEL_SENTINEL: cancelSentinel, PROMPT_SENTINEL: promptSentinel } },
      cancelGraceMs: 150,
      idempotencyKey: 'nc-ignore-prompt',
    })
    // Attach a handler immediately so the eventual rejection is never unhandled.
    const rejection = promptPromise.then(() => null, (error) => error)
    await waitFor(() => fileHas(promptSentinel, 'prompting'))

    const result = await cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId: f.cancelApprovalId, idempotencyKey: 'nc-ignore-cancel' })
    assert.equal(result.liveProcess, true)
    assert.equal(result.delivered, true)

    assert.ok(await fileHas(cancelSentinel, 'session/cancel'), 'the ACP session/cancel reached the (ignoring) agent')
    const error = await rejection
    assert.equal(error?.code, 'NATIVE_ACP_CANCELLED', 'the forced termination is surfaced honestly')
    await waitFor(async () => nativeInFlightExecutionIds().length === 0)
    assert.equal((await f.store.getExecution(f.executionId)).status, 'cancelled', 'a force-terminated prompt is cancelled, not blocked')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('replaying a cancel never re-consumes the approval nor re-enters the kill path', async () => {
  const f = await cancelFixture()
  try {
    const cancelSentinel = path.join(f.stateDir, 'cancel-sentinel')
    const promptSentinel = path.join(f.stateDir, 'prompt-sentinel')
    const promptPromise = executeNativeSessionPrompt({
      store: f.store, ...f.promptInput, approvalId: f.promptApprovalId,
      command: process.execPath, args: f.promptArgs, sandbox: makeSandbox().sandbox,
      sandboxGrant: { extraEnv: { CANCEL_SENTINEL: cancelSentinel, PROMPT_SENTINEL: promptSentinel } },
      idempotencyKey: 'nc-replay-prompt',
    })
    await waitFor(() => fileHas(promptSentinel, 'prompting'))
    const counts = {}
    const store = countingStore(f.store, counts)
    const first = await cancelNativeExecution({ store, executionId: f.executionId, approvalId: f.cancelApprovalId, idempotencyKey: 'nc-replay' })
    assert.equal(first.liveProcess, true)
    assert.equal(first.delivered, true)
    await promptPromise
    const second = await cancelNativeExecution({ store, executionId: f.executionId, approvalId: f.cancelApprovalId, idempotencyKey: 'nc-replay' })
    assert.equal(second.replay, true)
    assert.equal(second.alreadyTerminal, true)
    assert.equal(second.liveProcess, false, 'the replay never finds (or signals) a live process')
    assert.equal(counts.consumeApproval, 1, 'the approval is consumed exactly once across the replay')
    assert.equal(counts.updateExecutionStatus, 1, 'only the first cancel writes state; the replay is a pure read')
    assert.equal((await f.store.getExecution(f.executionId)).status, 'cancelled')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// sessionRefId in the plan/approval scope (P4 Wave3 step 7, gap 7)
//
// The prompt/cancel plan, the durable engine ref and the execution guard all
// carry the SAME sessionRefId, so (a) an approval the operator granted for one
// session can never launch another, (b) a missing sessionRefId is refused
// fail-closed rather than defaulted, and (c) the native prompt binds exactly the
// session the SESSION_LOCKED / SESSION_BUSY defences key on. Still fully
// synthetic: fake ACP agent, spy sandbox, scratch store dir; no real CLI.
// ---------------------------------------------------------------------------

test('nativePromptPlan carries sessionRefId into the approval digest and refuses a plan without one', () => {
  const plan = nativePromptPlan({ taskId: 'task-1', executionId: 'exec-1', source: 'codex', nativeSessionId: 'native-1', sessionRefId: 'session:codex:native-1', cwd: '/tmp', prompt: '继续' })
  assert.equal(plan.action, 'native.session.prompt')
  assert.equal(plan.target, 'codex/native-1')
  assert.deepEqual(plan.parameters, { taskId: 'task-1', executionId: 'exec-1', source: 'codex', nativeSessionId: 'native-1', sessionRefId: 'session:codex:native-1', cwd: '/tmp', promptDigest: parametersDigest('继续') })
  assert.equal(plan.parametersDigest, parametersDigest(plan.parameters))
  assert.equal(plan.requiresApproval, true)
  // A missing sessionRefId is refused fail-closed (no default is invented).
  assert.throws(
    () => nativePromptPlan({ taskId: 'task-1', executionId: 'exec-1', source: 'codex', nativeSessionId: 'native-1', cwd: '/tmp', prompt: '继续' }),
    (error) => error.code === 'NATIVE_PROMPT_PLAN_INVALID' && error.status === 400,
  )
  // Two plans identical in every other field but the session digest differently.
  const other = nativePromptPlan({ taskId: 'task-1', executionId: 'exec-1', source: 'codex', nativeSessionId: 'native-1', sessionRefId: 'session:codex:native-2', cwd: '/tmp', prompt: '继续' })
  assert.notEqual(other.parametersDigest, plan.parametersDigest, 'a different session yields a different approval digest')
})

test('executeNativeSessionPrompt refuses a missing sessionRefId fail-closed before any effect', async () => {
  const f = await launchFixture()
  try {
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, taskId: f.taskId, executionId: f.executionId, source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp', prompt: '继续', approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sr-missing' }),
      (error) => error.code === 'SESSION_REF_REQUIRED' && error.status === 400,
    )
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.status, 'queued', 'no launch intent is written when the session is absent')
    assert.equal(execution.engineRef, undefined)
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('executeNativeSessionPrompt refuses a sessionRefId that differs from the execution binding', async () => {
  const f = await launchFixture()
  try {
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, sessionRefId: 'session:fake:other', approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sr-mismatch' }),
      (error) => error.code === 'EXECUTION_SESSION_MISMATCH' && error.status === 409,
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'queued', 'a mismatched session never writes a launch intent')
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('an approval bound to one session cannot authorize a prompt on another session', async () => {
  // Both sessions here are structurally valid (`session:fake:<native>` for the
  // request's source 'fake'/nativeSessionId 'native-1'): the two refs differ ONLY
  // in the session, so only the approval digest can explain the refusal — the new
  // ref-binding check (which passes for either) is deliberately not what fires.
  const f = await launchFixture({ sessionRefId: 'session:fake:native-1' })
  try {
    // A plan identical to the executor's in every scope field EXCEPT sessionRefId:
    // only the session differs, so only the digest can explain a mismatch.
    const otherSession = nativePromptPlan({ taskId: f.taskId, executionId: f.executionId, source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:native-2', cwd: '/tmp', prompt: '继续' })
    assert.notEqual(otherSession.parametersDigest, f.plan.parametersDigest)
    const approvalB = await f.store.createApproval({ action: otherSession.action, target: otherSession.target, parametersDigest: otherSession.parametersDigest }, { idempotencyKey: 'xscope-approval-b' })
    await f.store.decideApproval(approvalB.approval.id, { decision: 'approved', approvedBy: 'tester' }, { idempotencyKey: 'xscope-decide-b' })
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: approvalB.approval.id, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'xscope-run' }),
      (error) => error.code === 'APPROVAL_SCOPE_MISMATCH',
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'blocked')
    assert.equal((await f.store.getApproval(approvalB.approval.id)).usedAt, undefined, 'the wrong-session approval is never consumed')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('the sessionRefId the native prompt binds is the session SESSION_BUSY/SESSION_LOCKED guard', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-session-busy-'))
  try {
    const store = new ControlPlaneStore({ stateDir })
    const task = await store.createTask({ goal: 'session busy' }, { idempotencyKey: 'sb-task' })
    // Second line of defence: a second active execution on the same session is refused.
    const first = await store.createExecution(task.task.id, { workerId: 'fake:native', sessionRefId: 'session:fake:S' }, { idempotencyKey: 'sb-exec-1' })
    await assert.rejects(
      () => store.createExecution(task.task.id, { workerId: 'fake:native', sessionRefId: 'session:fake:S' }, { idempotencyKey: 'sb-exec-2' }),
      (error) => error.code === 'SESSION_BUSY',
    )
    // First line of defence: a locked session cannot be claimed without the token.
    await store.acquireSessionLock('session:fake:L', { owner: 'chief', ttlMs: 10_000 }, { idempotencyKey: 'sb-lock' })
    await assert.rejects(
      () => store.createExecution(task.task.id, { workerId: 'fake:native', sessionRefId: 'session:fake:L' }, { idempotencyKey: 'sb-exec-3' }),
      (error) => error.code === 'SESSION_LOCKED',
    )
    // The launched prompt can only ever name the execution's exact session, so the
    // guarded session and the prompted session cannot diverge.
    await assert.rejects(
      () => executeNativeSessionPrompt({ store, taskId: task.task.id, executionId: first.execution.id, source: 'fake', nativeSessionId: 'native-1', sessionRefId: 'session:fake:OTHER', cwd: '/tmp', prompt: '继续', approvalId: 'irrelevant', command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sb-run' }),
      (error) => error.code === 'EXECUTION_SESSION_MISMATCH',
    )
  } finally { await fs.rm(stateDir, { recursive: true, force: true }) }
})

test('a cancel approval bound to one session cannot cancel another session', async () => {
  const f = await idleNativeExecution()
  try {
    const otherSession = nativeCancelPlan({ executionId: f.executionId, engineRef: { id: 'fake:native-1' }, sessionRefId: 'session:fake:other' })
    assert.notEqual(otherSession.parametersDigest, f.plan.parametersDigest)
    const approvalId = await approveCancel(f.store, otherSession, { idempotencyKey: 'xscope-cancel-approval' })
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId, idempotencyKey: 'xscope-cancel' }),
      (error) => error.code === 'APPROVAL_SCOPE_MISMATCH',
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'running', 'a wrong-session cancel leaves the execution untouched')
    assert.equal((await f.store.getApproval(approvalId)).usedAt, undefined, 'the wrong-session cancel approval is never consumed')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Reviewer read-only enforcement (P4 Wave3 step 8, gap 8)
//
// A reviewer execution must be able to READ the artifact under review but must
// never rewrite it. When the execution's role is `reviewer` the native sandbox
// spec's writeLiterals is FORCED empty — even when the caller explicitly granted
// write paths — and the downgrade is reported in the run result and (for the
// store-backed path) recorded as an auditable Evidence log line. Fully synthetic:
// fake ACP agent, spy sandbox, scratch store dir; no real CLI, no network.
// ---------------------------------------------------------------------------

test('applyReviewerReadonlyConstraint forces workspaceWrite false and writeLiterals empty for a reviewer, keeps scratch, and never mutates the input', () => {
  const spec = nativeAcpSandboxSpec({ command: '/bin/echo', cwd: '/synthetic/ws', grant: { readLiterals: ['/r.txt'], writeLiterals: ['/w.txt'], denyNetwork: true, scratchDir: '/synthetic/scratch' } })
  assert.equal(spec.workspaceWrite, true, 'the worker spec opts the workspace in for write')
  const reviewer = applyReviewerReadonlyConstraint(spec, 'reviewer')
  assert.deepEqual(reviewer.spec.writeLiterals, [], 'the reviewer write literals are forced empty')
  assert.equal(reviewer.spec.workspaceWrite, false, 'the workspace write grant itself is turned off (an empty array alone is not enough)')
  assert.deepEqual(reviewer.spec.readLiterals, ['/r.txt'], 'read access is preserved (the reviewer must read the artifact)')
  assert.equal(reviewer.spec.denyNetwork, true, 'the network policy is untouched')
  assert.equal(reviewer.spec.scratchDir, '/synthetic/scratch', 'the host scratch outlet is preserved as the one remaining write path')
  assert.deepEqual(spec.writeLiterals, ['/w.txt'], 'the input spec is not mutated (write literals)')
  assert.equal(spec.workspaceWrite, true, 'the input spec is not mutated (workspaceWrite)')
  assert.equal(reviewer.readonly.applied, true)
  assert.equal(reviewer.readonly.code, REVIEWER_READONLY_APPLIED)
  assert.deepEqual(reviewer.readonly.strippedWriteLiterals, ['/w.txt'])
  assert.equal(reviewer.readonly.scratchDir, '/synthetic/scratch')
  // With no scratch dir there is no write outlet at all.
  const bare = applyReviewerReadonlyConstraint(nativeAcpSandboxSpec({ command: '/bin/echo', cwd: '/synthetic/ws' }), 'reviewer')
  assert.equal(bare.spec.workspaceWrite, false)
  assert.deepEqual(bare.spec.writeLiterals, [])
  assert.equal('scratchDir' in bare.spec, false)
  assert.equal(bare.readonly.scratchDir, undefined)
  for (const role of [undefined, 'worker']) {
    const out = applyReviewerReadonlyConstraint(spec, role)
    assert.equal(out.spec, spec, 'a non-reviewer spec is passed through untouched')
    assert.equal(out.readonly.applied, false)
  }
})

test('a reviewer native prompt forces workspaceWrite false and writeLiterals empty in the sandbox spec and reports the marker', async () => {
  const { calls, sandbox } = makeSandbox()
  const result = await runPrompt({
    nativeSessionId: 'native-reviewer',
    role: 'reviewer',
    sandbox,
    sandboxGrant: { readLiterals: ['/tmp/artifact.txt'], writeLiterals: ['/tmp/must-not-write.txt'], denyNetwork: true },
  })
  assert.equal(calls.length, 1, 'the sandbox port is invoked exactly once')
  assert.deepEqual(calls[0].spec.writeLiterals, [], 'a caller write grant on a reviewer run is stripped at the sandbox port')
  assert.equal(calls[0].spec.workspaceWrite, false, 'the workspace write grant is turned off, so the reviewed artifact is read-only under Seatbelt')
  assert.deepEqual(calls[0].spec.readLiterals, ['/tmp/artifact.txt'], 'the reviewer keeps read access to the artifact')
  assert.equal(calls[0].spec.denyNetwork, true, 'the network policy is unchanged')
  assert.equal(result.reviewerReadonly.applied, true)
  assert.equal(result.reviewerReadonly.code, REVIEWER_READONLY_APPLIED)
  assert.deepEqual(result.reviewerReadonly.strippedWriteLiterals, ['/tmp/must-not-write.txt'])
  assert.equal(result.stopReason, 'end_turn', 'the prompt still runs, just read-only')
})

test('a worker native prompt passes writeLiterals and the workspace write opt-in through unchanged', async () => {
  const { calls, sandbox } = makeSandbox()
  const result = await runPrompt({
    nativeSessionId: 'native-worker',
    sandbox,
    sandboxGrant: { writeLiterals: ['/tmp/write.txt'] },
  })
  assert.deepEqual(calls[0].spec.writeLiterals, ['/tmp/write.txt'], 'a non-reviewer keeps its write grant verbatim')
  assert.equal(calls[0].spec.workspaceWrite, true, 'a non-reviewer keeps the workspace writable')
  assert.equal(result.reviewerReadonly.applied, false)
})

test('executeNativeSessionPrompt takes the role from the stored execution and records the read-only constraint', async () => {
  const f = await launchFixture({ role: 'reviewer' })
  try {
    const { calls, sandbox } = makeSandbox()
    const result = await executeNativeSessionPrompt({
      store: f.store, ...f.input, approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox,
      sandboxGrant: { readLiterals: ['/tmp/artifact.txt'], writeLiterals: ['/tmp/must-not-write.txt'], scratchDir: '/synthetic/reviewer-scratch' },
      idempotencyKey: 'ro-reviewer',
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].spec.writeLiterals, [], 'the stored reviewer role strips the write grant at the sandbox port')
    assert.equal(calls[0].spec.workspaceWrite, false, 'the stored reviewer role turns the workspace write off')
    assert.equal(calls[0].spec.scratchDir, '/synthetic/reviewer-scratch', 'the host scratch dir survives as the only write outlet')
    assert.equal(result.execution.status, 'verifying')
    assert.equal(result.reviewerReadonly.applied, true)
    assert.equal(result.reviewerReadonly.code, REVIEWER_READONLY_APPLIED)
    const evidence = (await f.store.getTask(f.taskId)).evidence
    const log = evidence.find((item) => item.kind === 'log' && item.summary.includes(REVIEWER_READONLY_APPLIED))
    assert.ok(log, 'the read-only downgrade is recorded as an auditable Evidence log line')
    assert.match(log.summary, /must-not-write\.txt/, 'the stripped write literals are named')
    assert.match(log.summary, /workspaceWrite=false/, 'the Evidence is honest about the workspace write being off')
    assert.match(log.summary, /synthetic\/reviewer-scratch/, 'the Evidence names the surviving scratch outlet (matches the real OS rule)')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// sessionRefId ↔ nativeSessionId/source consistency (P4 gap-7 residual, D56)
//
// Every provider mints its SessionRef id as `session:<provider>:<nativeSessionId>`
// (control-plane/session-index.mjs). assertSessionRefMatches binds an inbound ref
// to the (source, nativeSessionId) it must describe, so a well-formed ref minted
// for session A can never be silently used against session B. This is the
// STRUCTURAL half of the session-index-consistency residual: shape only, never
// existence/freshness (that is a deployment-batch concern). Still fully synthetic:
// fake ACP agent, spy sandbox, scratch store dir; no real CLI, no network.
// ---------------------------------------------------------------------------

test('assertSessionRefMatches binds a ref to the exact source/nativeSessionId, splitting malformed (400) from mismatched (409)', () => {
  // Consistent → the parsed binding is returned.
  assert.deepEqual(
    assertSessionRefMatches('session:codex:native-1', { source: 'codex', nativeSessionId: 'native-1' }),
    { source: 'codex', nativeSessionId: 'native-1' },
  )
  // A native id that itself contains a colon is carried through verbatim (only the
  // FIRST colon after the prefix is the provider separator).
  assert.deepEqual(
    assertSessionRefMatches('session:codex:thread:2', { source: 'codex', nativeSessionId: 'thread:2' }),
    { source: 'codex', nativeSessionId: 'thread:2' },
  )
  // Malformed: not a `session:<provider>:<native>` triple at all → 400 parameter error.
  for (const bad of [undefined, null, 42, '', 'codex:native-1', 'session', 'session:', 'session:codex', 'session:codex:', 'session::native-1', 'Session:codex:native-1']) {
    assert.throws(
      () => assertSessionRefMatches(bad, { source: 'codex', nativeSessionId: 'native-1' }),
      (error) => error.code === 'SESSION_REF_MALFORMED' && error.status === 400,
      `malformed ref ${JSON.stringify(bad)} must be refused as a 400 parameter error`,
    )
  }
  // Mismatch: well-formed but names a different provider or a different native id → 409.
  assert.throws(
    () => assertSessionRefMatches('session:opencode:native-1', { source: 'codex', nativeSessionId: 'native-1' }),
    (error) => error.code === 'SESSION_REF_MISMATCH' && error.status === 409,
  )
  // The near-miss trap: same prefix, different suffix must NOT be treated as equal.
  assert.throws(
    () => assertSessionRefMatches('session:codex:native-10', { source: 'codex', nativeSessionId: 'native-1' }),
    (error) => error.code === 'SESSION_REF_MISMATCH' && error.status === 409,
  )
  assert.throws(
    () => assertSessionRefMatches('session:codex:native-1', { source: 'codex', nativeSessionId: 'native-10' }),
    (error) => error.code === 'SESSION_REF_MISMATCH' && error.status === 409,
  )
})

test('executeNativeSessionPrompt refuses a malformed sessionRefId as a 400 with zero store writes', async () => {
  const f = await launchFixture({ sessionRefId: 'not-a-session-ref' })
  try {
    const events = []
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sr-malformed' }),
      (error) => error.code === 'SESSION_REF_MALFORMED' && error.status === 400,
    )
    assert.deepEqual(events, [], 'a malformed ref must not touch the store at all (no attach/running/consume/evidence)')
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.status, 'queued', 'no launch intent is written for a malformed ref')
    assert.equal(execution.engineRef, undefined)
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined, 'the approval is never consumed')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('executeNativeSessionPrompt refuses a sessionRefId whose provider is not the request source', async () => {
  // The execution and the input agree on the ref (so the EXECUTION_SESSION_MISMATCH
  // guard passes); only the ref's PROVIDER contradicts the request source.
  const f = await launchFixture({ sessionRefId: 'session:opencode:native-1' })
  try {
    const events = []
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sr-provider' }),
      (error) => error.code === 'SESSION_REF_MISMATCH' && error.status === 409,
    )
    assert.deepEqual(events, [], 'a provider-mismatched ref must not touch the store at all')
    assert.equal((await f.store.getExecution(f.executionId)).status, 'queued')
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('executeNativeSessionPrompt refuses a sessionRefId whose native segment is a near-miss of the requested one', async () => {
  // 'native-10' shares the 'native-1' prefix but is a DIFFERENT session: a naive
  // "startsWith" match would launder it, an exact match refuses it.
  const f = await launchFixture({ sessionRefId: 'session:fake:native-10' })
  try {
    const events = []
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sr-nearmiss' }),
      (error) => error.code === 'SESSION_REF_MISMATCH' && error.status === 409,
    )
    assert.deepEqual(events, [], 'a near-miss ref must not touch the store at all')
    assert.equal((await f.store.getExecution(f.executionId)).status, 'queued')
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('executeNativeSessionPrompt accepts a sessionRefId that structurally describes the requested session', async () => {
  const f = await launchFixture({ sessionRefId: 'session:fake:native-1' })
  try {
    const result = await executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'sr-consistent' })
    assert.equal(result.execution.status, 'verifying', 'a structurally consistent ref passes and the prompt runs')
    const execution = await f.store.getExecution(f.executionId)
    assert.equal(execution.engineRef.sessionRefId, 'session:fake:native-1', 'the bound ref is the consistent one')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

// A small fixture for the cancel-path ref binding: an execution whose stored
// sessionRefId is deliberately at odds with its engine ref's source/nativeSessionId.
async function refMismatchedCancelFixture({ sessionRefId, engineSource = 'fake', engineNativeSessionId = 'native-1' } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-cancel-refbind-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'cancel ref binding' }, { idempotencyKey: 'crb-task' })
  const created = await store.createExecution(task.task.id, { workerId: 'fake:native', sessionRefId }, { idempotencyKey: 'crb-exec' })
  const executionId = created.execution.id
  await store.attachExecutionRef(executionId, { engine: 'native-acp', id: `${engineSource}:${engineNativeSessionId}`, source: engineSource, nativeSessionId: engineNativeSessionId, sessionRefId, cwd: '/tmp' }, { idempotencyKey: 'crb-attach' })
  await store.updateExecutionStatus(executionId, { status: 'running' }, { idempotencyKey: 'crb-running' })
  const plan = nativeCancelPlan({ executionId, engineRef: { id: `${engineSource}:${engineNativeSessionId}` }, sessionRefId })
  const approvalId = await approveCancel(store, plan, { idempotencyKey: 'crb-approval' })
  return { stateDir, store, executionId, approvalId }
}

test('cancelNativeExecution refuses a stored session that does not match its engine ref, before consuming the approval', async () => {
  // The cancel plan is approved for exactly this stored session (so consumeApproval
  // would otherwise succeed): only the ref-binding check stands between the request
  // and a cancel of a session the engine ref does not describe.
  const f = await refMismatchedCancelFixture({ sessionRefId: 'session:fake:other' })
  try {
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId: f.approvalId, idempotencyKey: 'crb-cancel' }),
      (error) => error.code === 'SESSION_REF_MISMATCH' && error.status === 409,
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'running', 'a ref that names another session never cancels the execution')
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined, 'the cancel approval is never consumed')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('cancelNativeExecution refuses a malformed stored sessionRefId as a 400 before any effect', async () => {
  const f = await refMismatchedCancelFixture({ sessionRefId: 'garbage' })
  try {
    await assert.rejects(
      () => cancelNativeExecution({ store: f.store, executionId: f.executionId, approvalId: f.approvalId, idempotencyKey: 'crb-malformed-cancel' }),
      (error) => error.code === 'SESSION_REF_MALFORMED' && error.status === 400,
    )
    assert.equal((await f.store.getExecution(f.executionId)).status, 'running', 'a malformed stored ref never cancels the execution')
    assert.equal((await f.store.getApproval(f.approvalId)).usedAt, undefined, 'the cancel approval is never consumed')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// External-occupancy observation (V41)
//
// The occupancy probe is an OPTIONAL port whose honest default is `unknown` (a
// local SESSION_LOCKED / SESSION_BUSY lock can never stand in for an external
// App / GUI lock, so absent evidence we must NOT claim `clear`). Every launch
// records its occupancy as its own bounded, redacted Evidence log line under a
// dedicated `${key}:occupancy` key, and `suspected` is surfaced in the outcome
// without blocking the spawn (record-level concern, not an admission gate).
// Fully synthetic: fake ACP agent, spy sandbox, scratch store dir; no real CLI,
// no network, no user files.
// ---------------------------------------------------------------------------

// The occupancy Evidence log lines recorded for one execution, in order.
const occupancyEvidence = async (store, taskId) =>
  (await store.getTask(taskId)).evidence.filter((item) => item.kind === 'log' && item.summary.includes('外部占用探测'))

test('the default occupancy probe answers unknown (never clear), and resolveOccupancy normalises the three states honestly', async () => {
  // The default probe must NEVER claim `clear`: with no external-occupancy source
  // wired, `unknown` + the reason is the only honest answer.
  assert.deepEqual(await defaultOccupancyProbe(), { state: 'unknown', detail: OCCUPANCY_PROBE_UNCONFIGURED })
  assert.deepEqual(await resolveOccupancy({}), { state: 'unknown', detail: OCCUPANCY_PROBE_UNCONFIGURED }, 'no probe configured → unknown')
  assert.deepEqual(await resolveOccupancy({ probe: null }), { state: 'unknown', detail: OCCUPANCY_PROBE_UNCONFIGURED }, 'a non-function probe falls back to the default')
  // The three recognised states pass through with their detail.
  assert.deepEqual(await resolveOccupancy({ probe: async () => ({ state: 'clear', detail: 'no GUI on this cwd' }) }), { state: 'clear', detail: 'no GUI on this cwd' })
  assert.deepEqual(await resolveOccupancy({ probe: async () => ({ state: 'suspected', detail: 'GUI open' }) }), { state: 'suspected', detail: 'GUI open' })
  assert.deepEqual(await resolveOccupancy({ probe: async () => ({ state: 'unknown', detail: 'cannot tell' }) }), { state: 'unknown', detail: 'cannot tell' })
  // A missing detail gets an honest per-state default rather than fabricated evidence.
  assert.equal((await resolveOccupancy({ probe: async () => ({ state: 'clear' }) })).detail, '未检测到外部占用迹象')
  // An unrecognised state fails soft to unknown — never to clear.
  const weird = await resolveOccupancy({ probe: async () => ({ state: 'maybe' }) })
  assert.equal(weird.state, 'unknown')
  assert.equal(weird.probeError, 'OCCUPANCY_PROBE_UNRECOGNIZED')
  assert.match(weird.detail, /maybe/)
  // The Evidence summary always carries the state and is bounded.
  const long = await resolveOccupancy({ probe: async () => ({ state: 'suspected', detail: 'x'.repeat(1000) }) })
  const summary = occupancyEvidenceSummary(long)
  assert.match(summary, /state=suspected/)
  assert.ok(summary.length <= OCCUPANCY_SUMMARY_MAX, `the occupancy summary is bounded (got ${summary.length})`)
})

test('with no occupancy probe configured the launch records an honest unknown (never clear)', async () => {
  const f = await launchFixture()
  try {
    const result = await executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'occ-default' })
    assert.equal(result.execution.status, 'verifying')
    assert.equal(result.occupancy.state, 'unknown', 'the default probe must never claim clear')
    assert.equal(result.occupancy.detail, OCCUPANCY_PROBE_UNCONFIGURED)
    const records = await occupancyEvidence(f.store, f.taskId)
    assert.equal(records.length, 1, 'exactly one occupancy record is written')
    assert.match(records[0].summary, /state=unknown/)
    assert.match(records[0].summary, /未配置外部占用探测/)
    assert.equal(records[0].kind, 'log')
    assert.equal(records[0].redacted, true)
    assert.equal(records[0].source, 'fake:acp')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('the occupancy probe receives the source, nativeSessionId and cwd of the launch', async () => {
  const seen = []
  const f = await launchFixture()
  try {
    await executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, occupancyProbe: async (input) => { seen.push(input); return { state: 'clear', detail: 'quiet' } }, idempotencyKey: 'occ-args' })
    assert.deepEqual(seen, [{ source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp' }])
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('a clear / suspected / unknown probe each lands its own occupancy Evidence record', async () => {
  for (const state of ['clear', 'suspected', 'unknown']) {
    const f = await launchFixture()
    try {
      const result = await executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, occupancyProbe: async () => ({ state, detail: `probe says ${state}` }), idempotencyKey: `occ-${state}` })
      assert.equal(result.occupancy.state, state)
      const records = await occupancyEvidence(f.store, f.taskId)
      assert.equal(records.length, 1, `a ${state} probe writes exactly one record`)
      assert.match(records[0].summary, new RegExp(`state=${state}`))
      assert.match(records[0].summary, new RegExp(`probe says ${state}`))
    } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
  }
})

test('a probe that throws is recorded as unknown with the error class and never blocks the launch', async () => {
  const f = await launchFixture()
  try {
    const events = []
    const boom = Object.assign(new Error('gui query exploded'), { code: 'GUI_PROBE_DOWN' })
    const result = await executeNativeSessionPrompt({
      store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox: trackingSandbox(events),
      occupancyProbe: async () => { throw boom },
      idempotencyKey: 'occ-throw',
    })
    assert.equal(result.execution.status, 'verifying', 'a broken probe must not block the launch')
    assert.equal(result.occupancy.state, 'unknown')
    assert.equal(result.occupancy.probeError, 'GUI_PROBE_DOWN')
    assert.match(result.occupancy.detail, /GUI_PROBE_DOWN/, 'the error class is recorded')
    assert.match(result.occupancy.detail, /gui query exploded/)
    assert.ok(events.some((event) => event.op === 'spawn'), 'the spawn still happens after a probe failure')
    const [record] = await occupancyEvidence(f.store, f.taskId)
    assert.match(record.summary, /state=unknown/)
    assert.match(record.summary, /GUI_PROBE_DOWN/)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('a suspected occupancy is recorded, does not block the spawn, and is surfaced in the outcome', async () => {
  const f = await launchFixture()
  try {
    const events = []
    const result = await executeNativeSessionPrompt({
      store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox: trackingSandbox(events),
      occupancyProbe: async () => ({ state: 'suspected', detail: 'GUI 打开同一 cwd' }),
      idempotencyKey: 'occ-suspected',
    })
    assert.equal(result.execution.status, 'verifying', 'a suspected occupancy is recorded, never enforced')
    assert.equal(result.occupancy.state, 'suspected')
    assert.ok(events.some((event) => event.op === 'spawn'), 'a suspected occupancy must not block the spawn')
    assert.match(result.execution.outcome, /检测到可能的外部占用迹象/)
    const records = await occupancyEvidence(f.store, f.taskId)
    assert.equal(records.length, 1)
    assert.match(records[0].summary, /state=suspected/)
    assert.match(records[0].summary, /GUI 打开同一 cwd/)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('the occupancy record is written under a dedicated idempotency key so a replay never duplicates it', async () => {
  const f = await launchFixture()
  try {
    const events = []
    await executeNativeSessionPrompt({
      store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox,
      occupancyProbe: async () => ({ state: 'clear', detail: 'quiet' }),
      idempotencyKey: 'occ-replay',
    })
    assert.equal((await occupancyEvidence(f.store, f.taskId)).length, 1)
    const call = events.find((event) => event.op === 'addEvidence' && event.args[1].summary.includes('外部占用探测'))
    assert.ok(call, 'the occupancy record is written through addEvidence')
    assert.equal(call.args[2].idempotencyKey, 'occ-replay:occupancy', 'the occupancy key is dedicated')
    // Replaying the very same write (same key, same input) is an idempotent no-op.
    const replay = await f.store.addEvidence(f.executionId, call.args[1], { idempotencyKey: call.args[2].idempotencyKey })
    assert.equal(replay.replay, true)
    assert.equal((await occupancyEvidence(f.store, f.taskId)).length, 1, 'a replayed occupancy key never adds a second record')
    // And a full executor replay is refused before any effect (the execution is no longer queued).
    await assert.rejects(
      () => executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, occupancyProbe: async () => ({ state: 'clear', detail: 'quiet' }), idempotencyKey: 'occ-replay' }),
      (error) => error.code === 'EXECUTION_NOT_QUEUED',
    )
    assert.equal((await occupancyEvidence(f.store, f.taskId)).length, 1)
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('the occupancy probe runs after the launch intent and before the approval is consumed', async () => {
  const f = await launchFixture()
  try {
    const events = []
    await executeNativeSessionPrompt({
      store: recordingStore(f.store, events), ...f.input, approvalId: f.approvalId,
      command: process.execPath, args: FAKE_OK, sandbox: trackingSandbox(events),
      occupancyProbe: async () => ({ state: 'clear', detail: 'quiet' }),
      idempotencyKey: 'occ-order',
    })
    const occupancyAt = events.findIndex((event) => event.op === 'addEvidence' && event.args[1].summary.includes('外部占用探测'))
    const runningAt = events.findIndex((event) => event.op === 'updateExecutionStatus' && event.args[1]?.status === 'running')
    const consumeAt = events.findIndex((event) => event.op === 'consumeApproval')
    const spawnAt = events.findIndex((event) => event.op === 'spawn')
    assert.ok(runningAt > -1 && occupancyAt > -1 && consumeAt > -1 && spawnAt > -1)
    assert.ok(runningAt < occupancyAt, 'the launch intent (running) precedes the occupancy record')
    assert.ok(occupancyAt < consumeAt, 'the occupancy record precedes the approval consumption')
    assert.ok(occupancyAt < spawnAt, 'the occupancy record precedes the spawn')
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})
