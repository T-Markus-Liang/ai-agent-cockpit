import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GoalStore } from '../control-plane/goal-store.mjs'
import { GoalRuntime } from '../control-plane/goal-runtime.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { prepareWorkspace, workspaceState, applyProposal } from '../control-plane/goal-workspace.mjs'

const fixed = { files: [{ path: 'calculator.mjs', content: 'export function add(a,b) { return a+b }\n' }] }
async function setup(t, recovery = { enabled: true, maxAttempts: 3 }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-recovery-'))
  const goals = new GoalStore({ stateDir: path.join(dir, 'goals') }), tasks = new ControlPlaneStore({ stateDir: path.join(dir, 'proof') })
  const goal = await goals.create({ title: 'recovery fixture', objective: 'repair add without changing acceptance', sourceDir: path.resolve('tests/fixtures/goal-pilot'), readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'], checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }], recovery, limits: { intervalMs: 1000 } }, { idempotencyKey: 'fixture' })
  await prepareWorkspace(goal); await goals.grant(goal.id, { digest: goal.specDigest, approvedBy: 'test-owner' })
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return { dir, goals, tasks, goal }
}
async function interruptedProposal(ctx, phase = 'applying') {
  const active = await ctx.goals.claim(ctx.goal.id, { owner: 'daemon:999999:old' }), state = await workspaceState(active)
  await ctx.goals.checkpoint(active.id, active.lease.token, { phase, resumeCheckpoint: { generation: active.generation, specDigest: active.specDigest, beforeFiles: state.files, proposal: fixed, writerIdentity: 'deepseek-official/deepseek-flash' } })
  return active
}
function reviewerOnly(calls) {
  return { call: async (role, _state, options) => {
    calls.push(role); assert.equal(role, 'reviewer', 'saved proposal must not start planner or worker again')
    await options.reserve(100); await options.reconcile(100, 30)
    return { identity: 'kimi/reviewer', result: { verdict: 'passed', goalMet: true, summary: 'independent acceptance' } }
  } }
}
async function finish(runtime) { await runtime.start(); const job = [...runtime.active.values()][0]; if (job) await job.job }

test('restart reuses a saved proposal, performs real checks and independent review', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t); await interruptedProposal(ctx); const calls = []
  const runtime = new GoalRuntime({ ...ctx, ai: reviewerOnly(calls) }); t.after(() => runtime.stop())
  await finish(runtime); const completed = await ctx.goals.get(ctx.goal.id)
  assert.equal(completed.status, 'complete'); assert.equal(completed.recoveryCount, 1); assert.deepEqual(calls, ['reviewer'])
  assert.ok(completed.lastChecks.every(row => row.exitCode === 0))
});

test('already-applied proposal is verified rather than asking another worker to redo it', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t); await interruptedProposal(ctx); await applyProposal(ctx.goal, fixed); const calls = []
  const runtime = new GoalRuntime({ ...ctx, ai: reviewerOnly(calls) }); t.after(() => runtime.stop()); await finish(runtime)
  assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'complete'); assert.deepEqual(calls, ['reviewer'])
});

test('changed immutable acceptance conflicts with the checkpoint and does not start any model', async t => {
  const ctx = await setup(t); await interruptedProposal(ctx)
  await fs.appendFile(path.join(ctx.goal.workspaceDir, 'calculator.test.mjs'), '\n// altered acceptance\n')
  const calls = [], runtime = new GoalRuntime({ ...ctx, ai: reviewerOnly(calls) }); t.after(() => runtime.stop()); await finish(runtime)
  assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'waiting'); assert.deepEqual(calls, [])
});

test('uncertain verifier phase without closed check evidence waits instead of spawning overlapping checks', async t => {
  const ctx = await setup(t); await interruptedProposal(ctx, 'verifying'); const recovery = await ctx.goals.recover()
  assert.equal(recovery.resumed, 0); assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'waiting')
});

test('global pause, explicit cancel and disabled recovery are respected', async t => {
  for (const scenario of ['pause', 'cancel', 'disabled']) {
    const ctx = await setup(t, { enabled: scenario !== 'disabled', maxAttempts: 3 }); await interruptedProposal(ctx)
    if (scenario === 'pause') await ctx.goals.controlAll('pause')
    if (scenario === 'cancel') await ctx.goals.control(ctx.goal.id, 'cancel')
    await ctx.goals.recover(); assert.notEqual((await ctx.goals.get(ctx.goal.id)).status, 'ready')
  }
});

test('live daemon ownership is not stolen by another recovery pass', async t => {
  const ctx = await setup(t); await ctx.goals.claim(ctx.goal.id, { owner: `daemon:${process.pid}:live` })
  await ctx.goals.recover(); assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'running')
});

test('completed proof left by an interrupted final settlement is reconciled without model calls', { skip: process.platform !== 'darwin' }, async t => {
  const ctx = await setup(t); await interruptedProposal(ctx); const calls = []
  const originalSettle = ctx.goals.settle.bind(ctx.goals)
  ctx.goals.settle = async (id, token, result) => { if (result.outcome === 'complete') throw new Error('simulated final write loss'); return originalSettle(id, token, result) }
  const runtime = new GoalRuntime({ ...ctx, ai: reviewerOnly(calls) }); t.after(() => runtime.stop()); await finish(runtime); await runtime.stop()
  const pending = await ctx.goals.get(ctx.goal.id); assert.equal((await ctx.tasks.getTask(pending.taskId)).task.status, 'completed')
  ctx.goals.settle = originalSettle
  const resumed = new GoalRuntime({ ...ctx, ai: { call: async () => assert.fail('verified task must not run again') } }); t.after(() => resumed.stop()); await finish(resumed)
  assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'complete')
});
