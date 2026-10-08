import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { PiRuntimeAdapter } from '../runtime/pi-adapter.mjs';
import { openOwnedSqliteStorage } from '../runtime/owner-sqlite.mjs';
import { runAdapterCanary, main } from '../scripts/runtime-adapter-canary.mjs';

const REF = { provider: 'faux', modelId: 'faux-1' };
const REQUEST = { ownerId: 'synthetic-settings-owner', sourceRequestId: 'settings-1', content: 'synthetic input',
  productTaskId: 'task', executionId: 'execution', profileId: 'no-tools', authorizationDigest: 'reference-not-authority' };
const SENTINEL = 'SYNTHETIC_PRIVATE_VALUE_NOT_FOR_ERRORS';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), '.port-state-settings-'));
  const owned = await openOwnedSqliteStorage(join(dir, 'session.sqlite'));
  const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage('synthetic answer')]);
  const models = createModels(); models.setProvider(faux.provider);
  let handle;
  try {
    await run({ owned, models, faux, setHandle: value => { handle = value; } });
  } finally {
    await handle?.close(BACKGROUND_CONTEXT).catch(() => {});
    await owned.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function rejectsBeforeHarness(settings) {
  await fixture(async ({ owned, models, faux }) => {
    await assert.rejects(() => PiRuntimeAdapter.open(owned, { models, modelRef: REF, settings }), error => {
      assert.ok(['unsafe-settings', 'unsafe-stream-option'].includes(error.code));
      assert.equal(error.message.includes(SENTINEL), false);
      return true;
    });
    assert.equal(faux.state.callCount, 0);
    assert.equal((await owned.storage.scanConversations({}, 50, undefined, BACKGROUND_CONTEXT)).items.length, 0);
    assert.equal((await owned.storage.scanTasks({}, 50, undefined, BACKGROUND_CONTEXT)).items.length, 0);
    assert.equal((await owned.storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 50, undefined, BACKGROUND_CONTEXT)).items.length, 0);
  });
}

test('raw Harness reproduces checkpoint callback fault before any model request', async () => {
  await fixture(async ({ owned, models, faux, setHandle }) => {
    let calls = 0;
    const harness = await Harness.open(owned.storage, { models, registry: createRegistry(), settings: { stream: { onPayload() { calls++; } } } }, BACKGROUND_CONTEXT);
    setHandle(harness);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: REF, tools: [] } });
    const submitted = await root.submit({ type: 'input', requestId: 'synthetic-fault', content: 'synthetic' }, BACKGROUND_CONTEXT);
    const settled = await submitted.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, 'unanswered'); assert.equal(settled.reason, 'faulted');
    assert.match(settled.detail, /non-JSON function/);
    assert.equal(faux.state.callCount, 0); assert.equal(calls, 0);
  });
});

for (const key of ['onPayload', 'onResponse', 'apiKey', 'headers', 'metadata', 'maxTokens', 'temperature', 'samplingParams', 'signal']) {
  test(`stream ${key} is rejected before any durable Harness state`, async () => {
    const value = key.startsWith('on') ? () => { throw Error(SENTINEL); } : key === 'signal' ? new AbortController().signal : SENTINEL;
    await rejectsBeforeHarness({ stream: { [key]: value } });
  });
}

test('stream and nested policy accessors are never invoked', async () => {
  let calls = 0;
  const settings = {}; Object.defineProperty(settings, 'stream', { enumerable: true, get() { calls++; return {}; } });
  await rejectsBeforeHarness(settings);
  const retry = {}; Object.defineProperty(retry, 'enabled', { enumerable: true, get() { calls++; return true; } });
  await rejectsBeforeHarness({ retry }); assert.equal(calls, 0);
});

