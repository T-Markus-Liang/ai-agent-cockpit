import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SessionManager, type UserSession } from '../src/acp/session.js';

function session(id: string, prompt: () => Promise<{ stopReason: 'end_turn' }>, produced = true, usedTools = false): UserSession {
  const child = new EventEmitter(); Object.assign(child, { killed: false, exitCode: null, signalCode: null });
  return { userId: 'synthetic', contextToken: 'latest', client: { beginTurn: async () => {}, flush: async () => 'reply', hasProducedMessage: produced, hasUsedTools: usedTools } as never,
    agentInfo: { process: child as never, connection: { closed: new Promise(() => {}), prompt, cancel: async () => {} } as never, sessionId: id, configOptions: [], sessionOutcome: 'new' },
    configOptions: [], queue: [], processing: false, createdAt: Date.now(), lastActivity: Date.now(), lifecycleGeneration: 0 };
}

function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms); })])
    .finally(() => clearTimeout(timer));
}

test('timeout preserves the queued voice and sends the notice after old session removal', async () => {
  const notices: string[] = [], completed: string[] = [], prepared: string[] = [];
  let done!: () => void; const secondDone = new Promise<void>(resolve => { done = resolve; });
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    promptTimeoutMs: 15, showThoughts: false, killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {},
    preparePrompt: async (_id, blocks) => { prepared.push((blocks[0] as { text: string }).text); return blocks; },
    onReply: async (_id, _context, text, _generation, current) => { if (!current || current()) notices.push(text); } });
  const first = session('first', async () => new Promise(() => {}));
  first.queue = [{ prompt: [{ type: 'text', text: 'first voice' }], contextToken: 'first', completion: { resolve: () => assert.fail('timeout cannot succeed'), reject: () => { completed.push('first-failed'); } } },
    { prompt: [{ type: 'text', text: 'second voice' }], contextToken: 'second', completion: { resolve: () => { completed.push('second-done'); done(); }, reject: () => { completed.push('second-rejected'); done(); } } }];
  first.processing = true;
  const internal = manager as unknown as { sessions: Map<string, UserSession>; createSession: (...args: unknown[]) => Promise<UserSession>; processQueue: (s: UserSession) => Promise<void> };
  internal.sessions.set(first.userId, first); internal.createSession = async () => session('replacement', async () => ({ stopReason: 'end_turn' }));
  try {
    await internal.processQueue(first);
    await within(secondDone);
    assert.deepEqual(prepared, ['first voice', 'second voice']);
    assert.ok(completed.includes('first-failed')); assert.ok(completed.includes('second-done')); assert.ok(!completed.includes('second-rejected'));
    assert.ok(notices.some(text => /超|中断/.test(text)), 'timeout notice must not be filtered as a stale session');
  } finally { await manager.stop(); }
});

test('explicit reset still cancels queued work instead of replaying it', async () => {
  let rejected = 0;
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    showThoughts: false, killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {}, onReply: async () => {} });
  const s = session('reset', async () => ({ stopReason: 'end_turn' }));
  s.queue = [{ prompt: [], contextToken: 'one', completion: { resolve: () => assert.fail(), reject: () => { rejected++; } } }];
  (manager as unknown as { sessions: Map<string, UserSession> }).sessions.set(s.userId, s);
  await manager.resetSession(s.userId); assert.equal(rejected, 1); await manager.stop();
});

