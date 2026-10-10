import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneStore } from '../control-plane/store.mjs';
import { acpPermissionPlan } from '../control-plane/acp-permission-broker.mjs';
import { createSessionPermissionBroker, SessionPermissionError } from '../control-plane/session-permission-broker.mjs';

// Fully synthetic harness. No production secrets, native sessions or files.
const OPERATOR = { id: 'operator-synthetic', role: 'operator', authenticated: true };

// A promise plus its resolver, so a test can park the broker at a chosen await
// and interleave a session close deterministically.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Fail fast (rather than hang the runner) if a regression leaves an await parked.
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('test deadline exceeded')), 2000); })]);
  } finally { clearTimeout(timer); }
};

// The flattened request shape a SessionManager would call with. Kept separate
// from the nested D07 `params` so the session layer's translation is exercised.
const flatRequest = (overrides = {}) => ({
  toolCallId: 'call-1',
  tool: { kind: 'read' },
  rawInput: { path: 'example.txt' },
  options: [{ kind: 'allow_once', optionId: 'once', name: 'once' }],
  ...overrides,
});

const innerParams = (binding, flat) => ({
  sessionId: binding.nativeSessionId,
  toolCall: { toolCallId: flat.toolCallId, kind: flat.tool?.kind, rawInput: flat.rawInput },
  options: flat.options,
});

async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-session-permission-'));
  try {
    const store = new ControlPlaneStore({ stateDir: path.join(dir, 'state') });
    const task = await store.createTask({ goal: 'synthetic scope' }, { idempotencyKey: 'task' });
    const exec = await store.createExecution(task.task.id, { workerId: 'synthetic-worker' }, { idempotencyKey: 'execution' });
    const binding = { ownerId: 'owner-synthetic', source: 'codex', accountId: 'account-synthetic', profileId: 'profile-synthetic', nativeSessionId: 'native-synthetic', cwd: dir, taskId: task.task.id, executionId: exec.execution.id };
    await store.attachExecutionRef(exec.execution.id, { engine: 'native-acp', id: 'native-synthetic', ...binding }, { idempotencyKey: 'bind' });
    await store.updateExecutionStatus(exec.execution.id, { status: 'running' }, { idempotencyKey: 'running' });

    let counter = 0;
    const approval = async (flat, { authenticated = true, expiresAt = new Date(Date.now() + 60000).toISOString(), alter = {} } = {}) => {
      const plan = acpPermissionPlan(binding, innerParams(binding, flat));
      const created = await store.createApproval({ action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest, ...(expiresAt ? { expiresAt } : {}), ...alter }, { idempotencyKey: `approval-${++counter}` });
      await store.decideApproval(created.approval.id, { decision: 'approved', approvedBy: OPERATOR.id }, { idempotencyKey: `decision-${counter}`, ...(authenticated ? { principal: OPERATOR } : {}) });
      return created.approval.id;
    };

    // Counts consumeApproval calls without changing semantics.
    const countStore = { calls: 0, consumeApproval: (...args) => { countStore.calls += 1; return store.consumeApproval(...args); } };
    await run({ store, countStore, binding, approval });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('1: a registered session with a live approval returns allow_once and consumes it once', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    assert.match(sessionId, /^s_[a-f0-9]{32}$/);
    approvalId = await approval(flatRequest());
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'allow_once' });
    assert.ok((await store.getApproval(approvalId)).usedAt);
    assert.equal(countStore.calls, 1);
  });
});

test('2: an unregistered session is denied unknown-session and never touches the approval resolver', async () => {
  await fixture(async ({ store, binding }) => {
    const broker = createSessionPermissionBroker({ store, findApprovalId: async () => { throw Error('must not resolve unknown sessions'); } });
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId: `s_${'0'.repeat(32)}`, ...flatRequest() }),
      { outcome: 'denied', reason: 'unknown-session' });
  });
});

test('3: a closed session is denied session-closed; closing an unknown session throws unknown-session', async () => {
  await fixture(async ({ store, countStore, binding }) => {
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => { throw Error('must not resolve closed sessions'); } });
    const { sessionId } = broker.registerSession(binding);
    assert.deepEqual(broker.closeSession(sessionId), { sessionId, closed: true });
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'session-closed' });
    assert.throws(() => broker.closeSession(`s_${'9'.repeat(32)}`), error => error instanceof SessionPermissionError && error.code === 'unknown-session');
  });
});

