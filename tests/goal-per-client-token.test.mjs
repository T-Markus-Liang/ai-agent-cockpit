import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGoalServer } from '../gateway/goals.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { createPairingAuthority, PairingError } from '../control-plane/identity-pairing.mjs'
import { writeAuthorityFile, AuthorityError } from '../control-plane/request-authority.mjs'

// Fully synthetic harness (tmp dirs only): no production service, DB, launchd
// or real user files are touched. The goals service authenticates per client
// from an authority document revalidated on every request.
const digest = token => crypto.createHash('sha256').update(token).digest('hex')
const mintToken = () => crypto.randomBytes(32).toString('base64url')
const future = () => Date.now() + 3_600_000

async function startServer(t, document) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-per-client-'))
  const stateDir = path.join(dir, 'goals')
  const engine = { active: new Map(), start: async () => {}, stop: async () => {}, tick: async () => {}, abort: () => {} }
  const app = await createGoalServer({ stateDir, tasks: new ControlPlaneStore({ stateDir: path.join(dir, 'tasks') }), runtime: engine, wechatStateFile: path.join(dir, 'wechat.json') })
  const authFile = path.join(stateDir, 'authority.json')
  await fs.writeFile(authFile, JSON.stringify(document), { mode: 0o600 })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }) })
  const root = `http://127.0.0.1:${app.server.address().port}`
  const request = async (endpoint, token) => {
    const response = await fetch(root + endpoint, { signal: AbortSignal.timeout(3000), headers: token ? { Authorization: `Bearer ${token}` } : {} })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: response.status, body }
  }
  return { app, root, authFile, dir, request }
}

test('per-client principals authenticate independently: revoked, expired, unknown and absent tokens are refused', async t => {
  const validToken = mintToken(), revokedToken = mintToken(), expiredToken = mintToken()
  const document = { version: 1, principals: [
    { id: 'p_valid', role: 'operator', tokenDigest: digest(validToken), expiresAt: future() },
    { id: 'p_revoked', role: 'operator', tokenDigest: digest(revokedToken), expiresAt: future(), revoked: true },
    { id: 'p_expired', role: 'operator', tokenDigest: digest(expiredToken), expiresAt: Date.now() - 1000 },
  ] }
  const { request } = await startServer(t, document)
  assert.equal((await request('/api/goals')).status, 401)
  assert.equal((await request('/api/goals', mintToken())).status, 401)
  assert.equal((await request('/api/goals', validToken)).status, 200)
  assert.equal((await request('/api/goals', revokedToken)).status, 401)
  assert.equal((await request('/api/goals', expiredToken)).status, 401)
})

test('rotating the authority file refuses the old token immediately without a restart', async t => {
  const oldToken = mintToken(), newToken = mintToken()
  const { request, authFile } = await startServer(t, { version: 1, principals: [
    { id: 'p_client', role: 'operator', tokenDigest: digest(oldToken), expiresAt: future() }] })
  assert.equal((await request('/api/goals', oldToken)).status, 200)
  await writeAuthorityFile(authFile, { version: 1, principals: [
    { id: 'p_client', role: 'operator', tokenDigest: digest(newToken), expiresAt: future() }] })
  assert.equal((await request('/api/goals', oldToken)).status, 401)
  assert.equal((await request('/api/goals', newToken)).status, 200)
})

test('a missing or invalid authority document fails every authenticated request closed with 500', async t => {
  const token = mintToken()
  const { request, authFile } = await startServer(t, { version: 1, principals: [
    { id: 'p_client', role: 'operator', tokenDigest: digest(token), expiresAt: future() }] })
  // /health never needs authority
  assert.equal((await request('/health')).status, 200)
  await fs.rm(authFile)
  const missing = await request('/api/goals', token)
  assert.equal(missing.status, 500)
  assert.equal(missing.body.error, 'AUTH_CONFIGURATION')
})

test('writeAuthorityFile refuses an invalid snapshot and never mutates the target', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-authwrite-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'authority.json')
  const good = { version: 1, principals: [{ id: 'p_keep', role: 'viewer', tokenDigest: digest(mintToken()), expiresAt: future() }] }
  await writeAuthorityFile(file, good)
  const before = await fs.readFile(file, 'utf8')
  assert.equal((await fs.stat(file)).mode & 511, 384)
  const bad = [
    { version: 2, principals: good.principals },
    { version: 1, principals: [] },
    { version: 1, principals: [{ id: 'p_bad', role: 'root', tokenDigest: digest('x'), expiresAt: future() }] },
    { version: 1, principals: [{ id: 'p_bad', role: 'viewer', tokenDigest: 'not-hex', expiresAt: future() }] },
    { version: 1, principals: [{ id: 'p_bad', role: 'viewer', tokenDigest: digest('x'), expiresAt: future(), extra: true }] },
  ]
  for (const snapshot of bad) {
    await assert.rejects(() => writeAuthorityFile(file, snapshot),
      error => error instanceof AuthorityError && error.code === 'AUTH_CONFIGURATION')
  }
  assert.equal(await fs.readFile(file, 'utf8'), before)
  assert.equal((await fs.readdir(dir)).some(name => name.includes('.tmp')), false)
})

test('exportPrincipals refuses to exceed the 16-principal request-authority ceiling', () => {
  const authority = createPairingAuthority()
  for (let i = 0; i < 16; i++) authority.completePairing(authority.beginPairing({ role: 'viewer' }).pairingCode)
  assert.equal(authority.exportPrincipals().principals.length, 16)
  authority.completePairing(authority.beginPairing({ role: 'viewer' }).pairingCode) // 17th active principal
  assert.throws(() => authority.exportPrincipals(), error => error instanceof PairingError && error.code === 'export-overflow')
})

test('identity-pairing export feeds the live goal server, and revocation lands without a restart', async t => {
  const pair = createPairingAuthority()
  const client = pair.completePairing(pair.beginPairing({ role: 'operator' }).pairingCode)
  const { request, authFile } = await startServer(t, pair.exportPrincipals())
  assert.equal((await request('/api/goals', client.token)).status, 200)
  pair.revoke(client.principalId)
  await writeAuthorityFile(authFile, pair.exportPrincipals()) // revoked entry retained as evidence
  assert.equal((await request('/api/goals', client.token)).status, 401)
})
