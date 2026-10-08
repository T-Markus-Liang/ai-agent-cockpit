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
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  NATIVE_ACP_BROKER_ERROR,
  NATIVE_ACP_CLIENT_TOOL_DENIED,
  NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED,
  executeNativeSessionPrompt,
  nativeAcpChildEnv,
  nativeAcpSandboxSpec,
  nativePromptPlan,
  runNativeAcpPrompt,
} from '../control-plane/native-acp-executor.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'

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

test('nativeAcpSandboxSpec defaults read/write to empty and denyNetwork to false', () => {
  const spec = nativeAcpSandboxSpec({ command: '/bin/echo', cwd: '/synthetic/ws' })
  assert.deepEqual(spec, { execLiterals: ['/bin/echo'], workspaceDir: '/synthetic/ws', readLiterals: [], writeLiterals: [], denyNetwork: false })
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
async function launchFixture({ decision = 'approved', expiresAt, promptCwd = '/tmp', planCwd = '/tmp' } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-launch-'))
  const store = new ControlPlaneStore({ stateDir })
  const task = await store.createTask({ goal: 'launch intent guard' }, { idempotencyKey: 'li-task' })
  const created = await store.createExecution(task.task.id, { workerId: 'fake:native', sessionRefId: 'session:fake:native-1' }, { idempotencyKey: 'li-exec' })
  const executionId = created.execution.id
  const plan = nativePromptPlan({ taskId: task.task.id, executionId, source: 'fake', nativeSessionId: 'native-1', cwd: planCwd, prompt: '继续' })
  const approval = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest, ...(expiresAt ? { expiresAt } : {}) }, { idempotencyKey: 'li-approval' })
  await store.decideApproval(approval.approval.id, { decision, approvedBy: 'tester' }, { idempotencyKey: 'li-decide' })
  return {
    stateDir,
    store,
    taskId: task.task.id,
    executionId,
    approvalId: approval.approval.id,
    plan,
    input: { taskId: task.task.id, executionId, source: 'fake', nativeSessionId: 'native-1', cwd: promptCwd, prompt: '继续' },
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
    assert.deepEqual(attach.args[1], { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp', accountId: 'acct-1', profileId: 'prof-1' })
    const consume = events.find((event) => event.op === 'consumeApproval')
    assert.deepEqual(consume.args[2].executionGuard, { executionId: f.executionId, taskId: f.taskId, source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp', accountId: 'acct-1', profileId: 'prof-1' })
  } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
})

test('an absent account/profile stays absent on both sides and the prompt still completes', async () => {
  const f = await launchFixture()
  try {
    const result = await executeNativeSessionPrompt({ store: f.store, ...f.input, approvalId: f.approvalId, command: process.execPath, args: FAKE_OK, sandbox: makeSandbox().sandbox, idempotencyKey: 'li-absent' })
    assert.equal(result.execution.status, 'verifying')
    assert.deepEqual(JSON.parse(result.reply).responses, [])
    const execution = await f.store.getExecution(f.executionId)
    assert.deepEqual(execution.engineRef, { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp' }, 'no accountId/profileId is fabricated')
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
    assert.deepEqual(execution.engineRef, { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp' }, 'the un-authorized launch-intent ref is retained, not deleted')
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
    ['cwd', { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp/tampered' }],
    ['nativeSessionId', { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-evil', cwd: '/tmp' }],
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

test('consumeApproval executionGuard refuses a non-running execution and a one-sided account scope', async () => {
  const base = { engine: 'native-acp', id: 'fake:native-1', source: 'fake', nativeSessionId: 'native-1', cwd: '/tmp' }
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
  // (b) accountId present on only ONE side (ref or guard) is refused; both sides must agree.
  for (const [label, engineRef, guardExtra] of [
    ['ref-only', { ...base, accountId: 'acct-1' }, {}],
    ['guard-only', base, { accountId: 'acct-1' }],
  ]) {
    const f = await launchFixture()
    try {
      await f.store.attachExecutionRef(f.executionId, engineRef, { idempotencyKey: `g-${label}-attach` })
      await f.store.updateExecutionStatus(f.executionId, { status: 'running' }, { idempotencyKey: `g-${label}-running` })
      await assert.rejects(
        () => f.store.consumeApproval(f.approvalId, { action: f.plan.action, target: f.plan.target, parametersDigest: f.plan.parametersDigest }, { executionGuard: { executionId: f.executionId, taskId: f.taskId, ...base, ...guardExtra }, idempotencyKey: `g-${label}-consume` }),
        (error) => error.code === 'EXECUTION_SCOPE_CHANGED',
        `an accountId on only the ${label} side must be refused`,
      )
    } finally { await fs.rm(f.stateDir, { recursive: true, force: true }) }
  }
})
