import { GoalAI } from './goal-ai.mjs'
import { workspaceState, applyProposal, runChecks } from './goal-workspace.mjs'
import crypto from 'node:crypto'

/** Persistent scheduler. Agents propose; this process owns file and evidence writes. */
export class GoalRuntime {
  constructor({ goals, tasks, ai = new GoalAI(), checks = runChecks, tickMs = 1000 } = {}) {
    this.goals = goals; this.tasks = tasks; this.ai = ai; this.checks = checks; this.tickMs = tickMs
    this.active = new Map(); this.closed = false; this.ticking = false
    this.owner = `daemon:${process.pid}:${crypto.randomUUID()}`
  }
  async start() {
    await this.reconcileCompleted()
    await this.goals.recover()
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    await this.tick()
  }
  async tick() {
    if (this.closed || this.ticking || this.active.size) return
    this.ticking = true
    try {
      if (await this.goals.isPaused()) return
      await this.reconcileCompleted()
      if ((await this.goals.list()).some(goal => goal.status === 'running' || (goal.status === 'waiting' && goal.needsRecovery))) await this.goals.recover()
      const next = (await this.goals.list()).find(goal => goal.status === 'ready' && Number(goal.nextWakeAt ?? 0) <= Date.now())
      if (!next) return
      const goal = await this.goals.claim(next.id, { owner: this.owner, leaseMs: 15000 })
      if (!goal || goal.status !== 'running') return
      const controller = new AbortController()
      const job = this.run(goal, controller).finally(() => this.active.delete(goal.id))
      this.active.set(goal.id, { controller, job })
    } catch { /* failure remains in private state; no raw provider content is logged */ }
    finally { this.ticking = false }
  }
  abort(id) { this.active.get(id)?.controller.abort(new Error('goal paused, cancelled or revised')) }
  async stop() {
    this.closed = true; clearInterval(this.timer)
    for (const { controller } of this.active.values()) controller.abort(new Error('goal runtime stopping'))
    await Promise.allSettled([...this.active.values()].map(item => item.job))
  }
  async reconcileCompleted() {
    for (const goal of await this.goals.list()) {
      if (!goal.spec.recovery?.enabled || !goal.taskId || !goal.artifactRef || !['running', 'waiting', 'ready'].includes(goal.status)) continue
      try {
        const { task } = await this.tasks.getTask(goal.taskId)
        if (task.status !== 'completed' || !/^sha256:[a-f0-9]{64}$/.test(task.completionProof?.parametersDigest ?? '') || !task.completionProof?.at) continue
        const current = await workspaceState(goal)
        if (current.artifactRef !== goal.artifactRef) continue
        await this.goals.reconcileCompleted(goal.id, { generation: goal.generation, specDigest: goal.specDigest, taskId: task.id, artifactRef: current.artifactRef, completed: true, completedAt: task.completionProof.at })
      } catch { /* Missing or mismatched evidence never causes execution or completion. */ }
    }
  }
  async run(goal, controller) {
    const token = goal.lease.token
    const deadline = setTimeout(() => controller.abort(new Error('goal deadline reached')), Math.max(1, Date.parse(goal.grant.expiresAt) - Date.now()))
    const heartbeat = setInterval(() => { void this.goals.heartbeat(goal.id, token).catch(() => controller.abort(new Error('goal lease expired'))) }, 5000)
    let taskId, workerId, reviewId
    const key = suffix => `${goal.id}:${goal.generation}:${goal.iterations}:${suffix}`
    const phase = value => this.goals.checkpoint(goal.id, token, { phase: value })
    const call = async (role, state) => {
      await phase(role)
      return this.ai.call(role, state, { signal: controller.signal,
        reserve: count => this.goals.reserve(goal.id, token, count),
        reconcile: (reserved, actual) => this.goals.reconcileUsage(goal.id, token, reserved, actual) })
    }
    try {
      const before = await workspaceState(goal)
      const saved = goal.resumeCheckpoint
      const restoring = saved?.proposal && saved.generation === goal.generation && saved.specDigest === goal.specDigest
      if (restoring) {
        if (!Array.isArray(saved.beforeFiles) || !Array.isArray(saved.proposal.files) || typeof saved.writerIdentity !== 'string') throw new Error('CHECKPOINT_CONFLICT: invalid saved proposal provenance')
        for (const file of before.files) {
          const original = saved.beforeFiles?.find(item => item.path === file.path)
          const proposed = saved.proposal.files?.find(item => item.path === file.path)
          if (!original || (file.content !== original.content && (!file.writable || file.content !== proposed?.content))) throw new Error('CHECKPOINT_CONFLICT: workspace changed outside the saved proposal')
        }
      }
      let checkpoint = restoring ? saved : { generation: goal.generation, specDigest: goal.specDigest, beforeFiles: before.files }
      const common = { objective: goal.spec.objective, writePaths: goal.spec.writePaths, checks: goal.spec.checks, files: before.files,
        priorSummary: goal.summary, priorChecks: goal.lastChecks, constraints: 'Only approved files in this isolated workspace; acceptance files cannot change. No external messages, deployment or credentials.' }
      const { task } = await this.tasks.createTask({ goal: goal.spec.objective, chief: 'kimi/planner', acceptanceCriteria: goal.spec.checks.map(check => check.name) }, { idempotencyKey: key('task') })
      taskId = task.id
      await this.goals.checkpoint(goal.id, token, { taskId })
      const plan = restoring ? { result: { instruction: '接续已保存且范围匹配的提案，不再次派发 Worker' } } : await call('planner', common)
      if (typeof plan.result.instruction !== 'string' || !plan.result.instruction.trim()) throw new Error('chief returned no usable next step')
      const { execution } = await this.tasks.createExecution(taskId, { workerId: restoring ? 'checkpoint-recovery/controller' : 'deepseek-official/deepseek-flash', artifactRef: before.artifactRef }, { idempotencyKey: key('worker') })
      workerId = execution.id
      await this.tasks.updateExecutionStatus(workerId, { status: 'running' }, { idempotencyKey: key('working') })
      const proposal = restoring ? { result: saved.proposal, identity: saved.writerIdentity } : await call('worker', { ...common, instruction: plan.result.instruction })
      checkpoint = { ...checkpoint, proposal: proposal.result, writerIdentity: proposal.identity }
      await this.goals.checkpoint(goal.id, token, { phase: 'applying', resumeCheckpoint: checkpoint })
      const pendingProposal = restoring ? { ...proposal.result, files: proposal.result.files.filter(file => before.files.find(current => current.path === file.path)?.content !== file.content) } : proposal.result
      await this.goals.withLease(goal.id, token, () => applyProposal(goal, pendingProposal))
      const after = await workspaceState(goal)
      await this.tasks.updateExecutionStatus(workerId, { status: 'verifying', artifactRef: after.artifactRef }, { idempotencyKey: key('verifying') })
      checkpoint = { ...checkpoint, afterArtifactRef: after.artifactRef }; delete checkpoint.checks
      await this.goals.checkpoint(goal.id, token, { phase: 'verifying', artifactRef: after.artifactRef, resumeCheckpoint: checkpoint })
      const checks = await this.checks(goal, { signal: controller.signal })
      const checked = await workspaceState(goal)
      const allPassed = checks.length === goal.spec.checks.length && checks.every(check => check.exitCode === 0 && !check.timedOut) && checked.artifactRef === after.artifactRef
      checkpoint = { ...checkpoint, checks, checkedArtifactRef: checked.artifactRef }
      await this.goals.checkpoint(goal.id, token, { lastChecks: checks, resumeCheckpoint: checkpoint })
      for (const [index, check] of checks.entries()) {
        await this.tasks.addEvidence(workerId, { kind: 'test', summary: check.output.slice(0, 2000) || check.name, source: 'seatbelt/node-test', exitCode: check.exitCode ?? 1, artifactRef: after.artifactRef }, { idempotencyKey: key(`check:${index}`) })
      }
      if (!allPassed) {
        await this.tasks.updateExecutionStatus(workerId, { status: 'failed', outcome: 'real acceptance checks failed or changed the artifact' }, { idempotencyKey: key('failed-checks') })
        await this.goals.settle(goal.id, token, { outcome: 'retry', summary: '真实验收未通过，下一轮由 Agent 依据失败记录调整方案。', artifactRef: checked.artifactRef, checks, progress: checked.artifactRef !== before.artifactRef, taskId })
        return
      }
      const reviewer = await this.tasks.createExecution(taskId, { workerId: 'kimi/reviewer', parentExecutionId: workerId, artifactRef: after.artifactRef }, { idempotencyKey: key('reviewer') })
      reviewId = reviewer.execution.id
      await this.tasks.updateExecutionStatus(reviewId, { status: 'running' }, { idempotencyKey: key('reviewing-agent') })
      const review = await call('reviewer', { objective: goal.spec.objective, files: checked.files, artifactRef: after.artifactRef, checks, writerIdentity: proposal.identity })
      if (!['passed', 'failed'].includes(review.result.verdict) || typeof review.result.goalMet !== 'boolean' || typeof review.result.summary !== 'string') throw new Error('independent reviewer returned invalid verdict')
      const current = await workspaceState(goal)
      const passed = review.result.verdict === 'passed' && review.result.goalMet && current.artifactRef === after.artifactRef
      await this.tasks.updateExecutionStatus(workerId, { status: 'reviewing' }, { idempotencyKey: key('reviewing') })
      await this.tasks.updateExecutionStatus(reviewId, { status: 'verifying' }, { idempotencyKey: key('review-verifying') })
      await this.tasks.updateExecutionStatus(reviewId, { status: 'reviewing' }, { idempotencyKey: key('review-reviewing') })
      await this.tasks.addEvidence(reviewId, { kind: 'review', summary: review.result.summary.slice(0, 2000), source: review.identity,
        verdict: passed ? 'passed' : 'failed', artifactRef: after.artifactRef, reviewOfExecutionId: workerId }, { idempotencyKey: key('review-evidence') })
      for (const id of [workerId, reviewId]) await this.tasks.updateExecutionStatus(id, { status: passed ? 'succeeded' : 'failed', outcome: review.result.summary.slice(0, 1000) }, { idempotencyKey: key(`verdict:${id}`) })
      if (passed) {
        // Material authority is the explicit, version-bound goal grant. The
        // model cannot create or increase it; legacy unscoped actions stay gated.
        await this.goals.withLease(goal.id, token, async () => {
          const completion = await this.tasks.completionPlan(taskId)
          if (!completion.ready) throw new Error('completion evidence gate rejected the iteration')
          const approval = await this.tasks.createApproval({ action: completion.action, target: completion.target, parametersDigest: completion.parametersDigest,
            decision: 'approved', approvedBy: `goal-grant:${goal.id}:${goal.specDigest}` }, { idempotencyKey: key('completion-approval') })
          await this.tasks.completeTask(taskId, { approvalId: approval.approval.id }, { idempotencyKey: key('complete-task') })
        })
      }
      await this.goals.settle(goal.id, token, { outcome: passed ? 'complete' : 'retry', summary: review.result.summary.slice(0, 1500), artifactRef: current.artifactRef,
        checks, review: { ...review.result, identity: review.identity }, progress: current.artifactRef !== before.artifactRef, taskId })
    } catch (error) {
      for (const id of [workerId, reviewId].filter(Boolean)) {
        const execution = await this.tasks.getExecution(id).catch(() => null)
        if (execution && ['queued', 'running', 'verifying', 'reviewing'].includes(execution.status)) await this.tasks.updateExecutionStatus(id, { status: 'blocked', outcome: 'iteration interrupted; private goal audit has the reason' }, { idempotencyKey: key(`blocked:${id}`) }).catch(() => {})
      }
      if (!controller.signal.aborted) {
        const current = await this.goals.get(goal.id).catch(() => null)
        const retainCheckpoint = Boolean(current?.resumeCheckpoint?.checks && current.resumeCheckpoint.checkedArtifactRef === current.resumeCheckpoint.afterArtifactRef)
        await this.goals.settle(goal.id, token, { outcome: String(error.message).startsWith('CHECKPOINT_CONFLICT') ? 'wait' : 'retry', summary: String(error.message).slice(0, 500), progress: false, taskId, retainCheckpoint }).catch(() => {})
      }
      else await this.goals.interrupt(goal.id, token, String(controller.signal.reason?.message ?? '执行中断，需要核对后恢复')).catch(() => {})
    } finally { clearInterval(heartbeat); clearTimeout(deadline) }
  }
}
