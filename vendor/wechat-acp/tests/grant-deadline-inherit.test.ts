import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { SessionManager, type UserSession } from '../src/acp/session.js';
import { MessageInbox } from '../src/storage/message-inbox.js';
import { ReplyOutbox } from '../src/storage/reply-outbox.js';
import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig, type WeChatAcpConfig } from '../src/config.js';
import { MessageType, type WeixinMessage } from '../src/weixin/types.js';
import { classifyFailure, decideFallback } from '../src/acp/fallback-policy.js';

/**
 * P3 FG-F001 r2 — the absolute grant deadline is recorded once and inherited.
 *
 * The audited defect: a GrantDeadlineError branch re-enqueued the same pending,
 * and the NEXT attempt opened a fresh full grantDeadlineMs timer, so an elapsed
 * deadline never forbade a fallback. These tests pin the reworked semantics:
 * the deadline is stamped once, a spent deadline terminates (never resends), and
 * a fallback requires a proven-clean, degradable, in-budget failure.
 */

function makeSession(
  id: string,
  prompt: () => Promise<{ stopReason: string }>,
  produced = true,
  usedTools = false,
): UserSession {
  const child = new EventEmitter();
  Object.assign(child, { killed: false, exitCode: null, signalCode: null });
  return {
    userId: 'synthetic',
    contextToken: 'latest',
    client: { beginTurn: () => ({}), flush: async () => 'reply', hasProducedMessage: produced, hasUsedTools: usedTools } as never,
    agentInfo: { process: child as never, connection: { closed: new Promise(() => {}), prompt, cancel: async () => {} } as never, sessionId: id, configOptions: [], sessionOutcome: 'new' },
    configOptions: [], queue: [], processing: false, createdAt: Date.now(), lastActivity: Date.now(), lifecycleGeneration: 0,
  };
}

function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms); })])
    .finally(() => clearTimeout(timer));
}

interface Internal {
  sessions: Map<string, UserSession>;
  createSession: (...args: unknown[]) => Promise<UserSession>;
  processQueue: (session: UserSession) => Promise<void>;
  fallbackUsers: Set<string>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------
// The audit's negative example: a silent primary whose deadline elapses must be
// terminated — the fallback is NEVER invoked.
// --------------------------------------------------------------------------

test('a silent primary whose absolute grant expires is terminated, never re-enqueued to a fallback', async () => {
  const completed: string[] = [], notices: string[] = [];
  let created = 0, fallbackPrompts = 0;
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 0, grantDeadlineMs: 40, showThoughts: false,
    fallbackAgents: [{ command: 'fallback', args: [] }],
    killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {},
    onNotice: async (_id, _ctx, text) => { notices.push(text); },
    onReply: async (_id, _ctx, text) => { notices.push(text); },
  });
  // The primary never returns and produces no message / tool activity.
  const primary = makeSession('primary', async () => new Promise(() => {}), false, false);
  primary.queue = [{ prompt: [{ type: 'text', text: 'first' }], contextToken: 'first', completion: { resolve: () => assert.fail('an expired turn must not succeed'), reject: () => { completed.push('first-failed'); } } }];
  primary.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(primary.userId, primary);
  internal.createSession = async () => { created += 1; return makeSession('fallback', async () => { fallbackPrompts += 1; return { stopReason: 'end_turn' }; }); };
  try {
    await within(internal.processQueue(primary));
    await sleep(60); // give any (forbidden) fallback a chance to start
    assert.ok(completed.includes('first-failed'), 'the expired turn must be rejected, not resolved');
    assert.equal(created, 0, 'no replacement session may be created after the deadline');
    assert.equal(fallbackPrompts, 0, 'the fallback must never be invoked after the deadline');
    assert.equal(notices.filter((text) => /Grant 期限/.test(text)).length, 1, 'exactly one grant-deadline notice');
    assert.equal(internal.fallbackUsers.has('synthetic'), false, 'no fallback candidate may be selected');
  } finally { await manager.stop(); }
});

