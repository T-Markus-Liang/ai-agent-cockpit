// Actual SIGKILL + Pi 1.0.4 recovery, private synthetic stores and faux only.
// Raw Harness fixtures verify upstream replay policy; arbitrary/unsafe registries
// are intentionally NOT accepted by PiRuntimeAdapter or production routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { openOwnedSqliteStorage } from '../runtime/owner-sqlite.mjs';
import { replayRegistry, productFixture, effect, MODEL, PARTIAL } from './fixtures/runtime-crash-driver.mjs';

const DRIVER = fileURLToPath(new URL('./fixtures/runtime-crash-driver.mjs', import.meta.url));
const bounded = () => withAbortSignal(AbortSignal.timeout(4000), BACKGROUND_CONTEXT);

for (const stored of ['safe', 'unsafe']) for (const current of ['safe', 'unsafe']) {
  test(`SIGKILL stored ${stored} / current ${current}: only safe+safe replays one idempotent effect`, { timeout: 10000 }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-replay-'));
    let owned, harness;
    const child = spawn(process.execPath, [DRIVER, dir, stored], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      await harness?.close(BACKGROUND_CONTEXT); await owned?.close(); await fs.rm(dir, { recursive: true, force: true });
    });
    const entered = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic child progress timeout')), 4000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('synthetic child exited before its effect')); });
      child.on('message', message => {
        if (message.type === 'effect-entered') { clearTimeout(timer); resolve(message); }
      });
    });
    assert.ok(Number.isSafeInteger(entered.toolTaskId));
    child.kill('SIGKILL'); const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const product = await productFixture(dir);
    assert.equal((await product.store.getTask(product.taskId)).executions.length, 2);
    owned = await openOwnedSqliteStorage(path.join(dir, 'runtime.sqlite'));
    const beforeOpen = await owned.storage.task(entered.toolTaskId, BACKGROUND_CONTEXT);
    assert.equal(beforeOpen.state.status, 'running'); assert.equal(beforeOpen.state.checkpoint.phase, 'execute');
    let calls = 0;
    const { registry } = replayRegistry(current, async (_args, api) => {
      calls += 1; const created = await effect(product, api); assert.equal(created.replay, true);
      return { content: [{ type: 'text', text: 'SYNTHETIC_RECOVERED' }] };
    });
    const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage('synthetic final')]);
    const models = createModels(); models.setProvider(faux.provider);
    harness = await Harness.open(owned.storage, { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
    const restored = await harness.getTask(entered.toolTaskId, BACKGROUND_CONTEXT);
    assert.equal(restored.state.status, 'pending'); assert.equal(calls, 0); assert.equal(faux.state.callCount, 0);
    const settled = await harness.waitForTask(entered.toolTaskId, bounded());
    const replayed = stored === 'safe' && current === 'safe';
    assert.equal(calls, replayed ? 1 : 0);
    assert.equal(settled.state.outcome.status, replayed ? 'completed' : 'failed');
    const results = (await owned.storage.scanEntries({ conversationId: entered.conversationId }, 50, undefined, BACKGROUND_CONTEXT)).items
      .filter(entry => entry.kind === 'pi.tool-result').flatMap(entry => entry.model ?? []);
    assert.equal(results.length, 1);
    if (replayed) assert.ok(JSON.stringify(results[0]).includes('SYNTHETIC_RECOVERED'));
    else {
      assert.equal(results[0].isError, true);
      assert.ok(results[0].content.some(block => block.type === 'text' && block.text.includes(PARTIAL)));
      assert.ok(JSON.stringify(results[0]).includes('interrupted'));
    }
    const aggregate = await product.store.getTask(product.taskId);
    assert.equal(aggregate.executions.length, 2); assert.equal(aggregate.evidence.length, 0);
    assert.notEqual(aggregate.task.status, 'completed');
    assert.ok(aggregate.executions.every(execution => execution.engineRef === undefined));
  });
}
