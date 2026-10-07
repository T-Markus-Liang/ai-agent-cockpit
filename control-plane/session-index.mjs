import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createSessionRef } from './contracts.mjs'

const DEFAULT_LIMIT = 500
const CODEX_DB_GLOB = /^state_\d+\.sqlite$/
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLAUDE_HEAD_BYTES = 128 * 1024

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

function extractClaudeCwd(head) {
  const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`)
  } catch {
    return match[1]
  }
}

// 只统计 JSONL 行数并从文件头部取出 cwd 字段，不解析、不保留任何消息正文。
function analyzeClaudeTranscript(file) {
  return new Promise((resolve) => {
    let head = ''
    let messageCount = 0
    let settled = false
    const stream = createReadStream(file)
    const done = (result) => {
      if (settled) return
      settled = true
      stream.destroy()
      resolve(result)
    }
    stream.on('data', (chunk) => {
      if (head.length < CLAUDE_HEAD_BYTES) {
        head += chunk.toString('utf8', 0, Math.min(chunk.length, CLAUDE_HEAD_BYTES - head.length))
      }
      let index = chunk.indexOf(10)
      while (index !== -1) {
        messageCount += 1
        index = chunk.indexOf(10, index + 1)
      }
    })
    stream.on('end', () => done({ cwd: extractClaudeCwd(head), messageCount }))
    stream.on('error', () => done({ cwd: undefined, messageCount: undefined }))
  })
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

async function indexDevin(home, limit) {
  const db = path.join(home, '.local/share/devin/cli/sessions.db')
  const detected = existsSync(db)
  // created_at / last_activity_at 存的是 epoch 秒；hidden=1 表示在 CLI 列表里隐藏。
  const rows = await querySqlite(db, `SELECT id, title, working_directory AS cwd,
    created_at * 1000 AS createdAt, last_activity_at * 1000 AS lastActivityAt, hidden
    FROM sessions ORDER BY last_activity_at DESC LIMIT ${sessionLimit(limit)}`)
  const sessions = rows.map((row) => createSessionRef({
    id: `session:devin:${row.id}`,
    source: 'devin',
    nativeSessionId: row.id,
    title: displayTitle(row.title, row.id),
    cwd: row.cwd || home,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    archived: Boolean(row.hidden),
    capabilities: { metadata: 'available', history: 'unknown', resume: 'unknown', write: 'unavailable' },
    resumeHint: 'devin --resume / devin acp (not invoked by read-only index)',
    limitations: ['只读 sessions.db 的会话元数据；不读取凭据或消息正文；resume/ACP 恢复未验证'],
  }))
  return {
    source: sourceDescriptor({
      provider: 'devin', label: 'Devin', detected, metadata: sessions.length > 0,
      resumeHint: 'devin --resume / devin acp', root: db,
      limitations: !detected
        ? ['未发现 ~/.local/share/devin/cli/sessions.db']
        : sessions.length
          ? []
          : ['检测到 ~/.local/share/devin/cli/sessions.db 但未读出会话行（可能是 schema 变更或权限）'],
    }),
    sessions,
  }
}

async function indexWorkBuddy(home, limit) {
  const db = path.join(home, '.workbuddy-ai/workbuddy.db')
  const detected = existsSync(db)
  // deleted_at 非空表示已删除（用 archived 标记）；时间戳都是 epoch 毫秒。
  const rows = await querySqlite(db, `SELECT id, title, custom_title AS customTitle, cwd,
    created_at AS createdAt, COALESCE(last_activity_at, updated_at) AS lastActivityAt,
    CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS archived
    FROM sessions ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ${sessionLimit(limit)}`)
  const sessions = rows.map((row) => createSessionRef({
    id: `session:workbuddy:${row.id}`,
    source: 'workbuddy',
    nativeSessionId: row.id,
    title: displayTitle(row.customTitle || row.title, row.id),
    cwd: row.cwd || home,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    archived: Boolean(row.archived),
    capabilities: { metadata: 'available', history: 'unknown', resume: 'unknown', write: 'unavailable' },
    resumeHint: 'codebuddy --resume / codebuddy --acp (not invoked by read-only index)',
    limitations: ['只读 workbuddy.db 的 sessions 表；不读取凭据或消息正文；resume/ACP 恢复未验证'],
  }))
  return {
    source: sourceDescriptor({
      provider: 'workbuddy', label: 'WorkBuddy', detected, metadata: sessions.length > 0,
      resumeHint: 'codebuddy --resume / codebuddy --acp', root: db,
      limitations: !detected
        ? ['未发现 ~/.workbuddy-ai/workbuddy.db']
        : sessions.length
          ? []
          : ['检测到 ~/.workbuddy-ai/workbuddy.db 但未读出会话行（可能是 schema 变更或权限）'],
    }),
    sessions,
  }
}

async function indexClaude(home, limit) {
  const root = path.join(home, '.claude/projects')
  const detected = existsSync(root)
  const sessions = []
  if (detected) {
    let projects = []
    try {
      projects = await fs.readdir(root, { withFileTypes: true })
    } catch {
      projects = []
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(root, project.name)
      let files = []
      try {
        files = await fs.readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        const nativeSessionId = file.name.slice(0, -'.jsonl'.length)
        if (!CLAUDE_SESSION_ID_PATTERN.test(nativeSessionId)) continue
        const transcript = path.join(projectDir, file.name)
        const stat = await fs.stat(transcript).catch(() => undefined)
        if (!stat) continue
        const analysis = await analyzeClaudeTranscript(transcript)
        const cwd = analysis.cwd || home
        const projectName = analysis.cwd ? path.basename(analysis.cwd) : project.name
        const title = Number.isInteger(analysis.messageCount) ? `${projectName} · ${analysis.messageCount} msgs` : projectName
        sessions.push(createSessionRef({
          id: `session:claude:${nativeSessionId}`,
          source: 'claude',
          nativeSessionId,
          title: displayTitle(title, nativeSessionId),
          cwd,
          createdAt: stat.birthtimeMs,
          lastActivityAt: stat.mtimeMs,
          archived: false,
          capabilities: { metadata: 'available', history: 'unknown', resume: 'unknown', write: 'unavailable' },
          resumeHint: `claude --resume ${nativeSessionId} (not invoked by read-only index)`,
          limitations: ['只读 ~/.claude/projects/<project>/<session>.jsonl 的文件元信息与行数；不读取消息正文或凭据；title 取自项目名而非首条消息'],
        }))
      }
    }
  }
  sessions.sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
  return {
    source: sourceDescriptor({
      provider: 'claude', label: 'Claude Code', detected, metadata: sessions.length > 0,
      resumeHint: 'claude --resume <id>', root,
      limitations: !detected
        ? ['未发现 ~/.claude/projects']
        : sessions.length
          ? []
          : ['检测到 ~/.claude/projects 但未发现可索引的 <sessionId>.jsonl'],
    }),
    sessions: sessions.slice(0, sessionLimit(limit)),
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
  if (include('workbuddy')) results.push(await indexWorkBuddy(home, limit))
  if (include('devin')) results.push(await indexDevin(home, limit))
  if (include('claude')) results.push(await indexClaude(home, limit))
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