test('a primary that produced a message before the deadline is terminated, never replayed', async () => {
  const completed: string[] = [], notices: string[] = [];
  let created = 0, fallbackPrompts = 0;
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 0, grantDeadlineMs: 40, showThoughts: false,
    fallbackAgents: [{ command: 'fallback', args: [] }],
    killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {},
    onNotice: async (_id, _ctx, text) => { notices.push(text); },
    onReply: async (_id, _ctx, text) => { notices.push(text); },
  });
  const primary = makeSession('primary', async () => new Promise(() => {}), true, false);
  primary.queue = [{ prompt: [], contextToken: 'first', completion: { resolve: () => assert.fail(), reject: () => { completed.push('first-failed'); } } }];
  primary.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(primary.userId, primary);
  internal.createSession = async () => { created += 1; return makeSession('fallback', async () => { fallbackPrompts += 1; return { stopReason: 'end_turn' }; }); };
  try {
    await within(internal.processQueue(primary));
    await sleep(60);
    assert.ok(completed.includes('first-failed'));
    assert.equal(created, 0, 'a dirty timeout must not fall back');
    assert.equal(fallbackPrompts, 0, 'a dirty timeout must not fall back');
  } finally { await manager.stop(); }
});

// --------------------------------------------------------------------------
// The legitimate case: an in-budget, proven-clean startup failure may fall back,
// and the retry INHERITS the original absolute deadline (never a fresh timer).
// --------------------------------------------------------------------------

test('an in-budget, proven-clean startup failure falls back and the retry inherits the same deadlineAt', async () => {
  const notices: string[] = [], preparing: number[] = [];
  let created = 0, fallbackPrompts = 0;
  let done!: () => void; const finished = new Promise<void>((resolve) => { done = resolve; });
  const deadline = Date.now() + 800;
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 0, grantDeadlineMs: 5000, showThoughts: false,
    fallbackAgents: [{ command: 'fallback', args: [] }],
    killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {},
    onNotice: async (_id, _ctx, text) => { notices.push(text); },
    onReply: async () => {},
    onTurnEvent: async (_id, _pending, event) => { if (event.phase === 'preparing') preparing.push(event.deadlineAt!); },
  });
  // Primary fails during turn setup (before the prompt is dispatched) => proven clean.
  const primary = makeSession('primary', async () => ({ stopReason: 'end_turn' }), false, false);
  (primary.client as unknown as { beginTurn: () => Promise<never> }).beginTurn = async () => { await sleep(30); throw new Error('synthetic primary startup failure'); };
  primary.queue = [{ prompt: [{ type: 'text', text: 'task' }], contextToken: 'first', deadlineAt: deadline, completion: { resolve: done, reject: () => assert.fail('the fallback turn must resolve') } }];
  primary.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(primary.userId, primary);
  internal.createSession = async () => { created += 1; return makeSession('fallback', async () => { fallbackPrompts += 1; return { stopReason: 'end_turn' }; }); };
  try {
    await within(internal.processQueue(primary));
    await within(finished);
    assert.equal(created, 1, 'exactly one fallback session is created');
    assert.equal(fallbackPrompts, 1, 'the fallback candidate is prompted exactly once');
    assert.equal(internal.fallbackUsers.has('synthetic'), true);
    assert.ok(notices.some((text) => /备用候选/.test(text)), 'the user is told a fallback candidate is used');
    assert.deepEqual(preparing, [deadline], 'the retry reuses the ORIGINAL absolute deadline, never a fresh full timer');
  } finally { await manager.stop(); }
});

// --------------------------------------------------------------------------
// The vendor-side fallback gate mirrors runtime/fallback-policy's classify.
// --------------------------------------------------------------------------

