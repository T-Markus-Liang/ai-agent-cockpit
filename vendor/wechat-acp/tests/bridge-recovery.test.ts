import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig, type WeChatAcpConfig } from '../src/config.js';
import { MessageInbox } from '../src/storage/message-inbox.js';
import { ReplyOutbox } from '../src/storage/reply-outbox.js';
import { MessageType, type WeixinMessage } from '../src/weixin/types.js';

/** Test bridge that intercepts the network send boundary and records segments. */
class ProbeBridge extends WeChatAcpBridge {
  networkUp = true;
  readonly clientIds: Array<string | undefined> = [];
  readonly sentSegments: Array<{ userId: string; contextToken: string; text: string }> = [];

  protected override async sendTextSegment(
    userId: string,
    contextToken: string,
    segment: string,
    _isCurrent: () => boolean = () => true,
    _persistentClientId?: string,
  ): Promise<boolean> {
    this.clientIds.push(_persistentClientId);
    if (!this.networkUp) return false;
    this.sentSegments.push({ userId, contextToken, text: segment });
    return true;
  }
}

interface FakeManager {
  calls: unknown[][];
  enqueue: (...args: unknown[]) => Promise<void>;
  getSession: () => undefined;
  stop: () => Promise<void>;
}

function fakeManager(): FakeManager {
  const calls: unknown[][] = [];
  return {
    calls,
    enqueue: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve();
    },
    getSession: () => undefined,
    stop: async () => {},
  };
}

function makeConfig(tmpDir: string): WeChatAcpConfig {
  const config = defaultConfig();
  config.storage.dir = tmpDir;
  config.storage.stateFile = undefined;
  config.inbound = { enabled: true, dir: path.join(tmpDir, 'incoming-receipts') };
  config.recovery = { enabled: true, sweepMs: 60_000 };
  config.memory = { enabled: false };
  config.session.resume = 'off';
  // No control-plane: reconcileLinkedTask must fail closed offline.
  config.controlPlaneUrl = undefined;
  return config;
}

function userMessage(id: number): WeixinMessage {
  return {
    message_id: id,
    from_user_id: 'user-recovery',
    to_user_id: 'bot-account',
    message_type: MessageType.USER,
    context_token: 'ctx-recovery',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  };
}

