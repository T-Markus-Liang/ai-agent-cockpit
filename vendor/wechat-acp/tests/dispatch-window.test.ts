import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig, type WeChatAcpConfig } from '../src/config.js';
import { MessageInbox } from '../src/storage/message-inbox.js';
import { ReplyOutbox } from '../src/storage/reply-outbox.js';
import { MessageType, type WeixinMessage } from '../src/weixin/types.js';
import { SessionManager, type UserSession } from '../src/acp/session.js';

/**
 * B02 dispatch-window tests.
 *
 * The safety property under test: a durable state that maps back to a replayable
 * `queued` admission must never coexist with a prompt that may already have been
 * sent. `sent-unconfirmed` is journaled before the ACP prompt is issued, so any
 * crash from that point resolves to `uncertain` and is never re-dispatched.
 */

/** A pid that cannot be alive on this host (macOS pid_max is 99999). */
const DEAD_PID = 999999;

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
    from_user_id: 'user-dispatch',
    to_user_id: 'bot-account',
    message_type: MessageType.USER,
    context_token: 'ctx-dispatch',
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

// --------------------------------------------------------------------------
// Inbox-level invariant: sent-unconfirmed is never replayable.
// --------------------------------------------------------------------------

test('recover maps a sent-unconfirmed receipt to uncertain and scheduleRetry refuses it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-window-inbox-'));
  try {
    const first = new MessageInbox({ dir });
    const { record } = await first.put(userMessage(901));
    await first.setStatus(record.id, 'running');
    await first.checkpoint(record.id, { phase: 'sent-unconfirmed', processId: DEAD_PID, groupIds: [record.id] });
    await first.close();

    const reopened = new MessageInbox({ dir });
    // A receipt whose prompt may already be in flight must never be auto-retried.
    assert.equal(
      await reopened.scheduleRetry(record.id, { maxAttempts: 3, delayMs: 1, errorKind: 'synthetic' }),
      false,
      'scheduleRetry must refuse a sent-unconfirmed receipt',
    );
    assert.equal((await reopened.list())[0]?.status, 'running', 'a refused retry must not change the status');

    const result = await reopened.recover();
    assert.equal(result.pending.length, 0, 'sent-unconfirmed must never be returned as pending');
    assert.equal(result.uncertainCount, 1);
    const latest = (await reopened.list())[0];
    assert.equal(latest?.status, 'uncertain');
    assert.equal(latest?.execution?.phase, 'sent-unconfirmed');
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a receipt still in preparing is the only crash state that recovers as replayable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-window-inbox-'));
  try {
    const first = new MessageInbox({ dir });
    const { record } = await first.put(userMessage(902));
    await first.checkpoint(record.id, { phase: 'preparing', processId: DEAD_PID, groupIds: [record.id] }, true);
    await first.close();

    const reopened = new MessageInbox({ dir });
    const result = await reopened.recover();
    assert.deepEqual(result.pending.map((row) => row.id), [record.id], 'a pre-dispatch crash stays replayable');
    assert.equal(result.uncertainCount, 0);
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Crash matrix at the bridge boundary.
// --------------------------------------------------------------------------

test('crash while still preparing: re-admitted exactly once (safe replay)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-window-bridge-'));
  const config = makeConfig(dir);

  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(userMessage(801));
  await seedInbox.checkpoint(record.id, { phase: 'preparing', processId: DEAD_PID, groupIds: [record.id] }, true);
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

  await (bridge as any).recoverIncoming();

  const inbox = (bridge as any).messageInbox as MessageInbox;
  const latest = (await inbox.list()).find((row) => row.id === record.id);
  assert.equal(latest?.status, 'queued', 'a pre-dispatch crash is admitted for replay');
  assert.equal(manager.calls.length, 1, 'it must be re-enqueued exactly once');
});

test('crash after sent-unconfirmed but before the send: uncertain, never replayed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-window-bridge-'));
  const config = makeConfig(dir);

  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(userMessage(802));
  await seedInbox.setStatus(record.id, 'running');
  await seedInbox.checkpoint(record.id, { phase: 'sent-unconfirmed', processId: DEAD_PID, groupIds: [record.id] });
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

  const outbox = (bridge as any).replyOutbox as ReplyOutbox;
  await outbox.recover();
  await (bridge as any).recoverIncoming();
  await (bridge as any).runRecoverySweep();

  const inbox = (bridge as any).messageInbox as MessageInbox;
  await waitFor('receipt retained as uncertain', async () =>
    (await inbox.list()).some((row) => row.id === record.id && row.status === 'uncertain'));
  assert.equal(manager.calls.length, 0, 'sent-unconfirmed work must never be re-enqueued');

  await waitFor('durable needs-review notice', async () =>
    (await outbox.list()).some((row) => row.kind === 'notice' && row.receiptIds.includes(record.id)));

  // Durability: a fresh reader also sees the retained receipt.
  const freshInbox = new MessageInbox({ dir: path.join(dir, 'incoming-receipts') });
  const durable = (await freshInbox.list()).find((row) => row.id === record.id);
  await freshInbox.close();
  assert.equal(durable?.status, 'uncertain');
});

