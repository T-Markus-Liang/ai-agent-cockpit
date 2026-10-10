#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ConversationMemoryStore } from '../vendor/wechat-acp/dist/src/storage/memory.js'

// Explicit opt-in: briefly stops ONLY Mem0, not WeChat or native Agent sessions.
assert.equal(process.env.MEMORY_RECOVERY_TEST, '1', 'Set MEMORY_RECOVERY_TEST=1 to authorize the brief memory-service outage')
assert.equal(process.platform, 'darwin', 'This recovery test uses macOS launchd')
const run = promisify(execFile)
const root = 'http://127.0.0.1:4325'
const target = `gui/${process.getuid()}/com.markus.personal-ai-os.memory`
const plist = path.join(os.homedir(), 'Library/LaunchAgents/com.markus.personal-ai-os.memory.plist')
await fs.access(plist)
// Per-client authentication (0.3.0 G4): the shared mem0 api-token file is
// retired. Supply this client's bearer token via MEMORY_AUTH_TOKEN.
const token = process.env.MEMORY_AUTH_TOKEN
if (!token) throw new Error('MEMORY_AUTH_TOKEN is required (per-client bearer token; the shared mem0 api-token file was retired)')
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
async function request(endpoint, body) {
  const response = await fetch(`${root}${endpoint}`, { signal: AbortSignal.timeout(3000), ...(body ? { method: 'POST', headers, body: JSON.stringify(body) } : {}) })
  assert.ok(response.ok, `memory API HTTP ${response.status}`)
  return response.json()
}
async function eventually(check, description, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { if (await check()) return } catch { /* startup/provider work may still be pending */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(description)
}
async function bootstrap() {
  for (let i = 0; i < 20; i++) {
    try { await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { timeout: 5000 }); return }
    catch {
      try { if ((await request('/health')).engine === 'mem0-oss') return } catch { /* wait for old process teardown */ }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Memory launchd bootstrap failed; inspect the installed plist')
}
const health = await request('/health')
assert.equal(health.engine, 'mem0-oss')
await eventually(async () => (await request('/health')).ingestion.pending === 0, 'Wait for existing memory ingestion before stopping the service')
const user = `memory-recovery-${crypto.randomUUID()}`
const userId = `wechat-${crypto.createHash('sha256').update(user).digest('hex')}`
const query = text => request('/v1/search', { user_id: userId, query: text, limit: 5 })
await request('/v1/turns', { event_id: `${user}:before`, user_id: userId, role: 'user', text: '我的独立恢复测试项目代号是银河蓝。' })
await eventually(async () => (await query('测试项目代号')).results.some(row => /银河蓝/.test(row.memory)), 'Pre-restart fact extraction failed', 180)
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem0-real-recovery-'))
// The bridge client still reads a token file (migrated in a deployment batch);
// materialise this client's per-client token for it.
const tokenFile = path.join(dir, 'client-token')
await fs.writeFile(tokenFile, token, { mode: 0o600 })
const options = { file: path.join(dir, 'memory.json'), enabled: true, mem0: { url: root, tokenFile, timeoutMs: 1500 } }
let first, second, stopped = false
try {
  await run('launchctl', ['bootout', target], { timeout: 10000 })
  stopped = true
  await eventually(async () => {
    try { await request('/health'); return false } catch { return true }
  }, 'Memory did not stop')
  console.log('Memory stopped; verifying local-context degradation and durable outbox')
  first = new ConversationMemoryStore(options)
  await first.append(user, 'user', '我的恢复测试项目代号是青杉，回答请使用简体中文。')
  await first.append(user, 'assistant', '（合成测试）助手猜测你喜欢法语，这不是用户事实。')
  await first.flushOutbox()
  assert.equal(JSON.parse(await fs.readFile(options.file, 'utf8')).outbox.length, 2)
  const started = Date.now()
  assert.match(await first.context(user, '项目代号'), /青杉/)
  assert.ok(Date.now() - started < 3000, 'Local context must not stall on memory outage')
  await first.close()
  await bootstrap()
  stopped = false
  await eventually(async () => (await request('/health')).engine === 'mem0-oss', 'Memory readiness timeout')
  assert.ok((await query('测试项目代号')).results.some(row => /银河蓝/.test(row.memory)), 'Existing vector memory must survive an actual service restart')
  second = new ConversationMemoryStore(options)
  await second.flushOutbox()
  assert.equal(JSON.parse(await fs.readFile(options.file, 'utf8')).outbox.length, 0)
  await eventually(async () => (await query('项目代号和语言偏好')).results.some(row => /青杉/.test(row.memory)), 'Recovered outbox must reach real semantic memory', 180)
  const facts = (await query('语言偏好')).results
  assert.ok(facts.every(row => !/法语/.test(row.memory)), 'Assistant guesses must not become long-term user facts')
  assert.equal((await request('/v1/search', { user_id: `${userId}-other`, query: '项目代号', limit: 5 })).results.length, 0)
  console.log(JSON.stringify({ type: 'RealMem0RecoveryVerification', passed: ['actual-service-outage', 'local-context-degradation-under-3s', 'durable-outbox-after-bridge-recreation', 'actual-service-restart-vector-persistence', 'recovery-to-real-semantic-memory', 'assistant-not-inferred', 'user-isolation'], realWeChatMessagesSent: 0 }))
} finally {
  if (stopped) { await bootstrap(); await eventually(async () => (await request('/health')).engine === 'mem0-oss', 'Failed to restore Mem0') }
  await first?.close()
  await second?.close()
  await fs.rm(dir, { recursive: true, force: true })
}
