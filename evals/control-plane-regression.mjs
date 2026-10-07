#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ControlPlaneStore, StoreError, parametersDigest } from '../control-plane/store.mjs'
import { cezarDispatchPlan } from '../control-plane/dispatcher.mjs'

const cases = [
  {
    id: 'idempotency.no_duplicate_task',
    run: async (store) => {
      const first = await store.createTask({ goal: 'eval' }, { idempotencyKey: 'eval-task' })
      const replay = await store.createTask({ goal: 'eval' }, { idempotencyKey: 'eval-task' })
      assert.equal(replay.replay, true)
      assert.equal(replay.task.id, first.task.id)
      assert.equal((await store.listTasks()).length, 1)
    },
  },
  {
    id: 'state.invalid_transition_rejected',
    run: async (store) => {
      const task = await store.createTask({ goal: 'eval' }, { idempotencyKey: 'transition-task' })
      const execution = await store.createExecution(task.task.id, { workerId: 'eval' }, { idempotencyKey: 'transition-execution' })
      await assert.rejects(() => store.updateExecutionStatus(execution.execution.id, { status: 'succeeded' }, { idempotencyKey: 'transition-invalid' }), (error) => error instanceof StoreError && error.code === 'INVALID_TRANSITION')
    },
  },
  {
    id: 'approval.scope_mismatch_rejected',
    run: async (store) => {
      const approval = await store.createApproval({ action: 'eval.action', target: 'target-a', parametersDigest: 'sha256:a' }, { idempotencyKey: 'approval-create' })
      await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'eval' }, { idempotencyKey: 'approval-decide' })
      await assert.rejects(() => store.consumeApproval(approval.approval.id, { action: 'eval.action', target: 'target-b', parametersDigest: 'sha256:a' }, { idempotencyKey: 'approval-consume' }), (error) => error instanceof StoreError && error.code === 'APPROVAL_SCOPE_MISMATCH')
    },
  },
  {
    id: 'session.lock.prevents_overlap',
    run: async (store) => {
      await store.acquireSessionLock('session:eval:1', { owner: 'eval', ttlMs: 10_000 }, { idempotencyKey: 'lock-create' })
      await assert.rejects(() => store.acquireSessionLock('session:eval:1', { owner: 'other', ttlMs: 10_000 }, { idempotencyKey: 'lock-conflict' }), (error) => error instanceof StoreError && error.code === 'SESSION_LOCKED')
    },
  },
  {
    id: 'recovery.running_becomes_blocked',
    run: async (store) => {
      const task = await store.createTask({ goal: 'eval' }, { idempotencyKey: 'recovery-task' })
      const execution = await store.createExecution(task.task.id, { workerId: 'eval' }, { idempotencyKey: 'recovery-execution' })
      await store.updateExecutionStatus(execution.execution.id, { status: 'running' }, { idempotencyKey: 'recovery-running' })
      const restarted = new ControlPlaneStore({ stateDir: store.stateDir })
      const recovery = await restarted.recoverOnStartup()
      assert.deepEqual(recovery.blockedExecutionIds, [execution.execution.id])
    },
  },
  {
    id: 'completion.requires_review_and_verification',
    run: async (store) => {
      const task = await store.createTask({ goal: 'eval' }, { idempotencyKey: 'complete-task' })
      const artifactRef = `git:${'a'.repeat(40)}`
      const execution = await store.createExecution(task.task.id, { workerId: 'eval', artifactRef }, { idempotencyKey: 'complete-execution' })
      for (const [index, status] of ['running', 'verifying', 'reviewing', 'succeeded'].entries()) await store.updateExecutionStatus(execution.execution.id, { status }, { idempotencyKey: `complete-status-${index}` })
      await store.addEvidence(execution.execution.id, { kind: 'test', summary: 'passed', source: 'eval', artifactRef, exitCode: 0 }, { idempotencyKey: 'complete-test' })
      const notReady = await store.completionPlan(task.task.id)
      assert.equal(notReady.ready, false)
      const reviewer = await store.createExecution(task.task.id, { workerId: 'eval-reviewer', parentExecutionId: execution.execution.id, artifactRef }, { idempotencyKey: 'eval-reviewer' })
      for (const status of ['running', 'verifying', 'reviewing', 'succeeded']) await store.updateExecutionStatus(reviewer.execution.id, { status }, { idempotencyKey: `eval-reviewer-${status}` })
      await store.addEvidence(reviewer.execution.id, { kind: 'review', summary: 'approved', source: 'eval-reviewer', artifactRef, verdict: 'passed', reviewOfExecutionId: execution.execution.id }, { idempotencyKey: 'complete-review' })
      const ready = await store.completionPlan(task.task.id)
      assert.equal(ready.ready, true)
      const approval = await store.createApproval({ action: ready.action, target: ready.target, parametersDigest: ready.parametersDigest }, { idempotencyKey: 'complete-approval' })
      await store.decideApproval(approval.approval.id, { decision: 'approved', approvedBy: 'eval' }, { idempotencyKey: 'complete-decision' })
      const completed = await store.completeTask(task.task.id, { approvalId: approval.approval.id }, { idempotencyKey: 'complete-final' })
      assert.equal(completed.task.status, 'completed')
    },
  },
  {
    id: 'cezar.dispatch.digest_is_bound',
    run: async () => {
      const plan = cezarDispatchPlan({ taskId: 'task', executionId: 'execution', runner: 'codex', workflow: 'quick-task', worktree: true })
      assert.equal(plan.action, 'cezar.dispatch')
      assert.equal(plan.parametersDigest, parametersDigest(plan.parameters))
      assert.equal(plan.requiresApproval, true)
    },
  },
]

const results = []
for (const item of cases) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-ai-os-eval-'))
  const started = Date.now()
  try {
    await item.run(new ControlPlaneStore({ stateDir }))
    results.push({ id: item.id, status: 'passed', durationMs: Date.now() - started })
  } catch (error) {
    results.push({ id: item.id, status: 'failed', durationMs: Date.now() - started, error: String(error) })
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
}

const report = { type: 'PersonalAiOsRegressionReport', version: 1, passed: results.filter((item) => item.status === 'passed').length, failed: results.filter((item) => item.status === 'failed').length, cases: results }
console.log(JSON.stringify(report, null, 2))
if (report.failed > 0) process.exitCode = 1
