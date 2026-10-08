import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SessionManager, type UserSession } from '../src/acp/session.js';

/** Minimal fake ACP session with a controllable prompt and cancel. */
function makeSession(
  id: string,
  prompt: () => Promise<{ stopReason: string }>,
  cancel: () => Promise<void> = async () => {},
  produced = true,
): UserSession {
  const child = new EventEmitter();
  Object.assign(child, { killed: false, exitCode: null, signalCode: null });
  return {
    userId: 'synthetic',
    contextToken: 'latest',
    client: { beginTurn: async () => {}, flush: async () => 'reply', hasProducedMessage: produced, hasUsedTools: false } as never,
    agentInfo: { process: child as never, connection: { closed: new Promise(() => {}), prompt, cancel } as never, sessionId: id, configOptions: [], sessionOutcome: 'new' },
    configOptions: [], queue: [], processing: false, createdAt: Date.now(), lastActivity: Date.now(), lifecycleGeneration: 0,
  };
}

function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms); })])
    .finally(() => clearTimeout(timer));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface Internal {
  sessions: Map<string, UserSession>;
  createSession: (...args: unknown[]) => Promise<UserSession>;
  processQueue: (session: UserSession) => Promise<void>;
}

test('a result returned inside the foreground window emits no background phase', async () => {
  const events: string[] = [], replies: string[] = [];
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 1000, grantDeadlineMs: 5000, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {}, onReply: async (_id, _token, text) => { replies.push(text); },
    onTurnEvent: async (_id, _pending, event) => { events.push(event.phase); },
  });
  const s = makeSession('fast', async () => ({ stopReason: 'end_turn' }));
  s.queue = [{ prompt: [{ type: 'text', text: 'quick' }], contextToken: 'quick' }];
  s.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(s.userId, s);
  try {
    await within(internal.processQueue(s));
    assert.ok(events.includes('preparing') && events.includes('dispatched') && events.includes('result_ready'));
    assert.ok(!events.includes('background'), 'a fast turn must not emit a background phase');
    assert.deepEqual(replies, ['reply']);
  } finally { await manager.stop(); }
});

test('a foreground wait expiry emits one background phase and the late result is still delivered', async () => {
  const events: string[] = [], replies: string[] = [];
  const release = deferred(), sawBackground = deferred();
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 20, grantDeadlineMs: 5000, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {}, onReply: async (_id, _token, text) => { replies.push(text); },
    onTurnEvent: async (_id, _pending, event) => { events.push(event.phase); if (event.phase === 'background') sawBackground.resolve(); },
  });
  const s = makeSession('slow', async () => { await release.promise; return { stopReason: 'end_turn' }; });
  s.queue = [{ prompt: [{ type: 'text', text: 'slow' }], contextToken: 'slow' }];
  s.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(s.userId, s);
  const running = internal.processQueue(s);
  try {
    await within(sawBackground.promise);
    assert.equal(events.filter((phase) => phase === 'background').length, 1, 'the foreground wait must fire exactly once');
    assert.equal(internal.sessions.get(s.userId), s, 'a background turn keeps its live session');
    assert.deepEqual(replies, [], 'no reply is owed before the late result arrives');
    release.resolve();
    await within(running);
    assert.ok(events.includes('result_ready'));
    assert.deepEqual(replies, ['reply'], 'the late result is still delivered after the background phase');
  } finally { release.resolve(); await manager.stop(); }
});

test('the foreground wait fires exactly once even when the turn runs many times longer', async () => {
  const events: string[] = [];
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 15, grantDeadlineMs: 5000, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {}, onReply: async () => {},
    onTurnEvent: async (_id, _pending, event) => { events.push(event.phase); },
  });
  // The turn takes ~3x the foreground window but still completes on its own.
  const s = makeSession('mid', async () => { await new Promise((r) => setTimeout(r, 45)); return { stopReason: 'end_turn' }; });
  s.queue = [{ prompt: [{ type: 'text', text: 'mid' }], contextToken: 'mid' }];
  s.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(s.userId, s);
  try {
    await within(internal.processQueue(s), 5000);
    assert.equal(events.filter((phase) => phase === 'background').length, 1, 'only one background phase, never a reset');
    assert.ok(events.includes('result_ready'));
  } finally { await manager.stop(); }
});

test('grant deadline terminates the turn with a truthful Chinese notice and continues the queue', async () => {
  const notices: string[] = [], completed: string[] = [];
  const second = deferred();
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 0, grantDeadlineMs: 15, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {},
    preparePrompt: async (_id, blocks) => blocks,
    onReply: async (_id, _token, text, _generation, current) => { if (!current || current()) notices.push(text); },
  });
  const first = makeSession('first', async () => new Promise(() => {}));
  first.queue = [
    { prompt: [{ type: 'text', text: 'first' }], contextToken: 'first', completion: { resolve: () => assert.fail('a deadline cannot succeed'), reject: () => { completed.push('first-failed'); } } },
    { prompt: [{ type: 'text', text: 'second' }], contextToken: 'second', completion: { resolve: () => { completed.push('second-done'); second.resolve(); }, reject: () => { completed.push('second-rejected'); second.resolve(); } } },
  ];
  first.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(first.userId, first);
  internal.createSession = async () => makeSession('replacement', async () => ({ stopReason: 'end_turn' }));
  try {
    await internal.processQueue(first);
    await within(second.promise);
    assert.ok(completed.includes('first-failed'), 'the deadline turn must be rejected, not resolved');
    assert.ok(completed.includes('second-done') && !completed.includes('second-rejected'), 'queued work continues after the reset');
    assert.ok(notices.some((text) => /Grant 期限/.test(text)), 'the user must be told the grant deadline was reached');
  } finally { await manager.stop(); }
});

test('a turn running in the background can still be cancelled', async () => {
  const events: string[] = [], replies: string[] = [];
  const release = deferred(), sawBackground = deferred();
  const cancelState = { called: false };
  const manager = new SessionManager({
    agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    foregroundWaitMs: 20, grantDeadlineMs: 5000, showThoughts: false, killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {}, onReply: async (_id, _token, text) => { replies.push(text); },
    onTurnEvent: async (_id, _pending, event) => { events.push(event.phase); if (event.phase === 'background') sawBackground.resolve(); },
  });
  const s = makeSession(
    'cancel-bg',
    async () => { await release.promise; return { stopReason: 'cancelled' }; },
    async () => { cancelState.called = true; release.resolve(); },
  );
  s.queue = [{ prompt: [{ type: 'text', text: 'x' }], contextToken: 'x' }];
  s.processing = true;
  const internal = manager as unknown as Internal;
  internal.sessions.set(s.userId, s);
  const running = internal.processQueue(s);
  try {
    await within(sawBackground.promise);
    const result = await manager.cancelCurrent(s.userId, {});
    assert.equal(result.cancelledTurn, true, 'a background turn is still cancellable');
    assert.equal(cancelState.called, true, 'cancel must reach the live agent connection');
    await within(running);
    assert.ok(replies.some((text) => /\[cancelled\]/.test(text)), 'the cancelled turn must still be reported to the user');
  } finally { release.resolve(); await manager.stop(); }
});
