import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { createGoalServer } from '../gateway/goals.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'

async function startServer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-http-'))
  const stateFile = path.join(dir, 'wechat.json')
  await fs.writeFile(stateFile, JSON.stringify({ lastActiveUserId: 'owner', users: { owner: {} } }))
  const stateDir = path.join(dir, 'goals')
  // Per-client authority (M02 goals wave 1.6): a synthetic token whose sha256
  // digest is written to a mode-0600 authority document that the server
  // revalidates on every request. No shared token file exists any more.
  const token = crypto.randomBytes(32).toString('base64url')
  const engine = { active: new Map(), start: async () => {}, stop: async () => {}, tick: async () => {}, abort: () => {} }
  const app = await createGoalServer({ stateDir, tasks: new ControlPlaneStore({ stateDir: path.join(dir, 'tasks') }), runtime: engine, wechatStateFile: stateFile })
  const authFile = path.join(stateDir, 'authority.json')
  await fs.writeFile(authFile, JSON.stringify({ version: 1, principals: [
    { id: 'p_http_test', role: 'operator', tokenDigest: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 3_600_000 }] }), { mode: 0o600 })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) })
  const root = `http://127.0.0.1:${app.server.address().port}`
  const request = async (endpoint, options = {}) => {
    const response = await fetch(root + endpoint, { signal: AbortSignal.timeout(3000), ...options })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: response.status, body, text, response }
  }
  return { app, root, token, request, authFile }
}

test('retired bootstrap never returns a token under spoofed Origin/header or valid auth', async t => {
  const { token, request } = await startServer(t)
  const forgedCockpit = { Origin: 'http://127.0.0.1:4321', 'X-AI-OS-Client': 'cockpit' }
  const spoofed = await request('/api/bootstrap', { headers: forgedCockpit })
  assert.equal(spoofed.status, 410)
  assert.equal(spoofed.body.error, 'BOOTSTRAP_RETIRED')
  assert.equal('token' in spoofed.body, false)
  assert.equal(spoofed.text.includes(token), false)
  const withAuth = await request('/api/bootstrap', { headers: { ...forgedCockpit, Authorization: `Bearer ${token}` } })
  assert.equal(withAuth.status, 410)
  assert.equal(withAuth.body.error, 'BOOTSTRAP_RETIRED')
  assert.equal('token' in withAuth.body, false)
  assert.equal(withAuth.text.includes(token), false)
  const untrusted = await request('/api/bootstrap', { headers: { Origin: 'https://evil.example', 'X-AI-OS-Client': 'cockpit' } })
  assert.notEqual(untrusted.status, 200)
  assert.equal('token' in untrusted.body, false)
  assert.equal(untrusted.text.includes(token), false)
  const noOrigin = await request('/api/bootstrap', { headers: { 'X-AI-OS-Client': 'cockpit' } })
  assert.equal(noOrigin.status, 410)
  assert.equal('token' in noOrigin.body, false)
  assert.equal(noOrigin.text.includes(token), false)
})

test('goal HTTP authentication, host/origin, owner, grant, pause, resume and revision', async t => {
  const { app, token, request, authFile } = await startServer(t)
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const payload = { title: 'API test', objective: 'repair add', sourceDir: path.resolve('tests/fixtures/goal-pilot'), readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'], checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }] }
  assert.equal((await request('/api/goals')).status, 401)
  assert.equal((await request('/health', { headers: { Origin: 'https://evil.example' } })).status, 403)
  const badHost = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${app.server.address().port}/health`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) }).once('error', reject)
  })
  assert.equal(badHost, 403)
  assert.equal(app.authFile, authFile)
  assert.equal((await fs.stat(authFile)).mode & 511, 384)
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
