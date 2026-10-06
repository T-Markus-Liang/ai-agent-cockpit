import { CezarAdapter, mapCezarStatus } from '../adapters/engines/cezar.mjs'
import { parametersDigest, StoreError } from './store.mjs'

export function cezarDispatchPlan({ taskId, executionId, runner = 'codex', workflow = 'quick-task', worktree = true } = {}) {
  const parameters = { taskId, executionId, runner, workflow, worktree }
  return {
    action: 'cezar.dispatch',
    target: executionId,
    parameters,
    parametersDigest: parametersDigest(parameters),
    requiresApproval: true,
  }
}

export function cezarCancelPlan({ executionId } = {}) {
  const parameters = { executionId }
  return { action: 'cezar.cancel', target: executionId, parameters, parametersDigest: parametersDigest(parameters), requiresApproval: true }
}

export async function dispatchCezar({ store, adapter = new CezarAdapter(), taskId, executionId, approvalId, runner = 'codex', workflow = 'quick-task', worktree = true, idempotencyKey } = {}) {
  if (!store) throw new StoreError('STORE_REQUIRED', 'control-plane store is required', 500)
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'dispatch requires an approved approval id', 403)
  const aggregate = await store.getTask(taskId)
  const execution = aggregate.executions.find((candidate) => candidate.id === executionId)
  if (!execution) throw new StoreError('EXECUTION_TASK_MISMATCH', `execution ${executionId} is not attached to task ${taskId}`, 409)
  if (execution.status !== 'queued') throw new StoreError('EXECUTION_NOT_QUEUED', `execution is ${execution.status}; only queued executions may dispatch`, 409)
  if (execution.engineRef) return { replay: true, execution, engineRef: execution.engineRef }
  const digest = cezarDispatchPlan({ taskId, executionId, runner, workflow, worktree }).parametersDigest
  await store.consumeApproval(approvalId, { action: 'cezar.dispatch', target: executionId, parametersDigest: digest }, { idempotencyKey: `${idempotencyKey ?? executionId}:approval` })
  await store.updateExecutionStatus(executionId, { status: 'running', outcome: 'Cezar dispatch is in flight; reconciliation required after interruption' }, { idempotencyKey: `${idempotencyKey ?? executionId}:dispatching` })
  let run
  try {
    run = await adapter.start({ task: aggregate.task.goal, runner, workflow, worktree })
  } catch (error) {
    await store.updateExecutionStatus(executionId, { status: 'blocked', outcome: `Cezar dispatch failed before a run reference was received: ${error.message}` }, { idempotencyKey: `${idempotencyKey ?? executionId}:blocked` })
    throw error
  }
  const runId = run?.id ?? run?.run?.id
  if (!runId) {
    await store.updateExecutionStatus(executionId, { status: 'blocked', outcome: 'Cezar returned no run id; dispatch is uncertain and requires reconciliation' }, { idempotencyKey: `${idempotencyKey ?? executionId}:blocked` })
    throw new StoreError('CEZAR_RUN_ID_MISSING', 'Cezar returned no run id; execution was blocked', 502)
  }
  try {
    await store.attachExecutionRef(executionId, {
      engine: 'cezar',
      id: runId,
      baseUrl: adapter.baseUrl,
      projectId: run.projectId,
      branch: run.branch,
      worktreePath: run.worktreePath,
    }, { idempotencyKey: `${idempotencyKey ?? executionId}:attach` })
    const started = await store.updateExecutionStatus(executionId, { status: 'running', outcome: `Cezar run ${runId} started` }, { idempotencyKey: `${idempotencyKey ?? executionId}:running` })
    return { replay: false, execution: started.execution, engineRef: started.execution.engineRef, cezarRun: run }
  } catch (error) {
    await store.updateExecutionStatus(executionId, { status: 'blocked', outcome: `Cezar run ${runId} started but control-plane association failed; reconcile manually before retrying` }, { idempotencyKey: `${idempotencyKey ?? executionId}:association-blocked` }).catch(() => {})
    throw error
  }
}

export async function reconcileCezarExecution({ store, adapter = new CezarAdapter(), executionId, idempotencyKey } = {}) {
  const execution = await store.getExecution(executionId)
  if (execution.engineRef?.engine !== 'cezar') throw new StoreError('CEZAR_REF_REQUIRED', 'execution has no Cezar engine reference', 409)
  const run = await adapter.getRun(execution.engineRef.id)
  const nextStatus = mapCezarStatus(run?.status)
  if (nextStatus === execution.status) return { changed: false, execution, cezarRun: run }
  const updated = await store.updateExecutionStatus(executionId, { status: nextStatus, outcome: run?.error ?? `Cezar status: ${run?.status ?? 'unknown'}` }, { idempotencyKey: `${idempotencyKey ?? executionId}:reconcile:${nextStatus}` })
  return { changed: true, execution: updated.execution, cezarRun: run }
}

export async function watchCezarExecution({ store, adapter = new CezarAdapter(), executionId, signal } = {}) {
  const execution = await store.getExecution(executionId)
  if (execution.engineRef?.engine !== 'cezar') throw new StoreError('CEZAR_REF_REQUIRED', 'execution has no Cezar engine reference', 409)
  for await (const event of adapter.events(execution.engineRef.id, { signal })) {
    if (event.event !== 'run' || !event.data || typeof event.data !== 'object') continue
    const status = event.data.status
    const nextStatus = mapCezarStatus(status)
    const current = await store.getExecution(executionId)
    if (nextStatus !== current.status) {
      try {
        await store.updateExecutionStatus(executionId, { status: nextStatus, outcome: event.data.error ?? `Cezar status: ${status}` }, { idempotencyKey: `cezar-watch:${executionId}:${event.id ?? status}` })
      } catch (error) {
        return { stopped: true, error: String(error), execution: await store.getExecution(executionId) }
      }
    }
    if (['done', 'failed', 'cancelled'].includes(status)) return { stopped: true, execution: await store.getExecution(executionId), lastEvent: event }
  }
  return { stopped: true, execution: await store.getExecution(executionId) }
}

export async function cancelCezarExecution({ store, adapter = new CezarAdapter(), executionId, approvalId, idempotencyKey } = {}) {
  const execution = await store.getExecution(executionId)
  if (execution.engineRef?.engine !== 'cezar') throw new StoreError('CEZAR_REF_REQUIRED', 'execution has no Cezar engine reference', 409)
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'cancellation requires an approved approval id', 403)
  const plan = cezarCancelPlan({ executionId })
  await store.consumeApproval(approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: `${idempotencyKey ?? executionId}:approval` })
  await adapter.cancel(execution.engineRef.id)
  return store.updateExecutionStatus(executionId, { status: 'cancelled', outcome: 'cancelled through Cezar adapter' }, { idempotencyKey: `${idempotencyKey ?? executionId}:cancel` })
}
