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

  async *events(runId, { afterSeq = 0, signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${encodeURIComponent(String(afterSeq))}`, { headers: { Accept: 'text/event-stream' }, signal })
    if (!response.ok || !response.body) throw new CezarAdapterError(`Cezar SSE ${response.status} /runs/${runId}/events`, { status: response.status })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = {}
    const emit = function* () {
      if (!event.data) return
      let data = event.data
      try { data = JSON.parse(data) } catch { /* keep text */ }
      const value = { ...event, data }
      event = {}
      return yield value
    }
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line === '') {
            const emitted = emit()
            if (emitted) yield* emitted
          } else if (line.startsWith('id:')) event.id = line.slice(3).trim()
          else if (line.startsWith('event:')) event.event = line.slice(6).trim()
          else if (line.startsWith('data:')) event.data = `${event.data ? `${event.data}\n` : ''}${line.slice(5).trim()}`
        }
      }
      if (event.data) {
        const emitted = emit()
        if (emitted) yield* emitted
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
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
