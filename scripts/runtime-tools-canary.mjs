// Two bounded model rounds and one read-only product query. Never native dispatch.
// --live opts into the existing loopback Kimi shim; default is faux/no network.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { ControlPlaneStore } from '../control-plane/store.mjs';
import { createChiefToolSuite } from '../runtime/chief-tools.mjs';
import { PiRuntimeAdapter } from '../runtime/pi-adapter.mjs';
import { openOwnedSqliteStorage } from '../runtime/owner-sqlite.mjs';
import { loopbackModels, savedMarker } from './runtime-adapter-canary.mjs';

const MARKER = 'TOOL_CANARY_OK';
const GOAL = 'SYNTHETIC_TOOL_CANARY_GOAL';
const SETTINGS = { stream: { timeoutMs: 30000, maxRetries: 0 }, retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } };

// Test-only ephemeral source process. No production restart or copied credentials.
async function isolatedShim() {
  const networkEnv = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn('/opt/homebrew/bin/python3.11', [fileURLToPath(new URL('../gateway/kimi-chat-shim.py', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { ...networkEnv, PATH: '/opt/homebrew/bin:/usr/bin:/bin', KIMI_SHIM_PORT: '0', KIMI_SHIM_REPORT_READY: '1' } });
  const exited = once(child, 'exit').catch(() => {});
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await exited; } finally { clearTimeout(force); }
  };
  try {
    const port = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('isolated shim startup timeout')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('isolated shim exited')); });
      child.stdout.on('data', chunk => {
        text += String(chunk);
        if (text.length > 4096) { clearTimeout(timer); reject(new Error('invalid shim readiness')); return; }
        if (!text.includes('\n')) return;
        try {
          const value = JSON.parse(text.split('\n')[0]);
          if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('invalid readiness');
          clearTimeout(timer); resolve(value.port);
        } catch { clearTimeout(timer); reject(new Error('invalid shim readiness')); }
      });
    });
    return { port, close };
  } catch (error) { await close(); throw error; }
}

