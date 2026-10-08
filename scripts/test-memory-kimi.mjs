#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { WeChatAcpBridge } from '../vendor/wechat-acp/dist/src/bridge.js'
import { SessionManager } from '../vendor/wechat-acp/dist/src/acp/session.js'
import { defaultConfig } from '../vendor/wechat-acp/dist/src/config.js'

// Exercise the actual bridge preparation + real Kimi ACP, but replace WeChat
// network sinks. No user session is resumed and no real WeChat message is sent.
const root = 'http://127.0.0.1:4325'
const tokenFile = path.join(os.homedir(), '.local/state/personal-ai-os/mem0/api-token')
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
const user = `kimi-memory-verification-${crypto.randomUUID()}`
const user_id = `wechat-${crypto.createHash('sha256').update(user).digest('hex')}`
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
const seed = await fetch(`${root}/v1/turns`, { method: 'POST', headers, signal: AbortSignal.timeout(5000), body: JSON.stringify({ event_id: `${user}:seed`, user_id, role: 'user', text: '请记住我希望你称呼我小柚，并且以后用简体中文回答。' }) })
assert.equal(seed.status, 202)
for (let i = 0; i < 60; i++) {
  const response = await fetch(`${root}/v1/search`, { method: 'POST', headers, signal: AbortSignal.timeout(5000), body: JSON.stringify({ user_id, query: '用户希望怎么称呼', limit: 5 }) })
  if (response.ok && (await response.json()).results.some(r => /小柚/.test(r.memory))) break
  if (i === 59) throw new Error('Mem0 seed did not become retrievable')
  await new Promise(resolve => setTimeout(resolve, 1000))
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-memory-acp-'))
const config = defaultConfig({ instance: 'memory-verification' })
config.storage.dir = dir
config.storage.stateFile = undefined
config.storage.memoryFile = path.join(dir, 'memory.json')
config.memory = { enabled: true, mem0: { url: root, tokenFile }, personaFile: path.resolve('AGENTS.md') }
const replies = []
let recalledInPrompt = false
class ProbeBridge extends WeChatAcpBridge {
  async sendTextSegment(_user, _token, text) { replies.push(text); return true }
}
const bridge = new ProbeBridge(config, () => {})
const manager = new SessionManager({
  agentCommand: '/Users/markus/.kimi-code/bin/kimi', agentArgs: ['acp'], agentCwd: process.cwd(),
  maxConcurrentUsers: 1, idleTimeoutMs: 0, startupTimeoutMs: 30000, foregroundWaitMs: 60000, grantDeadlineMs: 90000,
  showThoughts: false, showDiffs: false,
  preparePrompt: async (id, prompt) => {
    const prepared = await bridge.enrichPromptWithMemory(id, prompt)
    recalledInPrompt = prepared.some(block => block.type === 'text' && /Mem0 retrieved user memories/.test(block.text) && /小柚/.test(block.text))
    return prepared
  },
  onReply: (...args) => bridge.sendAgentReply(...args), sendTyping: async () => {}, log: () => {},
})
try {
  await manager.enqueueAndWait(user, { contextToken: 'synthetic-only', replyGeneration: 0, prompt: [{ type: 'text', text: '仅根据已检索的记忆，告诉我希望你怎么称呼我。只回答称呼，不调用工具，不读写任何项目文件，不发送外部消息。' }] })
  assert.equal(recalledInPrompt, true, 'Mem0 memory must be injected into real Kimi prompt')
  assert.match(replies.join(''), /小柚/)
  const archive = path.join(dir, 'conversation-archive', `${user_id}.jsonl`)
  const turns = (await fs.readFile(archive, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(turns.some(turn => turn.role === 'user' && /仅根据已检索/.test(turn.text)))
  assert.ok(turns.some(turn => turn.role === 'assistant' && /小柚/.test(turn.text)))
  console.log(JSON.stringify({ type: 'RealKimiBridgeMemoryVerification', mem0Injected: true, kimiRecalledCorrectly: true, rawArchiveCreated: true, realWeChatMessagesSent: 0 }))
} finally {
  await manager.stop()
  await bridge.stop()
  await fs.rm(dir, { recursive: true, force: true })
}
