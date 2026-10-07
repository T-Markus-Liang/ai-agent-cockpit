import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { createGoalServer } from '../gateway/goals.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'

test('goal HTTP authentication, host/origin, owner, grant, pause, resume and revision', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-http-'))
  const stateFile = path.join(dir, 'wechat.json')
  await fs.writeFile(stateFile, JSON.stringify({ lastActiveUserId: 'owner', users: { owner: {} } }))
  const engine = { active: new Map(), start: async () => {}, stop: async () => {}, tick: async () => {}, abort: () => {} }
  const app = await createGoalServer({ stateDir: path.join(dir, 'goals'), tasks: new ControlPlaneStore({ stateDir: path.join(dir, 'tasks') }), runtime: engine, wechatStateFile: stateFile })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) })
  const root = `http://127.0.0.1:${app.server.address().port}`
  const token = (await fs.readFile(app.tokenFile, 'utf8')).trim()
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const payload = { title: 'API test', objective: 'repair add', sourceDir: path.resolve('tests/fixtures/goal-pilot'), readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'], checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }] }
  const request = async (endpoint, options = {}) => {
    const response = await fetch(root + endpoint, { signal: AbortSignal.timeout(3000), ...options }); return { status: response.status, body: await response.json(), response }
  }
  assert.equal((await request('/api/goals')).status, 401)
  assert.equal((await request('/api/bootstrap')).status, 403)
  assert.equal((await request('/health', { headers: { Origin: 'https://evil.example' } })).status, 403)
  const badHost = await new Promise((resolve, reject) => {
    http.get(`${root}/health`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }).once('error', reject)
  })
  assert.equal(badHost, 403)
  const bootstrap = await request('/api/bootstrap', { headers: { Origin: 'http://127.0.0.1:4321', 'X-AI-OS-Client': 'cockpit' } })
  assert.equal(bootstrap.body.token, token); assert.equal(bootstrap.response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4321')
  assert.equal((await fs.stat(app.tokenFile)).mode & 511, 384)
  const ownerActor = `wechat-${crypto.createHash('sha256').update('owner').digest('hex')}`
  assert.equal((await request('/api/goals', { headers: { ...auth, 'X-Goal-Actor': 'wechat-stranger' } })).status, 403)
  const created = await request('/api/goals', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'create' }, body: JSON.stringify(payload) })
  assert.equal(created.status, 201); const goal = created.body.goal
  assert.equal((await request(`/api/goals/${goal.id}/grant`, { method: 'POST', headers: auth, body: JSON.stringify({ digest: 'wrong' }) })).status, 403)
  const granted = await request(`/api/goals/${goal.id}/grant`, { method: 'POST', headers: { ...auth, 'X-Goal-Actor': ownerActor }, body: JSON.stringify({ digest: goal.specDigest }) })
  assert.equal(granted.body.goal.status, 'ready')
  for (const [action, state] of [['pause', 'paused'], ['resume', 'ready'], ['pause', 'paused']]) {
    const result = await request(`/api/goals/${goal.id}/${action}`, { method: 'POST', headers: auth, body: '{}' }); assert.equal(result.body.goal.status, state)
  }
  const revised = await request(`/api/goals/${goal.id}/revise`, { method: 'POST', headers: auth, body: JSON.stringify({ ...payload, objective: 'new goal' }) })
  assert.equal(revised.body.goal.status, 'draft'); assert.equal(revised.body.goal.generation, 2)
  assert.equal((await request(`/api/goals/${goal.id}/grant`, { method: 'POST', headers: auth, body: JSON.stringify({ digest: goal.specDigest }) })).status, 403)
  const cancelled = await request(`/api/goals/${goal.id}/cancel`, { method: 'POST', headers: auth, body: '{}' }); assert.equal(cancelled.body.goal.status, 'cancelled')
})
