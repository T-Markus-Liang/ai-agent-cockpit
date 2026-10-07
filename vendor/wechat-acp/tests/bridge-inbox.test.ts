import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig } from '../src/config.js';
import { MessageInbox } from '../src/storage/message-inbox.js';
import type { PendingMessage } from '../src/acp/session.js';

class ProbeBridge extends WeChatAcpBridge {
  replies: string[] = [];
  protected override async sendTextSegment(_user: string, _token: string, text: string) { this.replies.push(text); return true; }
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-inbox-'));
  const config = defaultConfig(); config.storage.dir = dir; config.storage.stateFile = undefined;
  config.inbound = { enabled: true, dir: path.join(dir, 'receipts'), acknowledgeVoice: true };
  const bridge = new ProbeBridge(config, () => {});
  const enqueued: PendingMessage[] = [];
  const fake = { enqueue: async (_user: string, message: PendingMessage) => { enqueued.push(message); }, getSession: () => undefined, stop: async () => {} };
  (bridge as unknown as { sessionManager: unknown }).sessionManager = fake;
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, bridge, enqueued, config };
}
const voice = (id = 1, text = '合成语音内容') => ({ message_type: 1, message_id: id, from_user_id: 'synthetic', to_user_id: 'synthetic-bot', context_token: `context-${id}`, item_list: [{ type: 3, voice_item: { text } }] });

test('voice is fully durable before enqueue, and duplicate delivery is suppressed', async t => {
  const ctx = await setup(t);
  await ctx.bridge.handleMessage(voice()); await ctx.bridge.handleMessage(voice());
  assert.equal(ctx.enqueued.length, 1); assert.equal(ctx.enqueued[0]!.receiptIds?.length, 1);
  const inbox = new MessageInbox({ dir: ctx.config.inbound!.dir! });
  const records = await inbox.list(); assert.equal(records.length, 1); assert.equal(records[0]!.message.item_list![0]!.voice_item!.text, '合成语音内容'); assert.equal(records[0]!.status, 'queued');
  assert.ok(ctx.bridge.replies.some(text => /保存/.test(text)));
  ctx.enqueued[0]!.completion!.resolve();
  await (ctx.bridge as unknown as { messageInbox: MessageInbox }).messageInbox.list();
  assert.equal((await inbox.list())[0]!.status, 'done'); await inbox.close();
});
test('untranscribed voice is explained and retained, never sent as an empty task', async t => {
  const ctx = await setup(t); await ctx.bridge.handleMessage(voice(2, ''));
  assert.equal(ctx.enqueued.length, 0); assert.ok(ctx.bridge.replies.some(text => /没有转写/.test(text)));
  const inbox = new MessageInbox({ dir: ctx.config.inbound!.dir! }); assert.equal((await inbox.list())[0]!.status, 'failed'); await inbox.close();
});
test('whitespace-only voice transcription is not dispatched as a task', async t => {
  const ctx = await setup(t); await ctx.bridge.handleMessage(voice(6, ' \n\t'));
  assert.equal(ctx.enqueued.length, 0);
  assert.ok(ctx.bridge.replies.some(text => /没有转写/.test(text)));
});
test('restart recovers only unstarted messages, never an uncertain active request', async t => {
  const ctx = await setup(t), inbox = new MessageInbox({ dir: ctx.config.inbound!.dir! });
  await inbox.put(voice(3)); const active = await inbox.put(voice(4)); await inbox.setStatus(active.record.id, 'running');
  await (ctx.bridge as unknown as { recoverIncoming: () => Promise<void> }).recoverIncoming();
  assert.equal(ctx.enqueued.length, 1); assert.equal((ctx.enqueued[0]!.prompt[0] as { text: string }).text, '合成语音内容');
  assert.equal((await inbox.list()).find(item => item.id === active.record.id)!.status, 'uncertain'); await inbox.close();
});
test('transcribed voice slash command stays on the native control path', async t => {
  const ctx = await setup(t); await ctx.bridge.handleMessage(voice(5, '/消息'));
  assert.equal(ctx.enqueued.length, 0); assert.ok(ctx.bridge.replies.some(text => /处理中/.test(text)));
});
