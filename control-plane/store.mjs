import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createApproval,
  createEvidence,
  createExecution,
  createTask,
  EXECUTION_STATUSES,
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
    const started = Date.now()
    while (Date.now() - started < this.lockTimeoutMs) {
      try {
        const handle = await fs.open(this.lockFile, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now() }))
        await handle.close()
        return
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new StoreError('LOCK_FAILED', error.message, 500)
        try {
          const stat = await fs.stat(this.lockFile)
          if (Date.now() - stat.mtimeMs > Math.max(this.lockTimeoutMs * 2, 30_000)) await fs.unlink(this.lockFile)
        } catch {
          // A concurrent writer may have removed the lock between stat and unlink.
        }
        await sleep(25)
      }
    }
    throw new StoreError('LOCK_TIMEOUT', 'control-plane state is busy; retry the operation', 409)
  }

  async #releaseFileLock() {
    await fs.unlink(this.lockFile).catch(() => {})
  }

  async #write(state) {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.stateDir, `.control-plane.${process.pid}.${crypto.randomUUID()}.tmp`)
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await fs.rename(temporary, this.stateFile)
  }

  async #mutate(mutator) {
    await this.#acquireFileLock()
    try {
      const state = await readJson(this.stateFile)
      const result = await mutator(state)
      await this.#write(state)
      return result
    } finally {
      await this.#releaseFileLock()
    }
  }

  #remember(state, { type, entityType, entityId, details = {} }) {
    state.events.push({ id: randomId('event'), type, entityType, entityId, details, at: now() })
    if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000)
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

  async listTasks({ status, limit } = {}) {
    const state = await this.read()
    const tasks = Object.values(state.tasks)
      .filter((task) => !status || task.status === status)
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

  async getExecution(executionId) {
    const state = await this.read()
    const execution = state.executions[executionId]
    if (!execution) throw new StoreError('EXECUTION_NOT_FOUND', `execution ${executionId} was not found`, 404)
    return execution
  }

  async createExecution(taskId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      this.#pruneLocks(state)
      const request = { taskId, input, operation: 'execution.create' }
      const result = this.#idempotent(state, idempotencyKey, request, 'execution.create', () => {
        const task = state.tasks[taskId]
        if (!task) throw new StoreError('TASK_NOT_FOUND', `task ${taskId} was not found`, 404)
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
        if (execution.status !== next && !TRANSITIONS[execution.status]?.has(next)) {
          throw new StoreError('INVALID_TRANSITION', `cannot move execution from ${execution.status} to ${next}`, 409)
        }
        if (execution.status === next) return { executionId }
        const previousStatus = execution.status
        execution.status = next
        execution.updatedAt = now()
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
    return this.#mutate(async (state) => {
      const request = { input, operation: 'approval.create' }
      const result = this.#idempotent(state, idempotencyKey, request, 'approval.create', () => {
        const approval = createApproval({ ...input, decision: input?.decision ?? 'pending' })
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

  async decideApproval(approvalId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { approvalId, input, operation: 'approval.decide' }
      const result = this.#idempotent(state, idempotencyKey, request, 'approval.decide', () => {
        const approval = state.approvals[approvalId]
        if (!approval) throw new StoreError('APPROVAL_NOT_FOUND', `approval ${approvalId} was not found`, 404)
        const decision = input?.decision
        if (!['approved', 'rejected', 'expired'].includes(decision)) throw new StoreError('INVALID_APPROVAL_DECISION', 'decision must be approved, rejected or expired', 400)
        if (approval.decision !== 'pending' && approval.decision !== decision) throw new StoreError('APPROVAL_ALREADY_DECIDED', `approval is already ${approval.decision}`, 409)
        if (decision === 'approved' && !String(input?.approvedBy ?? '').trim()) throw new StoreError('APPROVER_REQUIRED', 'approvedBy is required to approve an action', 400)
        approval.decision = decision
        if (input?.approvedBy !== undefined) approval.approvedBy = String(input.approvedBy)
        this.#remember(state, { type: 'approval.decided', entityType: 'Approval', entityId: approvalId, details: { decision, approvedBy: approval.approvedBy } })
        return { approvalId }
      })
      return { ...result, approval: state.approvals[result.result.approvalId] }
    })
  }

  async consumeApproval(approvalId, input, { idempotencyKey } = {}) {
    return this.#mutate(async (state) => {
      const request = { approvalId, input, operation: 'approval.consume' }
      const result = this.#idempotent(state, idempotencyKey, request, 'approval.consume', () => {
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
}
