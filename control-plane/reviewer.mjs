import { StoreError } from './store.mjs'
import { createAdmittedExecution } from './dispatcher.mjs'

export async function createReviewerExecution({ store, taskId, sourceExecutionId, reviewerId, sessionRefId, idempotencyKey } = {}) {
  if (!store) throw new StoreError('STORE_REQUIRED', 'control-plane store is required', 500)
  if (!reviewerId) throw new StoreError('REVIEWER_REQUIRED', 'reviewerId is required', 400)
  const aggregate = await store.getTask(taskId)
  const source = aggregate.executions.find((execution) => execution.id === sourceExecutionId)
  if (!source) throw new StoreError('EXECUTION_TASK_MISMATCH', `execution ${sourceExecutionId} is not attached to task ${taskId}`, 409)
  if (!['succeeded', 'verifying', 'reviewing'].includes(source.status)) throw new StoreError('SOURCE_NOT_REVIEWABLE', `execution is ${source.status}; review requires succeeded/verifying/reviewing`, 409)
  // (S03b) the reviewer admission Grant is issued by the host at enqueue: the
  // reviewerId is the owner, and the scope names the only dispatch family a
  // reviewer execution is ever launched through (native ACP prompt, where the
  // read-only constraint is enforced).
  const fields = { workerId: reviewerId, role: 'reviewer', sessionRefId, parentExecutionId: sourceExecutionId, artifactRef: source.artifactRef }
  const execution = await createAdmittedExecution({ store, taskId, input: fields, owner: reviewerId, scope: ['native.session.prompt'], idempotencyKey })
  return { ...execution, reviewOf: sourceExecutionId, independent: reviewerId !== source.workerId }
}