export async function runToolsCanary({ live = false, isolated = false } = {}) {
  const counters = { modelCalls: 0, preparedPayloads: 0, httpStatus: null };
  const report = { ok: false, mode: live ? 'live' : 'fake', status: null, markerSeen: false, savedQueryResults: 0,
    duplicateSameSubmission: false, reopenSameSubmission: false, duplicateExtraCalls: null, reopenExtraCalls: null,
    querySawBoundGoal: false, unchangedProductState: false, usageTokens: 0, counters,
    scope: { productionTouched: false, nativeSessionsTouched: false, networkAttempted: live, isolatedShimSource: isolated, tools: ['aios_get_current_task'], workerDispatches: 0, productCompleted: false } };
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 45000);
  let dir, owned, adapter, shim;
  try {
    if (isolated && !live) throw new Error('isolated shim requires explicit live mode');
    dir = await mkdtemp(join(tmpdir(), '.port-state-tool-canary-'));
    const store = new ControlPlaneStore({ stateDir: join(dir, 'product') });
    const created = await store.createTask({ goal: GOAL, acceptanceCriteria: ['synthetic query only'] }, { idempotencyKey: 'task' });
    const parent = await store.createExecution(created.task.id, { workerId: 'chief' }, { idempotencyKey: 'chief' });
    const before = JSON.stringify(await store.read());
    const binding = { ownerId: 'synthetic-readonly-tools', productTaskId: created.task.id, executionId: parent.execution.id,
      profileId: 'synthetic-query-only', cwd: dir, authorizationDigest: 'reference-not-approval' };
    const suite = createChiefToolSuite({ store, binding, workerIds: ['codex'], readOnly: true });
    let source;
    if (live) {
      if (isolated) shim = await isolatedShim();
      source = await loopbackModels(counters, deadline, { queryTool: true, ...(shim === undefined ? {} : { port: shim.port }) });
    }
    else {
      const faux = fauxProvider(); faux.setResponses([
        fauxAssistantMessage(fauxToolCall('aios_get_current_task', {}, { id: 'query-once' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(MARKER),
      ]);
      const models = createModels(); models.setProvider(faux.provider);
      source = { models, ref: { provider: 'faux', modelId: 'faux-1' }, callCount: () => faux.state.callCount };
    }
    const file = join(dir, 'session.sqlite');
    const open = async () => {
      owned = await openOwnedSqliteStorage(file);
      adapter = await PiRuntimeAdapter.open(owned, { models: source.models, modelRef: source.ref, toolSuite: suite, settings: SETTINGS, allowUnbudgeted: true });
    };
    await open();
    const request = { ...binding, sourceRequestId: 'readonly-query-1',
      content: `Call aios_get_current_task exactly once with {}. If its task.goal is ${GOAL}, reply only ${MARKER}. No other text or actions.` };
    const first = await adapter.submit(request); const settled = await adapter.wait(first.submissionId);
    report.status = settled.status; report.markerSeen = await savedMarker(owned, first.conversationId, settled, MARKER);
    report.reason = ['aborted', 'faulted', 'model_error', 'no_model', 'reset', 'stale'].includes(settled.reason) ? settled.reason : null;
    const entries = (await owned.storage.scanEntries({ conversationId: first.conversationId }, 50, undefined, BACKGROUND_CONTEXT)).items;
    const results = entries.filter(entry => entry.kind === 'pi.tool-result').flatMap(entry => entry.model ?? []);
    report.savedQueryResults = results.length;
    report.querySawBoundGoal = results.length === 1 && !results[0].isError && results[0].content.some(block =>
      block.type === 'text' && JSON.parse(block.text).task?.goal === GOAL);
    const usage = await adapter.usage();
    report.usageTokens = Object.values(usage.models).reduce((total, row) => total + (row.totalTokens ?? 0), 0);
    const calls = source.callCount(); const duplicate = await adapter.submit(request); await adapter.wait(duplicate.submissionId);
    report.duplicateSameSubmission = duplicate.submissionId === first.submissionId; report.duplicateExtraCalls = source.callCount() - calls;
    await adapter.close(); adapter = undefined; await open();
    const reopened = await adapter.submit(request); const reopenedResult = await adapter.wait(reopened.submissionId);
    report.reopenSameSubmission = reopened.submissionId === first.submissionId;
    report.reopenMarkerSeen = await savedMarker(owned, reopened.conversationId, reopenedResult, MARKER);
    report.reopenExtraCalls = source.callCount() - calls; counters.modelCalls = source.callCount();
    report.unchangedProductState = before === JSON.stringify(await store.read());
    report.ok = report.status === 'done' && report.markerSeen && report.reopenMarkerSeen && report.savedQueryResults === 1 &&
      report.querySawBoundGoal && report.unchangedProductState && report.duplicateSameSubmission && report.reopenSameSubmission &&
      report.duplicateExtraCalls === 0 && report.reopenExtraCalls === 0 && counters.modelCalls === 2 &&
      (!live || counters.httpStatus === 200 && counters.preparedPayloads === 2 && report.usageTokens > 0);
  } catch {
    report.errorCategory = 'probe-failed'; // No prompts, provider errors or secrets in reports.
  } finally {
    clearTimeout(timer); deadline.abort();
    await adapter?.close().catch(() => {}); await owned?.close().catch(() => {});
    await shim?.close().catch(() => {});
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--live', '--isolated-shim', '--help', '-h'].includes(arg)) || args.includes('--isolated-shim') && !args.includes('--live')) return 2;
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('runtime-tools-canary: faux by default; --live makes at most two Kimi requests and one read-only query. --live --isolated-shim tests current shim source on an ephemeral loopback port without restarting production.\n');
    return 0;
  }
  const report = await runToolsCanary({ live: args.includes('--live'), isolated: args.includes('--isolated-shim') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
