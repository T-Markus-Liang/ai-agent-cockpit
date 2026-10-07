#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { GoalStore } from '../control-plane/goal-store.mjs'
import { GoalRuntime } from '../control-plane/goal-runtime.mjs'
import { GoalAI } from '../control-plane/goal-ai.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { prepareWorkspace } from '../control-plane/goal-workspace.mjs'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-recovery-live-'))
const goals = new GoalStore({ stateDir: path.join(dir, 'goals') }), tasks = new ControlPlaneStore({ stateDir: path.join(dir, 'proof') })
const sourceDir = path.resolve('tests/fixtures/goal-pilot'), original = await fs.readFile(path.join(sourceDir, 'calculator.mjs'), 'utf8')
const goal = await goals.create({ title: '隔离的真实断点恢复验证', objective: '修复 add 使不可修改的三个 Node 加法测试通过。只改 calculator.mjs，不发送消息，不部署，不修改测试。',
  sourceDir, readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'], checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }],
  limits: { maxTokens: 80000, maxDurationMs: 240000, maxIterations: 3, intervalMs: 1000 }, recovery: { enabled: true, maxAttempts: 3 } }, { idempotencyKey: 'synthetic-live' })
await prepareWorkspace(goal); await goals.grant(goal.id, { digest: goal.specDigest, approvedBy: 'authorized-isolated-test' })
const model = new GoalAI(), calls = []
const ai = { call: async (...args) => { calls.push(args[0]); return model.call(...args) } }
const first = new GoalRuntime({ goals, tasks, ai })
const originalWithLease = goals.withLease.bind(goals)
let injected = false
goals.withLease = async (...args) => {
  if (!injected && (await goals.get(args[0])).phase === 'applying') {
    injected = true; first.abort(args[0]); throw new Error('synthetic interruption after durable proposal before file application')
  }
  return originalWithLease(...args)
}
let resumed
try {
  await first.tick(); await [...first.active.values()][0]?.job; await first.stop()
  const interrupted = await goals.get(goal.id)
  assert.ok(injected); assert.equal(interrupted.status, 'waiting'); assert.ok(interrupted.resumeCheckpoint?.proposal)
  goals.withLease = originalWithLease
  resumed = new GoalRuntime({ goals, tasks, ai }); await resumed.start(); await [...resumed.active.values()][0]?.job
  const result = await goals.get(goal.id)
  assert.equal(result.status, 'complete', result.reason ?? result.summary)
  assert.deepEqual(calls, ['planner', 'worker', 'reviewer'], 'restart must not repeat planner or worker')
  assert.ok(result.lastChecks.every(row => row.exitCode === 0)); assert.equal(result.history.at(-1).review.verdict, 'passed')
  assert.equal(await fs.readFile(path.join(sourceDir, 'calculator.mjs'), 'utf8'), original)
  console.log(JSON.stringify({ type: 'RealGoalRecoveryVerification', actualModels: true, interruptionInjected: true, savedProposalReused: true,
    modelCalls: calls, actualNodeChecksPassed: true, independentReviewPassed: true, originalProjectUnmodified: true, tokensUsed: result.tokensUsed, realWeChatMessagesSent: 0 }))
} finally { await first.stop(); await resumed?.stop(); await fs.rm(dir, { recursive: true, force: true }) }