test('4: a replayed toolCallId is denied replay and never re-consumes the approval', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    approvalId = await approval(flatRequest());
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'allow_once' });
    assert.equal(countStore.calls, 1);
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'replay' });
    assert.equal(countStore.calls, 1, 'replay must not reach consumeApproval');
    assert.deepEqual(broker.decisions(sessionId).map(entry => entry.outcome), ['allow_once', 'replay']);
  });
});

test('5: missing, expired, wrong-digest and unverified approvals deny without changing the store', async () => {
  for (const mode of ['missing', 'expired', 'wrong-digest', 'legacy']) await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    approvalId = mode === 'missing' ? undefined : await approval(flatRequest(), {
      authenticated: mode !== 'legacy',
      expiresAt: mode === 'expired' ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 60000).toISOString(),
      alter: mode === 'wrong-digest' ? { parametersDigest: 'sha256:different' } : {},
    });
    const before = JSON.stringify(await store.read());
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'no-approval' }, mode);
    assert.equal(JSON.stringify(await store.read()), before, mode);
    if (approvalId) assert.equal((await store.getApproval(approvalId)).usedAt, undefined, mode);
  });
});

test('6: options that are not exactly one allow_once are denied unsupported-options', async () => {
  await fixture(async ({ store, countStore, binding }) => {
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => { throw Error('must not resolve malformed option sets'); } });
    const { sessionId } = broker.registerSession(binding);
    const cases = [
      ['multi', [{ kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'always' }]],
      ['not-allow-once', [{ kind: 'allow_always', optionId: 'always' }]],
      ['empty', []],
    ];
    for (const [label, options] of cases) {
      assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest({ toolCallId: `call-${label}`, options }) }),
        { outcome: 'denied', reason: 'unsupported-options' }, label);
    }
  });
});

test('7: an unknown tool kind is denied unknown-tool-kind', async () => {
  await fixture(async ({ store, countStore, binding }) => {
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => { throw Error('must not resolve unknown tool kinds'); } });
    const { sessionId } = broker.registerSession(binding);
    for (const [label, tool] of [['unknown', { kind: 'other' }], ['missing', undefined]]) {
      assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest({ toolCallId: `call-${label}`, tool }) }),
        { outcome: 'denied', reason: 'unknown-tool-kind' }, label);
    }
  });
});

test('8: registering a binding with a missing field is rejected', async () => {
  await fixture(async ({ store, countStore, binding }) => {
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => undefined });
    for (const field of ['ownerId', 'cwd', 'executionId']) {
      const incomplete = { ...binding };
      delete incomplete[field];
      assert.throws(() => broker.registerSession(incomplete), error => error instanceof SessionPermissionError && error.code === 'invalid-binding', field);
    }
    // The shorthand aliases from the design brief are accepted and normalized.
    assert.doesNotThrow(() => broker.registerSession({ owner: 'o', source: 'codex', account: 'a', profile: 'p', nativeSessionId: 'n', cwd: binding.cwd, taskId: binding.taskId, executionId: binding.executionId }));
  });
});

test('9: the decision log keeps digests, never rawInput, and filters by session', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const a = broker.registerSession(binding).sessionId;
    const b = broker.registerSession(binding).sessionId;
    const secret = 'SYNTHETIC_RAW_INPUT_SECRET_VALUE';
    const req = flatRequest({ rawInput: { path: 'x.txt', token: secret } });
    approvalId = await approval(req);
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId: a, ...req }), { outcome: 'allow_once' });
    await broker.handlePermissionRequest({ sessionId: b, ...flatRequest({ toolCallId: 'call-b', tool: { kind: 'other' } }) });

    const entriesA = broker.decisions(a);
    assert.equal(entriesA.length, 1);
    assert.equal(entriesA[0].outcome, 'allow_once');
    assert.equal(entriesA[0].toolKind, 'read');
    assert.match(entriesA[0].parametersDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(typeof entriesA[0].at, 'string');
    assert.equal(JSON.stringify(entriesA).includes(secret), false);
    assert.equal('rawInput' in entriesA[0], false);
    assert.deepEqual(broker.decisions(b).map(entry => entry.outcome), ['unknown-tool-kind']);
    assert.equal(broker.decisions().length, 2);
    assert.deepEqual(broker.decisions(`s_${'f'.repeat(32)}`), []);
    assert.ok(Object.isFrozen(broker.decisions()));
    assert.ok(Object.isFrozen(broker.decisions()[0]));
    for (const entry of broker.decisions()) assert.equal(JSON.stringify(entry).includes(secret), false);
  });
});