test('fallback gate: proven-clean degradable kinds pass, dirty/unknown/auth/spent-budget stop', () => {
  assert.deepEqual(decideFallback({ kind: 'startup_error', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'fallback', reason: 'startup-failure' });
  assert.deepEqual(decideFallback({ kind: 'protocol_error', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'fallback', reason: 'protocol-failure' });
  assert.deepEqual(decideFallback({ kind: 'rate_limit', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'fallback', reason: 'rate-limited' });
  assert.deepEqual(decideFallback({ kind: 'timeout', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'fallback', reason: 'timeout-clean' });
  assert.equal(decideFallback({ kind: 'startup_error', hasProducedMessage: false, hasUsedTools: false, remainingMs: Number.POSITIVE_INFINITY }).action, 'fallback', 'no grant configured means unlimited budget');
  // A clean kind but a spent (or already-elapsed) budget is a hard stop.
  assert.deepEqual(decideFallback({ kind: 'startup_error', hasProducedMessage: false, hasUsedTools: false, remainingMs: 0 }), { action: 'stop', reason: 'deadline-exhausted' });
  assert.deepEqual(decideFallback({ kind: 'timeout', hasProducedMessage: false, hasUsedTools: false, remainingMs: -5 }), { action: 'stop', reason: 'deadline-exhausted' });
  // Side-effect barrier: a missing/truthy flag is unknown -> refused for every kind.
  assert.deepEqual(decideFallback({ kind: 'timeout', hasProducedMessage: true, hasUsedTools: false, remainingMs: 1000 }), { action: 'stop', reason: 'timeout-dirty' });
  assert.deepEqual(decideFallback({ kind: 'startup_error', hasProducedMessage: undefined, hasUsedTools: false, remainingMs: 1000 }), { action: 'stop', reason: 'unclean-side-effects' });
  assert.deepEqual(decideFallback({ kind: 'auth_error', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'stop', reason: 'auth-failure' });
  assert.deepEqual(decideFallback({ kind: 'mid_generation_failure', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'stop', reason: 'uncertain-side-effects' });
  assert.deepEqual(decideFallback({ kind: 'something_else', hasProducedMessage: false, hasUsedTools: false, remainingMs: 1000 }), { action: 'stop', reason: 'uncertain-side-effects' });
  assert.deepEqual(classifyFailure('startup_error', false, false), { eligible: true, reason: 'startup-failure' });
});

// --------------------------------------------------------------------------
// Restart: the persisted absolute deadline round-trips and is resumed, never reset.
// --------------------------------------------------------------------------

test('a journaled deadlineAt survives a restart and a replayable turn resumes against it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-deadline-inbox-'));
  try {
    const deadline = Date.now() + 123_456;
    const first = new MessageInbox({ dir });
    const { record } = await first.put(inboxMessage(701));
    await first.checkpoint(record.id, { phase: 'preparing', groupIds: [record.id], deadlineAt: deadline }, true);
    await first.close();

    const reopened = new MessageInbox({ dir });
    const result = await reopened.recover();
    assert.deepEqual(result.pending.map((row) => row.id), [record.id], 'a journaled pre-dispatch turn is replayable');
    const latest = (await reopened.list())[0];
    assert.equal(latest?.status, 'queued');
    assert.equal(latest?.execution?.deadlineAt, deadline, 'the original absolute deadline is preserved, not reset');
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Bridge re-admission threads the persisted deadlineAt into the re-enqueued turn.
// --------------------------------------------------------------------------

function inboxMessage(id: number): WeixinMessage {
  return {
    message_id: id,
    from_user_id: 'user-grant',
    to_user_id: 'bot-account',
    message_type: MessageType.USER,
    context_token: 'ctx-grant',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
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

test('recoverIncoming re-enqueues a recovered turn with its persisted deadlineAt', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-deadline-bridge-'));
  const config = makeConfig(dir);
  const deadline = Date.now() + 99_999;

  const seed = new WeChatAcpBridge(config);
  const seedInbox = (seed as any).messageInbox as MessageInbox;
  const { record } = await seedInbox.put(inboxMessage(702));
  await seedInbox.checkpoint(record.id, { phase: 'preparing', groupIds: [record.id], deadlineAt: deadline }, true);
  await seedInbox.close();
  await ((seed as any).replyOutbox as ReplyOutbox).close();

  const bridge = new WeChatAcpBridge(config);
  const calls: unknown[][] = [];
  (bridge as any).sessionManager = { enqueue: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); }, getSession: () => undefined, stop: async () => {} };

  t.after(async () => {
    await bridge.stop().catch(() => {});
    await seed.stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  await (bridge as any).recoverIncoming();
  assert.equal(calls.length, 1, 'the recovered receipt is re-enqueued exactly once');
  const payload = calls[0]![1] as { deadlineAt?: number };
  assert.equal(payload.deadlineAt, deadline, 'the resumed turn inherits the persisted absolute deadline');
});
