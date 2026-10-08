/**
 * /消息 "验收中" display derivation (P3 / Wave 2.4).
 *
 * All fixtures are synthetic and in-process: a fake loopback control-plane HTTP
 * server (or a deliberately unreachable/non-loopback URL) plus a temp-dir
 * MessageInbox. No real WeChat, no real control-plane service, no network egress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig, type WeChatAcpConfig } from '../src/config.js';
import type { MessageInbox, MessageInboxStatus } from '../src/storage/message-inbox.js';
import { MessageType, type WeixinMessage } from '../src/weixin/types.js';

/** Test bridge that captures every reply segment at the network boundary. */
class ProbeBridge extends WeChatAcpBridge {
  readonly sent: string[] = [];

  protected override async sendTextSegment(
    _userId: string,
    _contextToken: string,
    segment: string,
  ): Promise<boolean> {
    this.sent.push(segment);
    return true;
  }
}

function makeConfig(dir: string): WeChatAcpConfig {
  const config = defaultConfig();
  config.storage.dir = dir;
  config.storage.stateFile = undefined;
  config.memory = { enabled: false };
  // inbound.enabled gives the bridge a real MessageInbox but no ReplyOutbox, so
  // /消息 replies are delivered straight through the captured send boundary.
  config.inbound = { enabled: true, dir: path.join(dir, 'incoming-receipts') };
  config.recovery = undefined;
  config.controlPlaneUrl = undefined;
  return config;
}

function userMessage(id: number): WeixinMessage {
  return {
    message_id: id,
    from_user_id: 'user-review',
    to_user_id: 'bot',
    message_type: MessageType.USER,
    context_token: 'ctx-review',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  };
}

function slashMessage(): WeixinMessage {
  return {
    message_id: 9001,
    from_user_id: 'user-review',
    to_user_id: 'bot',
    message_type: MessageType.USER,
    context_token: 'ctx-review',
    item_list: [{ type: 1, text_item: { text: '/消息' } }],
  };
}

interface FakeTask { id: string; sourceRequestId: string; status: string; goal: string }

/** In-process fake control-plane: GET /api/control-plane/tasks?sourceRequestId=… */
async function startFakeControlPlane(
  tasksBySource: Record<string, FakeTask[]>,
  opts: { delayMs?: number } = {},
): Promise<{ server: http.Server; hits: string[]; url: string }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sourceRequestId = url.searchParams.get('sourceRequestId') ?? '';
    hits.push(sourceRequestId);
    const respond = () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tasks: tasksBySource[sourceRequestId] ?? [] }));
    };
    if (opts.delayMs) setTimeout(respond, opts.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, hits, url: `http://127.0.0.1:${port}` };
}

async function seed(inbox: MessageInbox, id: number, status: MessageInboxStatus, groupIds?: string[]): Promise<string> {
  const { record } = await inbox.put(userMessage(id));
  await inbox.setStatus(record.id, status);
  if (groupIds) await inbox.checkpoint(record.id, { groupIds });
  return record.id;
}

/** Invoke the private /消息 handler directly (display layer) and return the reply. */
async function renderMessage(bridge: ProbeBridge): Promise<string> {
  await (bridge as unknown as {
    handleUserMessage: (m: WeixinMessage, u: string, c: string, g: number) => Promise<void>;
  }).handleUserMessage(slashMessage(), 'user-review', 'ctx-review', 0);
  return bridge.sent.join('\n');
}

