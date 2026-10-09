import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createWechatControlServer } from '../gateway/wechat-control.mjs'

// In-process harness for the AUI3-F002 split: GET /api/wechat/status is a pure
// local read (no remote call, no token write, no bridge spawn) and POST
// /api/wechat/qr is the only path that advances the QR lifecycle or spawns.
function makeHarness(options = {}) {
  const remoteCalls = []
  const spawnCalls = []
  const tmp = { dir: null }
  const clock = { now: 1_700_000_000_000, ...(options.clock ?? {}) }
  const plan = options.remotePlan ?? {}
  const fetchImpl = async (url) => {
    remoteCalls.push(String(url))
    if (String(url).includes('get_bot_qrcode')) {
      return jsonResponse({ qrcode: 'qr-code-1', qrcode_img_content: 'https://weixin.example/qr.png' })
    }
    if (String(url).includes('get_qrcode_status')) {
      const status = typeof plan.qrcodeStatus === 'function' ? plan.qrcodeStatus() : plan.qrcodeStatus ?? 'waiting'
      if (status === 'confirmed') {
        return jsonResponse({ status: 'confirmed', bot_token: 'bot-token-1', baseurl: 'https://ilinkai.weixin.qq.com', ilink_bot_id: 'bot-42', ilink_user_id: 'user-7' })
      }
      return jsonResponse({ status })
    }
    throw new Error(`unexpected remote URL: ${url}`)
  }
  const spawnImpl = (...args) => {
    spawnCalls.push(args)
    if (options.failSpawnAttempts && spawnCalls.length <= options.failSpawnAttempts) {
      // Async spawn failure: the server must survive (no unhandled 'error') and
      // clear its once-guard so a later explicit write can retry.
      return { on(event, cb) { if (event === 'error') queueMicrotask(() => cb(new Error('spawn failed'))); return this }, unref() {} }
    }
    return { on() {}, unref() {} }
  }
  return { remoteCalls, spawnCalls, spawnImpl, clock, fetchImpl, spawnCallsList: spawnCalls }
}

function jsonResponse(body) {
  return { ok: true, text: async () => JSON.stringify(body) }
}

async function startServer(t, harness, options = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-control-suite-'))
  const tokenPath = options.tokenPath ?? path.join(stateDir, 'token.json')
  const bridgeBin = options.bridgeBin ?? path.join(stateDir, 'bridge.js')
  if (options.bridgeExists !== false) await fs.writeFile(bridgeBin, '#!/usr/bin/env node\n')
  const server = createWechatControlServer({
    fetchImpl: harness.fetchImpl,
    spawnImpl: harness.spawnImpl,
    tokenPath,
    bridgeBin,
    now: () => harness.clock.now,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const request = async (pathname, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options)
    return { response, body: await response.json().catch(() => null), acao: response.headers.get('access-control-allow-origin') }
  }
  return { request, tokenPath, stateDir }
}

test('GET /status is a pure read: disconnected, zero remote calls, zero spawns', async (t) => {
  const harness = makeHarness()
  const { request } = await startServer(t, harness)
  const first = await request('/api/wechat/status')
  assert.equal(first.body.status, 'disconnected')
  const second = await request('/api/wechat/status')
  assert.equal(second.body.status, 'disconnected')
  assert.equal(harness.remoteCalls.length, 0)
  assert.equal(harness.spawnCallsList.length, 0)
})

test('POST /qr starts a flow; GET reports it without touching remote or bridge', async (t) => {
  const harness = makeHarness()
  const { request } = await startServer(t, harness)
  const started = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(started.body.status, 'pending')
  assert.equal(started.body.qrUrl, 'https://weixin.example/qr.png')
  assert.equal(typeof started.body.expiresAt, 'number')
  assert.equal(harness.remoteCalls.length, 1)
  assert.equal(harness.spawnCallsList.length, 0)

  const read = await request('/api/wechat/status')
  assert.equal(read.body.status, 'pending')
  assert.equal(read.body.qrUrl, 'https://weixin.example/qr.png')
  assert.equal(harness.remoteCalls.length, 1, 'GET must not poll the remote API')
  assert.equal(harness.spawnCallsList.length, 0, 'GET must never spawn the bridge')
})

test('POST advances the lifecycle to scanned, then confirmed persists token and starts bridge once', async (t) => {
  const remotePlan = { qrcodeStatus: 'scaned' }
  const harness = makeHarness({ remotePlan })
  const { request, tokenPath } = await startServer(t, harness)
  await request('/api/wechat/qr', { method: 'POST' })

  const scanned = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(scanned.body.status, 'scanned')
  assert.equal(harness.spawnCallsList.length, 0)

  remotePlan.qrcodeStatus = 'confirmed'
  const confirmed = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(confirmed.body.status, 'connected')
  assert.equal(confirmed.body.botId, 'bot-42')
  assert.equal(harness.spawnCallsList.length, 1)

  const saved = JSON.parse(await fs.readFile(tokenPath, 'utf8'))
  assert.equal(saved.token, 'bot-token-1')
  assert.equal(saved.accountId, 'bot-42')
  const stat = await fs.stat(tokenPath)
  assert.equal(stat.mode & 0o777, 0o600)

  const read = await request('/api/wechat/status')
  assert.equal(read.body.status, 'connected')
  assert.equal(read.body.botId, 'bot-42')
  assert.equal(harness.remoteCalls.length, 3, 'reads after connect never poll remote')
  assert.equal(harness.spawnCallsList.length, 1, 'bridge starts exactly once')
})

test('repeated POST while connected is idempotent: no extra spawn, no remote calls', async (t) => {
  const harness = makeHarness()
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-control-suite-'))
  const tokenPath = path.join(stateDir, 'token.json')
  await fs.writeFile(tokenPath, JSON.stringify({ token: 'bot-token-1', accountId: 'bot-42', savedAt: '2026-10-09T00:00:00.000Z' }))
  const { request } = await startServer(t, harness, { tokenPath })
  for (let index = 0; index < 3; index += 1) {
    const response = await request('/api/wechat/qr', { method: 'POST' })
    assert.equal(response.body.status, 'connected')
  }
  assert.equal(harness.remoteCalls.length, 0)
  assert.equal(harness.spawnCallsList.length, 1, 'token branch ensures the bridge exactly once')
})

test('locally expired QR reads as expired and POST begins a fresh flow', async (t) => {
  const harness = makeHarness()
  const { request } = await startServer(t, harness)
  await request('/api/wechat/qr', { method: 'POST' })
  harness.clock.now += 6 * 60_000
  const read = await request('/api/wechat/status')
  assert.equal(read.body.status, 'expired')
  assert.equal(harness.remoteCalls.length, 1, 'expiry is judged locally on GET')
  const restarted = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(restarted.body.status, 'pending')
  assert.equal(harness.remoteCalls.length, 2)
  assert.equal(harness.spawnCallsList.length, 0)
})

test('remotely expired QR is cleared and a new POST starts a fresh flow', async (t) => {
  const harness = makeHarness({ remotePlan: { qrcodeStatus: 'expired' } })
  const { request } = await startServer(t, harness)
  await request('/api/wechat/qr', { method: 'POST' })
  const expired = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(expired.body.status, 'expired')
  assert.equal(harness.spawnCallsList.length, 0)
  const restarted = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(restarted.body.status, 'pending')
})

test('CORS mirrors the control-plane allowlist: trusted origins answered, untrusted rejected', async (t) => {
  const harness = makeHarness()
  const { request } = await startServer(t, harness)
  const trusted = await request('/api/wechat/status', { headers: { Origin: 'http://127.0.0.1:4321' } })
  assert.equal(trusted.body.status, 'disconnected')
  assert.equal(trusted.acao, 'http://127.0.0.1:4321')

  const untrusted = await request('/api/wechat/status', { headers: { Origin: 'http://evil.example' } })
  assert.equal(untrusted.response.status, 403)
  assert.equal(untrusted.body.error, 'UNTRUSTED_ORIGIN')

  const preflight = await request('/api/wechat/status', { method: 'OPTIONS', headers: { Origin: 'http://localhost:4321' } })
  assert.equal(preflight.response.status, 204)
  assert.equal(preflight.acao, 'http://localhost:4321')

  const preflightUntrusted = await request('/api/wechat/status', { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } })
  assert.equal(preflightUntrusted.response.status, 403)
})