test('timed-out active prompt with tool activity is not retried while queued work continues', async () => {
  const completed: string[] = [], prepared: string[] = [];
  let done!: () => void; const secondDone = new Promise<void>(resolve => { done = resolve; });
  let replacementPrompts = 0, created = 0;
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    promptTimeoutMs: 15, showThoughts: false, fallbackAgents: [{ command: 'fallback', args: [] }], killAgentProcess: async () => {},
    sendTyping: async () => {}, log: () => {}, preparePrompt: async (_id, blocks) => { prepared.push((blocks[0] as { text: string }).text); return blocks; }, onReply: async () => {} });
  const first = session('first', async () => new Promise(() => {}), false, true);
  first.queue = [{ prompt: [{ type: 'text', text: 'first voice' }], contextToken: 'first', completion: { resolve: () => assert.fail('timeout cannot succeed'), reject: () => { completed.push('first-failed'); } } },
    { prompt: [{ type: 'text', text: 'second voice' }], contextToken: 'second', completion: { resolve: () => { completed.push('second-done'); done(); }, reject: () => { completed.push('second-rejected'); done(); } } }];
  first.processing = true;
  const internal = manager as unknown as { sessions: Map<string, UserSession>; createSession: (...args: unknown[]) => Promise<UserSession>; processQueue: (s: UserSession) => Promise<void>; fallbackUsers: Set<string> };
  internal.sessions.set(first.userId, first);
  internal.createSession = async () => { created++; return session('replacement', async () => { replacementPrompts++; return { stopReason: 'end_turn' }; }); };
  try {
    await internal.processQueue(first); await within(secondDone);
    assert.deepEqual(prepared, ['first voice', 'second voice']);
    assert.ok(completed.includes('first-failed')); assert.ok(completed.includes('second-done')); assert.ok(!completed.includes('second-rejected'));
    assert.equal(created, 1); assert.equal(replacementPrompts, 1, 'active prompt must not be retried');
    assert.equal(internal.fallbackUsers.has(first.userId), false);
  } finally { await manager.stop(); }
});

test('rejected cleanup retains backlog and accepts newer work without starting another process', async () => {
  const completed: string[] = [];
  let cleanupFails = true, created = 0;
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    promptTimeoutMs: 15, showThoughts: false, killAgentProcess: async () => { if (cleanupFails) throw new Error('cleanup refused'); },
    sendTyping: async () => {}, log: () => {}, onReply: async () => {} });
  const first = session('first', async () => new Promise(() => {}), false, false);
  first.queue = [{ prompt: [], contextToken: 'first', completion: { resolve: () => assert.fail(), reject: () => { completed.push('first-failed'); } } },
    { prompt: [], contextToken: 'second', completion: { resolve: () => { completed.push('second-done'); }, reject: () => { completed.push('second-rejected'); } } }];
  first.processing = true;
  const internal = manager as unknown as { sessions: Map<string, UserSession>; createSession: (...args: unknown[]) => Promise<UserSession>; processQueue: (s: UserSession) => Promise<void>; retainedMessages: Map<string, { messages: Array<{ contextToken: string }> }> };
  internal.sessions.set(first.userId, first);
  internal.createSession = async () => { created++; return session('replacement', async () => ({ stopReason: 'end_turn' })); };
  try {
    await internal.processQueue(first);
    await manager.enqueue(first.userId, { prompt: [], contextToken: 'third' });
    assert.deepEqual(internal.retainedMessages.get(first.userId)?.messages.map(message => message.contextToken), ['second', 'third']);
    assert.equal(created, 0); assert.ok(completed.includes('first-failed'));
    assert.ok(!completed.includes('second-done') && !completed.includes('second-rejected'));
  } finally { cleanupFails = false; await manager.stop(); }
});

test('messages received during timeout cleanup stay behind the retained backlog', async () => {
  let entered!: () => void, release!: () => void, finished!: () => void;
  const cleaning = new Promise<void>(resolve => { entered = resolve; });
  const cleanupGate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  const dispatched: string[] = [], notices: Array<{ token: string; text: string }> = [];
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    promptTimeoutMs: 15, showThoughts: false, killAgentProcess: async () => { entered(); await cleanupGate; }, sendTyping: async () => {}, log: () => {}, onReply: async () => {},
    onNotice: async (_id, token, text) => { notices.push({ token, text }); },
    preparePrompt: async (_id, blocks) => { dispatched.push((blocks[0] as { text: string }).text); return blocks; } });
  const first = session('first', async () => new Promise(() => {}));
  first.processing = true; first.queue = [{ prompt: [{ type: 'text', text: 'first' }], contextToken: 'first' }, { prompt: [{ type: 'text', text: 'second' }], contextToken: 'second' }];
  const internal = manager as unknown as { sessions: Map<string, UserSession>; createSession: () => Promise<UserSession>; processQueue: (s: UserSession) => Promise<void> };
  internal.sessions.set(first.userId, first); internal.createSession = async () => session('replacement', async () => ({ stopReason: 'end_turn' }));
  const running = internal.processQueue(first);
  try {
    await within(cleaning);
    await manager.enqueue(first.userId, { prompt: [{ type: 'text', text: 'third' }], contextToken: 'third', completion: { resolve: finished, reject: () => assert.fail('new message must remain queued') } });
    assert.deepEqual(dispatched, ['first']); release(); await within(running); await within(done);
    assert.deepEqual(dispatched, ['first', 'second', 'third']);
    assert.equal(notices[0]?.token, 'third', 'notice must use the newest admitted delivery token');
    assert.match(notices[0]!.text, /2 条消息已保留/);
  } finally { release(); await manager.stop(); }
});

