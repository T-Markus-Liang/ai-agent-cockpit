import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { createSessionRef } from './contracts.mjs'
import { StoreError } from './store.mjs'

const ACP_COMMANDS = Object.freeze({
  codex: { command: '/usr/local/bin/npx', args: ['--yes', '@agentclientprotocol/codex-acp'] },
  opencode: { command: path.join(os.homedir(), '.opencode/bin/opencode'), args: ['acp'] },
  kimi: { command: path.join(os.homedir(), '.kimi-code/bin/kimi'), args: ['acp'] },
  workbuddy: { command: '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy', args: ['--acp'] },
  devin: { command: '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin', args: ['acp'] },
})

function timeoutError(message) {
  return new StoreError('NATIVE_ACP_TIMEOUT', message, 504)
}

async function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => child.once('close', resolve))
}

export async function listNativeAcpSessions({ source = 'codex', cwd = path.resolve(process.cwd()), command, args, env = {}, timeoutMs = 30_000, loadSessionId } = {}) {
  const selected = command ? { command, args: args ?? [] } : ACP_COMMANDS[source]
  if (!selected) throw new StoreError('NATIVE_ACP_UNSUPPORTED', `no native ACP probe is configured for ${source}`, 501)
  if (!path.isAbsolute(cwd)) throw new StoreError('ABSOLUTE_CWD_REQUIRED', 'native ACP session listing requires an absolute cwd', 400)
  const child = spawn(selected.command, selected.args, {
    cwd,
    env: { ...process.env, HOME: os.homedir(), PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const errors = []
  child.stderr.on('data', (chunk) => { if (errors.join('').length < 2000) errors.push(String(chunk)) })
  const processFailure = new Promise((_, reject) => child.once('error', (error) => reject(new StoreError('NATIVE_ACP_SPAWN_FAILED', `${selected.command} could not start: ${error.message}`, 502))))
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 1
  let agentCapabilities
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForClose(child)
  }
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message?.id === undefined || message?.id === null) return
    const resolve = pending.get(message.id)
    if (!resolve) return
    pending.delete(message.id)
    if (message.error) resolve({ error: message.error })
    else resolve({ result: message.result })
  })
  const request = async (method, params) => {
    const id = nextId++
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(timeoutError(`native ACP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, (value) => { clearTimeout(timer); resolve(value) })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const value = await Promise.race([response, processFailure])
    if (value.error) throw new StoreError('NATIVE_ACP_ERROR', `${method} failed: ${value.error.message ?? JSON.stringify(value.error)}`, 502, { source })
    return value.result
  }
  try {
    const initialize = await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'personal-ai-os-control-plane', title: 'Personal AI OS control plane', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    })
    agentCapabilities = initialize?.agentCapabilities ?? {}
    if (agentCapabilities?.sessionCapabilities?.list === undefined) {
      return { source, transport: 'acp', verified: true, agentInfo: initialize?.agentInfo, agentCapabilities, sessions: [], limitations: ['ACP agent did not advertise session/list'] }
    }
    const listed = await request('session/list', { cwd })
    const listedSessions = listed?.sessions ?? []
    const sessions = listedSessions.map((session) => createSessionRef({
      id: `session:${source}:${session.sessionId}`,
      source,
      nativeSessionId: session.sessionId,
      title: session.title || session.sessionId,
      cwd: session.cwd,
      lastActivityAt: session.updatedAt,
      capabilities: { metadata: 'available', history: 'unknown', resume: agentCapabilities?.sessionCapabilities?.resume ? 'available' : 'unknown', write: 'unavailable' },
      resumeHint: `${source} ACP session/load or session/resume (not invoked by this read-only probe)`,
      limitations: ['本次只调用 initialize/session/list；没有加载、prompt、写入或读取消息正文'],
    }))
    let loadProbe
    if (loadSessionId !== undefined) {
      if (!agentCapabilities.loadSession) throw new StoreError('NATIVE_ACP_LOAD_UNSUPPORTED', `${source} did not advertise session/load`, 501)
      if (!listedSessions.some((session) => session.sessionId === loadSessionId)) throw new StoreError('SESSION_NOT_FOUND', `${source} session ${loadSessionId} was not returned by session/list`, 404)
      const loaded = await request('session/load', { cwd, mcpServers: [], sessionId: loadSessionId })
      loadProbe = { sessionId: loadSessionId, succeeded: true, responseKeys: Object.keys(loaded ?? {}) }
    }
    return { source, transport: 'acp', verified: true, agentInfo: initialize?.agentInfo, agentCapabilities, sessions, nextCursor: listed?.nextCursor ?? undefined, loadProbe, stderr: errors.join('').slice(0, 500) || undefined }
  } finally {
    await close()
  }
}
