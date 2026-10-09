// S03a (remediation plan §5.5) reviewer routing invariant.
//
// Reviewer read-only is PROVEN only on the native sandbox / native-acp paths
// (RO-F001 r2): the goal-access broker (Seatbelt helper + READ_ONLY_ROLE write
// denial) and the native-acp-executor (role from the stored execution forces
// writeLiterals: []). Every other path must not route a reviewer until it
// proves the same read-only posture. This file pins that invariant:
//   1. the goal scheduler's reviewer is a GoalAI chat completion with NO tool
//      or filesystem surface — it stays on the loopback endpoint, never reads
//      a credential file and can only return a JSON verdict;
//   2. the Cezar dispatcher rejects reviewers before any engine call, even
//      when their grant and Approval cover cezar.dispatch;
//   3. a source tripwire: any control-plane module that mentions a reviewer
//      must be one of the already-adjudicated files, so a NEW reviewer
//      dispatch surface fails this test until it is proven read-only.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoalAI } from '../control-plane/goal-ai.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { createAdmittedExecution, cezarDispatchPlan, dispatchCezar } from '../control-plane/dispatcher.mjs'
import os from 'node:os'

const CONTROL_PLANE = fileURLToPath(new URL('../control-plane/', import.meta.url))

// Files whose reviewer mentions are already adjudicated: the broker and
// native executor enforce read-only, reviewer.mjs marks the role at creation,
// contracts/goal-store carry the role enum and phase name, goal-ai is the
// tool-less chat completion pinned below, goal-runtime only hands 'reviewer'
// to GoalAI. Anything ELSE mentioning a reviewer is an unproven surface.
const ADJUDICATED_REVIEWER_FILES = new Set([
  'contracts.mjs',
  'dispatcher.mjs', // Denial-only reviewer gate, behavior pinned below.
  'goal-access-broker.mjs',
  'goal-ai.mjs',
  'goal-runtime.mjs',
  'goal-store.mjs',
  'native-acp-executor.mjs',
  'native-sandbox.mjs',
  'reviewer.mjs',
  'store.mjs',
])

test('the goal reviewer is a tool-less loopback completion that never reads credentials', async () => {
  const requests = []
  const ai = new GoalAI({
    // If the reviewer path ever tried to read a credential file this missing
    // path makes the call fail loudly.
    credentialFile: 'missing-credential-file-reviewer-must-not-read',
    fetcher: async (url, init) => {
      requests.push({ url, init })
      return Response.json({ choices: [{ message: { content: '{"verdict":"passed","goalMet":true,"summary":"synthetic"}' } }], usage: { total_tokens: 42 } })
    },
  })
  const result = await ai.call('reviewer', { objective: 'synthetic' }, { reserve: async () => {}, reconcile: async () => {} })
  assert.equal(result.identity, 'kimi/reviewer')
  assert.equal(requests.length, 1, 'a reviewer makes exactly one inference call')
  assert.equal(requests[0].url, 'http://127.0.0.1:4323/v1/chat/completions', 'reviewer inference never leaves the loopback endpoint')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer loopback-shim', 'reviewer never presents a real credential')
  const payload = JSON.parse(requests[0].init.body)
  assert.equal(payload.tools, undefined, 'the reviewer request exposes no tool surface')
  assert.equal(payload.model, 'kimi-k3')
})

test('the Cezar dispatcher refuses reviewers even with Cezar scope and matching Approval', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-dispatch-denial-'))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const store = new ControlPlaneStore({ stateDir })
  const { task } = await store.createTask({ goal: 'synthetic review' }, { idempotencyKey: 'task' })
  const { execution } = await createAdmittedExecution({ store, taskId: task.id,
    input: { workerId: 'synthetic', role: 'reviewer' }, owner: 'synthetic',
    scope: ['cezar.dispatch'], idempotencyKey: 'execution' })
  const plan = cezarDispatchPlan({ taskId: task.id, executionId: execution.id })
  const { approval } = await store.createApproval(plan, { idempotencyKey: 'approval' })
  await store.decideApproval(approval.id, { decision: 'approved', approvedBy: 'synthetic' }, { idempotencyKey: 'decision' })
  let starts = 0
  await assert.rejects(() => dispatchCezar({ store, taskId: task.id, executionId: execution.id,
    approvalId: approval.id, adapter: { start: async () => { starts++; return { id: 'unexpected' } } },
    idempotencyKey: 'dispatch' }), error => error.code === 'REVIEWER_READONLY_REQUIRED')
  assert.equal(starts, 0, 'Cezar must never start a reviewer without enforced read-only')
  assert.equal((await store.getApproval(approval.id)).usedAt, undefined)
  assert.equal((await store.getExecution(execution.id)).status, 'blocked')
  assert.equal((await store.getExecution(execution.id)).engineRef, undefined)
})

test('every control-plane reviewer mention is an already-adjudicated file', async () => {
  const offenders = []
  for (const name of (await fs.readdir(CONTROL_PLANE)).filter((name) => name.endsWith('.mjs'))) {
    const source = await fs.readFile(path.join(CONTROL_PLANE, name), 'utf8')
    if (/reviewer/i.test(source) && !ADJUDICATED_REVIEWER_FILES.has(name)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], 'a new reviewer surface must prove read-only before routing (extend the allowlist only via an adjudicated batch)')
})
