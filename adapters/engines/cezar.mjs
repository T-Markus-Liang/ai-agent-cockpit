const DEFAULT_BASE_URL = 'http://127.0.0.1:4321'

export class CezarAdapterError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'CezarAdapterError'
    this.status = status
    this.body = body
  }
}

export class CezarAdapter {
  constructor({ baseUrl = process.env.CEZAR_BASE_URL ?? DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetch = fetchImpl
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    })
    const text = await response.text()
    let value
    try { value = text ? JSON.parse(text) : null } catch { value = text }
    if (!response.ok) throw new CezarAdapterError(`Cezar ${response.status} ${path}`, { status: response.status, body: value })
    return value
  }

  async health() {
    return this.request('/api/v1/health')
  }

  async listRuns() {
    return this.request('/api/v1/runs')
  }

  async getRun(runId) {
    return this.request(`/api/v1/runs/${encodeURIComponent(runId)}`)
  }

  async start({ task, runner = 'codex', workflow = 'quick-task', worktree = true } = {}) {
    if (!task?.trim()) throw new CezarAdapterError('Cezar task is required', { status: 400 })
    return this.request('/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ workflow, task, runner, worktree }),
    })
  }

  async cancel(runId) {
    return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
  }
}

export function mapCezarStatus(status) {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'review') return 'reviewing'
  if (status === 'done') return 'verifying'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'waiting') return 'blocked'
  return 'blocked'
}

