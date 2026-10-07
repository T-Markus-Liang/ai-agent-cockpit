import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export class GoalError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new GoalError(code, message, status) }
const copy = value => structuredClone(value)
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value)
const digest = value => `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`
const defaults = { maxIterations: 10, maxTokens: 80000, maxDurationMs: 86400000, maxNoProgress: 3, intervalMs: 5000 }
const bounds = { maxIterations: [1, 50], maxTokens: [1000, 1000000], maxDurationMs: [60000, 604800000], maxNoProgress: [1, 10], intervalMs: [1000, 3600000] }
const text = (value, name, max = 2000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_SPEC', `${name} is required and must not exceed ${max} characters`, 400); return value.trim() }
function relative(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.split('/').some(part => !part || part.startsWith('.') || /^(credentials?|auth|secrets?)(\.|$)/i.test(part)) || /(?:^|\/)(?:api[-_]?keys?|passwords?|tokens?)(?:\.|$)/i.test(value)) fail('INVALID_PATH', 'exact non-secret relative file paths are required', 400)
  return value
}
export function validateGoalSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_SPEC', 'goal spec must be an object', 400)
  const title = text(input.title, 'title', 200), objective = text(input.objective, 'objective', 4000)
  const sourceDir = text(input.sourceDir, 'sourceDir', 1000)
  if (!path.isAbsolute(sourceDir) || [path.parse(sourceDir).root, os.homedir(), os.tmpdir(), '/tmp', '/private/tmp', '/Users', '/Applications'].includes(path.resolve(sourceDir)) || sourceDir.split(path.sep).some(part => part.startsWith('.') || part === 'Library')) fail('INVALID_SOURCE', 'a narrow project directory, not home/system/credentials, is required', 400)
  if (!Array.isArray(input.readPaths) || !input.readPaths.length || input.readPaths.length > 30) fail('INVALID_SPEC', 'readPaths requires 1..30 files', 400)
  const readPaths = [...new Set(input.readPaths.map(relative))]
  if (!Array.isArray(input.writePaths) || !input.writePaths.length || input.writePaths.length > 20) fail('INVALID_SPEC', 'writePaths requires 1..20 files', 400)
  const writePaths = [...new Set(input.writePaths.map(relative))]
  if (writePaths.some(file => !readPaths.includes(file))) fail('INVALID_SPEC', 'writePaths must be a subset of readPaths', 400)
  if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 5) fail('INVALID_CHECKS', '1..5 immutable Node acceptance checks are required', 400)
  const checks = input.checks.map(check => {
    const name = text(check?.name, 'check name', 100)
    if (!Array.isArray(check.args) || check.args.length !== 2 || check.args[0] !== '--test' || !/\.test\.(mjs|cjs|js)$/.test(check.args[1]) || !readPaths.includes(check.args[1]) || writePaths.includes(check.args[1])) fail('INVALID_CHECKS', 'only node --test <read-only acceptance.test.mjs> is supported', 400)
    return { name, args: [...check.args] }
  })
  if (input.limits !== undefined && (!input.limits || Array.isArray(input.limits) || typeof input.limits !== 'object')) fail('INVALID_LIMITS', 'limits must be an object', 400)
  const limits = { ...defaults }
  for (const [key, value] of Object.entries(input.limits ?? {})) {
    if (!bounds[key] || !Number.isInteger(value) || value < bounds[key][0] || value > bounds[key][1]) fail('INVALID_LIMITS', `invalid ${key}`, 400)
    limits[key] = value
  }
  const recovery = input.recovery ?? { enabled: true, maxAttempts: 3 }
  if (!recovery || Object.keys(recovery).some(key => !['enabled', 'maxAttempts'].includes(key)) || typeof recovery.enabled !== 'boolean' || !Number.isInteger(recovery.maxAttempts) || recovery.maxAttempts < 1 || recovery.maxAttempts > 10) fail('INVALID_RECOVERY', 'recovery requires enabled and maxAttempts 1..10', 400)
  return { title, objective, sourceDir: path.resolve(sourceDir), readPaths, writePaths, checks, limits, recovery: { enabled: recovery.enabled, maxAttempts: recovery.maxAttempts } }
}