test('bridge spawn failure does not latch: the next explicit write retries', async (t) => {
  const harness = makeHarness({ failSpawnAttempts: 1 })
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-control-suite-'))
  const tokenPath = path.join(stateDir, 'token.json')
  await fs.writeFile(tokenPath, JSON.stringify({ token: 'bot-token-1', accountId: 'bot-42', savedAt: '2026-10-10T00:00:00.000Z' }))
  const { request } = await startServer(t, harness, { tokenPath })
  const first = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(first.body.status, 'connected')
  await new Promise((resolve) => setImmediate(resolve))
  const second = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(second.body.status, 'connected')
  assert.equal(harness.spawnCallsList.length, 2, 'failed spawn is retried on the next write')
})

test('confirmed write tightens a pre-existing loose-permission token file to 0600', async (t) => {
  const harness = makeHarness({ remotePlan: { qrcodeStatus: 'confirmed' } })
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-control-suite-'))
  const tokenPath = path.join(stateDir, 'token.json')
  await fs.writeFile(tokenPath, 'not-json', { mode: 0o644 })
  const { request } = await startServer(t, harness, { tokenPath })
  await request('/api/wechat/qr', { method: 'POST' })
  const confirmed = await request('/api/wechat/qr', { method: 'POST' })
  assert.equal(confirmed.body.status, 'connected')
  const stat = await fs.stat(tokenPath)
  assert.equal(stat.mode & 0o777, 0o600, 'pre-existing file is chmodded, not just created-time mode')
})

test('GET never spawns the bridge across the whole lifecycle', async (t) => {
  const remotePlan = { qrcodeStatus: 'scaned' }
  const harness = makeHarness({ remotePlan })
  const { request } = await startServer(t, harness)
  await request('/api/wechat/qr', { method: 'POST' })
  for (let index = 0; index < 3; index += 1) await request('/api/wechat/status')
  assert.equal(harness.spawnCallsList.length, 0)
  remotePlan.qrcodeStatus = 'confirmed'
  await request('/api/wechat/qr', { method: 'POST' })
  for (let index = 0; index < 3; index += 1) await request('/api/wechat/status')
  assert.equal(harness.spawnCallsList.length, 1)
})
