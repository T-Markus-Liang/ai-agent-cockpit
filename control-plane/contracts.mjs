import crypto from 'node:crypto'

export const CONTRACT_VERSION = 1

export const TASK_STATUSES = Object.freeze([
  'draft',
  'planned',
  'queued',
  'running',
  'verifying',
  'reviewing',
  'ready',
  'blocked',
  'failed',
  'cancelled',
  'completed',
])

export const EXECUTION_STATUSES = Object.freeze([
  'queued',
  'running',
  'verifying',
  'reviewing',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
])

export const CAPABILITY_STATES = Object.freeze(['available', 'unknown', 'unavailable'])

export class ContractError extends Error {
  constructor(message, path = []) {
    super(`${path.length ? `${path.join('.')} ` : ''}${message}`)
    this.name = 'ContractError'
    this.path = path
  }
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function string(value, field, { optional = false } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError('must be a non-empty string', [field])
  return value.trim()
}

function enumValue(value, field, values) {
  if (!values.includes(value)) throw new ContractError(`must be one of: ${values.join(', ')}`, [field])
  return value
}

function timestamp(value, field, { optional = false } = {}) {
  if (optional && value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(parsed)) throw new ContractError('must be an ISO timestamp or epoch milliseconds', [field])
  return new Date(parsed).toISOString()
}

function list(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ContractError('must be an array of strings', [field])
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
}

function capabilityState(value, field) {
  return enumValue(value ?? 'unknown', field, CAPABILITY_STATES)
}

const ARTIFACT_REF_PATTERNS = Object.freeze([
  /^git:[0-9a-f]{40,64}$/,
  /^sha256:[0-9a-f]{64}$/,
])

export function isValidArtifactRef(value) {
  return typeof value === 'string' && ARTIFACT_REF_PATTERNS.some((pattern) => pattern.test(value.trim()))
}

function optionalArtifactRef(value, field) {
  if (value === undefined || value === null) return undefined
  if (!isValidArtifactRef(value)) {
    throw new ContractError('must match git:<40-64 hex> or sha256:<64 hex>', [field])
  }
  return value.trim()
}

function base(idValue, prefix) {
  return string(idValue ?? id(prefix), 'id')
}

export function createTask(input = {}) {
  const now = new Date().toISOString()
  const sourceRequestId = string(input.sourceRequestId, 'sourceRequestId', { optional: true })
  if (sourceRequestId !== undefined && !/^[a-f0-9]{64}$/.test(sourceRequestId)) throw new ContractError('must be an opaque receipt id', ['sourceRequestId'])
  const task = {
    contractVersion: CONTRACT_VERSION,
    type: 'Task',
    id: base(input.id, 'task'),
    goal: string(input.goal, 'goal'),
    status: enumValue(input.status ?? 'draft', 'status', TASK_STATUSES),
    chief: string(input.chief, 'chief', { optional: true }),
    constraints: list(input.constraints, 'constraints'),
    acceptanceCriteria: list(input.acceptanceCriteria, 'acceptanceCriteria'),
    executionIds: list(input.executionIds, 'executionIds'),
    createdAt: timestamp(input.createdAt ?? now, 'createdAt'),
    updatedAt: timestamp(input.updatedAt ?? now, 'updatedAt'),
    ...(sourceRequestId ? { sourceRequestId } : {}),
  }
  return task
}

export function createSessionRef(input = {}) {
  const capabilities = input.capabilities ?? {}
  // accountId is OPTIONAL and never fabricated: when the caller has a real
  // account source it must be a non-empty string, otherwise the field is left
  // absent entirely (no default is invented). This mirrors the store guard,
  // which treats an absent field on both sides as a legitimate match.
  const accountId = string(input.accountId, 'accountId', { optional: true })
  return {
    contractVersion: CONTRACT_VERSION,
    type: 'SessionRef',
    id: base(input.id, 'session'),
    source: string(input.source, 'source'),
    profile: string(input.profile ?? 'local-default', 'profile'),
    ...(accountId === undefined ? {} : { accountId }),
    nativeSessionId: string(input.nativeSessionId, 'nativeSessionId'),
    title: string(input.title ?? input.nativeSessionId, 'title'),
    cwd: string(input.cwd, 'cwd'),
    createdAt: timestamp(input.createdAt, 'createdAt', { optional: true }),
    lastActivityAt: timestamp(input.lastActivityAt, 'lastActivityAt', { optional: true }),
    archived: Boolean(input.archived),
    capabilities: {
      metadata: capabilityState(capabilities.metadata, 'capabilities.metadata'),
      history: capabilityState(capabilities.history, 'capabilities.history'),
      resume: capabilityState(capabilities.resume, 'capabilities.resume'),
      write: capabilityState(capabilities.write, 'capabilities.write'),
    },
    resumeHint: string(input.resumeHint, 'resumeHint', { optional: true }),
    limitations: list(input.limitations, 'limitations'),
  }
}

export function createExecution(input = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    type: 'Execution',
    id: base(input.id, 'execution'),
    taskId: string(input.taskId, 'taskId'),
    workerId: string(input.workerId, 'workerId'),
    status: enumValue(input.status ?? 'queued', 'status', EXECUTION_STATUSES),
    attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    sessionRefId: string(input.sessionRefId, 'sessionRefId', { optional: true }),
    parentExecutionId: string(input.parentExecutionId, 'parentExecutionId', { optional: true }),
    startedAt: timestamp(input.startedAt, 'startedAt', { optional: true }),
    finishedAt: timestamp(input.finishedAt, 'finishedAt', { optional: true }),
    outcome: string(input.outcome, 'outcome', { optional: true }),
    artifactRef: optionalArtifactRef(input.artifactRef, 'artifactRef'),
  }
}