test('10: a serialized snapshot restores closed sessions and the log; replay is still denied', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const brokerA = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const open = brokerA.registerSession(binding).sessionId;
    const closed = brokerA.registerSession(binding).sessionId;
    brokerA.closeSession(closed);
    approvalId = await approval(flatRequest());
    assert.deepEqual(await brokerA.handlePermissionRequest({ sessionId: open, ...flatRequest() }), { outcome: 'allow_once' });

    const snapshot = JSON.parse(JSON.stringify(brokerA.toJSON()));
    const brokerB = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    assert.equal(brokerB.fromJSON(snapshot), brokerB);
    assert.deepEqual(brokerB.decisions(), brokerA.decisions());
    assert.deepEqual(await brokerB.handlePermissionRequest({ sessionId: open, ...flatRequest() }), { outcome: 'denied', reason: 'replay' });
    assert.deepEqual(await brokerB.handlePermissionRequest({ sessionId: closed, ...flatRequest() }), { outcome: 'denied', reason: 'session-closed' });

    // the binding survived the round-trip: a fresh approval on the restored session allows
    approvalId = await approval(flatRequest({ toolCallId: 'call-restore' }));
    assert.deepEqual(await brokerB.handlePermissionRequest({ sessionId: open, ...flatRequest({ toolCallId: 'call-restore' }) }), { outcome: 'allow_once' });
  });
});

test('11: every denied path leaves the store byte-identical', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const open = broker.registerSession(binding).sessionId;
    const closed = broker.registerSession(binding).sessionId;
    broker.closeSession(closed);
    approvalId = await approval(flatRequest());
    const before = JSON.stringify(await store.read());

    assert.equal((await broker.handlePermissionRequest({ sessionId: `s_${'1'.repeat(32)}`, ...flatRequest() })).reason, 'unknown-session');
    assert.equal((await broker.handlePermissionRequest({ sessionId: closed, ...flatRequest() })).reason, 'session-closed');
    assert.equal((await broker.handlePermissionRequest({ sessionId: open, ...flatRequest({ toolCallId: 'c-opt', options: [] }) })).reason, 'unsupported-options');
    assert.equal((await broker.handlePermissionRequest({ sessionId: open, ...flatRequest({ toolCallId: 'c-kind', tool: { kind: 'other' } }) })).reason, 'unknown-tool-kind');
    approvalId = undefined;
    assert.equal((await broker.handlePermissionRequest({ sessionId: open, ...flatRequest({ toolCallId: 'c-none' }) })).reason, 'no-approval');

    assert.equal(JSON.stringify(await store.read()), before);
  });
});

test('12: error messages carry only codes, never payloads or secrets; the handler never throws', async () => {
  await fixture(async ({ store, countStore, binding }) => {
    const secret = 'SYNTHETIC_SECRET_PROBE';
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => undefined });
    const capture = fn => { try { fn(); return undefined; } catch (error) { return error; } };

    const badBinding = capture(() => broker.registerSession({ ...binding, ownerId: '' }));
    const unknownClose = capture(() => broker.closeSession(secret));
    const badState = capture(() => broker.fromJSON({ version: 1, sessions: [{ sessionId: 's_bad', binding, closed: false, closedAt: null }], decisions: [] }));
    assert.ok(badBinding instanceof SessionPermissionError && badBinding.code === 'invalid-binding');
    assert.ok(unknownClose instanceof SessionPermissionError && unknownClose.code === 'unknown-session');
    assert.ok(badState instanceof SessionPermissionError && badState.code === 'invalid-state');
    for (const error of [badBinding, unknownClose, badState]) {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(binding.ownerId), false);
    }

    for (const hostile of [undefined, null, {}, { sessionId: 42 }, { sessionId: 'nope', tool: secret }, { sessionId: 'nope', options: secret }]) {
      assert.equal((await broker.handlePermissionRequest(hostile)).outcome, 'denied');
    }
  });
});

