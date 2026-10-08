#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { WeChatAcpBridge } from '../vendor/wechat-acp/dist/src/bridge.js'
import { SessionManager } from '../vendor/wechat-acp/dist/src/acp/session.js'
import { defaultConfig } from '../vendor/wechat-acp/dist/src/config.js'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-voice-live-'))
const config = defaultConfig({ instance: 'isolated-voice-verification' })
config.storage.dir = dir; config.storage.stateFile = undefined; config.storage.memoryFile = path.join(dir, 'memory.json')
config.memory = { enabled: true }
config.inbound = { enabled: true, dir: path.join(dir, 'receipts'), acknowledgeVoice: true }
config.recovery = { enabled: true }
const user = `voice-verification-${crypto.randomUUID()}`
class ProbeBridge extends WeChatAcpBridge {
  replies = []
  failAnswerDelivery = false
  async sendTextSegment(_user, _context, text) {
    if (this.failAnswerDelivery && /语音链路测试成功/.test(text)) return false
    this.replies.push(text); return true
  }
}
const bridge = new ProbeBridge(config, () => {})
bridge.failAnswerDelivery = true
const manager = new SessionManager({ agentCommand: '/Users/markus/.kimi-code/bin/kimi', agentArgs: ['acp'], agentCwd: dir,
  maxConcurrentUsers: 1, idleTimeoutMs: 0, foregroundWaitMs: 60000, grantDeadlineMs: 120000, startupTimeoutMs: 30000, showThoughts: false, log: () => {}, sendTyping: async () => {},
  preparePrompt: async (id, prompt, pending) => { await bridge.setReceiptStatus(pending?.receiptIds ?? [], 'running'); return bridge.enrichPromptWithMemory(id, prompt) },
  onTurnEvent: async (_id, pending, event) => { for (const id of pending.receiptIds ?? []) await bridge.messageInbox.checkpoint(id, { ...event, ...(event.phase === 'tool_activity' ? { usedTools: true } : {}) }, event.phase === 'preparing') },
  onReply: (...args) => bridge.sendAgentReply(...args), onNotice: (...args) => bridge.sendAgentReply(...args), progressNoticeMs: 5000 })
bridge.sessionManager = manager
try {
  await bridge.handleMessage({ message_type: 1, message_id: 991, from_user_id: user, to_user_id: 'synthetic-bot', context_token: 'synthetic-only',
    item_list: [{ type: 3, voice_item: { text: '这是隔离的语音转写测试。只回答“语音链路测试成功”，不调用工具，不启动子任务，不读写任何文件，不发外部消息。' } }] })
  let record
  for (let i = 0; i < 120; i++) {
    record = (await bridge.messageInbox.list())[0]
    if (['reply_pending', 'done', 'failed', 'uncertain'].includes(record?.status)) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.equal(record?.status, 'reply_pending', `voice receipt ended as ${record?.status}`)
  assert.ok(bridge.replies.some(text => /语音已转成文字并保存/.test(text)))
  assert.ok(record.message.item_list[0].voice_item.text.length > 30)
  assert.equal(record.execution.phase, 'result_ready')
  await bridge.stop()
  const resumed = new ProbeBridge(config, () => {})
  let reexecutions = 0
  resumed.sessionManager = { getSession: () => undefined, enqueue: async () => { reexecutions++ }, stop: async () => {} }
  try {
    resumed.replyOutbox.now = () => Date.now() + 300000
    await resumed.replyOutbox.recover(); await resumed.recoverIncoming(); await resumed.runRecoverySweep()
    for (let i = 0; i < 200 && (await resumed.messageInbox.list())[0].status !== 'done'; i++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal((await resumed.messageInbox.list())[0].status, 'done')
    assert.ok(resumed.replies.some(text => /语音链路测试成功/.test(text))); assert.equal(reexecutions, 0)
  } finally { await resumed.stop() }
  console.log(JSON.stringify({ type: 'RealKimiVoiceReceiptVerification', actualKimiACP: true, fullVoiceTextDurable: true, firstAcknowledgment: true,
    completedReceipt: true, failedDeliverySurvivesRestart: true, taskReexecutionsAfterRestart: 0, realWeChatMessagesSent: 0 }))
} finally { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }) }
