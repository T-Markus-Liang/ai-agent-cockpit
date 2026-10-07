import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ControlPlaneStore } from '../control-plane/store.mjs'

const GIT_A = `git:${'a'.repeat(40)}`
const GIT_B = `git:${'b'.repeat(40)}`
const SHA_A = `sha256:${'a'.repeat(64)}`

let counter = 0
const key = () => `key-${++counter}`
const tempDirs = []

async function newStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-gate-'))
  tempDirs.push(dir)
  return new ControlPlaneStore({ stateDir: dir })
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function newTask(store) {
  const created = await store.createTask({ goal: 'ship it' }, { idempotencyKey: key() })
  return created.task.id
}

async function createWorker(store, taskId, { workerId = 'worker-1', artifactRef } = {}) {
  const created = await store.createExecution(taskId, { workerId, ...(artifactRef ? { artifactRef } : {}) }, { idempotencyKey: key() })
  return created.execution.id
}

async function createReviewer(store, taskId, { workerId = 'reviewer-1', parentExecutionId, artifactRef } = {}) {
  const created = await store.createExecution(taskId, { workerId, parentExecutionId, ...(artifactRef ? { artifactRef } : {}) }, { idempotencyKey: key() })
  return created.execution.id
}

async function drive(store, executionId, statuses = ['running', 'verifying', 'reviewing', 'succeeded']) {
  for (const status of statuses) {
    await store.updateExecutionStatus(executionId, { status }, { idempotencyKey: key() })
  }
}

async function addVerification(store, executionId, artifactRef, extra = {}) {
  await store.addEvidence(executionId, { kind: 'test', summary: 'checks', source: 'npm test', artifactRef, ...extra }, { idempotencyKey: key() })
}

async function addReview(store, executionId, { artifactRef, reviewOfExecutionId, verdict = 'passed' } = {}) {
  await store.addEvidence(executionId, { kind: 'review', summary: 'review', source: 'reviewer notes', verdict, artifactRef, reviewOfExecutionId }, { idempotencyKey: key() })
}

async function buildIndependentProof(store, { workerArtifact = GIT_A } = {}) {
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: workerArtifact })
  await addVerification(store, workerId, workerArtifact, { exitCode: 0 })
  const reviewerId = await createReviewer(store, taskId, { parentExecutionId: workerId, artifactRef: workerArtifact })
  await drive(store, workerId)
  await drive(store, reviewerId)
  await addReview(store, reviewerId, { artifactRef: workerArtifact, reviewOfExecutionId: workerId })
  return { taskId, workerId, reviewerId }
}

async function approveCompletion(store, taskId) {
  const plan = await store.completionPlan(taskId)
  const approval = await store.createApproval({
    action: 'task.complete',
    target: taskId,
    parametersDigest: plan.parametersDigest,
    decision: 'approved',
    approvedBy: 'chief',
  }, { idempotencyKey: key() })
  return { plan, approval }
}

test('successful independent proof completes the task', async () => {
  const store = await newStore()
  const { taskId } = await buildIndependentProof(store)
  const { plan, approval } = await approveCompletion(store, taskId)
  assert.equal(plan.ready, true, plan.reasons.join('; '))
  const completed = await store.completeTask(taskId, { approvalId: approval.approval.id }, { idempotencyKey: key() })
  assert.equal(completed.task.status, 'completed')
  assert.equal(completed.task.completionProof.parametersDigest, plan.parametersDigest)
})

test('failed verification exit code fails closed', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  await addVerification(store, workerId, GIT_A, { exitCode: 1 })
  const reviewerId = await createReviewer(store, taskId, { parentExecutionId: workerId })
  await drive(store, workerId)
  await drive(store, reviewerId)
  await addReview(store, reviewerId, { artifactRef: GIT_A, reviewOfExecutionId: workerId })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('exitCode=0')))
})
test('a passing receipt cannot hide another failed current-artifact test', async () => {
  const store = await newStore()
  const { taskId, workerId } = await buildIndependentProof(store)
  await addVerification(store, workerId, GIT_A, { exitCode: 1 })
  assert.equal((await store.completionPlan(taskId)).ready, false)
})
test('null and string exit codes cannot be coerced into successful proof', async () => {
  const store = await newStore(), taskId = await newTask(store), workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  for (const exitCode of [null, '0', false]) await assert.rejects(addVerification(store, workerId, GIT_A, { exitCode }))
})

test('missing verification exit code fails closed', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  await addVerification(store, workerId, GIT_A)
  const reviewerId = await createReviewer(store, taskId, { parentExecutionId: workerId })
  await drive(store, workerId)
  await drive(store, reviewerId)
  await addReview(store, reviewerId, { artifactRef: GIT_A, reviewOfExecutionId: workerId })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('exitCode=0')))
})

test('succeeded root worker without artifactRef fails closed', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId)
  await drive(store, workerId)
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('artifactRef')))
})

test('review by the same worker is not independent', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  await addVerification(store, workerId, GIT_A, { exitCode: 0 })
  const reviewerId = await createReviewer(store, taskId, { workerId: 'worker-1', parentExecutionId: workerId })
  await drive(store, workerId)
  await drive(store, reviewerId)
  await addReview(store, reviewerId, { artifactRef: GIT_A, reviewOfExecutionId: workerId })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('独立 reviewer')))
})

