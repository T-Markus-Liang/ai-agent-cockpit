import { CezarAdapter, mapCezarStatus } from '../adapters/engines/cezar.mjs'
import { parametersDigest, StoreError } from './store.mjs'
import { DEFAULT_MAX_EXECUTION_LIFETIME_MS, GrantError, issueGrantForAdmission, verifyGrant } from './execution-grant.mjs'

// ---------------------------------------------------------------------------
// S03b execution-Grant admission gate (remediation plan §5 items 1/2).
//
// A REAL dispatch — anything that can spawn a process or call out to an
// engine — is admitted only while the STORED execution record carries a Grant
// that verifyGrant accepts for THIS task/execution/parametersDigest under the
// injected clock. The check always runs against the stored record (never
// caller-supplied grant material), mirroring the RO r2 precedent of taking
// the role from storage so nothing can be laundered through the call site.
//
// On refusal the execution is settled honestly: it moves queued -> blocked
// (a legal, terminal transition) with an outcome that names the grant code,
// and the caller gets a StoreError whose code is the grant code in the
// control-plane UPPER_SNAKE style (the GrantError code is preserved in
// `details.grantCode`). A refusal therefore never crashes the process with a
// bare error and never leaves a silently-stuck queued record. The blocked
// marking is best-effort (`.catch(() => {})`): even if the concurrent state
// moved on, the dispatch itself is still refused.
//
// Grant expiry stops NEW dispatches only. Work already in flight is never
// retroactively cancelled by this gate — it settles under the existing
// honest certain/uncertain semantics (and the FG r2 rule that a foreground
// wait timeout changes notification only is untouched).
// ---------------------------------------------------------------------------

/** Map a lowercase GrantError code onto the control-plane StoreError style. */
export function grantStoreCode(grantCode) {
  return String(grantCode).replace(/-/g, '_').toUpperCase()
}

// The enqueue-parameter fields an admission digest covers. Secret-adjacent
// material (sessionLockToken) is deliberately EXCLUDED: the digest is
// persisted on the execution record and must never derive from a lock token.
const ADMITTED_PARAMETER_FIELDS = Object.freeze(['workerId', 'sessionRefId', 'parentExecutionId', 'role', 'artifactRef', 'attempt'])

/** Pick the defined admitted enqueue parameters out of an entry's input. */
export function admittedParametersOf(input = {}) {
  const parameters = {}
  for (const field of ADMITTED_PARAMETER_FIELDS) if (input[field] !== undefined) parameters[field] = input[field]
  return parameters
}

/**
 * Production enqueue-entry glue (S03b): compute the admission parametersDigest
 * with the SAME parametersDigest function the approval-matching path uses
 * (single digest source), issue the grant, and hand the entry the exact
 * fields to spread into store.createExecution input — `{ id, grant,
 * parametersDigest }` — so the grant is persisted with the record BEFORE it
 * is queued. GrantError denials are translated into control-plane StoreError
 * shape (UPPER_SNAKE code, httpStatus, `details.grantCode`), so an entry
 * never leaks a bare GrantError across an HTTP/MCP/CLI boundary.
 */
export function executionAdmissionInput({ taskId, executionId, owner, parameters, scope, expiresAt, authorizerExpiresAt, maxLifetimeMs, now, random, idempotencyKey } = {}) {
  try {
    const admitted = parameters ?? {}
    return issueGrantForAdmission({
      taskId,
      executionId,
      owner,
      parametersDigest: parametersDigest(admitted),
      scope,
      expiresAt,
      authorizerExpiresAt,
      // Idempotency-replay safety: the execution id is derived from the
      // request itself (taskId + the entry's idempotency key + the admitted
      // parameters), so a retried request mints the SAME id and replays
      // instead of conflicting. The grant's clock fields are excluded from
      // the store's idempotency fingerprint for the same reason (see
      // store.createExecution).
      idSeed: { taskId, idempotencyKey: idempotencyKey ?? null, parameters: admitted },
      ...(maxLifetimeMs === undefined ? {} : { maxLifetimeMs }),
      ...(now === undefined ? {} : { now }),
      ...(random === undefined ? {} : { random }),
    })
  } catch (error) {
    if (error instanceof GrantError) throw new StoreError(grantStoreCode(error.code), error.message, error.httpStatus ?? 400, { grantCode: error.code })
    throw error
  }
}

