#!/usr/bin/env node
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const WECHAT_BASE = 'https://ilinkai.weixin.qq.com'
const TOKEN_PATH = path.join(process.env.HOME ?? '', '.wechat-acp/instances/cezar-codex/token.json')
const BRIDGE_DIR = path.join(ROOT, 'vendor/wechat-acp')
const BRIDGE_BIN = path.join(BRIDGE_DIR, 'dist/bin/wechat-acp.js')
const BRIDGE_CONFIG = path.join(ROOT, 'config/wechat-acp.json')
const PROJECT_ROOT = ROOT
const PORT = Number(process.env.WECHAT_CONTROL_PORT ?? 4322)
// Same first-party origin allowlist as the control plane (AUI3-F002): only the
// cezar cockpit may read this API cross-port. Untrusted origins are rejected
// outright, everything else answers without CORS-wildcard headers.
const TRUSTED_ORIGINS = new Set(['http://127.0.0.1:4321', 'http://localhost:4321'])
const QR_TTL_MS = 5 * 60_000

export function createWechatControlServer(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const spawnImpl = deps.spawnImpl ?? spawn
  const tokenPath = deps.tokenPath ?? TOKEN_PATH
  const bridgeBin = deps.bridgeBin ?? BRIDGE_BIN
  const now = deps.now ?? Date.now

  let qr = null
  // The bridge is started only from the explicit write path (POST /api/wechat/qr),
  // never from a GET: a status read must not pull processes into existence, and a
  // third-party page that somehow reached this loopback service must not be able to
  // advance the bridge lifecycle either (AUI3-F002).
  let bridgeStarted = false

  function headers(token) {
    const uin = crypto.randomBytes(4).readUInt32BE(0).toString()
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(uin).toString('base64'),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  async function getJson(url, token) {
    const response = await fetchImpl(url, { headers: headers(token) })
    const text = await response.text()
    if (!response.ok) throw new Error(`WeChat API ${response.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text)
  }

  async function tokenData() {
    try { return JSON.parse(await fs.readFile(tokenPath, 'utf8')) } catch { return null }
  }

  function connectedPayload(token) {
    return token ? { status: 'connected', botId: token.accountId, savedAt: token.savedAt } : { status: 'disconnected' }
  }

  function startBridge() {
    if (bridgeStarted || !existsSync(bridgeBin)) return
    const child = spawnImpl(process.execPath, [bridgeBin, '--instance', 'cezar-codex', '--agent', 'codex', '--cwd', PROJECT_ROOT, '--config', BRIDGE_CONFIG, '--session-resume', 'auto', '--hide-thoughts', '--show-diffs', '--daemon'], {
      cwd: BRIDGE_DIR,
      detached: true,
      stdio: 'ignore',
    })
    // A failed spawn must not latch the once-guard: an async spawn error clears
    // the flag (and the listener keeps an unhandled 'error' event from crashing
    // the server), so the next explicit write can retry the bridge.
    child.on('error', () => { bridgeStarted = false })
    child.unref()
    bridgeStarted = true
  }

  async function beginQr() {
    const data = await getJson(`${WECHAT_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`)
    qr = { qrcode: data.qrcode, qrUrl: data.qrcode_img_content, createdAt: now(), scanned: false }
    return qrProgressPayload()
  }

  function qrProgressPayload() {
    if (!qr) return { status: 'disconnected' }
    const expiresAt = qr.createdAt + QR_TTL_MS
    if (now() - qr.createdAt > QR_TTL_MS) return { status: 'expired' }
    return { status: qr.scanned ? 'scanned' : 'pending', qrUrl: qr.qrUrl, expiresAt }
  }

  // GET /api/wechat/status is a pure local read: it reports token presence and the
  // in-memory QR flow state, and never calls the remote WeChat API, never writes
  // the token file, and never spawns the bridge.
  async function readStatus() {
    const token = await tokenData()
    if (token) return connectedPayload(token)
    return qrProgressPayload()
  }

  // POST /api/wechat/qr is the explicit write: it starts a QR flow when
  // disconnected, advances an in-flight flow against the remote API (which may
  // persist the confirmed token and start the bridge), or idempotently ensures the
  // bridge is running once connected.
  async function writeQr() {
    const token = await tokenData()
    if (token) {
      startBridge()
      return connectedPayload(token)
    }
    if (qr && now() - qr.createdAt <= QR_TTL_MS) {
      const data = await getJson(`${WECHAT_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`)
      if (data.status === 'confirmed') {
        const saved = { token: data.bot_token, baseUrl: data.baseurl || WECHAT_BASE, accountId: data.ilink_bot_id, userId: data.ilink_user_id, savedAt: new Date().toISOString() }
        await fs.mkdir(path.dirname(tokenPath), { recursive: true })
        await fs.writeFile(tokenPath, JSON.stringify(saved, null, 2), { mode: 0o600 })
        // mode only applies at creation; tighten pre-existing files too.
        await fs.chmod(tokenPath, 0o600).catch(() => {})
        qr = null
        startBridge()
        return connectedPayload(saved)
      }
      if (data.status === 'expired' || now() - qr.createdAt > QR_TTL_MS) {
        qr = null
        return { status: 'expired' }
      }
      qr.scanned = data.status === 'scaned'
      return qrProgressPayload()
    }
    return beginQr()
  }

  function send(res, status, body) {
    if (status === 204) {
      res.writeHead(status, { 'Access-Control-Allow-Origin': res.trustedOrigin ?? 'http://127.0.0.1:4321', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      return res.end()
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': res.trustedOrigin ?? 'http://127.0.0.1:4321',
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer(async (req, res) => {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'INVALID_HOST' })
    if (req.headers.origin && !TRUSTED_ORIGINS.has(req.headers.origin)) return send(res, 403, { error: 'UNTRUSTED_ORIGIN' })
    res.trustedOrigin = req.headers.origin
    if (req.method === 'OPTIONS') return send(res, 204)
    try {
      if (req.method === 'GET' && req.url === '/api/wechat/status') return send(res, 200, await readStatus())
      if (req.method === 'POST' && req.url === '/api/wechat/qr') return send(res, 200, await writeQr())
      send(res, 404, { error: 'not found' })
    } catch (error) { send(res, 500, { status: 'error', error: String(error) }) }
  })

  return server
}

// Compare against the resolved argv path so both absolute (launchd) and
// relative (`node gateway/wechat-control.mjs` from the repo root) invocations
// enter the listen branch, while imports and `node -e` stay silent.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWechatControlServer().listen(PORT, '127.0.0.1', () => console.log(`[wechat-control] listening at http://127.0.0.1:${PORT}`))
}
