#!/usr/bin/env node
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const WECHAT_BASE = 'https://ilinkai.weixin.qq.com'
const TOKEN_PATH = path.join(process.env.HOME ?? '', '.wechat-acp/instances/cezar-codex/token.json')
const BRIDGE_DIR = path.join(ROOT, 'vendor/wechat-acp')
const BRIDGE_BIN = path.join(BRIDGE_DIR, 'dist/bin/wechat-acp.js')
const BRIDGE_CONFIG = path.join(ROOT, 'config/wechat-acp.json')
const PROJECT_ROOT = ROOT
const PORT = Number(process.env.WECHAT_CONTROL_PORT ?? 4322)

let qr = null

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
  const response = await fetch(url, { headers: headers(token) })
  const text = await response.text()
  if (!response.ok) throw new Error(`WeChat API ${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function tokenData() {
  try { return JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8')) } catch { return null }
}

function connectedPayload(token) {
  return token ? { status: 'connected', botId: token.accountId, savedAt: token.savedAt } : { status: 'disconnected' }
}

function startBridge() {
  if (!existsSync(BRIDGE_BIN)) return
  const child = spawn(process.execPath, [BRIDGE_BIN, '--instance', 'cezar-codex', '--agent', 'codex', '--cwd', PROJECT_ROOT, '--config', BRIDGE_CONFIG, '--session-resume', 'auto', '--hide-thoughts', '--show-diffs', '--daemon'], {
    cwd: BRIDGE_DIR,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function beginQr() {
  const data = await getJson(`${WECHAT_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`)
  qr = { qrcode: data.qrcode, qrUrl: data.qrcode_img_content, createdAt: Date.now() }
  return { status: 'pending', qrUrl: qr.qrUrl, createdAt: qr.createdAt, expiresAt: qr.createdAt + 5 * 60_000 }
}

async function qrStatus() {
  const token = await tokenData()
  if (token) return connectedPayload(token)
  if (!qr) return { status: 'disconnected' }
  const data = await getJson(`${WECHAT_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`)
  if (data.status === 'confirmed') {
    const saved = { token: data.bot_token, baseUrl: data.baseurl || WECHAT_BASE, accountId: data.ilink_bot_id, userId: data.ilink_user_id, savedAt: new Date().toISOString() }
    await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true })
    await fs.writeFile(TOKEN_PATH, JSON.stringify(saved, null, 2), { mode: 0o600 })
    qr = null
    startBridge()
    return connectedPayload(saved)
  }
  if (data.status === 'expired' || Date.now() - qr.createdAt > 5 * 60_000) return { status: 'expired' }
  return { status: data.status === 'scaned' ? 'scanned' : 'pending', qrUrl: qr.qrUrl, expiresAt: qr.createdAt + 5 * 60_000 }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end() }
  try {
    if (req.method === 'GET' && req.url === '/api/wechat/status') return send(res, 200, await qrStatus())
    if (req.method === 'POST' && req.url === '/api/wechat/qr') {
      const token = await tokenData()
      return send(res, 200, token ? connectedPayload(token) : await beginQr())
    }
    send(res, 404, { error: 'not found' })
  } catch (error) { send(res, 500, { status: 'error', error: String(error) }) }
})

server.listen(PORT, '127.0.0.1', () => console.log(`[wechat-control] listening at http://127.0.0.1:${PORT}`))
