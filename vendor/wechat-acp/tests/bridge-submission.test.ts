import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig, type WeChatAcpConfig } from '../src/config.js';
import { MessageInbox } from '../src/storage/message-inbox.js';
import { SubmissionRegistry, computePayloadDigest } from '../src/storage/submission-registry.js';
import { MessageType, type WeixinMessage } from '../src/weixin/types.js';

/** Test bridge that intercepts the network send boundary. */
class ProbeBridge extends WeChatAcpBridge {
  protected override async sendTextSegment(): Promise<boolean> {
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

const userMessage = (id: number, text = 'hello'): WeixinMessage => ({
  message_id: id,
  from_user_id: 'user-submission',
  to_user_id: 'bot-account',
  message_type: MessageType.USER,
  context_token: `ctx-${id}`,
  item_list: [{ type: 1, text_item: { text } }],
});

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, tmpDir: string) {
  const config = makeConfig(tmpDir);
  const bridge = new ProbeBridge(config, () => {});
  const manager = fakeManager();
  (bridge as unknown as { sessionManager: unknown }).sessionManager = manager;
  const registry = (bridge as unknown as { submissionRegistry: SubmissionRegistry }).submissionRegistry;
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  t.after(async () => {
    await fs.chmod(path.join(tmpDir, 'submission-registry'), 0o700).catch(() => {});
    await bridge.stop().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return { config, bridge, manager, registry, inbox };
}

test('an admitted inbound message records the exact runtime submission', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-submission-'));
  const { bridge, inbox, registry } = await setup(t, tmpDir);

  await bridge.handleMessage(userMessage(11));

  const record = (await inbox.list())[0]!;
  const registration = await registry.getRegistration(record.id);
  assert.ok(registration, 'the receipt must be registered');
  assert.equal(registration!.receiptId, record.id);
  assert.equal(registration!.userId, 'user-submission');
  assert.equal(registration!.state, 'registered');
  assert.equal(registration!.payloadDigest, computePayloadDigest(record.message));
  assert.ok(Number.isFinite(registration!.registeredAt));
  assert.equal(await registry.count(), 1);
});

test('a replayed delivery is idempotent and never double-registers', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-submission-'));
  const { bridge, manager, registry } = await setup(t, tmpDir);

  await bridge.handleMessage(userMessage(21));
  await bridge.handleMessage(userMessage(21, 'hello')); // same server id -> duplicate delivery
  assert.equal(await registry.count(), 1, 'the replay must not create a second submission');
  assert.equal(manager.calls.length, 1, 'the replay must not be dispatched twice');
});

test('a poisoned registry fails admission and keeps the durable inbox record', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-submission-'));
  const { bridge, manager, registry, inbox } = await setup(t, tmpDir);

  // Force durable submission writes to fail; the next admission is refused.
  await registry.count(); // let the registry finish its own dir setup first
  await fs.chmod(path.join(tmpDir, 'submission-registry'), 0o500);
  // The registration write fails -> admission throws (never reported handled).
  await assert.rejects(bridge.handleMessage(userMessage(31)));

  // The message is durable in the inbox and was never dispatched.
  const records = await inbox.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, 'received');
  assert.equal(manager.calls.length, 0);
  // The registry is now poisoned: every API refuses fail-closed.
  await assert.rejects(() => registry.count(), (err: unknown) => {
    assert.equal((err as { code?: string })?.code, 'store-poisoned');
    return true;
  });
  await fs.chmod(path.join(tmpDir, 'submission-registry'), 0o700);
});

test('a registration survives a bridge restart (same dir)', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-submission-'));
  const first = await setup(t, tmpDir);
  await first.bridge.handleMessage(userMessage(41));
  const receiptId = (await first.inbox.list())[0]!.id;
  await first.bridge.stop();

  const second = new ProbeBridge(makeConfig(tmpDir), () => {});
  (second as unknown as { sessionManager: unknown }).sessionManager = fakeManager();
  const resumedRegistry = (second as unknown as { submissionRegistry: SubmissionRegistry }).submissionRegistry;
  assert.equal(await resumedRegistry.has(receiptId), true, 'the submission must persist across a restart');
  const restored = await resumedRegistry.getRegistration(receiptId);
  assert.equal(restored?.userId, 'user-submission');
  await second.stop();
});

test('startup reconciliation backfills an inbox receipt that has no registration', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-submission-'));
  const { bridge, registry } = await setup(t, tmpDir);

  // A receipt admitted outside this bridge (bypassing admitIncoming) has no submission.
  const seed = new MessageInbox({ dir: path.join(tmpDir, 'incoming-receipts') });
  const { record } = await seed.put(userMessage(51));
  await seed.close();
  assert.equal(await registry.count(), 0);

  await (bridge as unknown as { reconcileSubmissions: () => Promise<void> }).reconcileSubmissions();
  assert.equal(await registry.count(), 1);
  const registration = await registry.getRegistration(record.id);
  assert.equal(registration?.receiptId, record.id);
  assert.equal(registration?.userId, 'user-submission');
  assert.equal(registration?.payloadDigest, computePayloadDigest(record.message));

  // Idempotent: a second sweep backfills nothing new.
  await (bridge as unknown as { reconcileSubmissions: () => Promise<void> }).reconcileSubmissions();
  assert.equal(await registry.count(), 1);
});
