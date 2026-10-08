// Isolated RuntimePort verification, not a production route or product completion.
// Default is faux/no network; --live uses only the existing loopback Kimi shim.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { PiRuntimeAdapter } from '../runtime/pi-adapter.mjs';
import { openOwnedSqliteStorage } from '../runtime/owner-sqlite.mjs';

const MARKER = 'ADAPTER_CANARY_OK';
const SETTINGS = { stream: { timeoutMs: 30000, maxRetries: 0 }, retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } };
const REASONS = new Set(['aborted', 'faulted', 'model_error', 'no_model', 'reset', 'stale']);

// Shared by the isolated query-tool canary, never a production resolver.
export async function loopbackModels(counters, deadline, { queryTool = false, port = 4323 } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid canary loopback port');
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy');
  const ref = { provider: 'local-kimi-runtime-canary', modelId: 'kimi-k3' };
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const base = createProvider({
    id: ref.provider, name: 'Synthetic loopback Kimi canary', baseUrl,
    auth: { apiKey: { name: 'Dummy loopback auth', resolve: async () => ({ auth: { apiKey: 'loopback-shim' }, source: 'dummy-loopback' }) } },
    models: [{ id: ref.modelId, name: ref.modelId, provider: ref.provider, api: 'openai-completions', baseUrl,
      reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: 'max_tokens' } }],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider({ ...base, streamSimple(model, context, options = {}) {
    if (counters.modelCalls >= (queryTool ? 2 : 1)) throw new Error('canary model-call limit reached');
    counters.modelCalls += 1;
    const firstCall = counters.modelCalls === 1;
    // Transport callbacks/auth never enter settings.stream or a durable checkpoint.
    return base.streamSimple(model, context, { ...options,
      signal: options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal,
      async fetch(...args) {
        const response = await fetch(...args);
        counters.transportHttpStatus = response.status;
        const upstream = Number(response.headers.get('x-kimi-upstream-status'));
        if (Number.isInteger(upstream) && upstream >= 100 && upstream <= 599) counters.upstreamHttpStatus = upstream;
        return response;
      },
      maxTokens: 96, maxRetries: 0, temperature: 0.6, samplingParams: { top_p: 0.95 },
      onPayload(payload) {
        counters.preparedPayloads += 1;
        const next = { ...payload, temperature: 0.6, top_p: 0.95, max_tokens: 96, thinking: { type: 'disabled' } };
        delete next.reasoning_effort;
        if (queryTool) {
          counters.preparedToolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
          counters.queryToolMatches = payload.tools?.[0]?.function?.name === 'aios_get_current_task';
          if (counters.preparedToolCount !== 1 || !counters.queryToolMatches) throw new Error('canary tool scope rejected');
          next.tool_choice = firstCall ? 'auto' : 'none';
        }
        return next;
      },
      onResponse(response) { counters.httpStatus = Number.isInteger(response.status) ? response.status : null; },
    });
  } });
  return { models, ref, callCount: () => counters.modelCalls };
}

export async function savedMarker(owned, conversationId, settled, marker = MARKER) {
  if (settled.status !== 'done' || !Number.isSafeInteger(settled.answer)) return false;
  const saved = await owned.storage.entry(conversationId, settled.answer, BACKGROUND_CONTEXT);
  if (saved?.entry.kind !== 'pi.assistant') return false;
  const message = saved.entry.model?.[0];
  if (message?.role !== 'assistant') return false;
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim() === marker;
}

export async function runAdapterCanary({ live = false } = {}) {
  const counters = { modelCalls: 0, preparedPayloads: 0, httpStatus: null };
  const report = { ok: false, mode: live ? 'live' : 'fake', status: null, reason: null,
    markerSeen: false, reopenMarkerSeen: false, duplicateSameSubmission: false, reopenSameSubmission: false,
    duplicateExtraCalls: null, reopenExtraCalls: null, usageTokens: 0, counters,
    scope: { productionTouched: false, nativeSessionsTouched: false, tools: 0, productCompleted: false, networkAttempted: live } };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 35000);
  let dir, owned, adapter;
  try {
    const faux = live ? undefined : fauxProvider();
    let source;
    if (live) source = await loopbackModels(counters, deadline);
    else {
      faux.setResponses([fauxAssistantMessage(MARKER)]);
      const models = createModels(); models.setProvider(faux.provider);
      source = { models, ref: { provider: 'faux', modelId: 'faux-1' }, callCount: () => faux.state.callCount };
    }
    dir = await mkdtemp(join(tmpdir(), '.port-state-adapter-canary-'));
    const file = join(dir, 'session.sqlite');
    const open = async () => {
      owned = await openOwnedSqliteStorage(file);
      adapter = await PiRuntimeAdapter.open(owned, { models: source.models, modelRef: source.ref, settings: SETTINGS, allowUnbudgeted: true });
    };
    await open();
    const request = { ownerId: 'synthetic-adapter-canary', sourceRequestId: 'canary-1',
      content: `Reply only with ${MARKER}. No tools or external actions.`, productTaskId: 'synthetic-task',
      executionId: 'synthetic-execution', profileId: 'synthetic-no-tools', authorizationDigest: 'reference-not-authority' };
    const first = await adapter.submit(request);
    const settled = await adapter.wait(first.submissionId);
    report.status = settled.status;
    report.reason = settled.reason === undefined ? null : REASONS.has(settled.reason) ? settled.reason : 'unknown';
    report.markerSeen = await savedMarker(owned, first.conversationId, settled);
    const usage = await adapter.usage();
    report.usageTokens = Object.values(usage.models).reduce((total, item) => total + (item.totalTokens ?? 0), 0);
    const afterFirst = source.callCount();
    const duplicate = await adapter.submit(request); await adapter.wait(duplicate.submissionId);
    report.duplicateSameSubmission = duplicate.submissionId === first.submissionId;
    report.duplicateExtraCalls = source.callCount() - afterFirst;
    await adapter.close(); adapter = undefined;
    await open();
    const restored = await adapter.submit(request);
    const restoredSettled = await adapter.wait(restored.submissionId);
    report.reopenSameSubmission = restored.submissionId === first.submissionId;
    report.reopenMarkerSeen = await savedMarker(owned, restored.conversationId, restoredSettled);
    report.reopenExtraCalls = source.callCount() - afterFirst;
    counters.modelCalls = source.callCount();
    report.ok = report.status === 'done' && report.markerSeen && report.reopenMarkerSeen && report.duplicateSameSubmission &&
      report.reopenSameSubmission && report.duplicateExtraCalls === 0 && report.reopenExtraCalls === 0 && counters.modelCalls === 1 &&
      (!live || (counters.httpStatus === 200 && counters.preparedPayloads === 1 && report.usageTokens > 0));
  } catch {
    report.errorCategory = 'probe-failed'; // Never emit provider errors, headers, payloads or credential values.
  } finally {
    clearTimeout(timer); deadline.abort();
    await adapter?.close().catch(() => {}); await owned?.close().catch(() => {});
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--live', '--help', '-h'].includes(arg))) return 2;
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('runtime-adapter-canary: fake by default; --live makes one bounded synthetic request to the existing Kimi loopback shim.\n');
    return 0;
  }
  const report = await runAdapterCanary({ live: args.includes('--live') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