test('13: injected now/random make session ids and timestamps deterministic', async () => {
  await fixture(async ({ binding }) => {
    let counter = 0;
    const random = size => { const buffer = Buffer.alloc(size); for (let i = 0; i < size; i++) buffer[i] = (counter * 7 + i + 1) & 0xff; counter += 1; return buffer; };
    let ticks = 0;
    const now = () => 1_700_000_000_000 + ticks++ * 1000;
    const broker = createSessionPermissionBroker({ store: { consumeApproval: async () => ({ replay: false }) }, findApprovalId: async () => undefined, now, random });

    const first = broker.registerSession(binding).sessionId;
    const second = broker.registerSession(binding).sessionId;
    assert.match(first, /^s_[a-f0-9]{32}$/);
    assert.notEqual(first, second);
    broker.closeSession(first);
    assert.equal(broker.toJSON().sessions.find(record => record.sessionId === first).closedAt, new Date(1_700_000_000_000).toISOString());
  });
});

test('14: malformed snapshots fail closed with invalid-state', async () => {
  await fixture(async ({ store, countStore, binding }) => {
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => undefined });
    const { sessionId } = broker.registerSession(binding);
    const valid = broker.toJSON();
    const cases = [
      null, 42, 'x', {}, { ...valid, version: 2 }, { ...valid, extra: true },
      { version: 1, sessions: 'nope', decisions: [] },
      { version: 1, sessions: [], decisions: 'nope' },
      { version: 1, sessions: [{ sessionId: 'bad', binding, closed: false, closedAt: null }], decisions: [] },
      { version: 1, sessions: [{ sessionId, binding: { ...binding, extra: 1 }, closed: false, closedAt: null }], decisions: [] },
      { version: 1, sessions: [{ sessionId, binding, closed: 'no', closedAt: null }], decisions: [] },
      { version: 1, sessions: [], decisions: [{ sessionId, toolCallId: 'c', toolKind: 'read', parametersDigest: 'nope', outcome: 'allow_once', at: valid.sessions.length ? new Date().toISOString() : '' }] },
      { version: 1, sessions: [], decisions: [{ sessionId, toolCallId: 'c', toolKind: 'read', parametersDigest: null, outcome: 'invented', at: new Date().toISOString() }] },
    ];
    for (const bad of cases) assert.throws(() => createSessionPermissionBroker({ store: countStore, findApprovalId: async () => undefined }).fromJSON(bad), error => error.code === 'invalid-state');
    assert.doesNotThrow(() => createSessionPermissionBroker({ store: countStore, findApprovalId: async () => undefined }).fromJSON({ version: 1, sessions: [], decisions: [] }));
  });
});

// ---------------------------------------------------------------------------
// SP-F001 — logical session close must fence an in-flight adjudication.
// ---------------------------------------------------------------------------

test('15: a close before entry denies session-closed with zero consumption', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    approvalId = await approval(flatRequest());
    broker.closeSession(sessionId);
    const before = JSON.stringify(await store.read());
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'session-closed' });
    assert.equal(countStore.calls, 0);
    assert.equal((await store.getApproval(approvalId)).usedAt, undefined);
    assert.equal(JSON.stringify(await store.read()), before);
    assert.deepEqual(broker.decisions(sessionId).map(entry => entry.outcome), ['session-closed']);
  });
});

test('16: a close while the resolver is awaited denies session-closed and never consumes', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    const approvalId = await approval(flatRequest());
    const entered = deferred(); const gate = deferred();
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => { entered.resolve(); await gate.promise; return approvalId; } });
    const { sessionId } = broker.registerSession(binding);
    const pending = broker.handlePermissionRequest({ sessionId, ...flatRequest() });
    await bounded(entered.promise);
    broker.closeSession(sessionId);
    gate.resolve();
    assert.deepEqual(await bounded(pending), { outcome: 'denied', reason: 'session-closed' });
    assert.equal(countStore.calls, 0, 'close observed after the resolver returned must not consume');
    assert.equal((await store.getApproval(approvalId)).usedAt, undefined);
    assert.deepEqual(broker.decisions(sessionId).map(entry => entry.outcome), ['session-closed']);
  });
});

test('17: a close after the resolver fulfils but before the broker resumes denies session-closed', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    const approvalId = await approval(flatRequest());
    const gate = deferred();
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: () => gate.promise });
    const { sessionId } = broker.registerSession(binding);
    const pending = broker.handlePermissionRequest({ sessionId, ...flatRequest() });
    gate.resolve(approvalId);        // the resolver promise fulfils ...
    broker.closeSession(sessionId);  // ... and the session closes before the broker's continuation runs
    assert.deepEqual(await bounded(pending), { outcome: 'denied', reason: 'session-closed' });
    assert.equal(countStore.calls, 0);
    assert.equal((await store.getApproval(approvalId)).usedAt, undefined);
  });
});

