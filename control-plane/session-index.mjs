import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createSessionRef } from './contracts.mjs'

const DEFAULT_LIMIT = 500
const CODEX_DB_GLOB = /^state_\d+\.sqlite$/

function within(candidate, root) {
  const resolved = path.resolve(candidate)
  const base = path.resolve(root)
  return resolved === base || resolved.startsWith(`${base}${path.sep}`)
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function statTime(file) {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return undefined
  }
}

async function latestMatchingFile(dir, predicate) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const candidates = []
    for (const entry of entries) {
      if (!entry.isFile() || !predicate(entry.name)) continue
      const file = path.join(dir, entry.name)
      candidates.push({ file, mtimeMs: await statTime(file) ?? 0 })
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file
  } catch {
    return undefined
  }
}

function run(command, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 300)}`))
      else resolve(stdout)
    })
  })
}

async function querySqlite(db, sql) {
  if (!db || !existsSync(db)) return []
  try {
    const output = await run('sqlite3', ['-readonly', '-json', db, sql])
    const value = JSON.parse(output || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function sessionLimit(limit) {
  const parsed = Number(limit ?? DEFAULT_LIMIT)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, DEFAULT_LIMIT) : DEFAULT_LIMIT
}

function displayTitle(value, fallback) {
  const normalized = String(value || fallback || 'untitled').replace(/[\r\n\t]+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

function sourceDescriptor({ provider, label, detected, metadata, resumeHint, limitations = [], root }) {
  return {
    provider,
    label,
    detected,
    metadata,
    readOnly: true,
    root,
    resumeHint,
    limitations,
  }
}

async function indexCodex(home, limit) {
  const dir = path.join(home, '.codex')
  const db = await latestMatchingFile(dir, (name) => CODEX_DB_GLOB.test(name))
  const rows = await querySqlite(db, `SELECT id, title, cwd,
    COALESCE(created_at_ms, created_at * 1000) AS createdAt,
    COALESCE(updated_at_ms, updated_at * 1000) AS updatedAt,
    archived, model_provider, model
    FROM threads ORDER BY COALESCE(recency_at_ms, updated_at_ms, updated_at * 1000) DESC LIMIT ${sessionLimit(limit)}`)
  const sessions = rows.map((row) => createSessionRef({
    id: `session:codex:${row.id}`,
    source: 'codex',
    nativeSessionId: row.id,
    title: displayTitle(row.title, row.id),
    cwd: row.cwd || home,
    createdAt: row.createdAt,
    lastActivityAt: row.updatedAt,
    archived: Boolean(row.archived),
    capabilities: { metadata: 'available', history: 'unknown', resume: 'unknown', write: 'unavailable' },
    resumeHint: 'codex app-server / native thread resume (not invoked by read-only index)',
    limitations: ['索引阶段只读元数据；未验证本次恢复的认证、工具链或 App 并发状态'],
  }))
  return {
    source: sourceDescriptor({
      provider: 'codex', label: 'Codex', detected: Boolean(db), metadata: sessions.length > 0,
      resumeHint: 'codex app-server / native thread resume', root: db,
      limitations: db ? [] : ['未发现 ~/.codex/state_*.sqlite'],
    }),
    sessions,
  }
}

async function indexOpenCode(home, limit) {
  const db = path.join(home, '.local/share/opencode/opencode.db')
  const rows = await querySqlite(db, `SELECT id, title, directory,
    time_created AS createdAt, time_updated AS updatedAt, time_archived AS archived,
    agent, model FROM session ORDER BY time_updated DESC LIMIT ${sessionLimit(limit)}`)
  const sessions = rows.map((row) => createSessionRef({
    id: `session:opencode:${row.id}`,
    source: 'opencode',
    nativeSessionId: row.id,
    title: displayTitle(row.title, row.id),
    cwd: row.directory || home,
    createdAt: row.createdAt,
    lastActivityAt: row.updatedAt,
    archived: Boolean(row.archived),
    capabilities: { metadata: 'available', history: 'unknown', resume: 'unknown', write: 'unavailable' },
    resumeHint: 'opencode native session resume (not invoked by read-only index)',
    limitations: ['索引阶段只读元数据；不会读取 auth.json 或消息正文'],
  }))
  return {
    source: sourceDescriptor({
      provider: 'opencode', label: 'OpenCode', detected: existsSync(db), metadata: sessions.length > 0,
      resumeHint: 'opencode native session resume', root: db,
      limitations: existsSync(db) ? [] : ['未发现 ~/.local/share/opencode/opencode.db'],
    }),
    sessions,
  }
}

async function indexKimi(home, limit) {
  const root = path.join(home, '.kimi-code')
  const indexFile = path.join(root, 'session_index.jsonl')
  const sessions = []
  if (existsSync(indexFile)) {
    const lines = (await fs.readFile(indexFile, 'utf8')).split('\n').filter(Boolean).slice(-sessionLimit(limit))
    for (const line of lines) {
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (!entry?.sessionId || !entry.sessionDir || !within(entry.sessionDir, path.join(root, 'sessions'))) continue
      const stateFile = path.join(entry.sessionDir, 'state.json')
      const state = await readJson(stateFile)
      sessions.push(createSessionRef({
        id: `session:kimi:${entry.sessionId}`,
        source: 'kimi',
        nativeSessionId: entry.sessionId,
        title: displayTitle(state?.title, entry.sessionId),
        cwd: state?.cwd || entry.workDir || home,
        createdAt: state?.createdAt,
        lastActivityAt: state?.updatedAt ?? await statTime(stateFile),
        archived: Boolean(state?.archived),
        capabilities: { metadata: 'available', history: 'unknown', resume: 'unknown', write: 'unavailable' },
        resumeHint: `kimi --session ${entry.sessionId} (not invoked by read-only index)`,
        limitations: ['只读读取 session_index.jsonl 和每个 state.json；不会读取 credentials 或消息正文'],
      }))
    }
  }
  return {
    source: sourceDescriptor({
      provider: 'kimi', label: 'Kimi CLI', detected: existsSync(indexFile), metadata: sessions.length > 0,
      resumeHint: 'kimi --session <id>', root: indexFile,
      limitations: existsSync(indexFile) ? [] : ['未发现 ~/.kimi-code/session_index.jsonl'],
    }),
    sessions: sessions.reverse(),
  }
}

function appSource({ home, provider, label, appRoot, executable, resumeHint, limitations }) {
  const root = path.join(home, appRoot)
  const detected = existsSync(root) || existsSync(executable)
  return {
    source: sourceDescriptor({ provider, label, detected, metadata: false, resumeHint, root,
      limitations: detected ? limitations : [`未发现 ${appRoot} 或可执行入口`] }),
    sessions: [],
  }
}

export async function indexLocalSessions({ home = os.homedir(), limit = DEFAULT_LIMIT, providers } = {}) {
  const wanted = providers ? new Set(providers) : null
  const include = (provider) => !wanted || wanted.has(provider)
  const results = []
  if (include('codex')) results.push(await indexCodex(home, limit))
  if (include('opencode')) results.push(await indexOpenCode(home, limit))
  if (include('kimi')) results.push(await indexKimi(home, limit))
  if (include('workbuddy')) results.push(appSource({
    home, provider: 'workbuddy', label: 'WorkBuddy', appRoot: 'Library/Application Support/WorkBuddy AI',
    executable: '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    resumeHint: 'codebuddy --resume / codebuddy --acp',
    limitations: ['当前只确认 ACP/CLI 入口；未发现稳定的只读旧会话索引接口，不能猜测或静默创建新会话'],
  }))
  if (include('devin')) results.push(appSource({
    home, provider: 'devin', label: 'Devin', appRoot: 'Library/Application Support/Devin',
    executable: '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
    resumeHint: 'devin --resume / devin acp',
    limitations: ['当前只验证 ACP 握手/建会话；旧会话 list/load、认证与 prompt 尚未验证'],
  }))
  if (include('claude')) results.push(appSource({
    home, provider: 'claude', label: 'Claude Code', appRoot: '.claude', executable: '/opt/homebrew/bin/claude',
    resumeHint: 'Claude Code 原生 session 机制',
    limitations: ['本版本只做入口发现，不读取 ~/.claude 内部历史'],
  }))
  if (include('antigravity')) results.push(appSource({
    home, provider: 'antigravity', label: 'Antigravity', appRoot: 'Library/Application Support/Antigravity',
    executable: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
    resumeHint: 'GUI-only / proxy provider',
    limitations: ['当前为 GUI/反代能力，不提供稳定的本地旧会话只读索引'],
  }))

  return {
    contractVersion: 1,
    type: 'SessionIndexSnapshot',
    scannedAt: new Date().toISOString(),
    privacy: { readOnly: true, secretsRead: false, messageBodiesRead: false },
    sources: results.map((result) => result.source),
    sessions: results.flatMap((result) => result.sessions).sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '')),
  }
}