test('explicit reset during timeout cleanup discards retained work and suppresses obsolete notices', async () => {
  let entered!: () => void, release!: () => void;
  const cleaning = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let created = 0; const rejected: string[] = [], notices: string[] = [];
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    promptTimeoutMs: 15, showThoughts: false, killAgentProcess: async () => { entered(); await gate; }, sendTyping: async () => {}, log: () => {}, onReply: async (_id, _ctx, text) => { notices.push(text); } });
  const first = session('first', async () => new Promise(() => {})); first.processing = true;
  first.queue = [{ prompt: [], contextToken: 'first' }, { prompt: [], contextToken: 'second', completion: { resolve: () => assert.fail(), reject: error => { rejected.push((error as Error).name); } } }];
  const internal = manager as unknown as { sessions: Map<string, UserSession>; createSession: () => Promise<UserSession>; processQueue: (s: UserSession) => Promise<void>; retainedMessages: Map<string, unknown> };
  internal.sessions.set(first.userId, first); internal.createSession = async () => { created++; return session('replacement', async () => ({ stopReason: 'end_turn' })); };
  const running = internal.processQueue(first);
  try {
    await within(cleaning); const reset = manager.resetSession(first.userId); release(); await within(Promise.all([running, reset]));
    assert.deepEqual(rejected, ['SessionResetError']); assert.equal(created, 0); assert.equal(internal.retainedMessages.size, 0); assert.deepEqual(notices, []);
  } finally { release(); await manager.stop(); }
});

test('hung ACP cancellation is bounded so later queued work can resume', { timeout: 5000 }, async () => {
  let completed = false;
  let finish!: () => void; const secondDone = new Promise<void>(resolve => { finish = resolve; });
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    promptTimeoutMs: 15, showThoughts: false, killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {}, onReply: async () => {} });
  const first = session('first', async () => new Promise(() => {})); first.processing = true;
  first.agentInfo.connection.cancel = async () => new Promise(() => {});
  first.queue = [{ prompt: [], contextToken: 'first' }, { prompt: [], contextToken: 'second', completion: { resolve: () => { completed = true; finish(); }, reject: () => assert.fail() } }];
  const internal = manager as unknown as { sessions: Map<string, UserSession>; createSession: () => Promise<UserSession>; processQueue: (s: UserSession) => Promise<void> };
  internal.sessions.set(first.userId, first); internal.createSession = async () => session('replacement', async () => ({ stopReason: 'end_turn' }));
  try { await within(internal.processQueue(first), 3500); await within(secondDone); assert.ok(completed); } finally { await manager.stop(); }
});

test('a delayed progress notice becomes invalid as soon as its active turn finishes', async () => {
  let release!: () => void, noticed!: () => void, current: (() => boolean) | undefined;
  const promptGate = new Promise<void>(resolve => { release = resolve; }), noticeReady = new Promise<void>(resolve => { noticed = resolve; });
  const manager = new SessionManager({ agentCommand: 'unused', agentArgs: [], agentCwd: process.cwd(), maxConcurrentUsers: 1, idleTimeoutMs: 0,
    progressNoticeMs: 10, promptTimeoutMs: 1000, showThoughts: false, killAgentProcess: async () => {}, sendTyping: async () => {}, log: () => {}, onReply: async () => {},
    onNotice: async (_id, _ctx, _text, _generation, check) => { current = check; noticed(); } });
  const first = session('first', async () => { await promptGate; return { stopReason: 'end_turn' }; }, false); first.processing = true; first.queue = [{ prompt: [], contextToken: 'first' }];
  const internal = manager as unknown as { sessions: Map<string, UserSession>; processQueue: (s: UserSession) => Promise<void> }; internal.sessions.set(first.userId, first);
  const running = internal.processQueue(first);
  try { await within(noticeReady); assert.equal(current?.(), true); release(); await within(running); assert.equal(current?.(), false); } finally { release(); await manager.stop(); }
});