test('18: a close once the consume has committed reports consumed-then-closed, never a clean denial', async () => {
  await fixture(async ({ store, binding, approval }) => {
    const approvalId = await approval(flatRequest());
    const enteredConsume = deferred(); const gate = deferred();
    let consumed = 0;
    const gatedStore = { consumeApproval: async (...args) => {
      consumed += 1;
      const result = await store.consumeApproval(...args);
      enteredConsume.resolve();
      await gate.promise;
      return result;
    } };
    const broker = createSessionPermissionBroker({ store: gatedStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    const pending = broker.handlePermissionRequest({ sessionId, ...flatRequest() });
    await bounded(enteredConsume.promise); // the approval is now consumed
    broker.closeSession(sessionId);
    gate.resolve();
    assert.deepEqual(await bounded(pending), { outcome: 'denied', reason: 'consumed-then-closed' });
    assert.equal(consumed, 1, 'the consume was already committed and is not rolled back');
    assert.ok((await store.getApproval(approvalId)).usedAt, 'the consumed approval stays consumed');
    assert.deepEqual(broker.decisions(sessionId).map(entry => entry.outcome), ['consumed-then-closed']);
  });
});

// ---------------------------------------------------------------------------
// SP-F002 — one in-flight adjudication per (sessionId, toolCallId).
// ---------------------------------------------------------------------------

test('19: concurrent same id, same body replays and never allows or consumes twice', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    const approvalId = await approval(flatRequest());
    const gate = deferred(); let arrivals = 0;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => { arrivals += 1; await gate.promise; return approvalId; } });
    const { sessionId } = broker.registerSession(binding);
    const pending = Promise.all([
      broker.handlePermissionRequest({ sessionId, ...flatRequest() }),
      broker.handlePermissionRequest({ sessionId, ...flatRequest() }),
    ]);
    gate.resolve();
    const results = await bounded(pending);
    assert.deepEqual(results.map(r => r.outcome), ['allow_once', 'denied']);
    assert.deepEqual(results[1], { outcome: 'denied', reason: 'replay' });
    assert.equal(arrivals, 1, 'the duplicate is refused before the resolver');
    assert.equal(countStore.calls, 1, 'exactly one approval is consumed');
    assert.ok((await store.getApproval(approvalId)).usedAt);
  });
});

test('20: concurrent same id, different body is a conflict refused before resolver or consume', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    const first = flatRequest({ rawInput: { path: 'first.txt' } });
    const second = flatRequest({ rawInput: { path: 'second.txt' } });
    const approvalA = await approval(first);
    const approvalB = await approval(second);
    const gate = deferred(); let arrivals = 0;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async plan => { arrivals += 1; await gate.promise; return plan.parameters.toolCall.rawInput.path === 'first.txt' ? approvalA : approvalB; } });
    const { sessionId } = broker.registerSession(binding);
    const pending = Promise.all([
      broker.handlePermissionRequest({ sessionId, ...first }),
      broker.handlePermissionRequest({ sessionId, ...second }),
    ]);
    gate.resolve();
    const [r1, r2] = await bounded(pending);
    assert.deepEqual(r1, { outcome: 'allow_once' });
    assert.deepEqual(r2, { outcome: 'denied', reason: 'conflict' });
    assert.equal(arrivals, 1, 'the conflicting request never reaches the resolver');
    assert.equal(countStore.calls, 1);
    assert.ok((await store.getApproval(approvalA)).usedAt);
    assert.equal((await store.getApproval(approvalB)).usedAt, undefined, 'the conflicting approval is left untouched');
  });
});

test('21: once the first allow settles, a later same id replays without re-consuming', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    const approvalId = await approval(flatRequest());
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'allow_once' });
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'replay' });
    assert.equal(countStore.calls, 1);
    assert.deepEqual(broker.decisions(sessionId).map(entry => entry.outcome), ['allow_once', 'replay']);
  });
});

test('22: a settled denial burns the reservation, so a same-id retry is replay and cannot consume', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    let approvalId;
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => approvalId });
    const { sessionId } = broker.registerSession(binding);
    approvalId = undefined; // first attempt finds no approval -> no-approval (a settled denial)
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'no-approval' });
    approvalId = await approval(flatRequest()); // a real approval now exists
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'replay' });
    assert.equal(countStore.calls, 0, 'the burned reservation keeps the retry away from the store');
    assert.equal((await store.getApproval(approvalId)).usedAt, undefined);
  });
});