test('/消息 shows 验收中 for verifying and reviewing linked tasks, and not for completed', async (t) => {
  for (const [scenario, status, expectReviewing] of [
    ['verifying', 'verifying', true],
    ['reviewing', 'reviewing', true],
    ['completed', 'completed', false],
  ] as const) {
    await t.test(scenario, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
      const config = makeConfig(dir);
      const bridge = new ProbeBridge(config);
      const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
      const id = await seed(inbox, 101, 'running');
      const fake = await startFakeControlPlane({ [id]: [{ id: 'task_x', sourceRequestId: id, status, goal: 'g' }] });
      config.controlPlaneUrl = fake.url;
      try {
        const text = await renderMessage(bridge);
        assert.equal(text.includes('任务验收中'), expectReviewing, `scenario=${scenario} reply=${text}`);
        assert.equal(fake.hits.length, 1, 'exactly one query for the single displayed receipt');
        assert.equal(fake.hits[0], id, 'queried by the receipt id as sourceRequestId');
      } finally {
        await bridge.stop().catch(() => {});
        await new Promise<void>((resolve) => fake.server.close(() => resolve()));
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('/消息 keeps the original label when no linked task exists', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  await seed(inbox, 102, 'running');
  const fake = await startFakeControlPlane({});
  config.controlPlaneUrl = fake.url;
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = await renderMessage(bridge);
  assert.equal(fake.hits.length, 1, 'query still runs, no task returned');
  assert.equal(text.includes('任务验收中'), false, `reply=${text}`);
  assert.match(text, /处理中/, 'the original running label is preserved');
});

test('/消息 never fabricates 验收中 when the control plane is unreachable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  await seed(inbox, 103, 'running');
  // Start then close a server so the URL points at a dead loopback port.
  const dead = await startFakeControlPlane({});
  const deadUrl = dead.url;
  await new Promise<void>((resolve) => dead.server.close(() => resolve()));
  config.controlPlaneUrl = deadUrl;
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = await renderMessage(bridge);
  assert.equal(text.includes('任务验收中'), false, `reply=${text}`);
  assert.match(text, /处理中/);
});

test('/消息 never fabricates 验收中 on a slow (timed-out) control plane', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  const id = await seed(inbox, 104, 'running');
  const fake = await startFakeControlPlane({ [id]: [{ id: 'task_x', sourceRequestId: id, status: 'verifying', goal: 'g' }] }, { delayMs: 5_000 });
  config.controlPlaneUrl = fake.url;
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = await renderMessage(bridge);
  assert.equal(text.includes('任务验收中'), false, 'a task that never answers within the 3s budget is not asserted as verifying');
  assert.match(text, /处理中/);
});

test('/消息 never queries a non-loopback control plane', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  await seed(inbox, 105, 'running');
  config.controlPlaneUrl = 'http://example.invalid:4324';
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = await renderMessage(bridge);
  assert.equal(text.includes('任务验收中'), false, `reply=${text}`);
  assert.match(text, /处理中/);
});

test('/消息 does nothing extra when no control plane is configured', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  await seed(inbox, 106, 'running');
  const fake = await startFakeControlPlane({});
  config.controlPlaneUrl = undefined;
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = await renderMessage(bridge);
  assert.equal(fake.hits.length, 0, 'no control plane configured means no query at all');
  assert.equal(text.includes('任务验收中'), false);
});

test('/消息 deduplicates sourceRequestId queries across displayed receipts', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reviewing-'));
  const config = makeConfig(dir);
  const bridge = new ProbeBridge(config);
  const inbox = (bridge as unknown as { messageInbox: MessageInbox }).messageInbox;
  const primary = await seed(inbox, 107, 'running');
  // A second receipt shares the primary's sourceRequestId via execution.groupIds.
  const secondary = await seed(inbox, 108, 'running');
  await inbox.checkpoint(secondary, { groupIds: [primary, secondary] });
  const fake = await startFakeControlPlane({ [primary]: [{ id: 'task_x', sourceRequestId: primary, status: 'reviewing', goal: 'g' }] });
  config.controlPlaneUrl = fake.url;
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const text = await renderMessage(bridge);
  assert.equal(fake.hits.length, 1, 'both receipts resolve to the same sourceRequestId and are queried once');
  assert.equal(fake.hits[0], primary);
  assert.equal(text.split('任务验收中').length - 1, 2, `both receipt lines show 验收中: ${text}`);
});
