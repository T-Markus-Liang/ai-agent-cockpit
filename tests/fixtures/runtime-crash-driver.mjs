// Synthetic SDK recovery fixture, never a production tool registry.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat } from 'node:fs/promises';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, configure, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openOwnedSqliteStorage } from '../../runtime/owner-sqlite.mjs';
import { ControlPlaneStore } from '../../control-plane/store.mjs';

export const MODEL = { provider: 'faux', modelId: 'faux-1' };
export const TOOL_NAME = 'synthetic_effect_v1';
export const PARTIAL = 'SYNTHETIC_PARTIAL';

export function replayRegistry(replay, execute) {
  if (!['safe', 'unsafe'].includes(replay)) throw new Error('invalid fixture policy');
  const tool = defineTool({ name: TOOL_NAME, description: 'Synthetic private product-row effect, no native dispatch.',
    parameters: Type.Object({}, { additionalProperties: false }), replay, executionMode: 'sequential', execute });
  const extension = defineExtension({ name: 'synthetic.replay.v1', tools: [tool] });
  const registry = createRegistry(); registry.install(extension);
  return { registry, tool, extension };
}

export async function productFixture(dir) {
  const store = new ControlPlaneStore({ stateDir: path.join(dir, 'product') });
  const task = await store.createTask({ goal: 'synthetic replay only' }, { idempotencyKey: 'synthetic-task' });
  const parent = await store.createExecution(task.task.id, { workerId: 'synthetic-chief' }, { idempotencyKey: 'synthetic-parent' });
  return { store, taskId: task.task.id, parentId: parent.execution.id };
}

export async function effect(product, api) {
  return product.store.createExecution(product.taskId, { workerId: 'synthetic-worker', parentExecutionId: product.parentId },
    { idempotencyKey: `synthetic-effect:${api.taskId}:${api.callId}`, executionGuard: { taskId: product.taskId, executionId: product.parentId } });
}

async function main() {
  const [dir, replay] = process.argv.slice(2);
  if (!path.isAbsolute(dir ?? '') || !path.basename(dir).startsWith('pi-replay-') || !['safe', 'unsafe'].includes(replay)) throw new Error('invalid fixture arguments');
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('invalid fixture directory');
  const product = await productFixture(dir);
  const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage(fauxToolCall(TOOL_NAME, {}, { id: 'original-call' }), { stopReason: 'toolUse' })]);
  const models = createModels(); models.setProvider(faux.provider);
  let submission;
  const { registry, tool, extension } = replayRegistry(replay, async (_args, api, context) => {
    await effect(product, api);
    api.output(PARTIAL); await api.details({ marker: PARTIAL }, context);
    process.send?.({ type: 'effect-entered', conversationId: api.conversationId, submissionId: submission.id, toolTaskId: api.taskId });
    // Parent SIGKILLs only this synthetic child after the effect and progress commit.
    await new Promise(() => {});
  });
  const owned = await openOwnedSqliteStorage(path.join(dir, 'runtime.sqlite'));
  const harness = await Harness.open(owned.storage, { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false }, progress: { outputIntervalMs: 0, partialIntervalMs: 0 } } }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL, tools: [tool], extensions: [extension] } });
  // Configure through SDK objects, not strings (the SDK maps object.name).
  await harness.commit(tx => configure(tx, conversation.id, { model: MODEL, tools: [tool], extensions: [extension] }), BACKGROUND_CONTEXT);
  submission = await conversation.submit({ type: 'input', content: 'synthetic effect', requestId: 'original-request' }, BACKGROUND_CONTEXT);
  setInterval(() => {}, 1000); // Keep this owned fixture alive until its parent kills it.
  await submission.wait(BACKGROUND_CONTEXT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('synthetic crash fixture failed\n'); process.exitCode = 1; });
}
