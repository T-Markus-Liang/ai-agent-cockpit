import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGoalServer, goalActionFor, authorizeGoalRequest } from '../gateway/goals.mjs'
import { GoalStore, GoalError } from '../control-plane/goal-store.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'

// RR-F003 regression suite. Fully synthetic harness (tmp dirs only): no
// production service, DB, launchd or real user files are touched, and no
// message/model call is made. Every principal is a synthetic token whose sha256
// digest is written to a mode-0600 authority document revalidated per request.
// The goal store is wrapped in a recording proxy so a denied write request can
// be proven to invoke *zero* store methods (no state transition).
const digest = token => crypto.createHash('sha256').update(token).digest('hex')
const mintToken = () => crypto.randomBytes(32).toString('base64url')
const future = () => Date.now() + 3_600_000
const ownerActorFor = user => `wechat-${crypto.createHash('sha256').update(user).digest('hex')}`

const payload = {
  title: 'Role authz', objective: 'repair add', sourceDir: path.resolve('tests/fixtures/goal-pilot'),
  readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'],
  checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }],
}

function recordStore(store) {
  const calls = []
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args) => { calls.push(String(prop)); return value.apply(target, args) }
    },
  })
  return { store: proxy, calls }
}

async function startServer(t, { roles = {}, wechatUser = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-role-authz-'))
  const stateDir = path.join(dir, 'goals')
  const wechatStateFile = path.join(dir, 'wechat.json')
  if (wechatUser) await fs.writeFile(wechatStateFile, JSON.stringify({ lastActiveUserId: wechatUser, users: { [wechatUser]: {} } }), { mode: 0o600 })
  const engine = { active: new Map(), start: async () => {}, stop: async () => {}, tick: async () => {}, abort: () => {} }
  const recorder = recordStore(new GoalStore({ stateDir }))
  const app = await createGoalServer({ stateDir, goals: recorder.store, tasks: new ControlPlaneStore({ stateDir: path.join(dir, 'tasks') }), runtime: engine, wechatStateFile })
  const tokens = {}
  const principals = Object.entries(roles).map(([role, id]) => {
    const token = mintToken(); tokens[role] = token
    return { id, role, tokenDigest: digest(token), expiresAt: future() }
  })
  await fs.writeFile(path.join(stateDir, 'authority.json'), JSON.stringify({ version: 1, principals }), { mode: 0o600 })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) })
  const root = `http://127.0.0.1:${app.server.address().port}`
  const request = async (endpoint, options = {}) => {
    const { token, actor, method = 'GET', body, headers = {} } = options
    const finalHeaders = { ...headers }
    if (token) finalHeaders.Authorization = `Bearer ${token}`
    if (actor) finalHeaders['X-Goal-Actor'] = actor
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
    const response = await fetch(root + endpoint, { method, headers: finalHeaders, signal: AbortSignal.timeout(5000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed }
  }
  return { app, root, request, tokens, recorder, stateDir }
}

// Seed a goal as the operator so :id routes have a real target. Returns its id.
async function seedGoal(request, tokens, key = 'seed') {
  const created = await request('/api/goals', { token: tokens.operator, method: 'POST', body: payload, headers: { 'Idempotency-Key': key } })
  assert.equal(created.status, 201)
  return created.body.goal
}

test('role/action matrix resolves routes and denies exactly the contract', () => {
  // Route resolution
  assert.equal(goalActionFor('GET', '/api/goals'), 'read')
  assert.equal(goalActionFor('GET', '/api/goals/goal_x'), 'read')
  assert.equal(goalActionFor('GET', '/api/goals/goal_x/proof'), 'read')
  assert.equal(goalActionFor('POST', '/api/goals'), 'create')
  assert.equal(goalActionFor('POST', '/api/goals/pause-all'), 'pause-all')
  assert.equal(goalActionFor('POST', '/api/goals/resume-all'), 'resume-all')
  assert.equal(goalActionFor('POST', '/api/goals/goal_x/grant'), 'grant')
  assert.equal(goalActionFor('POST', '/api/goals/goal_x/wake'), 'wake')
  // Out-of-matrix requests fall through to existing NOT_FOUND / INVALID_METHOD handling
  assert.equal(goalActionFor('DELETE', '/api/goals'), undefined)
  assert.equal(goalActionFor('POST', '/api/goals/goal_x'), undefined)
  assert.equal(goalActionFor('POST', '/api/goals/goal_x/proof'), undefined)
  assert.equal(goalActionFor('GET', '/api/goals/goal_x/other'), undefined)
  const deny = (role, method, route) => assert.throws(
    () => authorizeGoalRequest({ authenticated: true, role }, method, route),
    error => error instanceof GoalError && error.code === 'AUTH_FORBIDDEN' && error.status === 403)
  const allow = (role, method, route) => assert.doesNotThrow(() => authorizeGoalRequest({ authenticated: true, role }, method, route))
  allow('viewer', 'GET', '/api/goals')
  deny('viewer', 'POST', '/api/goals')
  deny('viewer', 'POST', '/api/goals/pause-all')
  deny('viewer', 'POST', '/api/goals/g/pause')
  allow('coordinator', 'POST', '/api/goals/g/wake')
  deny('coordinator', 'POST', '/api/goals')
  deny('coordinator', 'POST', '/api/goals/g/pause')
  deny('coordinator', 'POST', '/api/goals/g/grant')
  allow('chief', 'POST', '/api/goals')
  allow('chief', 'POST', '/api/goals/g/pause')
  allow('chief', 'POST', '/api/goals/g/revise')
  deny('chief', 'POST', '/api/goals/g/grant')
  deny('chief', 'POST', '/api/goals/pause-all')
  deny('chief', 'POST', '/api/goals/resume-all')
  allow('operator', 'POST', '/api/goals/g/grant')
  allow('operator', 'POST', '/api/goals/pause-all')
  allow('operator', 'POST', '/api/goals/resume-all')
})

test('viewer is read-only: every goal write route is 403 AUTH_FORBIDDEN with zero store calls', async t => {
  const { request, tokens, recorder } = await startServer(t, { roles: { operator: 'p_op', viewer: 'p_view' } })
  const goal = await seedGoal(request, tokens)
  const before = recorder.calls.length
  const routes = [
    ['POST', '/api/goals', payload, { 'Idempotency-Key': 'viewer-create' }],
    ['POST', '/api/goals/pause-all', {}],
    ['POST', '/api/goals/resume-all', {}],
    ['POST', `/api/goals/${goal.id}/grant`, { digest: goal.specDigest }],
    ['POST', `/api/goals/${goal.id}/pause`, {}],
    ['POST', `/api/goals/${goal.id}/resume`, {}],
    ['POST', `/api/goals/${goal.id}/cancel`, {}],
    ['POST', `/api/goals/${goal.id}/revise`, payload],
    ['POST', `/api/goals/${goal.id}/wake`, {}],
  ]
  for (const [method, route, body, headers] of routes) {
    const res = await request(route, { token: tokens.viewer, method, body, headers })
    assert.equal(res.status, 403, `${method} ${route} -> ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error, 'AUTH_FORBIDDEN')
  }
  assert.equal(recorder.calls.length, before, `denied viewer requests must not touch the goal store (called: ${recorder.calls.slice(before).join(',')})`)
  // State is untouched: the seeded goal is still a draft and the scheduler is not globally paused.
  const state = await request(`/api/goals/${goal.id}`, { token: tokens.operator })
  assert.equal(state.body.goal.status, 'draft')
  assert.equal(state.body.goal.grant, undefined)
  const list = await request('/api/goals', { token: tokens.operator })
  assert.equal(list.body.paused, false)
})

test('a local-actor viewer still cannot write (audit reproduction is fixed)', async t => {
  const { request, tokens, recorder } = await startServer(t, { roles: { operator: 'p_op', viewer: 'p_view' } })
  const goal = await seedGoal(request, tokens)
  const before = recorder.calls.length
  for (const actor of [undefined, 'local']) {
    const res = await request('/api/goals/pause-all', { token: tokens.viewer, method: 'POST', body: {}, actor })
    assert.equal(res.status, 403, `actor=${actor ?? 'omitted'}`)
    assert.equal(res.body.error, 'AUTH_FORBIDDEN')
    const single = await request(`/api/goals/${goal.id}/pause`, { token: tokens.viewer, method: 'POST', body: {}, actor })
    assert.equal(single.status, 403)
    assert.equal(single.body.error, 'AUTH_FORBIDDEN')
  }
  assert.equal(recorder.calls.length, before)
  // Proof the global control was never invoked.
  assert.equal(recorder.calls.includes('controlAll'), false)
})

test('coordinator may read and wake, but no write action is allowed', async t => {
  const { request, tokens, recorder } = await startServer(t, { roles: { operator: 'p_op', coordinator: 'p_coord' } })
  const goal = await seedGoal(request, tokens)
  const before = recorder.calls.length
  for (const [route, body] of [['/api/goals', payload], ['/api/goals/pause-all', {}], ['/api/goals/resume-all', {}], [`/api/goals/${goal.id}/grant`, { digest: goal.specDigest }], [`/api/goals/${goal.id}/pause`, {}], [`/api/goals/${goal.id}/cancel`, {}], [`/api/goals/${goal.id}/revise`, payload]]) {
    const res = await request(route, { token: tokens.coordinator, method: 'POST', body, headers: { 'Idempotency-Key': 'coord' } })
    assert.equal(res.status, 403, `POST ${route} -> ${res.status}`)
    assert.equal(res.body.error, 'AUTH_FORBIDDEN')
  }
  assert.equal(recorder.calls.length, before)
  // wake is the one permitted write path (a scheduler nudge).
  const woke = await request(`/api/goals/${goal.id}/wake`, { token: tokens.coordinator, method: 'POST', body: {} })
  assert.equal(woke.status, 200)
  assert.equal(recorder.calls.includes('tick'), false) // tick is on the runtime engine, not the store
  // Reads are always allowed.
  assert.equal((await request(`/api/goals/${goal.id}`, { token: tokens.coordinator })).status, 200)
})

test('chief manages single goals but is denied grant and the global pause-all/resume-all', async t => {
  const { request, tokens, recorder } = await startServer(t, { roles: { operator: 'p_op', chief: 'p_chief' } })
  const created = await request('/api/goals', { token: tokens.chief, method: 'POST', body: payload, headers: { 'Idempotency-Key': 'chief-create' } })
  assert.equal(created.status, 201)
  const id = created.body.goal.id
  const seed = recorder.calls.length
  for (const [route, body] of [[`/api/goals/${id}/grant`, { digest: created.body.goal.specDigest }], ['/api/goals/pause-all', {}], ['/api/goals/resume-all', {}]]) {
    const res = await request(route, { token: tokens.chief, method: 'POST', body })
    assert.equal(res.status, 403, `POST ${route} -> ${res.status}`)
    assert.equal(res.body.error, 'AUTH_FORBIDDEN')
  }
  assert.equal(recorder.calls.length, seed, 'denied chief actions must not touch the store')
  const paused = await request(`/api/goals/${id}/pause`, { token: tokens.chief, method: 'POST', body: {} })
  assert.equal(paused.body.goal.status, 'paused')
  const revised = await request(`/api/goals/${id}/revise`, { token: tokens.chief, method: 'POST', body: { ...payload, objective: 'chief revise' } })
  assert.equal(revised.status, 200); assert.equal(revised.body.goal.generation, 2)
  const cancelled = await request(`/api/goals/${id}/cancel`, { token: tokens.chief, method: 'POST', body: {} })
  assert.equal(cancelled.body.goal.status, 'cancelled')
  assert.equal((await request(`/api/goals/${id}/wake`, { token: tokens.chief, method: 'POST', body: {} })).status, 200)
})

test('operator may perform every action, including grant and the global pause', async t => {
  const { request, tokens } = await startServer(t, { roles: { operator: 'p_op' } })
  const goal = await seedGoal(request, tokens, 'op-create')
  const revised = await request(`/api/goals/${goal.id}/revise`, { token: tokens.operator, method: 'POST', body: { ...payload, objective: 'operator revise' } })
  assert.equal(revised.status, 200)
  const granted = await request(`/api/goals/${goal.id}/grant`, { token: tokens.operator, method: 'POST', body: { digest: revised.body.goal.specDigest } })
  assert.equal(granted.status, 200); assert.equal(granted.body.goal.status, 'ready')
  assert.equal(granted.body.goal.grant.approvedBy, 'local')
  const paused = await request(`/api/goals/${goal.id}/pause`, { token: tokens.operator, method: 'POST', body: {} }); assert.equal(paused.body.goal.status, 'paused')
  const resumed = await request(`/api/goals/${goal.id}/resume`, { token: tokens.operator, method: 'POST', body: {} }); assert.equal(resumed.body.goal.status, 'ready')
  assert.equal((await request(`/api/goals/${goal.id}/wake`, { token: tokens.operator, method: 'POST', body: {} })).status, 200)
  assert.equal((await request('/api/goals/pause-all', { token: tokens.operator, method: 'POST', body: {} })).body.paused, true)
  assert.equal((await request('/api/goals/resume-all', { token: tokens.operator, method: 'POST', body: {} })).body.paused, false)
  assert.equal((await request(`/api/goals/${goal.id}/cancel`, { token: tokens.operator, method: 'POST', body: {} })).body.goal.status, 'cancelled')
})

test('a bound WeChat owner manages its own goals under a sufficient role; owner semantics and reads are unchanged', async t => {
  const user = 'TESTONLY-owner-user'
  const owner = ownerActorFor(user)
  const { request, tokens, recorder } = await startServer(t, { roles: { operator: 'p_op', chief: 'p_chief', viewer: 'p_view' }, wechatUser: user })
  const created = await request('/api/goals', { token: tokens.chief, method: 'POST', body: payload, headers: { 'Idempotency-Key': 'owner-create' } })
  assert.equal(created.status, 201)
  const id = created.body.goal.id
  assert.equal(created.body.goal.owner, owner)
  // chief with the owner actor manages its own goal (grant stays out of reach).
  assert.equal((await request(`/api/goals/${id}/grant`, { token: tokens.chief, method: 'POST', body: { digest: created.body.goal.specDigest }, actor: owner })).status, 403)
  assert.equal((await request(`/api/goals/${id}/pause`, { token: tokens.chief, method: 'POST', body: {}, actor: owner })).body.goal.status, 'paused')
  // A non-local actor that is not the bound owner is still refused (owner binding unchanged).
  const stranger = await request(`/api/goals/${id}/pause`, { token: tokens.chief, method: 'POST', body: {}, actor: 'wechat-stranger' })
  assert.equal(stranger.status, 403); assert.equal(stranger.body.error, 'OWNER_REQUIRED')
  // Viewer: read is normal; even with the owner actor a write is refused by role.
  assert.equal((await request('/api/goals', { token: tokens.viewer })).status, 200)
  assert.equal((await request(`/api/goals/${id}`, { token: tokens.viewer })).status, 200)
  assert.equal((await request(`/api/goals/${id}/proof`, { token: tokens.viewer })).status, 200)
  const denied = await request(`/api/goals/${id}/resume`, { token: tokens.viewer, method: 'POST', body: {}, actor: owner })
  assert.equal(denied.status, 403); assert.equal(denied.body.error, 'AUTH_FORBIDDEN')
  // operator with the default local actor still manages across owners (existing semantics).
  assert.equal((await request(`/api/goals/${id}/cancel`, { token: tokens.operator, method: 'POST', body: {} })).body.goal.status, 'cancelled')
  assert.equal(recorder.calls.includes('controlAll'), false)
})

test('/health and the retired /api/bootstrap remain unauthenticated and unchanged', async t => {
  const { request } = await startServer(t, { roles: { operator: 'p_op' } })
  const health = await request('/health')
  assert.equal(health.status, 200); assert.equal(health.body.status, 'ok')
  const bootstrap = await request('/api/bootstrap')
  assert.equal(bootstrap.status, 410); assert.equal(bootstrap.body.error, 'BOOTSTRAP_RETIRED')
})
