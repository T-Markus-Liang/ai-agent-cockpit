import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createApproval,
  createEvidence,
  createExecution,
  createTask,
  EXECUTION_STATUSES,
  isValidArtifactRef,
} from './contracts.mjs'

const STATE_VERSION = 1
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'ai-agent-cockpit')
const ACTIVE_EXECUTION_STATUSES = new Set(['queued', 'running', 'verifying', 'reviewing'])
const TERMINAL_EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked'])
const TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'cancelled', 'blocked']),
  running: new Set(['verifying', 'failed', 'cancelled', 'blocked']),
  verifying: new Set(['reviewing', 'failed', 'blocked']),
  reviewing: new Set(['succeeded', 'failed', 'blocked']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  blocked: new Set(),
})

export class StoreError extends Error {
  constructor(code, message, status = 409, details = undefined) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function now() {
  return new Date().toISOString()
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex')
}

export function parametersDigest(value) {
  return `sha256:${fingerprint(value)}`
}

function emptyState() {
  return {
    version: STATE_VERSION,
    tasks: {},
    executions: {},
    evidence: {},
    approvals: {},
    idempotency: {},
    locks: {},
    events: [],
  }
}

function safeLimit(value, fallback = 100) {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!parsed || parsed.version !== STATE_VERSION) {
      throw new StoreError('STATE_VERSION_UNSUPPORTED', `unsupported control-plane state version in ${file}`, 500)
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    if (error instanceof StoreError) throw error
    throw new StoreError('STATE_READ_FAILED', `unable to read control-plane state: ${error.message}`, 500)
  }
}

export class ControlPlaneStore {
  constructor({ stateDir = process.env.PERSONAL_AI_OS_STATE_DIR ?? DEFAULT_STATE_DIR, lockTimeoutMs = 4000 } = {}) {
    this.stateDir = path.resolve(stateDir)
    this.stateFile = path.join(this.stateDir, 'control-plane.json')
    this.lockFile = path.join(this.stateDir, 'control-plane.lock')
    this.lockTimeoutMs = lockTimeoutMs
  }

  async exists() {
    return existsSync(this.stateFile)
  }

  async read() {
    return readJson(this.stateFile)
  }

