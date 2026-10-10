// Test helper for S03b execution Grants: mints a formal grant (via the real
// control-plane/execution-grant.mjs issuer — no test-only reimplementation)
// bound to a caller-chosen execution id, plus the parametersDigest the stored
// record must carry for the anti-portability check. Spread the result into
// store.createExecution input:
//
//   const executionId = `execution_test_${crypto.randomUUID()}`
//   await store.createExecution(task.task.id, {
//     id: executionId, workerId: 'w1',
//     ...executionGrantFixture({ taskId: task.task.id, executionId }),
//   }, { idempotencyKey: '...' })
//
// The default clock is the REAL one (Date.now) with a one-hour lifetime, so
// fixture grants pass the dispatch admission gate under the store's real-time
// writes; expiry tests instead pass a short lifetimeMs and inject an advanced
// `now` into the dispatch call. Nothing here touches the network or any
// production path — grants are plain in-memory objects persisted by the
// store's normal execution record write.
import { issueGrant } from '../../control-plane/execution-grant.mjs'
import { parametersDigest } from '../../control-plane/store.mjs'

export function executionGrantFixture({
  taskId,
  executionId,
  owner = 'test-owner',
  scope = ['test.dispatch'],
  digestParameters,
  now = Date.now,
  lifetimeMs = 3_600_000,
  expiresAt,
  limits,
  random,
} = {}) {
  const digest = parametersDigest(digestParameters ?? { taskId, executionId })
  const at = now()
  const grant = issueGrant({
    taskId,
    executionId,
    owner,
    parametersDigest: digest,
    scope,
    expiresAt: expiresAt ?? at + lifetimeMs,
    ...(limits === undefined ? {} : { limits }),
    now,
    ...(random === undefined ? {} : { random }),
  })
  return { grant, parametersDigest: digest }
}
