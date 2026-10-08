// Task-scoped Pi tools. Host references bind scope but mint no approval.
// Only query, queued product writes and planning: no shell/files/dispatch/proof.
import path from 'node:path';
import { copyJson } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { parametersDigest } from '../control-plane/store.mjs';
import { nativePromptPlan } from '../control-plane/native-acp-executor.mjs';

const ISSUED = new WeakMap();
const VERSION = 1;
const EXTENSION = 'aios.chief.v1';
const BINDING_KEYS = ['ownerId', 'productTaskId', 'executionId', 'profileId', 'cwd', 'authorizationDigest'];
const ACTIVE = new Set(['queued', 'running', 'verifying', 'reviewing']);
const TOOL_NAMES = ['aios_get_current_task', 'aios_create_worker_execution', 'aios_plan_native_prompt'];

function deny() { throw new Error('controlled task operation rejected'); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freeze(value[key]); Object.freeze(value);
  }
  return value;
}
function checkedArgs(input, keys, required) {
  const value = copyJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => typeof value[key] !== 'string' || !value[key].trim())) deny();
  return value;
}

export function getChiefToolSuiteDescriptor(suite) {
  const descriptor = ISSUED.get(suite);
  return descriptor === undefined ? undefined : copyJson(descriptor);
}

export function createChiefToolSuite({ store, binding: input, workerIds: inputWorkers, readOnly = false } = {}) {
  if (typeof readOnly !== 'boolean') deny();
  const binding = copyJson(input);
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== BINDING_KEYS.length ||
      BINDING_KEYS.some(key => typeof binding[key] !== 'string' || !binding[key].trim() || binding[key].length > 512) || !path.isAbsolute(binding.cwd)) deny();
  freeze(binding);
  const workers = copyJson(inputWorkers);
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > 32 || workers.some(id => typeof id !== 'string' || !id.trim() || id.length > 100) || new Set(workers).size !== workers.length) deny();
  freeze(workers);
  if (!store || typeof store.getTask !== 'function' || !readOnly && typeof store.createExecution !== 'function') deny();
  const toolNames = readOnly ? TOOL_NAMES.slice(0, 1) : TOOL_NAMES.slice();
  const descriptor = freeze({ version: VERSION, extensionName: EXTENSION, toolNames, binding,
    digest: parametersDigest({ version: VERSION, extension: EXTENSION, tools: toolNames, binding, workerIds: workers }) });
  const currentTask = async () => {
    const aggregate = await store.getTask(binding.productTaskId);
    const parent = aggregate.executions.find(exec => exec.id === binding.executionId);
    if (!parent || parent.taskId !== binding.productTaskId || !ACTIVE.has(parent.status) || ['completed', 'cancelled', 'failed', 'blocked'].includes(aggregate.task.status)) deny();
    return { aggregate, parent };
  };
  const tool = (name, description, parameters, action) => freeze(defineTool({ name, description, parameters, replay: 'safe', executionMode: 'sequential',
    async execute(args, api, context) {
      try {
        if (context.abortSignal?.aborted || !Number.isSafeInteger(api.taskId) || typeof api.callId !== 'string' || !api.callId) deny();
        const value = await action(args, api, context);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch {
        return { isError: true, content: [], diagnostics: [{ severity: 'error', code: 'aios_scope_rejected', message: 'Controlled task operation rejected; no authority or scope was expanded.' }] };
      }
    } }));
  const ref = () => Type.String({ minLength: 1, maxLength: 512 });
  const tools = [
    tool(TOOL_NAMES[0], 'Read only the current bound product task and its executions. No approval authority.', Type.Object({}, { additionalProperties: false }), async args => {
      checkedArgs(args, [], []); const { aggregate } = await currentTask();
      return { task: { id: aggregate.task.id, goal: aggregate.task.goal, status: aggregate.task.status, constraints: aggregate.task.constraints, acceptanceCriteria: aggregate.task.acceptanceCriteria },
        executions: aggregate.executions.map(exec => ({ id: exec.id, status: exec.status, workerId: exec.workerId, parentExecutionId: exec.parentExecutionId ?? null, artifactRef: exec.artifactRef ?? null })) };
    }),
    tool(TOOL_NAMES[1], 'Create only a queued child worker execution. This does not connect or dispatch an agent.', Type.Object({ workerId: ref(), sessionRefId: Type.Optional(ref()) }, { additionalProperties: false }), async (raw, api, context) => {
      const args = checkedArgs(raw, ['workerId', 'sessionRefId'], ['workerId']);
      if (!workers.includes(args.workerId) || args.sessionRefId !== undefined && (typeof args.sessionRefId !== 'string' || !args.sessionRefId.trim())) deny();
      await currentTask(); if (context.abortSignal?.aborted) deny();
      const result = await store.createExecution(binding.productTaskId, { workerId: args.workerId, parentExecutionId: binding.executionId, ...(args.sessionRefId === undefined ? {} : { sessionRefId: args.sessionRefId }) },
        { idempotencyKey: `pi-chief:${descriptor.digest}:${api.taskId}:${api.callId}`,
          executionGuard: { taskId: binding.productTaskId, executionId: binding.executionId } });
      return { executionId: result.execution.id, status: result.execution.status, replay: result.replay, dispatched: false };
    }),
    tool(TOOL_NAMES[2], 'Plan a prompt for a queued child native session; approval and native identity verification are still required. No load/prompt.',
      Type.Object({ executionId: ref(), source: ref(), nativeSessionId: ref(), cwd: ref(), prompt: Type.String({ minLength: 1, maxLength: 100000 }) }, { additionalProperties: false }), async raw => {
        const args = checkedArgs(raw, ['executionId', 'source', 'nativeSessionId', 'cwd', 'prompt'], ['executionId', 'source', 'nativeSessionId', 'cwd', 'prompt']);
        const { aggregate } = await currentTask();
        const child = aggregate.executions.find(exec => exec.id === args.executionId);
        if (!child || child.parentExecutionId !== binding.executionId || child.status !== 'queued' || child.workerId !== args.source || !workers.includes(args.source) || args.cwd !== binding.cwd) deny();
        return { ...nativePromptPlan({ taskId: binding.productTaskId, ...args }), dispatched: false, nativeIdentityVerified: false };
      }),
  ];
  const extension = freeze(defineExtension({ name: EXTENSION, tools: readOnly ? tools.slice(0, 1) : tools }));
  const registry = createRegistry(); registry.install(extension);
  const suite = Object.freeze({ snapshot() {
    const source = registry.snapshot();
    // ponytail: a read facade preserves the public SDK protocol without exposing install or mutable arrays.
    return Object.freeze({ installed: () => Object.freeze(source.installed().slice()), extension: name => source.extension(name),
      tools: () => Object.freeze(source.tools().map(row => Object.freeze({ ...row }))), sections: () => Object.freeze([]),
      tasks: () => Object.freeze(source.tasks().slice()), task: name => source.task(name) });
  }, subscribe: listener => registry.subscribe(listener) });
  ISSUED.set(suite, descriptor); return suite;
}