async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('completed result_ready is recovered and delivered exactly once without replay', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-recovery-'));
  const config = makeConfig(tmpDir);

  // Seed a completed ACP turn that was journaled before the crash.
  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(userMessage(101));
  await seedInbox.setStatus(record.id, 'running');
  await seedInbox.checkpoint(record.id, {
    phase: 'result_ready',
    resultText: 'recovered answer text',
    stopReason: 'end_turn',
  });
  await seedInbox.close();
  await ((seed as any).replyOutbox as ReplyOutbox).close();

  // Restart: same private temp dir.
  const bridge = new ProbeBridge(config);
  const manager = fakeManager();
  (bridge as any).sessionManager = manager;
  const outbox = (bridge as any).replyOutbox as ReplyOutbox;

  t.after(async () => {
    await bridge.stop().catch(() => {});
    await seed.stop().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await outbox.recover();
  await (bridge as any).recoverIncoming();
  await (bridge as any).runRecoverySweep();

  const inbox = (bridge as any).messageInbox as MessageInbox;
  await waitFor('recovered receipt to reach done', async () =>
    (await inbox.list()).some((row) => row.id === record.id && row.status === 'done'));

  const delivered = bridge.sentSegments.filter((segment) => segment.text.includes('recovered answer text'));
  assert.equal(delivered.length, 1, 'recovered text must be delivered exactly once');
  assert.equal(manager.calls.length, 0, 'a completed result must never be replayed through enqueue');
});

test('dispatched tool activity becomes uncertain, is not replayed, and queues a durable review notice', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-recovery-'));
  const config = makeConfig(tmpDir);

  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(userMessage(202));
  await seedInbox.setStatus(record.id, 'running');
  await seedInbox.checkpoint(record.id, { phase: 'tool_activity', usedTools: true });
  await seedInbox.close();
  await ((seed as any).replyOutbox as ReplyOutbox).close();

  const bridge = new ProbeBridge(config);
  const manager = fakeManager();
  (bridge as any).sessionManager = manager;
  const outbox = (bridge as any).replyOutbox as ReplyOutbox;

  t.after(async () => {
    await bridge.stop().catch(() => {});
    await seed.stop().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await outbox.recover();
  await (bridge as any).recoverIncoming();
  await (bridge as any).runRecoverySweep();

  const inbox = (bridge as any).messageInbox as MessageInbox;
  await waitFor('durable needs-review notice to be queued', async () =>
    (await outbox.list()).some((row) => row.kind === 'notice' && row.receiptIds.includes(record.id)));

  const latest = (await inbox.list()).find((row) => row.id === record.id);
  assert.ok(latest, 'receipt must be retained');
  assert.equal(latest!.status, 'uncertain', 'dispatched tool activity must not be auto-replayed');
  assert.equal(manager.calls.length, 0, 'uncertain work must not be re-enqueued');

  // Durability: fresh readers see both the retained record and the notice on disk.
  const freshInbox = new MessageInbox({ dir: path.join(tmpDir, 'incoming-receipts') });
  const durable = (await freshInbox.list()).find((row) => row.id === record.id);
  await freshInbox.close();
  assert.equal(durable?.status, 'uncertain');
  assert.equal(durable?.execution?.noticeQueued, true);

  const freshOutbox = new ReplyOutbox({ dir: path.join(tmpDir, 'reply-outbox') });
  const notices = (await freshOutbox.list()).filter((row) => row.kind === 'notice' && row.receiptIds.includes(record.id));
  await freshOutbox.close();
  assert.ok(notices.length >= 1, 'needs-review notice must survive a restart');
});

test('failed delivery survives restart and automatically retries the same client id without task replay', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-delivery-'));
  const config = makeConfig(dir), first = new ProbeBridge(config), manager = fakeManager();
  (first as any).sessionManager = manager; first.networkUp = false;
  t.after(async () => { await first.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  await first.handleMessage(userMessage(301));
  const pending = manager.calls[0]![1] as any, inbox = (first as any).messageInbox as MessageInbox;
  const id = pending.receiptIds[0];
  await inbox.checkpoint(id, { phase: 'result_ready', resultText: 'saved final answer', stopReason: 'end_turn' });
  await (first as any).sendAgentReply('user-recovery', 'ctx-recovery', 'saved final answer', 0, () => true, { receiptIds: [id], dedupeKey: `${id}:reply` });
  pending.completion.resolve();
  await waitFor('pending delivery', async () => (await inbox.list())[0]?.status === 'reply_pending');
  await Promise.allSettled([...(first as any).outboxDrains.values()]);
  const saved = (await ((first as any).replyOutbox as ReplyOutbox).list())[0]!;
  assert.equal(saved.status, 'pending'); await first.stop();
  const resumed = new ProbeBridge(config), resumedManager = fakeManager(); (resumed as any).sessionManager = resumedManager;
  t.after(() => resumed.stop());
  (resumed as any).replyOutbox.now = () => Date.now() + 300000;
  await (resumed as any).replyOutbox.recover(); await (resumed as any).recoverIncoming(); await (resumed as any).runRecoverySweep();
  await waitFor('automatic delivered receipt', async () => (await (resumed as any).messageInbox.list())[0]?.status === 'done');
  assert.equal(resumedManager.calls.length, 0);
  assert.equal(resumed.clientIds[0], saved.clientId);
  assert.equal(resumed.sentSegments.filter(row => row.text === 'saved final answer').length, 1);
});

test('pre-dispatch admission failures automatically retry but obey a bounded failure budget', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-admission-')), config = makeConfig(dir);
  config.recovery = { enabled: true, baseDelayMs: 1, maxAttempts: 3 };
  const bridge = new ProbeBridge(config), manager = fakeManager(); (bridge as any).sessionManager = manager;
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  let calls = 0;
  manager.enqueue = async (...args) => { manager.calls.push(args); calls++; throw new Error('synthetic admission failure'); };
  await assert.rejects(bridge.handleMessage(userMessage(302)));
  const inbox = (bridge as any).messageInbox as MessageInbox;
  assert.equal((await inbox.list())[0]?.status, 'retry_wait');
  for (let count = 0; count < 2; count++) {
    await waitFor('retry due', async () => ((await inbox.list())[0]?.execution?.retryAt ?? 0) <= Date.now());
    await (bridge as any).runRecoverySweep();
  }
  assert.equal(calls, 3); assert.equal((await inbox.list())[0]?.status, 'failed');
  await (bridge as any).runRecoverySweep(); assert.equal(calls, 3);
});

test('a live old process prevents overlap and resumes only after exit is confirmed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-owner-')), config = makeConfig(dir), bridge = new ProbeBridge(config), manager = fakeManager();
  (bridge as any).sessionManager = manager;
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const inbox = (bridge as any).messageInbox as MessageInbox, { record } = await inbox.put(userMessage(303));
  await inbox.checkpoint(record.id, { phase: 'preparing', processId: process.pid, deadlineAt: Date.now() + 60_000 }, true);
  await (bridge as any).recoverIncoming(); await (bridge as any).runRecoverySweep();
  assert.equal(manager.calls.length, 0); assert.equal((await inbox.list())[0]?.status, 'queued');
  await inbox.checkpoint(record.id, { processId: 999999 });
  await (bridge as any).runRecoverySweep(); assert.equal(manager.calls.length, 1);
});

test('explicit reset stops replay and cancels durable pending deliveries, including uncertain work', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-cancel-')), config = makeConfig(dir), bridge = new ProbeBridge(config), manager = fakeManager();
  (bridge as any).sessionManager = manager; bridge.networkUp = false;
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const inbox = (bridge as any).messageInbox as MessageInbox, { record } = await inbox.put(userMessage(304));
  await inbox.setStatus(record.id, 'uncertain');
  const outbox = (bridge as any).replyOutbox as ReplyOutbox;
  await outbox.put({ userId: 'user-recovery', contextToken: 'ctx-recovery', text: 'old reply', receiptIds: [record.id] });
  await inbox.cancelForUser('user-recovery'); await outbox.cancelForUser('user-recovery');
  bridge.networkUp = true; await (bridge as any).runRecoverySweep();
  assert.equal((await inbox.list())[0]?.status, 'cancelled'); assert.equal((await outbox.list())[0]?.status, 'cancelled');
  assert.equal(manager.calls.length, 0); assert.equal(bridge.sentSegments.length, 0);
});