// Keep explicit admission intent in the durable idempotency fingerprint, but
// issue clock-dependent artifacts only on a new request, under the store lock.
// A replay returns the original record even after expiry; dispatch still checks
// that original grant and cannot extend its window through a retry.
export function createAdmittedExecution({ store, taskId, input = {}, owner, scope, expiresAt, authorizerExpiresAt, maxLifetimeMs = DEFAULT_MAX_EXECUTION_LIFETIME_MS, now, random, idempotencyKey, executionGuard } = {}) {
  const { grant: _callerGrant, parametersDigest: _callerDigest, ...fields } = input
  const intent = { owner, scope, maxLifetimeMs,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(authorizerExpiresAt === undefined ? {} : { authorizerExpiresAt }) }
  return store.createExecution(taskId, fields, {
    idempotencyKey, executionGuard, admissionIntent: intent,
    admissionFactory: () => executionAdmissionInput({ taskId, executionId: fields.id,
      parameters: admittedParametersOf(fields), ...intent, now, random, idempotencyKey }),
  })
}

/**
 * Verify the stored execution's grant and refuse the dispatch fail-closed.
 * Returns the verified (frozen) grant on success. `now` is injectable so
 * tests can advance the admission clock deterministically; production callers
 * leave the Date.now default.
 */
export async function assertDispatchGrant({ store, execution, taskId, executionId, requiredScope, now = Date.now, idempotencyKey } = {}) {
  try {
    if (!['cezar.dispatch', 'native.session.prompt'].includes(requiredScope)) {
      throw new GrantError('grant-scope-denied', 'dispatch requires an enforced action scope', 403)
    }
    const grant = verifyGrant(execution?.grant, { taskId, executionId, parametersDigest: execution?.parametersDigest, requiredScope, now })
    // Only the native prompt path forces the stored reviewer role through the
    // read-only sandbox constraint. Cezar has no equivalent enforcement.
    if (execution.role === 'reviewer' && requiredScope !== 'native.session.prompt') {
      throw new GrantError('reviewer-readonly-required', 'reviewer dispatch requires an enforced read-only execution path', 403)
    }
    return grant
  } catch (error) {
    if (!(error instanceof GrantError)) throw error
    await store.updateExecutionStatus(executionId, {
      status: 'blocked',
      outcome: `dispatch refused before any engine side effect (${error.code}): ${error.message}`,
    }, { idempotencyKey }).catch(() => {})
    throw new StoreError(grantStoreCode(error.code), error.message, error.httpStatus ?? 409, { grantCode: error.code })
  }
}

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

export async function dispatchCezar({ store, adapter = new CezarAdapter(), taskId, executionId, approvalId, runner = 'codex', workflow = 'quick-task', worktree = true, idempotencyKey, requireOperator = false, now } = {}) {
  if (!store) throw new StoreError('STORE_REQUIRED', 'control-plane store is required', 500)
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'dispatch requires an approved approval id', 403)
  const aggregate = await store.getTask(taskId)
  const execution = aggregate.executions.find((candidate) => candidate.id === executionId)
  if (!execution) throw new StoreError('EXECUTION_TASK_MISMATCH', `execution ${executionId} is not attached to task ${taskId}`, 409)
  if (execution.status !== 'queued') throw new StoreError('EXECUTION_NOT_QUEUED', `execution is ${execution.status}; only queued executions may dispatch`, 409)
  if (execution.engineRef) return { replay: true, execution, engineRef: execution.engineRef }
  // (S03b) Grant admission gate: AFTER the replay short-circuit (a replay is
  // not a new dispatch) and BEFORE the approval is consumed or the engine is
  // called. A missing/invalid/ported/expired grant refuses the dispatch and
  // settles the queued record as blocked with an honest outcome.
  await assertDispatchGrant({ store, execution, taskId, executionId, requiredScope: 'cezar.dispatch', now, idempotencyKey: `${idempotencyKey ?? executionId}:grant-refused` })
  const digest = cezarDispatchPlan({ taskId, executionId, runner, workflow, worktree }).parametersDigest
  await store.consumeApproval(approvalId, { action: 'cezar.dispatch', target: executionId, parametersDigest: digest }, { idempotencyKey: `${idempotencyKey ?? executionId}:approval`, requireOperator })
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

export async function cancelCezarExecution({ store, adapter = new CezarAdapter(), executionId, approvalId, idempotencyKey, requireOperator = false } = {}) {
  const execution = await store.getExecution(executionId)
  if (execution.engineRef?.engine !== 'cezar') throw new StoreError('CEZAR_REF_REQUIRED', 'execution has no Cezar engine reference', 409)
  if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'cancellation requires an approved approval id', 403)
  const plan = cezarCancelPlan({ executionId })
  await store.consumeApproval(approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, { idempotencyKey: `${idempotencyKey ?? executionId}:approval`, requireOperator })
  await adapter.cancel(execution.engineRef.id)
  return store.updateExecutionStatus(executionId, { status: 'cancelled', outcome: 'cancelled through Cezar adapter' }, { idempotencyKey: `${idempotencyKey ?? executionId}:cancel` })
}