test('crash after the send was issued: dispatched journals uncertain, never replayed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-window-bridge-'));
  const config = makeConfig(dir);

  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(userMessage(803));
  await seedInbox.setStatus(record.id, 'running');
  await seedInbox.checkpoint(record.id, { phase: 'dispatched', processId: DEAD_PID, groupIds: [record.id] });
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
  await waitFor('receipt retained as uncertain', async () =>
    (await inbox.list()).some((row) => row.id === record.id && row.status === 'uncertain'));
  assert.equal(manager.calls.length, 0, 'a dispatched turn must never be replayed after a restart');
});

// --------------------------------------------------------------------------
// Session main-loop ordering and pre-send write failure.
// --------------------------------------------------------------------------

/** Minimal fake ACP session with a controllable prompt and cancel. */
function makeAcpSession(
  id: string,
  prompt: () => Promise<{ stopReason: string }>,
  cancel: () => Promise<void> = async () => {},
): UserSession {
  const child = new EventEmitter();
  Object.assign(child, { killed: false, exitCode: null, signalCode: null });
  return {
    userId: 'synthetic',
    contextToken: 'latest',
    client: { beginTurn: async () => {}, flush: async () => 'reply', hasProducedMessage: true, hasUsedTools: false } as never,
    agentInfo: { process: child as never, connection: { closed: new Promise(() => {}), prompt, cancel } as never, sessionId: id, configOptions: [], sessionOutcome: 'new' },
    configOptions: [], queue: [], processing: false, createdAt: Date.now(), lastActivity: Date.now(), lifecycleGeneration: 0,
  };
}

function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms); })])
    .finally(() => clearTimeout(timer));
}

test('the normal turn journals preparing -> sent-unconfirmed -> dispatched -> result_ready', async () => {
  const events: string[] = [];
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 1000, grantDeadlineMs: 5000, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {}, onReply: async () => {},
    onTurnEvent: async (_id, _pending, event) => { events.push(event.phase); },
  });
  const session = makeAcpSession('ordering', async () => ({ stopReason: 'end_turn' }));
  session.queue = [{ prompt: [{ type: 'text', text: 'order' }], contextToken: 'order' }];
  session.processing = true;
  const internal = manager as unknown as { sessions: Map<string, UserSession>; processQueue: (s: UserSession) => Promise<void> };
  internal.sessions.set(session.userId, session);
  try {
    await within(internal.processQueue(session));
    assert.deepEqual(events, ['preparing', 'sent-unconfirmed', 'dispatched', 'result_ready']);
  } finally {
    await manager.stop();
  }
});

test('a failed pre-send checkpoint never issues the prompt and reports the error truthfully', async () => {
  const events: string[] = [];
  const replies: string[] = [];
  let promptCalls = 0;
  let rejection: string | undefined;
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 1000, grantDeadlineMs: 5000, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {},
    onReply: async (_id, _token, text) => { replies.push(text); },
    onTurnEvent: async (_id, _pending, event) => {
      events.push(event.phase);
      if (event.phase === 'sent-unconfirmed') throw new Error('synthetic checkpoint write failure');
    },
  });
  const session = makeAcpSession('write-fail', async () => { promptCalls += 1; return { stopReason: 'end_turn' }; });
  session.queue = [{
    prompt: [{ type: 'text', text: 'x' }], contextToken: 'x',
    completion: {
      resolve: () => assert.fail('a failed pre-send checkpoint must not resolve the turn'),
      reject: (err: unknown) => { rejection = String(err); },
    },
  }];
  session.processing = true;
  const internal = manager as unknown as { sessions: Map<string, UserSession>; processQueue: (s: UserSession) => Promise<void> };
  internal.sessions.set(session.userId, session);
  try {
    await within(internal.processQueue(session));
  } finally {
    await manager.stop();
  }
  assert.equal(promptCalls, 0, 'the ACP prompt must never be issued when the pre-send checkpoint fails');
  assert.deepEqual(events, ['preparing', 'sent-unconfirmed'], 'the turn must stop before any further phase');
  assert.match(rejection ?? '', /synthetic checkpoint write failure/);
  assert.ok(replies.some((text) => /Agent error/.test(text)), 'the failure must be surfaced, not silently swallowed');
});