  async #acquireFileLock() {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    // ponytail: use SQLite's OS-released write lock only for coordination;
    // records stay in the existing JSON file. Dead-owner reclaimers serialize.
    const mutexFile = path.join(this.stateDir, 'control-plane-mutex.sqlite')
    const mutex = new DatabaseSync(mutexFile)
    const mutexStarted = Date.now()
    let reserved = false
    try {
      await fs.chmod(mutexFile, 0o600)
      mutex.exec('PRAGMA busy_timeout=0')
      while (Date.now() - mutexStarted < this.lockTimeoutMs) {
        try { mutex.exec('BEGIN IMMEDIATE'); reserved = true; break }
        catch (error) {
          if (![5, 6].includes(error.errcode)) throw new StoreError('LOCK_FAILED', 'control-plane coordination failed', 500)
          await sleep(25)
        }
      }
      if (!reserved) throw new StoreError('LOCK_TIMEOUT', 'control-plane state is busy; retry the operation', 409)
    const token = crypto.randomUUID()
    const candidate = `${this.lockFile}.${token}.candidate`
    await fs.writeFile(candidate, JSON.stringify({ pid: process.pid, token, acquiredAt: now() }), { flag: 'wx', mode: 0o600 })
    const started = Date.now()
    try {
    while (Date.now() - started < this.lockTimeoutMs) {
      try {
        // Publish a complete owner record, never an empty half-written lock.
        await fs.link(candidate, this.lockFile)
        return { token, mutex }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new StoreError('LOCK_FAILED', error.message, 500)
        try {
          const held = JSON.parse(await fs.readFile(this.lockFile, 'utf8'))
          if (Number.isSafeInteger(held.pid) && held.pid > 0) {
            let dead = false
            try { process.kill(held.pid, 0) } catch (error) { dead = error.code === 'ESRCH' }
            if (dead) {
              const current = JSON.parse(await fs.readFile(this.lockFile, 'utf8'))
              if (current.pid === held.pid && current.token === held.token) await fs.unlink(this.lockFile)
            }
          }
        } catch {
          // Malformed/unknown ownership is never reclaimed by age. A concurrent
          // release may remove the file; the next link attempt observes that.
        }
        await sleep(25)
      }
    }
    throw new StoreError('LOCK_TIMEOUT', 'control-plane state is busy; retry the operation', 409)
    } finally { await fs.unlink(candidate).catch(() => {}) }
    } catch (error) {
      if (reserved) { try { mutex.exec('ROLLBACK') } catch {} }
      mutex.close()
      throw error
    }
  }

  async #releaseFileLock({ token, mutex }) {
    try {
    const owner = await fs.readFile(this.lockFile, 'utf8').then(JSON.parse).catch(() => null)
    if (owner?.pid === process.pid && owner.token === token) await fs.unlink(this.lockFile).catch(() => {})
    } finally {
      try { mutex.exec('ROLLBACK') } finally { mutex.close() }
    }
  }

  async #write(state, token) {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.stateDir, `.control-plane.${process.pid}.${crypto.randomUUID()}.tmp`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync() } finally { await handle.close() }
    const owner = await fs.readFile(this.lockFile, 'utf8').then(JSON.parse).catch(() => null)
    if (owner?.pid !== process.pid || owner.token !== token) {
      await fs.unlink(temporary).catch(() => {})
      throw new StoreError('LOCK_OWNER_CHANGED', 'control-plane write owner changed', 409)
    }
    await fs.rename(temporary, this.stateFile)
    const directory = await fs.open(this.stateDir, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async #mutate(mutator) {
    const lock = await this.#acquireFileLock()
    try {
      const state = await readJson(this.stateFile)
      const result = await mutator(state)
      await this.#write(state, lock.token)
      return result
    } finally {
      await this.#releaseFileLock(lock)
    }
  }

  #remember(state, { type, entityType, entityId, details = {} }) {
    const event = { id: randomId('event'), type, entityType, entityId, details, at: now() }
    state.events.push(event)
    if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000)
    return event
  }

  #idempotent(state, key, request, operation, execute) {
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new StoreError('IDEMPOTENCY_REQUIRED', 'write operations require an Idempotency-Key header', 400)
    }
    const normalized = key.trim()
    const requestFingerprint = fingerprint(request)
    const previous = state.idempotency[normalized]
    if (previous) {
      if (previous.fingerprint !== requestFingerprint) {
        throw new StoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was already used for a different request', 409)
      }
      return { replay: true, result: previous.result }
    }
    const result = execute()
    state.idempotency[normalized] = { operation, fingerprint: requestFingerprint, result, at: now() }
    return { replay: false, result }
  }

  #pruneLocks(state) {
    const at = Date.now()
    for (const [sessionRefId, lock] of Object.entries(state.locks)) {
      if (Date.parse(lock.expiresAt) <= at) delete state.locks[sessionRefId]
    }
  }

  #completionPlanState(state, taskId) {
    const task = state.tasks[taskId]
    if (!task) throw new StoreError('TASK_NOT_FOUND', `task ${taskId} was not found`, 404)
    const executions = task.executionIds.map((id) => state.executions[id]).filter(Boolean)
    const evidence = executions.flatMap((execution) => (execution.evidenceIds ?? []).map((id) => state.evidence[id]).filter(Boolean))
    const allTerminal = executions.length > 0 && executions.every((execution) => TERMINAL_EXECUTION_STATUSES.has(execution.status))
    const succeededById = new Map(executions.filter((execution) => execution.status === 'succeeded').map((execution) => [execution.id, execution]))
    const rootWorkers = [...succeededById.values()].filter((execution) => !execution.parentExecutionId)
    const parameters = {
      taskId,
      executionIds: executions.map((execution) => `${execution.id}:${execution.status}:${execution.artifactRef ?? ''}`).sort(),
      evidenceIds: evidence.map((item) => `${item.id}:${item.kind}:${item.exitCode ?? ''}:${item.artifactRef ?? ''}:${item.verdict ?? ''}:${item.reviewOfExecutionId ?? ''}`).sort(),
    }
    const reasons = []
    if (!allTerminal) reasons.push('所有 Execution 必须先进入终态')
    if (task.status === 'completed') reasons.push('Task 已经完成')
    if (rootWorkers.length === 0) reasons.push('至少需要一个 succeeded 的 root worker Execution')
    for (const worker of rootWorkers) {
      if (!worker.artifactRef) {
        reasons.push(`worker ${worker.id} 缺少 artifactRef`)
        continue
      }
      const workerEvidence = (worker.evidenceIds ?? []).map((id) => state.evidence[id]).filter(Boolean)
      const passingVerification = workerEvidence.some((item) => (
        (item.kind === 'test' || item.kind === 'command')
        && item.exitCode === 0
        && item.artifactRef === worker.artifactRef
      ))
      if (!passingVerification) reasons.push(`worker ${worker.id} 缺少 exitCode=0 且 artifactRef 匹配的 test/command Evidence`)
      if (workerEvidence.some(item => ['test', 'command'].includes(item.kind) && item.artifactRef === worker.artifactRef && item.exitCode !== 0)) reasons.push(`worker ${worker.id} 当前版本仍有失败或未完成的验证`)
      const independentReview = evidence.some((item) => {
        if (item.kind !== 'review' || item.verdict !== 'passed') return false
        if (item.artifactRef !== worker.artifactRef) return false
        if (item.reviewOfExecutionId !== worker.id) return false
        const reviewer = succeededById.get(item.executionId)
        if (!reviewer || reviewer.id === worker.id) return false
        if (reviewer.parentExecutionId !== worker.id) return false
        return reviewer.workerId !== worker.workerId && reviewer.artifactRef === worker.artifactRef
      })
      if (!independentReview) reasons.push(`worker ${worker.id} 缺少独立 reviewer 的 passed review Evidence`)
    }
    return {
      action: 'task.complete',
      target: taskId,
      parameters,
      parametersDigest: parametersDigest(parameters),
      ready: reasons.length === 0 && task.status !== 'completed',
      reasons,
    }
  }

  #consumeApprovalState(state, approvalId, input) {
    const approval = state.approvals[approvalId]
    if (!approval) throw new StoreError('APPROVAL_NOT_FOUND', `approval ${approvalId} was not found`, 404)
    if (approval.decision !== 'approved') throw new StoreError('APPROVAL_NOT_APPROVED', `approval is ${approval.decision}`, 409)
    if (approval.usedAt) throw new StoreError('APPROVAL_ALREADY_USED', 'approval has already been consumed', 409)
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      approval.decision = 'expired'
      throw new StoreError('APPROVAL_EXPIRED', 'approval has expired', 409)
    }
    for (const field of ['action', 'target', 'parametersDigest']) {
      if (String(input?.[field] ?? '') !== String(approval[field])) throw new StoreError('APPROVAL_SCOPE_MISMATCH', `approval does not cover ${field}`, 403)
    }
    approval.usedAt = now()
    this.#remember(state, { type: 'approval.consumed', entityType: 'Approval', entityId: approvalId, details: { action: approval.action, target: approval.target } })
    return approval
  }

  async createTask(input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { input, operation: 'task.create' }
      const result = this.#idempotent(state, idempotencyKey, request, 'task.create', () => {
        if (input?.status && !['draft', 'planned'].includes(input.status)) throw new StoreError('INVALID_INITIAL_STATUS', 'new tasks must start in draft or planned status', 400)
        const task = createTask({ ...input, status: input?.status ?? 'draft' })
        if (state.tasks[task.id]) throw new StoreError('TASK_EXISTS', `task ${task.id} already exists`, 409)
        state.tasks[task.id] = task
        this.#remember(state, { type: 'task.created', entityType: 'Task', entityId: task.id })
        return { taskId: task.id }
      })
      return { ...result, task: state.tasks[result.result.taskId] }
    })
  }

  async listTasks({ status, limit, sourceRequestId } = {}) {
    const state = await this.read()
    const tasks = Object.values(state.tasks)
      .filter((task) => !status || task.status === status)
      .filter((task) => !sourceRequestId || task.sourceRequestId === sourceRequestId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, safeLimit(limit))
    return tasks
  }

  async getTask(taskId) {
    const state = await this.read()
    const task = state.tasks[taskId]
    if (!task) throw new StoreError('TASK_NOT_FOUND', `task ${taskId} was not found`, 404)
    return {
      task,
      executions: task.executionIds.map((id) => state.executions[id]).filter(Boolean),
      evidence: task.executionIds.flatMap((id) => state.executions[id]?.evidenceIds ?? [])
        .map((id) => state.evidence[id]).filter(Boolean),
    }
  }

  async completionPlan(taskId) {
    const state = await this.read()
    return this.#completionPlanState(state, taskId)
  }

  async completeTask(taskId, { approvalId } = {}, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { taskId, approvalId, operation: 'task.complete' }
      const result = this.#idempotent(state, idempotencyKey, request, 'task.complete', () => {
        const plan = this.#completionPlanState(state, taskId)
        if (!plan.ready) throw new StoreError('TASK_NOT_READY', `task ${taskId} is not ready for completion`, 409, { reasons: plan.reasons, plan })
        if (!approvalId) throw new StoreError('APPROVAL_REQUIRED', 'task completion requires an approved approval id', 403)
        this.#consumeApprovalState(state, approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest })
        const task = state.tasks[taskId]
        task.status = 'completed'
        task.updatedAt = now()
        task.completionProof = { parametersDigest: plan.parametersDigest, at: now() }
        this.#remember(state, { type: 'task.completed', entityType: 'Task', entityId: taskId, details: { evidenceCount: plan.parameters.evidenceIds.length } })
        return { taskId, approvalId }
      })
      return { ...result, task: state.tasks[result.result.taskId], approval: state.approvals[result.result.approvalId] }
    })
  }

  async getExecution(executionId) {
    const state = await this.read()
    const execution = state.executions[executionId]
    if (!execution) throw new StoreError('EXECUTION_NOT_FOUND', `execution ${executionId} was not found`, 404)
    return execution
  }

  async createExecution(taskId, input, { idempotencyKey, executionGuard } = {}) {
    if (input?.status !== undefined && input.status !== 'queued') throw new StoreError('INVALID_INITIAL_STATUS', 'new executions must start queued', 400)
    return this.#mutate(async (state) => {
      this.#pruneLocks(state)
      const request = { taskId, input, operation: 'execution.create', ...(executionGuard === undefined ? {} : { executionGuard }) }
      const result = this.#idempotent(state, idempotencyKey, request, 'execution.create', () => {
        const task = state.tasks[taskId]
        if (!task) throw new StoreError('TASK_NOT_FOUND', `task ${taskId} was not found`, 404)
        if (executionGuard !== undefined) {
          // Recheck under the same durable write lock as creation. A prior
          // getTask() is advisory and cannot fence cancellation between reads.
          const parent = state.executions[executionGuard?.executionId]
          if (!executionGuard || Object.keys(executionGuard).some(key => !['taskId', 'executionId'].includes(key)) ||
              executionGuard.taskId !== taskId || executionGuard.executionId !== input?.parentExecutionId ||
              !parent || parent.taskId !== taskId || !ACTIVE_EXECUTION_STATUSES.has(parent.status) ||
              ['completed', 'cancelled', 'failed', 'blocked'].includes(task.status)) {
            throw new StoreError('EXECUTION_SCOPE_CHANGED', 'parent execution is no longer in the controlled scope', 403)
          }
        }
        const execution = createExecution({ ...input, taskId, status: input?.status ?? 'queued' })
        if (state.executions[execution.id]) throw new StoreError('EXECUTION_EXISTS', `execution ${execution.id} already exists`, 409)
        if (execution.sessionRefId) {
          const locked = state.locks[execution.sessionRefId]
          if (locked && Date.parse(locked.expiresAt) > Date.now() && input?.sessionLockToken !== locked.token) {
            throw new StoreError('SESSION_LOCKED', `session ${execution.sessionRefId} is locked by ${locked.owner}`, 409)
          }
          const active = Object.values(state.executions).find((candidate) => candidate.sessionRefId === execution.sessionRefId && ACTIVE_EXECUTION_STATUSES.has(candidate.status))
          if (active) throw new StoreError('SESSION_BUSY', `session ${execution.sessionRefId} is already used by ${active.id}`, 409)
        }
        execution.evidenceIds = []
        state.executions[execution.id] = execution
        task.executionIds.push(execution.id)
        task.status = task.status === 'draft' || task.status === 'planned' ? 'queued' : task.status
        task.updatedAt = now()
        this.#remember(state, { type: 'execution.created', entityType: 'Execution', entityId: execution.id, details: { taskId } })
        return { executionId: execution.id }
      })
      return { ...result, execution: state.executions[result.result.executionId] }
    })
  }

  async updateExecutionStatus(executionId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { executionId, input, operation: 'execution.status' }
      const result = this.#idempotent(state, idempotencyKey, request, 'execution.status', () => {
        const execution = state.executions[executionId]
        if (!execution) throw new StoreError('EXECUTION_NOT_FOUND', `execution ${executionId} was not found`, 404)
        const next = input?.status
        if (!EXECUTION_STATUSES.includes(next)) throw new StoreError('INVALID_STATUS', `invalid execution status ${next}`, 400)
        let providedArtifactRef
        if (input?.artifactRef !== undefined && input?.artifactRef !== null) {
          if (!isValidArtifactRef(input.artifactRef)) {
            throw new StoreError('INVALID_ARTIFACT_REF', 'artifactRef must match git:<40-64 hex> or sha256:<64 hex>', 400)
          }
          providedArtifactRef = String(input.artifactRef).trim()
        }
        const artifactChanged = providedArtifactRef !== undefined && providedArtifactRef !== execution.artifactRef
        if (execution.status === next) {
          if (artifactChanged) {
            const fromArtifactRef = execution.artifactRef
            execution.artifactRef = providedArtifactRef
            execution.updatedAt = now()
            delete execution.completionProof
            const owner = state.tasks[execution.taskId]
            if (owner) delete owner.completionProof
            this.#remember(state, { type: 'execution.artifact_changed', entityType: 'Execution', entityId: executionId, details: { from: fromArtifactRef ?? null, to: providedArtifactRef } })
          }
          return { executionId }
        }
        if (!TRANSITIONS[execution.status]?.has(next)) {
          throw new StoreError('INVALID_TRANSITION', `cannot move execution from ${execution.status} to ${next}`, 409)
        }
        const previousStatus = execution.status
        execution.status = next
        execution.updatedAt = now()
        if (providedArtifactRef !== undefined) execution.artifactRef = providedArtifactRef
        if (artifactChanged) {
          delete execution.completionProof
          const owner = state.tasks[execution.taskId]
          if (owner) delete owner.completionProof
        }
        if (input?.outcome !== undefined) execution.outcome = String(input.outcome)
        if (TERMINAL_EXECUTION_STATUSES.has(next)) execution.finishedAt = now()
        const task = state.tasks[execution.taskId]
        if (task) {
          if (next === 'running') task.status = 'running'
          else if (next === 'verifying') task.status = 'verifying'
          else if (next === 'reviewing') task.status = 'reviewing'
          else if (next === 'failed') task.status = 'failed'
          else if (next === 'cancelled') task.status = 'cancelled'
          else if (next === 'blocked') task.status = 'blocked'
          task.updatedAt = now()
        }
        this.#remember(state, { type: 'execution.status_changed', entityType: 'Execution', entityId: executionId, details: { from: previousStatus, to: next } })
        return { executionId }
      })
      return { ...result, execution: state.executions[result.result.executionId] }
    })
  }

  async attachExecutionRef(executionId, engineRef, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { executionId, engineRef, operation: 'execution.attach-ref' }
      const result = this.#idempotent(state, idempotencyKey, request, 'execution.attach-ref', () => {
        const execution = state.executions[executionId]
        if (!execution) throw new StoreError('EXECUTION_NOT_FOUND', `execution ${executionId} was not found`, 404)
        if (!engineRef || typeof engineRef.engine !== 'string' || typeof engineRef.id !== 'string') throw new StoreError('INVALID_ENGINE_REF', 'engineRef requires engine and id', 400)
        if (execution.engineRef && (execution.engineRef.engine !== engineRef.engine || execution.engineRef.id !== engineRef.id)) throw new StoreError('ENGINE_REF_CONFLICT', 'execution already references a different engine run', 409)
        execution.engineRef = { ...engineRef }
        execution.updatedAt = now()
        this.#remember(state, { type: 'execution.engine_ref_attached', entityType: 'Execution', entityId: executionId, details: { engine: engineRef.engine, id: engineRef.id } })
        return { executionId }
      })
      return { ...result, execution: state.executions[result.result.executionId] }
    })
  }

  async addEvidence(executionId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { executionId, input, operation: 'evidence.add' }
      const result = this.#idempotent(state, idempotencyKey, request, 'evidence.add', () => {
        const execution = state.executions[executionId]
        if (!execution) throw new StoreError('EXECUTION_NOT_FOUND', `execution ${executionId} was not found`, 404)
        const evidence = createEvidence({ ...input, executionId })
        if (state.evidence[evidence.id]) throw new StoreError('EVIDENCE_EXISTS', `evidence ${evidence.id} already exists`, 409)
        state.evidence[evidence.id] = evidence
        execution.evidenceIds ??= []
        execution.evidenceIds.push(evidence.id)
        execution.updatedAt = now()
        this.#remember(state, { type: 'evidence.added', entityType: 'Evidence', entityId: evidence.id, details: { executionId, kind: evidence.kind } })
        return { evidenceId: evidence.id }
      })
      return { ...result, evidence: state.evidence[result.result.evidenceId] }
    })
  }

  async createApproval(input, { idempotencyKey } = {}) {
    if (input?.decision !== undefined && input.decision !== 'pending') throw new StoreError('APPROVAL_DECISION_FORBIDDEN', 'approvals must be created pending', 400)
    if (Object.hasOwn(input ?? {}, 'approvedBy')) throw new StoreError('APPROVAL_APPROVER_FORBIDDEN', 'approval creation cannot set an approver', 400)
    if (Object.hasOwn(input ?? {}, 'usedAt')) throw new StoreError('APPROVAL_USED_AT_FORBIDDEN', 'approval creation cannot consume an approval', 400)
    return this.#mutate(async (state) => {
      const request = { input, operation: 'approval.create' }
      const result = this.#idempotent(state, idempotencyKey, request, 'approval.create', () => {
        const approval = createApproval({ ...input, decision: 'pending' })
        if (state.approvals[approval.id]) throw new StoreError('APPROVAL_EXISTS', `approval ${approval.id} already exists`, 409)
        state.approvals[approval.id] = approval
        this.#remember(state, { type: 'approval.created', entityType: 'Approval', entityId: approval.id, details: { action: approval.action, target: approval.target } })
        return { approvalId: approval.id }
      })
      return { ...result, approval: state.approvals[result.result.approvalId] }
    })
  }

  async getApproval(approvalId) {
    const state = await this.read()
    const approval = state.approvals[approvalId]
    if (!approval) throw new StoreError('APPROVAL_NOT_FOUND', `approval ${approvalId} was not found`, 404)
    return approval
  }

  async listApprovals({ decision, limit } = {}) {
    const state = await this.read()
    return Object.values(state.approvals)
      .filter((approval) => !decision || approval.decision === decision)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, safeLimit(limit))
  }

  async decideApproval(approvalId, input, { idempotencyKey, principal } = {}) {
    if (principal !== undefined && (principal?.authenticated !== true || principal.role !== 'operator' ||
        typeof principal.id !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(principal.id) || input?.approvedBy !== principal.id)) {
      throw new StoreError('APPROVAL_AUTHORITY_MISMATCH', 'operator authority does not match this decision', 403)
    }
    return this.#mutate(async (state) => {
      const request = { approvalId, input, operation: 'approval.decide', ...(principal === undefined ? {} : { authority: { kind: 'authenticated-operator', subjectId: principal.id } }) }
      const result = this.#idempotent(state, idempotencyKey, request, 'approval.decide', () => {
        const approval = state.approvals[approvalId]
        if (!approval) throw new StoreError('APPROVAL_NOT_FOUND', `approval ${approvalId} was not found`, 404)
        if (approval.usedAt) throw new StoreError('APPROVAL_ALREADY_USED', 'a consumed approval cannot be relabeled', 409)
        const decision = input?.decision
        if (!['approved', 'rejected', 'expired'].includes(decision)) throw new StoreError('INVALID_APPROVAL_DECISION', 'decision must be approved, rejected or expired', 400)
        if (approval.decision !== 'pending' && approval.decision !== decision) throw new StoreError('APPROVAL_ALREADY_DECIDED', `approval is already ${approval.decision}`, 409)
        if (decision === 'approved' && !String(input?.approvedBy ?? '').trim()) throw new StoreError('APPROVER_REQUIRED', 'approvedBy is required to approve an action', 400)
        approval.decision = decision
        if (input?.approvedBy !== undefined) approval.approvedBy = String(input.approvedBy)
        if (principal !== undefined) approval.decisionAuthority = { kind: 'authenticated-operator', subjectId: principal.id }
        this.#remember(state, { type: 'approval.decided', entityType: 'Approval', entityId: approvalId, details: { decision, approvedBy: approval.approvedBy } })
        return { approvalId }
      })
      return { ...result, approval: state.approvals[result.result.approvalId] }
    })
  }

  async consumeApproval(approvalId, input, { idempotencyKey, executionGuard, requireOperator = false } = {}) {
    return this.#mutate(async (state) => {
      const request = { approvalId, input, operation: 'approval.consume', ...(executionGuard === undefined ? {} : { executionGuard }), ...(requireOperator ? { requireOperator: true } : {}) }
      const result = this.#idempotent(state, idempotencyKey, request, 'approval.consume', () => {
        const approval = state.approvals[approvalId]
        if (!approval) throw new StoreError('APPROVAL_NOT_FOUND', `approval ${approvalId} was not found`, 404)
        if (requireOperator && (approval.decisionAuthority?.kind !== 'authenticated-operator' || approval.decisionAuthority.subjectId !== approval.approvedBy)) {
          throw new StoreError('APPROVAL_AUTHORITY_REQUIRED', 'a verified operator decision is required', 403)
        }
        if (requireOperator && !approval.expiresAt) throw new StoreError('APPROVAL_EXPIRY_REQUIRED', 'tool approval requires an explicit expiry', 403)
        if (executionGuard !== undefined) {
          const execution = state.executions[executionGuard.executionId]
          if (!execution || execution.taskId !== executionGuard.taskId || execution.status !== 'running' ||
              execution.engineRef?.engine !== 'native-acp' || ['source', 'nativeSessionId', 'cwd', 'sessionRefId', 'accountId', 'profileId'].some(field => execution.engineRef[field] !== executionGuard[field])) {
            throw new StoreError('EXECUTION_SCOPE_CHANGED', 'native execution is no longer in the approved scope', 403)
          }
        }
        if (approval.decision !== 'approved') throw new StoreError('APPROVAL_NOT_APPROVED', `approval is ${approval.decision}`, 409)
        if (approval.usedAt) throw new StoreError('APPROVAL_ALREADY_USED', 'approval has already been consumed', 409)
        if (approval.expiresAt && (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now())) {
          approval.decision = 'expired'
          throw new StoreError('APPROVAL_EXPIRED', 'approval has expired', 409)
        }
        for (const field of ['action', 'target', 'parametersDigest']) {
          if (String(input?.[field] ?? '') !== String(approval[field])) throw new StoreError('APPROVAL_SCOPE_MISMATCH', `approval does not cover ${field}`, 403)
        }
        approval.usedAt = now()
        this.#remember(state, { type: 'approval.consumed', entityType: 'Approval', entityId: approvalId, details: { action: approval.action, target: approval.target } })
        return { approvalId }
      })
      return { ...result, approval: state.approvals[result.result.approvalId] }
    })
  }

  async acquireSessionLock(sessionRefId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      this.#pruneLocks(state)
      const owner = String(input?.owner ?? '').trim()
      if (!owner) throw new StoreError('OWNER_REQUIRED', 'session lock owner is required', 400)
      const ttlMs = Number(input?.ttlMs ?? 120_000)
      if (!Number.isInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 900_000) throw new StoreError('INVALID_TTL', 'session lock ttl must be between 5 seconds and 15 minutes', 400)
      const request = { sessionRefId, input: { owner, ttlMs }, operation: 'session.lock' }
      const result = this.#idempotent(state, idempotencyKey, request, 'session.lock', () => {
        const current = state.locks[sessionRefId]
        if (current && current.owner !== owner) throw new StoreError('SESSION_LOCKED', `session ${sessionRefId} is locked by ${current.owner}`, 409)
        const lock = current ?? {
          sessionRefId,
          owner,
          token: randomId('lock'),
          acquiredAt: now(),
        }
        lock.expiresAt = new Date(Date.now() + ttlMs).toISOString()
        state.locks[sessionRefId] = lock
        this.#remember(state, { type: 'session.locked', entityType: 'SessionRef', entityId: sessionRefId, details: { owner, expiresAt: lock.expiresAt } })
        return { sessionRefId, token: lock.token }
      })
      return { ...result, lock: state.locks[sessionRefId] }
    })
  }

  async releaseSessionLock(sessionRefId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const token = String(input?.token ?? '').trim()
      const owner = String(input?.owner ?? '').trim()
      const request = { sessionRefId, input: { token, owner }, operation: 'session.unlock' }
      const result = this.#idempotent(state, idempotencyKey, request, 'session.unlock', () => {
        const current = state.locks[sessionRefId]
        if (!current) return { sessionRefId, released: false }
        if (current.token !== token && current.owner !== owner) throw new StoreError('LOCK_OWNER_MISMATCH', 'session lock token or owner does not match', 403)
        delete state.locks[sessionRefId]
        this.#remember(state, { type: 'session.unlocked', entityType: 'SessionRef', entityId: sessionRefId })
        return { sessionRefId, released: true }
      })
      return { ...result, lock: state.locks[sessionRefId] }
    })
  }

  async recoverOnStartup() {
    if (!await this.exists()) return { recovered: false, blockedExecutionIds: [] }
    return this.#mutate(async (state) => {
      this.#pruneLocks(state)
      const blockedExecutionIds = []
      for (const execution of Object.values(state.executions)) {
        if (execution.status !== 'running') continue
        execution.status = 'blocked'
        execution.outcome = 'control-plane restarted; execution requires explicit reconciliation'
        execution.finishedAt = now()
        execution.updatedAt = now()
        const task = state.tasks[execution.taskId]
        if (task) {
          task.status = 'blocked'
          task.updatedAt = now()
        }
        blockedExecutionIds.push(execution.id)
        this.#remember(state, { type: 'execution.recovered_as_blocked', entityType: 'Execution', entityId: execution.id })
      }
      return { recovered: true, blockedExecutionIds }
    })
  }

  async snapshot() {
    const state = await this.read()
    return {
      version: state.version,
      taskCount: Object.keys(state.tasks).length,
      executionCount: Object.keys(state.executions).length,
      evidenceCount: Object.keys(state.evidence).length,
      activeLocks: Object.values(state.locks).filter((lock) => Date.parse(lock.expiresAt) > Date.now()).length,
      lastEventAt: state.events.at(-1)?.at,
    }
  }

  async listEvents({ limit, entityId } = {}) {
    const state = await this.read()
    return state.events
      .filter((event) => !entityId || event.entityId === entityId)
      .slice(-(safeLimit(limit, 100)))
      .reverse()
  }

  async recordEvent(input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { input, operation: 'audit.record' }
      const result = this.#idempotent(state, idempotencyKey, request, 'audit.record', () => {
        if (!input?.type || !input?.entityType || !input?.entityId) throw new StoreError('AUDIT_EVENT_INVALID', 'type, entityType and entityId are required', 400)
        const event = this.#remember(state, { type: input.type, entityType: input.entityType, entityId: input.entityId, details: input.details ?? {} })
        return { eventId: event.id }
      })
      return { ...result, event: state.events.find((event) => event.id === result.result.eventId) }
    })
  }
}