test('non-JSON, prototype, hidden and cyclic settings are rejected', async () => {
  const cycle = {}; cycle.retry = cycle;
  const hidden = {}; Object.defineProperty(hidden, 'stream', { enumerable: false, value: {} });
  const symbol = { [Symbol('synthetic')]: SENTINEL };
  const hiddenSymbol = {}; Object.defineProperty(hiddenSymbol, Symbol('hidden'), { value: SENTINEL });
  class Settings { stream = {}; }
  for (const value of [cycle, hidden, symbol, hiddenSymbol, new Settings(), Object.create({ stream: {} }),
    { extensions: new Array(1) }, { stream: { timeoutMs: Infinity } }, { retry: { maxRetries: NaN } }, { progress: { outputIntervalMs: 1n } }]) {
    await rejectsBeforeHarness(value);
  }
});

for (const [name, settings] of Object.entries({
  'zero-timeout': { stream: { timeoutMs: 0 } }, 'negative-retries': { stream: { maxRetries: -1 } },
  'fractional-retries': { stream: { maxRetries: 0.5 } }, 'bad-transport': { stream: { transport: SENTINEL } },
  'bad-cache': { stream: { cacheRetention: SENTINEL } }, 'bad-window': { stream: { deferred: { window: SENTINEL } } },
  'bad-deferred-field': { stream: { deferred: { arbitrary: SENTINEL } } }, 'bad-retry-field': { retry: { apiKey: SENTINEL } },
  'bad-boolean': { compaction: { enabled: 'true' } }, 'bad-progress': { progress: { partialIntervalMs: -1 } },
  'bad-tool-mode': { toolExecution: SENTINEL }, 'bad-queue-mode': { steeringMode: SENTINEL },
})) test(`${name} settings fail closed`, () => rejectsBeforeHarness(settings));

test('documented settings work and caller mutation cannot inject code or change policies', async () => {
  await fixture(async ({ owned, models, faux, setHandle }) => {
    const settings = { extensions: [], stream: { transport: 'sse', timeoutMs: 1000, maxRetries: 0, maxRetryDelayMs: 0, cacheRetention: 'none', deferred: false },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0, backgroundTokens: 0 },
      progress: { partialIntervalMs: 0, outputIntervalMs: 0 }, toolExecution: 'sequential', steeringMode: 'all', followUpMode: 'one-at-a-time' };
    const adapter = await PiRuntimeAdapter.open(owned, { models, modelRef: REF, settings }); setHandle(adapter);
    let callbacks = 0;
    settings.stream.onPayload = () => { callbacks++; };
    settings.stream.apiKey = SENTINEL;
    Object.defineProperty(settings.retry, 'enabled', { get() { callbacks++; throw Error(SENTINEL); } });
    settings.extensions.push({ name: 'not-installed', tools: [] });
    const submitted = await adapter.submit(REQUEST);
    const settled = await adapter.wait(submitted.submissionId);
    assert.equal(settled.status, 'done'); assert.equal(faux.state.callCount, 1); assert.equal(callbacks, 0);
    const tasks = (await owned.storage.scanTasks({}, 50, undefined, BACKGROUND_CONTEXT)).items;
    assert.equal(JSON.stringify(tasks).includes(SENTINEL), false);
    assert.equal(JSON.stringify(tasks).includes('onPayload'), false);
    assert.deepEqual((await adapter.inspect()).registry, { extensions: [], tools: [] });
  });
});

test('adapter canary validates saved text, duplicate and reopen without any network', async () => {
  const report = await runAdapterCanary();
  assert.equal(report.ok, true); assert.equal(report.mode, 'fake'); assert.equal(report.status, 'done');
  assert.equal(report.markerSeen, true); assert.equal(report.reopenMarkerSeen, true);
  assert.equal(report.duplicateSameSubmission, true); assert.equal(report.reopenSameSubmission, true);
  assert.equal(report.duplicateExtraCalls, 0); assert.equal(report.reopenExtraCalls, 0);
  assert.equal(report.counters.modelCalls, 1); assert.equal(report.counters.httpStatus, null);
  assert.equal(report.scope.networkAttempted, false); assert.equal(report.scope.productionTouched, false);
  assert.equal(report.scope.nativeSessionsTouched, false); assert.equal(report.scope.tools, 0); assert.equal(report.scope.productCompleted, false);
});

test('unknown canary flags, including combinations with --live, never launch a model', async () => {
  assert.equal(await main(['--live', '--unknown']), 2);
});
