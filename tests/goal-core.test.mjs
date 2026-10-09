import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GoalStore, validateGoalSpec } from '../control-plane/goal-store.mjs'
import { GoalRuntime } from '../control-plane/goal-runtime.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { verifyGrant } from '../control-plane/execution-grant.mjs'
import { prepareWorkspace, applyProposal, runChecks, workspaceState } from '../control-plane/goal-workspace.mjs'

const spec = (changes = {}) => ({ title: 'test goal', objective: 'repair add, preserve acceptance tests', sourceDir: path.resolve('tests/fixtures/goal-pilot'),
  readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'], checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }], limits: { intervalMs: 1000 }, ...changes })
async function setup(t, input = spec()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-core-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const goals = new GoalStore({ stateDir: path.join(dir, 'goals') })
  const tasks = new ControlPlaneStore({ stateDir: path.join(dir, 'tasks') })
  const goal = await goals.create(input, { idempotencyKey: 'one' })
  await prepareWorkspace(goal)
  return { goals, tasks, goal, dir }
}
async function grant({ goals, goal }) { return goals.grant(goal.id, { digest: goal.specDigest, approvedBy: 'test-human' }) }
async function claim(ctx) { await grant(ctx); return ctx.goals.claim(ctx.goal.id, { owner: 'test-runner' }) }
const fixed = { summary: 'fix subtraction', files: [{ path: 'calculator.mjs', content: 'export function add(a,b) { return a+b }\n' }] }
function fakeAI({ badFirst = false, reviewPass = true } = {}) {
  let attempts = 0
  return { call: async (role, _state, options) => {
    await options.reserve(100); await options.reconcile(100, 30)
    const result = role === 'planner' ? { instruction: 'fix add', reason: 'tests fail' } : role === 'worker' ? (++attempts === 1 && badFirst ? { files: [], summary: 'unchanged' } : fixed) : { verdict: reviewPass ? 'passed' : 'failed', goalMet: reviewPass, summary: reviewPass ? 'independent review passed' : 'review rejected' }
    return { result, identity: role === 'worker' ? 'deepseek-official/deepseek-flash' : `kimi/${role}`, usage: 30 }
  } }
}
async function tick(runtime) { await runtime.tick(); const item = [...runtime.active.values()][0]; if (item) await item.job }

test('strict spec rejects traversal, credentials, editable acceptance and arbitrary commands', () => {
  for (const input of [spec({ readPaths: ['../secret'] }), spec({ sourceDir: os.homedir() }), spec({ readPaths: ['.env'] }), spec({ writePaths: ['calculator.test.mjs'] }), spec({ checks: [{ name: 'bad', args: ['-e', 'process.exit(0)'] }] }), spec({ limits: { maxTokens: '80000' } }), spec({ limits: { intervalMs: NaN } })]) assert.throws(() => validateGoalSpec(input))
})
test('goal draft never runs until exact scope is granted', async t => {
  const ctx = await setup(t)
  await assert.rejects(ctx.goals.claim(ctx.goal.id, { owner: 'x' }))
  await assert.rejects(ctx.goals.grant(ctx.goal.id, { digest: 'wrong', approvedBy: 'human' }))
  assert.equal((await grant(ctx)).status, 'ready')
})
test('create is idempotent and detects changed payload', async t => {
  const ctx = await setup(t)
  assert.equal((await ctx.goals.create(spec(), { idempotencyKey: 'one' })).id, ctx.goal.id)
  await assert.rejects(ctx.goals.create(spec({ objective: 'other' }), { idempotencyKey: 'one' }))
})
test('two stores cannot claim the same goal concurrently', async t => {
  const ctx = await setup(t); await grant(ctx)
  const second = new GoalStore({ stateDir: ctx.goals.stateDir })
  const results = await Promise.allSettled([ctx.goals.claim(ctx.goal.id, { owner: 'a' }), second.claim(ctx.goal.id, { owner: 'b' })])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
})
test('pause invalidates writes, checkpoints and old leases; resume keeps the grant deadline', async t => {
  const ctx = await setup(t), active = await claim(ctx), deadline = active.grant.expiresAt
  await ctx.goals.control(ctx.goal.id, 'pause')
  await assert.rejects(ctx.goals.withLease(ctx.goal.id, active.lease.token, () => assert.fail('must not write')))
  await assert.rejects(ctx.goals.checkpoint(ctx.goal.id, active.lease.token, { phase: 'fake' }))
  const resumed = await ctx.goals.control(ctx.goal.id, 'resume')
  assert.equal(resumed.grant.expiresAt, deadline)
})
test('changing direction invalidates the old grant and uses a new workspace', async t => {
  const ctx = await setup(t); await grant(ctx); await ctx.goals.control(ctx.goal.id, 'pause')
  const revised = await ctx.goals.revise(ctx.goal.id, spec({ objective: 'new objective' }))
  assert.equal(revised.status, 'draft'); assert.equal(revised.grant, undefined)
  assert.notEqual(revised.workspaceDir, ctx.goal.workspaceDir)
  await assert.rejects(ctx.goals.grant(ctx.goal.id, { digest: ctx.goal.specDigest, approvedBy: 'human' }))
})
test('global pause survives restart and prevents new grants from starting work', async t => {
  const ctx = await setup(t); await grant(ctx)
  await ctx.goals.controlAll('pause'); assert.equal(await ctx.goals.isPaused(), true)
  const restarted = new GoalStore({ stateDir: ctx.goals.stateDir }); assert.equal(await restarted.isPaused(), true)
  await assert.rejects(restarted.control(ctx.goal.id, 'resume'))
  const next = await restarted.create(spec({ title: 'other' }), { idempotencyKey: 'other' })
  await restarted.grant(next.id, { digest: next.specDigest, approvedBy: 'test' })
  await assert.rejects(restarted.claim(next.id, { owner: 'x' }))
  await restarted.controlAll('resume'); assert.equal(await restarted.isPaused(), false)
})
test('checkpoint cannot raise its own budget or change scope', async t => {
  const ctx = await setup(t), active = await claim(ctx)
  await assert.rejects(ctx.goals.checkpoint(ctx.goal.id, active.lease.token, { tokensUsed: 0 }))
  await assert.rejects(ctx.goals.checkpoint(ctx.goal.id, active.lease.token, { spec: spec() }))
})
test('token budget reserves before calls and usage reconciliation rejects invalid values', async t => {
  const ctx = await setup(t, spec({ limits: { maxTokens: 1000 } })), active = await claim(ctx)
  await ctx.goals.reserve(ctx.goal.id, active.lease.token, 1000)
  await assert.rejects(ctx.goals.reserve(ctx.goal.id, active.lease.token, 1))
  await assert.rejects(ctx.goals.reconcileUsage(ctx.goal.id, active.lease.token, 1000, 1001))
  await ctx.goals.reconcileUsage(ctx.goal.id, active.lease.token, 1000, 500)
  assert.equal((await ctx.goals.get(ctx.goal.id)).tokensUsed, 500)
})
test('expiry stops work without silently renewing authority', async t => {
  const ctx = await setup(t); await grant(ctx)
  const state = JSON.parse(await fs.readFile(ctx.goals.file, 'utf8')); state.goals[ctx.goal.id].grant.expiresAt = new Date(0).toISOString()
  await fs.writeFile(ctx.goals.file, JSON.stringify(state))
  const waiting = await ctx.goals.claim(ctx.goal.id, { owner: 'x' })
  assert.equal(waiting.status, 'waiting'); await assert.rejects(ctx.goals.control(ctx.goal.id, 'resume'))
})
test('iteration/no-progress limits wait rather than declaring success', async t => {
  const ctx = await setup(t, spec({ limits: { maxNoProgress: 1 } })), active = await claim(ctx)
  const settled = await ctx.goals.settle(ctx.goal.id, active.lease.token, { outcome: 'retry', progress: false, summary: 'not done' })
  assert.equal(settled.status, 'waiting'); assert.notEqual(settled.status, 'complete')
})
test('restart preserves checkpoints and blocks uncertain active work', async t => {
  const ctx = await setup(t), active = await claim(ctx)
  await ctx.goals.checkpoint(ctx.goal.id, active.lease.token, { phase: 'applying' })
  const restarted = new GoalStore({ stateDir: ctx.goals.stateDir }); await restarted.recover()
  const recovered = await restarted.get(ctx.goal.id)
  assert.equal(recovered.status, 'waiting'); assert.equal(recovered.phase, 'applying')
})
test('private permissions and corrupt state fail closed', async t => {
  const ctx = await setup(t)
  assert.equal((await fs.stat(ctx.goals.stateDir)).mode & 511, 448); assert.equal((await fs.stat(ctx.goals.file)).mode & 511, 384)
  await fs.writeFile(ctx.goals.file, 'broken')
  await assert.rejects(ctx.goals.create(spec(), { idempotencyKey: 'two' }))
  assert.equal(await fs.readFile(ctx.goals.file, 'utf8'), 'broken')
})
test('immutable acceptance and symlink/outside proposals are refused', async t => {
  const ctx = await setup(t)
  await assert.rejects(applyProposal(ctx.goal, { files: [{ path: 'calculator.test.mjs', content: '' }] }))
  await assert.rejects(applyProposal(ctx.goal, { files: [{ path: '../escape', content: '' }] }))
  await fs.unlink(path.join(ctx.goal.workspaceDir, 'calculator.mjs')); await fs.symlink(path.join(ctx.goal.spec.sourceDir, 'calculator.mjs'), path.join(ctx.goal.workspaceDir, 'calculator.mjs'))
  await assert.rejects(applyProposal(ctx.goal, fixed))
})
test('real Seatbelt accepts a valid repair and original source remains unchanged', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t), original = await fs.readFile(path.join(ctx.goal.spec.sourceDir, 'calculator.mjs'), 'utf8')
  assert.equal((await runChecks(ctx.goal))[0].exitCode, 1)
  await applyProposal(ctx.goal, fixed)
  assert.equal((await runChecks(ctx.goal))[0].exitCode, 0)
  assert.equal(await fs.readFile(path.join(ctx.goal.spec.sourceDir, 'calculator.mjs'), 'utf8'), original)
})
test('actual Seatbelt denies immutable/outside writes, private reads and network', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t)
  const outside = path.join(ctx.dir, 'private.txt'); await fs.writeFile(outside, 'private')
  await fs.writeFile(path.join(ctx.goal.workspaceDir, 'calculator.test.mjs'), `import fs from 'node:fs';import net from 'node:net';import test from 'node:test';import assert from 'node:assert/strict';
test('outside write blocked',()=>assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'changed')));
test('private read blocked',()=>assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)})));
test('acceptance write blocked',()=>assert.throws(()=>fs.writeFileSync('calculator.test.mjs','')));
test('network blocked',async()=>{await new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:4323});s.on('connect',()=>{s.destroy();reject(new Error('network allowed'))});s.on('error',()=>resolve());s.setTimeout(1000,()=>{s.destroy();resolve()})})});`)
  const results = await runChecks(ctx.goal)
  assert.equal(results[0].exitCode, 0, results[0].output)
  assert.equal(await fs.readFile(outside, 'utf8'), 'private')
})
test('runtime executes real checks and completes only with independent review', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t); await grant(ctx)
  const runtime = new GoalRuntime({ ...ctx, ai: fakeAI() }); t.after(() => runtime.stop())
  await tick(runtime)
  const goal = await ctx.goals.get(ctx.goal.id)
  assert.equal(goal.status, 'complete', goal.summary)
  assert.equal((await ctx.tasks.getTask(goal.history[0].taskId)).task.status, 'completed')
  assert.equal(goal.history[0].review.identity, 'kimi/reviewer')
  // (S03b) the goal-runtime entry issues every iteration execution's admission
  // Grant at enqueue; the goal grant's expiry participates as the authorizing
  // artifact's deadline (authorizerExpiresAt), and the 30-minute lifetime cap
  // still bounds the window.
  for (const execution of (await ctx.tasks.getTask(goal.history[0].taskId)).executions) {
    const admitted = verifyGrant(execution.grant, { taskId: goal.history[0].taskId, executionId: execution.id, parametersDigest: execution.parametersDigest, now: Date.now })
    assert.deepEqual(admitted.scope, ['goal-runtime.execution'])
    assert.ok(typeof admitted.owner === 'string' && admitted.owner.length > 0, 'the grant owner is a non-empty identity string')
    assert.ok(admitted.effectiveDeadlineAt - admitted.issuedAt <= 30 * 60_000, 'the lifetime cap participates in the effective deadline')
    assert.ok(admitted.effectiveDeadlineAt <= Date.parse(goal.grant.expiresAt), 'the goal grant expiry participates in the effective deadline')
  }
})
test('failed iteration automatically returns and repairs on a second iteration', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t); await grant(ctx)
  const runtime = new GoalRuntime({ ...ctx, ai: fakeAI({ badFirst: true }) }); t.after(() => runtime.stop())
  await tick(runtime); assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'ready')
  await new Promise(resolve => setTimeout(resolve, 1050)); await tick(runtime)
  const goal = await ctx.goals.get(ctx.goal.id)
  assert.equal(goal.status, 'complete'); assert.equal(goal.iterations, 2)
})
test('independent reviewer rejection prevents success and requests another iteration', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t); await grant(ctx)
  const runtime = new GoalRuntime({ ...ctx, ai: fakeAI({ reviewPass: false }) }); t.after(() => runtime.stop())
  await tick(runtime)
  const goal = await ctx.goals.get(ctx.goal.id)
  assert.equal(goal.status, 'ready'); assert.equal(goal.history[0].review.verdict, 'failed')
})
test('a stale worker response after pause cannot apply files', async t => {
  const ctx = await setup(t); await grant(ctx)
  let reached, release
  const began = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  const base = fakeAI()
  const ai = { call: async (role, state, options) => { if (role === 'worker') { reached(); await gate } return base.call(role, state, options) } }
  const runtime = new GoalRuntime({ ...ctx, ai }); t.after(() => runtime.stop())
  await runtime.tick(); await began
  await ctx.goals.control(ctx.goal.id, 'pause'); runtime.abort(ctx.goal.id); release()
  await [...runtime.active.values()][0].job
  assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'paused')
  assert.equal((await workspaceState(ctx.goal)).files.find(file => file.path === 'calculator.mjs').content.includes('a - b'), true)
})
