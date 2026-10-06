#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ConversationMemoryStore } from '../vendor/wechat-acp/dist/src/storage/memory.js'

const root = 'http://127.0.0.1:4325'
const tokenFile = path.join(os.homedir(), '.local/state/personal-ai-os/mem0/api-token')
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
const tag = process.env.MEMORY_TEST_TAG ?? `mem0-live-${crypto.randomUUID()}`
const query = { user_id: tag, query: '用户希望怎样称呼他，回答应该使用什么语言？', limit: 5 }
const health = await fetch(`${root}/health`).then(r => r.json())
assert.equal(health.engine, 'mem0-oss')
const unauthorized = await fetch(`${root}/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) })
assert.equal(unauthorized.status, 401)
const ingest = () => fetch(`${root}/v1/turns`, { method: 'POST', headers, body: JSON.stringify({ event_id: `${tag}:one`, user_id: tag, role: 'user', text: '请称呼我为小柚，我希望你的回答使用简体中文，简短自然。' }) })
assert.equal((await ingest()).status, 202)
assert.equal((await (await ingest()).json()).replay, true)
let memories = []
for (let attempt = 0; attempt < 90; attempt++) {
  const response = await fetch(`${root}/v1/search`, { method: 'POST', headers, body: JSON.stringify(query), signal: AbortSignal.timeout(3000) })
  if (response.ok) memories = (await response.json()).results
  if (memories.some(row => /小柚/.test(row.memory))) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}
assert.ok(memories.some(row => /小柚/.test(row.memory)), 'Chinese user fact must be extracted and retrievable')
const other = await fetch(`${root}/v1/search`, { method: 'POST', headers, body: JSON.stringify({ ...query, user_id: `${tag}:other` }) }).then(r => r.json())
assert.equal(other.results.length, 0)

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem0-bridge-live-'))
const options = { file: path.join(dir, 'memory.json'), enabled: true, maxTurns: 2, mem0: { url: root, tokenFile, timeoutMs: 1500 } }
const first = new ConversationMemoryStore(options)
try {
  await first.append(tag, 'user', '我的测试项目代号是紫竹，今后讨论项目时请记住。')
  await first.append(tag, 'assistant', '好的，我记住项目代号紫竹。')
  await first.flushOutbox()
  await first.close()
  const second = new ConversationMemoryStore(options)
  try {
    const context = await second.context(tag, '项目代号')
    assert.match(context, /紫竹/)
    assert.equal((await second.context(`${tag}:other`, '项目代号')).includes('紫竹'), false)
    assert.ok((await fs.readdir(second.archiveDir)).length > 0)
  } finally { await second.close() }
} finally { await first.close(); await fs.rm(dir, { recursive: true, force: true }) }
console.log(JSON.stringify({ type: 'Mem0LiveVerification', tag, passed: ['real-mem0-oss', 'authentication', 'idempotent-ingestion', 'Chinese-extraction-and-semantic-recall', 'cross-user-isolation', 'bridge-restart-context', 'full-local-archive'], memoryCount: memories.length, health }, null, 2))