export class GoalStore {
  constructor({ stateDir = path.join(os.homedir(), '.local/state/personal-ai-os/goals') } = {}) {
    this.stateDir = stateDir; this.file = path.join(stateDir, 'goals.json'); this.pending = Promise.resolve()
  }
  async read() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (state.version !== 1 || !state.goals || typeof state.goals !== 'object' || Array.isArray(state.goals) || !state.requests || typeof state.requests !== 'object' || Array.isArray(state.requests) || !Array.isArray(state.events)) fail('CORRUPT_STATE', 'goal state schema is invalid', 500)
      return state
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, goals: {}, requests: {}, events: [] }; throw error }
  }
  async mutate(operation) {
    const job = this.pending.catch(() => {}).then(async () => {
      await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 }); await fs.chmod(this.stateDir, 0o700)
      const lockPath = `${this.file}.lock`, candidate = `${lockPath}.${crypto.randomUUID()}`
      await fs.writeFile(candidate, String(process.pid), { flag: 'wx', mode: 0o600 })
      let held = false
      try {
        for (let i = 0; i < 400; i++) {
          try { await fs.link(candidate, lockPath); held = true; break } catch (error) {
            if (error.code !== 'EEXIST') throw error
            const owner = Number(await fs.readFile(lockPath, 'utf8').catch(() => ''))
            if (Number.isSafeInteger(owner) && owner > 0) {
              try { process.kill(owner, 0) } catch (error) { if (error.code === 'ESRCH') await fs.unlink(lockPath).catch(() => {}) }
            }
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        }
        if (!held) fail('LOCK_TIMEOUT', 'goal state is busy')
        const state = await this.read()
        const result = await operation(state)
        state.events = state.events.slice(-1000)
        const tmp = `${this.file}.${crypto.randomUUID()}.tmp`
        const handle = await fs.open(tmp, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
        await fs.rename(tmp, this.file)
        const directory = await fs.open(this.stateDir, 'r')
        try { await directory.sync() } finally { await directory.close() }
        return copy(result)
      } finally { if (held) await fs.unlink(lockPath).catch(() => {}); await fs.unlink(candidate).catch(() => {}) }
    })
    this.pending = job; return job
  }
  item(state, id) { if (!Object.hasOwn(state.goals, id)) fail('GOAL_NOT_FOUND', 'goal not found', 404); return state.goals[id] }
  event(state, goal, type) { goal.updatedAt = new Date().toISOString(); state.events.push({ goalId: goal.id, type, at: goal.updatedAt, generation: goal.generation }) }
  async create(input, { idempotencyKey, owner = 'local' } = {}) {
    const spec = validateGoalSpec(input), specDigest = digest(spec)
    const key = digest(text(idempotencyKey, 'idempotencyKey', 200))
    return this.mutate(state => {
      const previous = state.requests[key]
      if (previous) { if (previous.digest !== digest({ spec, owner })) fail('IDEMPOTENCY_CONFLICT', 'request key reused for different goal'); return this.item(state, previous.id) }
      const id = `goal_${crypto.randomUUID()}`
      const goal = { id, spec, specDigest, owner, generation: 1, status: 'draft', iterations: 0, tokensUsed: 0, noProgress: 0, history: [],
        workspaceDir: path.join(this.stateDir, 'workspaces', id), createdAt: new Date().toISOString() }
      state.goals[id] = goal; state.requests[key] = { id, digest: digest({ spec, owner }) }; this.event(state, goal, 'created'); return goal
    })
  }
  async list({ owner } = {}) { await this.pending.catch(() => {}); return Object.values((await this.read()).goals).filter(goal => owner === undefined || goal.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(copy) }
  async get(id) { await this.pending.catch(() => {}); return copy(this.item(await this.read(), id)) }
  async isPaused() { await this.pending.catch(() => {}); return (await this.read()).globalPaused === true }
  async controlAll(action) {
    if (!['pause', 'resume'].includes(action)) fail('INVALID_ACTION', 'invalid global action', 400)
    return this.mutate(state => {
      state.globalPaused = action === 'pause'
      for (const goal of Object.values(state.goals)) {
        if (action === 'pause' && ['ready', 'running'].includes(goal.status)) { goal.status = 'paused'; delete goal.lease; this.event(state, goal, 'pause-all') }
        if (action === 'resume' && goal.status === 'paused' && !this.permitted(goal)) { goal.status = 'ready'; goal.nextWakeAt = Date.now(); this.event(state, goal, 'resume-all') }
      }
      return { paused: state.globalPaused }
    })
  }
  async grant(id, { digest: expected, approvedBy } = {}) {
    text(approvedBy, 'approvedBy', 200)
    return this.mutate(state => {
      const goal = this.item(state, id)
      if (!['draft', 'waiting'].includes(goal.status) || goal.grant) fail('GRANT_CONFLICT', 'goal already granted or not grantable')
      if (expected !== goal.specDigest) fail('GRANT_SCOPE_MISMATCH', 'goal changed since confirmation', 403)
      goal.grant = { digest: expected, generation: goal.generation, approvedBy, at: new Date().toISOString(), expiresAt: new Date(Date.now() + goal.spec.limits.maxDurationMs).toISOString() }
      goal.status = 'ready'; goal.nextWakeAt = Date.now(); goal.reason = ''; this.event(state, goal, 'granted'); return goal
    })
  }
  permitted(goal) {
    if (!goal.grant || goal.grant.digest !== goal.specDigest || goal.grant.generation !== goal.generation) return '未确认目标或目标已改变'
    if (Date.parse(goal.grant.expiresAt) <= Date.now()) return '授权期限已到'
    if (goal.tokensUsed >= goal.spec.limits.maxTokens) return 'token 预算已耗尽'
    if (goal.iterations >= goal.spec.limits.maxIterations) return '已达到迭代上限'
    if (goal.noProgress >= goal.spec.limits.maxNoProgress) return '连续无进展，需要重新规划'
    return ''
  }
  async control(id, action) {
    return this.mutate(state => {
      const goal = this.item(state, id)
      if (['complete', 'cancelled'].includes(goal.status)) fail('GOAL_TERMINAL', 'goal is terminal')
      if (action === 'resume') {
        if (state.globalPaused) fail('GLOBAL_PAUSE', '全部目标已暂停，请先恢复全局调度', 403)
        if (!['paused', 'waiting'].includes(goal.status)) fail('INVALID_STATE', 'only paused or waiting goals can resume')
        const reason = this.permitted(goal); if (reason) fail('LIMIT_REACHED', reason, 403)
        goal.status = 'ready'; goal.nextWakeAt = Date.now()
      } else if (['pause', 'cancel'].includes(action)) {
        goal.status = action === 'pause' ? 'paused' : 'cancelled'; delete goal.lease
      } else fail('INVALID_ACTION', 'unknown goal control', 400)
      this.event(state, goal, action); return goal
    })
  }
  async revise(id, input) {
    const spec = validateGoalSpec(input)
    return this.mutate(state => {
      const goal = this.item(state, id)
      if (!['draft', 'paused', 'waiting'].includes(goal.status)) fail('INVALID_STATE', 'pause the goal before changing direction')
      goal.archives = [...(goal.archives ?? []), { generation: goal.generation, spec: goal.spec, history: goal.history, artifactRef: goal.artifactRef }].slice(-10)
      goal.generation++; goal.spec = spec; goal.specDigest = digest(spec); goal.workspaceDir = path.join(this.stateDir, 'workspaces', `${id}-v${goal.generation}`)
      goal.status = 'draft'; goal.iterations = 0; goal.tokensUsed = 0; goal.noProgress = 0; delete goal.grant; delete goal.lease
      goal.history = []; for (const field of ['summary', 'reason', 'lastChecks', 'artifactRef', 'taskId', 'phase', 'resumeCheckpoint', 'recoveryCount', 'needsRecovery']) delete goal[field]
      this.event(state, goal, 'revised'); return goal
    })
  }
  lease(goal, token) {
    if (goal.status !== 'running' || !goal.lease || goal.lease.token !== token || goal.lease.generation !== goal.generation || goal.lease.expiresAt <= Date.now() || Date.parse(goal.grant.expiresAt) <= Date.now()) fail('STALE_LEASE', 'goal stopped, changed or lease expired')
  }
  async claim(id, { owner, leaseMs = 15000 } = {}) {
    text(owner, 'lease owner', 200)
    return this.mutate(state => {
      const goal = this.item(state, id)
      if (goal.status !== 'ready' || goal.nextWakeAt > Date.now()) fail('NOT_READY', 'goal is not due')
      if (state.globalPaused) fail('GLOBAL_PAUSE', 'all goals are paused')
      const reason = this.permitted(goal)
      if (reason) { goal.status = 'waiting'; goal.reason = reason; this.event(state, goal, 'limit'); return goal }
      goal.iterations++; goal.status = 'running'; goal.phase = 'planning'
      goal.lease = { token: crypto.randomUUID(), owner, generation: goal.generation, expiresAt: Date.now() + leaseMs }
      this.event(state, goal, 'claimed'); return goal
    })
  }
  async heartbeat(id, token) { return this.mutate(state => { const goal = this.item(state, id); this.lease(goal, token); goal.lease.expiresAt = Date.now() + 15000; goal.heartbeatAt = new Date().toISOString(); return goal }) }
  async interrupt(id, token, reason) { return this.mutate(state => { const goal = this.item(state, id); if (goal.status !== 'running' || goal.lease?.token !== token) fail('STALE_LEASE', 'goal no longer belongs to this iteration'); goal.status = 'waiting'; goal.needsRecovery = true; goal.reason = String(reason).slice(0, 500); delete goal.lease; this.event(state, goal, 'interrupted'); return goal }) }
  async checkpoint(id, token, patch) {
    if (Object.keys(patch).some(key => !['phase', 'artifactRef', 'summary', 'taskId', 'lastChecks', 'resumeCheckpoint'].includes(key))) fail('CHECKPOINT_SCOPE', 'checkpoint cannot change permissions or budget', 403)
    if (patch.resumeCheckpoint && JSON.stringify(patch.resumeCheckpoint).length > 2500000) fail('CHECKPOINT_SIZE', 'checkpoint exceeds allowed size')
    return this.mutate(state => { const goal = this.item(state, id); this.lease(goal, token); Object.assign(goal, copy(patch)); this.event(state, goal, 'checkpoint'); return goal })
  }
  async withLease(id, token, callback) { return this.mutate(async state => { const goal = this.item(state, id); this.lease(goal, token); return callback(copy(goal)) }) }
  async reserve(id, token, count) {
    if (!Number.isInteger(count) || count <= 0) fail('INVALID_USAGE', 'invalid token reservation', 400)
    return this.mutate(state => { const goal = this.item(state, id); this.lease(goal, token); if (goal.tokensUsed + count > goal.spec.limits.maxTokens) fail('TOKEN_BUDGET', 'remaining token budget is insufficient', 403); goal.tokensUsed += count; return count })
  }
  async reconcileUsage(id, token, reserved, actual) {
    if (![reserved, actual].every(Number.isInteger) || actual <= 0 || actual > reserved) fail('INVALID_USAGE', 'invalid provider usage', 400)
    return this.mutate(state => { const goal = this.item(state, id); this.lease(goal, token); if (goal.tokensUsed < reserved) fail('INVALID_USAGE', 'reservation not present'); goal.tokensUsed -= reserved - actual; return goal.tokensUsed })
  }
  async settle(id, token, result) {
    if (!['complete', 'retry', 'wait'].includes(result.outcome)) fail('INVALID_OUTCOME', 'invalid iteration outcome', 400)
    return this.mutate(state => {
      const goal = this.item(state, id); this.lease(goal, token)
      goal.summary = String(result.summary ?? '').slice(0, 1500)
      if (!result.retainCheckpoint) delete goal.resumeCheckpoint
      delete goal.needsRecovery
      if (result.artifactRef) goal.artifactRef = result.artifactRef
      if (result.checks) goal.lastChecks = copy(result.checks)
      goal.noProgress = result.progress ? 0 : goal.noProgress + 1
      goal.history.push({ at: new Date().toISOString(), iteration: goal.iterations, ...copy(result) }); goal.history = goal.history.slice(-200)
      delete goal.lease
      const reason = this.permitted(goal)
      goal.status = result.outcome === 'complete' ? 'complete' : result.outcome === 'wait' || reason ? 'waiting' : 'ready'
      goal.reason = result.outcome === 'wait' ? goal.summary : reason; goal.nextWakeAt = Date.now() + goal.spec.limits.intervalMs
      this.event(state, goal, 'settled'); return goal
    })
  }
  async recover() {
    return this.mutate(state => {
      let count = 0, resumed = 0
      for (const goal of Object.values(state.goals)) {
        if (goal.status === 'running') {
          const ownerPid = Number(/^daemon:(\d+)(?::|$)/.exec(goal.lease?.owner ?? '')?.[1])
          if (ownerPid > 0) { try { process.kill(ownerPid, 0); continue } catch (error) { if (error.code !== 'ESRCH') continue } }
          goal.status = 'waiting'; goal.needsRecovery = true; goal.reason = '执行中断，正在核对检查点'; delete goal.lease; count++
        }
        if (goal.status !== 'waiting' || !goal.needsRecovery) continue
        const cp = goal.resumeCheckpoint
        const safePhase = ['planning', 'planner', 'worker'].includes(goal.phase)
          || (['applying', 'reviewer'].includes(goal.phase) && cp?.proposal && cp.specDigest === goal.specDigest && cp.generation === goal.generation)
          || (goal.phase === 'verifying' && cp?.checks && cp.afterArtifactRef && cp.specDigest === goal.specDigest && cp.generation === goal.generation)
        const allowed = goal.spec.recovery?.enabled && !state.globalPaused && !this.permitted(goal) && (goal.recoveryCount ?? 0) < goal.spec.recovery.maxAttempts && safePhase
        if (allowed) { goal.status = 'ready'; goal.nextWakeAt = Date.now(); goal.recoveryCount = (goal.recoveryCount ?? 0) + 1; goal.reason = ''; delete goal.needsRecovery; resumed++; this.event(state, goal, 'auto-recovery-ready') }
        else { goal.reason = '中断已保存：范围、预算、暂停或执行证据不满足安全恢复条件'; delete goal.needsRecovery; this.event(state, goal, 'recovery-needs-review') }
      }
      return { recovered: count, resumed }
    })
  }

  async reconcileCompleted(id, proof) {
    return this.mutate(state => {
      const goal = this.item(state, id)
      if (!goal.spec.recovery?.enabled || !['running', 'waiting', 'ready'].includes(goal.status) || state.globalPaused || proof.generation !== goal.generation || proof.specDigest !== goal.specDigest || proof.taskId !== goal.taskId || !proof.completed || goal.artifactRef !== proof.artifactRef || !goal.grant || goal.grant.digest !== goal.specDigest || goal.grant.generation !== goal.generation || !Number.isFinite(Date.parse(proof.completedAt)) || Date.parse(proof.completedAt) > Date.parse(goal.grant.expiresAt)) fail('RECOVERY_PROOF', 'completed task does not match the current goal grant')
      goal.status = 'complete'; goal.summary = '已核对中断前的任务完成记录与当前副本指纹；没有重复执行'; delete goal.lease; delete goal.needsRecovery; delete goal.resumeCheckpoint; this.event(state, goal, 'completed-reconciled'); return goal
    })
  }
}
