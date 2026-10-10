#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const root = 'http://127.0.0.1:4326'
// Per-client token (0.3.0 M02 / goals wave 1.6): the goals service no longer
// accepts the shared api-token file. Mint a token for this client with
// identity-pairing's beginPairing/completePairing, export the goals
// authority.json, then pass the plaintext token here.
const token = process.env.GOALS_AUTH_TOKEN
if (!token) throw new Error('GOALS_AUTH_TOKEN is required: mint a per-client token via identity-pairing and export the goals authority.json')
async function request(endpoint, body, key) {
  const response = await fetch(`${root}${endpoint}`, { signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  assert.ok(response.ok, result.message ?? `HTTP ${response.status}`)
  return result
}
const sourceDir = path.resolve('tests/fixtures/goal-pilot')
const retryScenario = process.env.GOAL_LIVE_RETRY === '1'
const original = await fs.readFile(path.join(sourceDir, 'calculator.mjs'), 'utf8')
const created = await request('/api/goals', { title: '0.2.0 自动修复验收试运行（合成）', objective: '将 add 的实现修复为正确加法，使三个不可修改的验收测试通过。只改 calculator.mjs，不修改测试，不做外部发送或部署。',
  sourceDir, readPaths: ['calculator.mjs', 'calculator.test.mjs', ...(retryScenario ? ['transient.test.mjs'] : [])], writePaths: ['calculator.mjs'], checks: [{ name: '真实 Node 加法验收', args: ['--test', 'calculator.test.mjs'] }, ...(retryScenario ? [{ name: '一次性故障恢复验收', args: ['--test', 'transient.test.mjs'] }] : [])],
  limits: { maxIterations: 3, maxTokens: 80000, maxDurationMs: 180000, intervalMs: 1000 } }, `live-${crypto.randomUUID()}`)
let goal = created.goal
assert.equal(goal.status, 'draft')
await request(`/api/goals/${goal.id}/grant`, { digest: goal.specDigest })
console.log(JSON.stringify({ type: 'RealGoalPilotStarted', id: goal.id, productionWrites: false, realWeChatMessagesSent: 0 }))
for (let i = 0; i < 180; i++) {
  goal = (await request(`/api/goals/${goal.id}`)).goal
  if (['complete', 'waiting', 'cancelled'].includes(goal.status)) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}
if (goal.status !== 'complete') {
  if (['running', 'ready'].includes(goal.status)) await request(`/api/goals/${goal.id}/pause`, {})
  throw new Error(`real pilot not complete: ${goal.status}; ${goal.reason ?? goal.summary ?? ''}`)
}
assert.ok(goal.lastChecks.every(check => check.exitCode === 0))
assert.equal(goal.history.at(-1).review.identity, 'kimi/reviewer')
assert.equal(goal.history.at(-1).review.verdict, 'passed')
if (retryScenario) { assert.ok(goal.iterations >= 2); assert.equal(goal.history[0].outcome, 'retry'); assert.ok(goal.history[0].checks.some(check => check.exitCode !== 0)) }
assert.equal(await fs.readFile(path.join(sourceDir, 'calculator.mjs'), 'utf8'), original)
assert.match(await fs.readFile(path.join(goal.workspaceDir, 'calculator.mjs'), 'utf8'), /\+/)
console.log(JSON.stringify({ type: 'RealGoalPilotVerification', id: goal.id, iterations: goal.iterations, tokensUsed: goal.tokensUsed,
  artifactRef: goal.artifactRef, actualChecksPassed: true, independentKimiReview: true, originalProjectUnmodified: true, realWeChatMessagesSent: 0 }))
