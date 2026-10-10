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
  readonly sentSegments: Array<{ userId: string; contextToken: string; text: string }> = [];

  protected override async sendTextSegment(
    userId: string,
    contextToken: string,
    segment: string,
    _isCurrent: () => boolean = () => true,
    _persistentClientId?: string,
  ): Promise<boolean> {
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
    enqueue: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); },
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

test('a foreground expiry marks receipts background and sends exactly one durable notice', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-background-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const manager = fakeManager();
  (bridge as any).sessionManager = manager;

  t.after(async () => {
    await bridge.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  const inbox = (bridge as any).messageInbox as MessageInbox;
  const { record } = await inbox.put(userMessage(701));
  await inbox.setStatus(record.id, 'running');
  await inbox.checkpoint(record.id, { phase: 'dispatched' });

  const pending = { contextToken: 'ctx-recovery', receiptIds: [record.id], replyGeneration: 0 };
  await (bridge as any).handleTurnBackground('user-recovery', pending);

  const latest = (await inbox.list()).find((row) => row.id === record.id);
  assert.equal(latest?.status, 'background', 'the foreground expiry must mark the receipt background');
  assert.equal(manager.calls.length, 0, 'marking a turn background must never re-enqueue work');

  await waitFor('background notice delivered', async () => bridge.sentSegments.some((segment) => segment.text.includes('后台执行')));

  // A repeated background event for the same turn must not deliver a second notice.
  await (bridge as any).handleTurnBackground('user-recovery', pending);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(bridge.sentSegments.filter((segment) => segment.text.includes('后台执行')).length, 1, 'the background notice must be delivered at most once per turn');

  // Durability: the notice is persisted in the outbox with a per-turn dedupe key.
  const outbox = (bridge as any).replyOutbox as ReplyOutbox;
  const notices = (await outbox.list()).filter((row) => row.kind === 'notice' && row.receiptIds.includes(record.id));
  assert.equal(notices.length, 1, 'exactly one durable background notice');
});

test('a background receipt that never completed recovers as uncertain and is never replayed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-background-'));
  const config = makeConfig(dir);

  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(userMessage(702));
  await seedInbox.setStatus(record.id, 'running');
  await seedInbox.checkpoint(record.id, { phase: 'dispatched' });
  await seedInbox.setStatus(record.id, 'background');
  await seedInbox.close();
  await ((seed as any).replyOutbox as ReplyOutbox).close();

  const bridge = new ProbeBridge(config);
  const manager = fakeManager();
  (bridge as any).sessionManager = manager;

  t.after(async () => {
    await bridge.stop().catch(() => {});
    await seed.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  await ((bridge as any).replyOutbox as ReplyOutbox).recover();
  await (bridge as any).recoverIncoming();
  await (bridge as any).runRecoverySweep();

  const inbox = (bridge as any).messageInbox as MessageInbox;
  await waitFor('background receipt to be retained as uncertain', async () =>
    (await inbox.list()).some((row) => row.id === record.id && row.status === 'uncertain'));
  assert.equal(manager.calls.length, 0, 'background work must never be replayed after a restart');

  // Durability: a fresh reader also sees the retained receipt.
  const freshInbox = new MessageInbox({ dir: path.join(dir, 'incoming-receipts') });
  const durable = (await freshInbox.list()).find((row) => row.id === record.id);
  await freshInbox.close();
  assert.equal(durable?.status, 'uncertain');
});