test('self-reported review on the original execution is not independent', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  await addVerification(store, workerId, GIT_A, { exitCode: 0 })
  await drive(store, workerId)
  await addReview(store, workerId, { artifactRef: GIT_A, reviewOfExecutionId: workerId })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('独立 reviewer')))
})

test('reviewer with mismatched parent does not provide independence', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  await addVerification(store, workerId, GIT_A, { exitCode: 0 })
  const reviewerId = await createReviewer(store, taskId, { parentExecutionId: 'execution_other' })
  await drive(store, workerId)
  await drive(store, reviewerId)
  await addReview(store, reviewerId, { artifactRef: GIT_A, reviewOfExecutionId: workerId })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('独立 reviewer')))
})

test('stale artifact on the root worker fails closed', async () => {
  const store = await newStore()
  const { taskId, workerId } = await buildIndependentProof(store)
  await store.updateExecutionStatus(workerId, { status: 'succeeded', artifactRef: GIT_B }, { idempotencyKey: key() })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('exitCode=0')))
})

test('failed reviewer does not satisfy the review requirement', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const workerId = await createWorker(store, taskId, { artifactRef: GIT_A })
  await addVerification(store, workerId, GIT_A, { exitCode: 0 })
  const reviewerId = await createReviewer(store, taskId, { parentExecutionId: workerId })
  await drive(store, workerId)
  await drive(store, reviewerId, ['running', 'failed'])
  await addReview(store, reviewerId, { artifactRef: GIT_A, reviewOfExecutionId: workerId })
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('独立 reviewer')))
})

test('reviewer-only success cannot complete the task', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  const reviewerId = await createReviewer(store, taskId, { parentExecutionId: 'execution_root' })
  await drive(store, reviewerId)
  const plan = await store.completionPlan(taskId)
  assert.equal(plan.ready, false)
  assert.ok(plan.reasons.some((reason) => reason.includes('root worker')))
})

test('changed artifact invalidates an already-issued approval', async () => {
  const store = await newStore()
  const { taskId, reviewerId } = await buildIndependentProof(store)
  const { plan, approval } = await approveCompletion(store, taskId)
  assert.equal(plan.ready, true, plan.reasons.join('; '))
  await store.updateExecutionStatus(reviewerId, { status: 'succeeded', artifactRef: GIT_B }, { idempotencyKey: key() })
  await assert.rejects(
    store.completeTask(taskId, { approvalId: approval.approval.id }, { idempotencyKey: key() }),
    (error) => ['APPROVAL_SCOPE_MISMATCH', 'TASK_NOT_READY'].includes(error.code),
  )
})

test('artifact change invalidates the stored completion proof', async () => {
  const store = await newStore()
  const { taskId, workerId } = await buildIndependentProof(store)
  const { approval } = await approveCompletion(store, taskId)
  await store.completeTask(taskId, { approvalId: approval.approval.id }, { idempotencyKey: key() })
  let { task } = await store.getTask(taskId)
  assert.ok(task.completionProof)
  await store.updateExecutionStatus(workerId, { status: 'succeeded', artifactRef: GIT_B }, { idempotencyKey: key() })
  ;({ task } = await store.getTask(taskId))
  assert.equal(task.completionProof, undefined)
})

test('malformed artifact refs are rejected', async () => {
  const store = await newStore()
  const taskId = await newTask(store)
  await assert.rejects(
    store.createExecution(taskId, { workerId: 'w1', artifactRef: 'git:xyz' }, { idempotencyKey: key() }),
    (error) => error.name === 'ContractError',
  )
  await assert.rejects(
    store.createExecution(taskId, { workerId: 'w2', artifactRef: `git:${'a'.repeat(39)}` }, { idempotencyKey: key() }),
    (error) => error.name === 'ContractError',
  )
  await assert.rejects(
    store.createExecution(taskId, { workerId: 'w3', artifactRef: `sha256:${'a'.repeat(63)}` }, { idempotencyKey: key() }),
    (error) => error.name === 'ContractError',
  )
  const valid = await store.createExecution(taskId, { workerId: 'w4', artifactRef: SHA_A }, { idempotencyKey: key() })
  assert.equal(valid.execution.artifactRef, SHA_A)
  await assert.rejects(
    store.addEvidence(valid.execution.id, { kind: 'test', summary: 's', source: 's', artifactRef: 'nope' }, { idempotencyKey: key() }),
    (error) => error.name === 'ContractError',
  )
  await assert.rejects(
    store.updateExecutionStatus(valid.execution.id, { status: 'succeeded', artifactRef: 'nope' }, { idempotencyKey: key() }),
    (error) => error.code === 'INVALID_ARTIFACT_REF',
  )
})

test('legacy completed tasks without artifacts stay unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-gate-legacy-'))
  tempDirs.push(dir)
  const at = new Date().toISOString()
  const state = {
    version: 1,
    tasks: {
      task_legacy: {
        contractVersion: 1,
        type: 'Task',
        id: 'task_legacy',
        goal: 'legacy goal',
        status: 'completed',
        constraints: [],
        acceptanceCriteria: [],
        executionIds: [],
        createdAt: at,
        updatedAt: at,
      },
    },
    executions: {},
    evidence: {},
    approvals: {},
    idempotency: {},
    locks: {},
    events: [],
  }
  await fs.writeFile(path.join(dir, 'control-plane.json'), JSON.stringify(state), 'utf8')
  const store = new ControlPlaneStore({ stateDir: dir })
  const tasks = await store.listTasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'completed')
  const plan = await store.completionPlan('task_legacy')
  assert.equal(plan.ready, false)
})