export function createEvidence(input = {}) {
  const kind = enumValue(input.kind ?? 'message', 'kind', ['command', 'test', 'diff', 'log', 'screenshot', 'review', 'message'])
  if (input.exitCode !== undefined && (typeof input.exitCode !== 'number' || !Number.isInteger(input.exitCode))) {
    throw new ContractError('exitCode must be an integer number', ['exitCode'])
  }
  const verdict = input.verdict === undefined || input.verdict === null
    ? undefined
    : enumValue(input.verdict, 'verdict', ['passed', 'failed'])
  return {
    contractVersion: CONTRACT_VERSION,
    type: 'Evidence',
    id: base(input.id, 'evidence'),
    executionId: string(input.executionId, 'executionId'),
    kind,
    summary: string(input.summary, 'summary'),
    source: string(input.source, 'source'),
    capturedAt: timestamp(input.capturedAt ?? new Date().toISOString(), 'capturedAt'),
    exitCode: input.exitCode === undefined ? undefined : Number(input.exitCode),
    uri: string(input.uri, 'uri', { optional: true }),
    redacted: input.redacted !== false,
    artifactRef: optionalArtifactRef(input.artifactRef, 'artifactRef'),
    verdict,
    reviewOfExecutionId: string(input.reviewOfExecutionId, 'reviewOfExecutionId', { optional: true }),
  }
}

export function createApproval(input = {}) {
  const decision = enumValue(input.decision ?? 'pending', 'decision', ['pending', 'approved', 'rejected', 'expired'])
  return {
    contractVersion: CONTRACT_VERSION,
    type: 'Approval',
    id: base(input.id, 'approval'),
    action: string(input.action, 'action'),
    target: string(input.target, 'target'),
    parametersDigest: string(input.parametersDigest, 'parametersDigest'),
    decision,
    approvedBy: string(input.approvedBy, 'approvedBy', { optional: true }),
    createdAt: timestamp(input.createdAt ?? new Date().toISOString(), 'createdAt'),
    expiresAt: timestamp(input.expiresAt, 'expiresAt', { optional: true }),
  }
}

export function createAgentCapability(input = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    type: 'AgentCapability',
    agentId: string(input.agentId, 'agentId'),
    provider: string(input.provider, 'provider'),
    role: enumValue(input.role ?? 'worker', 'role', ['chief', 'worker', 'reviewer']),
    transport: enumValue(input.transport ?? 'cli', 'transport', ['acp', 'cli', 'http', 'gui']),
    status: enumValue(input.status ?? 'unknown', 'status', ['ready', 'degraded', 'unknown', 'unavailable']),
    capabilities: list(input.capabilities, 'capabilities'),
    evidenceAt: timestamp(input.evidenceAt, 'evidenceAt', { optional: true }),
    limitations: list(input.limitations, 'limitations'),
  }
}