test('23: an exception path fail-closed burns the reservation (no replay-free retry of the same id)', async () => {
  await fixture(async ({ countStore, binding }) => {
    // A non-absolute cwd passes registerSession but makes the D07 broker throw
    // at construction, an otherwise unhandled error path.
    const relative = { ...binding, cwd: 'relative-not-absolute' };
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async () => { throw Error('the resolver must not run for an unverifiable binding'); } });
    const { sessionId } = broker.registerSession(relative);
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'error' });
    assert.deepEqual(await broker.handlePermissionRequest({ sessionId, ...flatRequest() }), { outcome: 'denied', reason: 'replay' });
    assert.equal(countStore.calls, 0);
    assert.deepEqual(broker.decisions(sessionId).map(entry => entry.outcome), ['error', 'replay']);
  });
});

test('24: different tool call ids adjudicate in parallel and each consumes its own approval', async () => {
  await fixture(async ({ store, countStore, binding, approval }) => {
    const first = flatRequest({ toolCallId: 'call-par-a', rawInput: { path: 'a.txt' } });
    const second = flatRequest({ toolCallId: 'call-par-b', rawInput: { path: 'b.txt' } });
    const approvalA = await approval(first);
    const approvalB = await approval(second);
    const entered = deferred(); const gate = deferred(); let arrivals = 0;
    const byId = { 'call-par-a': approvalA, 'call-par-b': approvalB };
    const broker = createSessionPermissionBroker({ store: countStore, findApprovalId: async plan => { if ((arrivals += 1) === 2) entered.resolve(); await gate.promise; return byId[plan.parameters.toolCall.toolCallId]; } });
    const { sessionId } = broker.registerSession(binding);
    const pending = Promise.all([
      broker.handlePermissionRequest({ sessionId, ...first }),
      broker.handlePermissionRequest({ sessionId, ...second }),
    ]);
    await bounded(entered.promise); // both requests are parked at the resolver, reservations distinct
    gate.resolve();
    const results = await bounded(pending);
    assert.deepEqual(results.map(r => r.outcome), ['allow_once', 'allow_once']);
    assert.equal(arrivals, 2);
    assert.equal(countStore.calls, 2);
    assert.ok((await store.getApproval(approvalA)).usedAt);
    assert.ok((await store.getApproval(approvalB)).usedAt);
  });
});

test('25: reservations are process-local — a restore keeps the log semantics but not in-flight claims', async () => {
  await fixture(async ({ binding }) => {
    const fakeStore = { calls: 0, consumeApproval: async () => { fakeStore.calls += 1; return { replay: false }; } };
    const gate = deferred();
    const brokerA = createSessionPermissionBroker({ store: fakeStore, findApprovalId: async () => { await gate.promise; return 'approval-live'; } });
    const { sessionId } = brokerA.registerSession(binding);

    const pending = brokerA.handlePermissionRequest({ sessionId, ...flatRequest({ toolCallId: 'call-live' }) });
    // 'call-live' is now reserved in brokerA but has not settled, so it is absent
    // from both the decision log and the serialized snapshot.
    const snapshot = JSON.parse(JSON.stringify(brokerA.toJSON()));
    assert.deepEqual(snapshot.decisions, []);

    const brokerB = createSessionPermissionBroker({ store: fakeStore, findApprovalId: async () => 'approval-live' });
    assert.equal(brokerB.fromJSON(snapshot), brokerB);
    assert.deepEqual(brokerB.decisions(), []);

    // The restored broker started with an empty reservation set: the same id is
    // adjudicated afresh, and only then does its own reservation dedupe a repeat.
    assert.deepEqual(await bounded(brokerB.handlePermissionRequest({ sessionId, ...flatRequest({ toolCallId: 'call-live' }) })), { outcome: 'allow_once' });
    assert.deepEqual(await bounded(brokerB.handlePermissionRequest({ sessionId, ...flatRequest({ toolCallId: 'call-live' }) })), { outcome: 'denied', reason: 'replay' });

    // brokerA's in-flight request settles independently and is unaffected by the restore.
    gate.resolve();
    assert.deepEqual(await bounded(pending), { outcome: 'allow_once' });
    assert.equal(fakeStore.calls, 2);
  });
});
