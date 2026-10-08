// GoalAccessBroker: the single already-confirmed Goal scope enforced across
// read / write / check operations. GoalStore stays the sole grant and lifecycle
// owner; this module adds no grant database, scheduler or registry. It binds a
// trusted captured goal.id/owner/generation/specDigest/workspaceDir plus the
// private lease token, and every operation rechecks authority before effects.
//
// File effects run inside a macOS Seatbelt helper with fixed, trusted Node code
// and JSON stdin. Model strings are never evaluated. The parent validates exact
// relative names and sizes; the child profile denies user/temp/volume reads
// except the exact approved files and permits writes only to exact approved
// targets plus unique explicit temporary files. Errors are redacted and there
// is no unsandboxed fallback.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { runChecks as runSandboxChecks, regularFile } from './goal-workspace.mjs'
import { grantFailureReason, assertLeaseIntegrity, goalSpecDigest } from './goal-store.mjs'

const MAX_FILE_BYTES = 80000
const MAX_TOTAL_BYTES = 160000
const HELPER_TIMEOUT_MS = 15000
const ROLES = new Set(['worker', 'reviewer'])

export class BrokerError extends Error {
  constructor(code, message, status = 403) { super(message); this.code = code; this.status = status }
}

// Fixed helper program. It is a constant, never model-provided. It performs a
// read-only snapshot or an atomic proposed replacement using only the exact
// paths the parent already admitted into the Seatbelt profile. Size limits are
// enforced with a stat before any content is read, symlinks are refused with
// O_NOFOLLOW, and replacements are written to a unique temp file, fsynced,
// renamed and the containing directory fsynced (bounded, redacted failures).
const FILE_HELPER_CODE = `
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
const MAX_FILE = ${MAX_FILE_BYTES}
const MAX_TOTAL = ${MAX_TOTAL_BYTES}
const read = () => new Promise(resolve => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { s += d }); process.stdin.on('end', () => resolve(s)) })
const input = JSON.parse(await read())
const safeRelative = value => typeof value === 'string' && value.length > 0 && value.length < 1024 && !value.startsWith('/') && !value.split('/').includes('..')
const out = {}
if (input.op === 'snapshot') {
  const files = []
  const hash = crypto.createHash('sha256')
  let total = 0
  for (const relative of [...input.readPaths].sort()) {
    if (!safeRelative(relative)) throw new Error('unsafe relative path')
    const handle = await fs.open(input.workspaceDir + '/' + relative, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('not a regular file')
      if (stat.size > MAX_FILE) throw new Error('file exceeds per-file limit')
      total += stat.size
      if (total > MAX_TOTAL) throw new Error('files exceed total limit')
      const content = await handle.readFile('utf8')
      hash.update(JSON.stringify([relative, content]))
      files.push({ path: relative, content })
    } finally { await handle.close() }
  }
  out.artifactRef = 'sha256:' + hash.digest('hex')
  out.files = files
} else if (input.op === 'apply') {
  for (const file of input.files) {
    if (!safeRelative(file.path) || typeof file.content !== 'string') throw new Error('unsafe proposal')
    if (Buffer.byteLength(file.content) > MAX_FILE) throw new Error('proposal exceeds per-file limit')
    const temporaryRelative = input.tempNames[file.path]
    if (!safeRelative(temporaryRelative)) throw new Error('unsafe temporary path')
    const temporary = input.workspaceDir + '/' + temporaryRelative
    const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(file.content); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, input.workspaceDir + '/' + file.path)
  }
  const directory = await fs.open(input.workspaceDir, fs.constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
  out.ok = true
} else throw new Error('unknown operation')
process.stdout.write(JSON.stringify(out))
`

function seatbeltProfile({ node, workspaceDir, readFiles, writeFiles }) {
  const q = value => JSON.stringify(value)
  const readLiterals = readFiles.map(file => `(literal ${q(file)})`).join(' ')
  const writeLiterals = writeFiles.map(file => `(literal ${q(file)})`).join(' ')
  // Structure matches the proven runChecks profile: default allow for system
  // libraries, explicit denies for user/temp/volume reads, no network, no exec
  // beyond the fixed Node binary, writes only to exact literals. The workspace
  // directory itself is read-allowed only so the helper can fsync it.
  return `(version 1)(allow default)(deny network*)(deny process-exec)(allow process-exec (literal ${q(node)}))(deny file-read* (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/Volumes"))(allow file-read-metadata)(allow file-read* (literal ${q(node)}) (literal ${q(workspaceDir)}) ${readLiterals})(deny file-write*)(allow file-write* (literal "/dev/null") ${writeLiterals})(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))`
}

async function runFileHelper({ node, workspaceDir, request, readFiles = [], writeFiles = [] }) {
  if (process.platform !== 'darwin') throw new BrokerError('SANDBOX_REQUIRED', 'macOS Seatbelt is required; no unsandboxed fallback')
  try { await fs.access('/usr/bin/sandbox-exec') } catch { throw new BrokerError('SANDBOX_REQUIRED', 'macOS Seatbelt is required; no unsandboxed fallback') }
  const root = await fs.realpath(workspaceDir)
  const profile = seatbeltProfile({ node, workspaceDir: root, readFiles, writeFiles })
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, node, '--input-type=module', '-e', FILE_HELPER_CODE], {
      cwd: '/', detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', ended = false
    child.stdout.on('data', chunk => { if (stdout.length < 2 * MAX_TOTAL_BYTES) stdout += chunk.toString() })
    child.stderr.on('data', () => {})
    const stop = () => { if (!ended) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
    const timer = setTimeout(() => { stop() }, HELPER_TIMEOUT_MS)
    child.once('error', () => { clearTimeout(timer); reject(new BrokerError('SANDBOX_FAILED', 'sandboxed file operation failed')) })
    child.once('close', code => {
      ended = true; clearTimeout(timer)
      if (code !== 0) return reject(new BrokerError('FILE_HELPER_FAILED', 'sandboxed file operation failed'))
      let parsed
      try { parsed = JSON.parse(stdout) } catch { return reject(new BrokerError('FILE_HELPER_FAILED', 'sandboxed file operation failed')) }
      resolve(parsed)
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function verifySnapshot(goal, result) {
  const expected = [...goal.spec.readPaths].sort()
  if (!result || !Array.isArray(result.files) || result.files.length !== expected.length) throw new BrokerError('FILE_HELPER_FAILED', 'sandboxed snapshot failed')
  const files = []
  let total = 0
  for (let index = 0; index < expected.length; index++) {
    const file = result.files[index]
    if (!file || file.path !== expected[index] || typeof file.content !== 'string') throw new BrokerError('FILE_HELPER_FAILED', 'sandboxed snapshot failed')
    const size = Buffer.byteLength(file.content)
    if (size > MAX_FILE_BYTES) throw new BrokerError('FILE_TOO_LARGE', 'approved file exceeds 80 KiB', 413)
    total += size
    if (total > MAX_TOTAL_BYTES) throw new BrokerError('CONTEXT_TOO_LARGE', 'approved context exceeds 160 KiB', 413)
    files.push({ path: expected[index], content: file.content, writable: goal.spec.writePaths.includes(expected[index]) })
  }
  const hash = crypto.createHash('sha256')
  for (const file of files) hash.update(JSON.stringify([file.path, file.content]))
  const artifactRef = `sha256:${hash.digest('hex')}`
  if (result.artifactRef !== artifactRef) throw new BrokerError('FILE_HELPER_FAILED', 'sandboxed snapshot digest mismatch')
  return { files, artifactRef }
}

function validateProposal(goal, proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || !Array.isArray(proposal.files)) throw new BrokerError('INVALID_PROPOSAL', 'a proposed files array is required', 400)
  if (proposal.files.length > goal.spec.writePaths.length) throw new BrokerError('WRITE_SCOPE', 'proposal exceeds approved write scope', 403)
  const acceptance = new Set(goal.spec.checks.map(check => check.args[1]))
  const seen = new Set(), files = []
  let total = 0
  for (const item of proposal.files) {
    if (!item || typeof item.path !== 'string' || !goal.spec.writePaths.includes(item.path) || acceptance.has(item.path) || seen.has(item.path)) throw new BrokerError('WRITE_SCOPE', 'proposal exceeds approved write scope', 403)
    if (typeof item.content !== 'string') throw new BrokerError('INVALID_PROPOSAL', 'proposed content must be text', 400)
    const size = Buffer.byteLength(item.content)
    if (size > MAX_FILE_BYTES) throw new BrokerError('FILE_TOO_LARGE', 'proposed file exceeds 80 KiB', 413)
    total += size
    if (total > MAX_TOTAL_BYTES) throw new BrokerError('CONTEXT_TOO_LARGE', 'proposed context exceeds 160 KiB', 413)
    seen.add(item.path); files.push({ path: item.path, content: item.content })
  }
  return files
}

export function createGoalAccessBroker({ goals, goal, leaseToken, role } = {}) {
  if (!goals || typeof goals.withLease !== 'function' || typeof goals.get !== 'function') throw new BrokerError('BROKER_CONFIGURATION', 'a GoalStore is required', 500)
  if (!goal || typeof goal.id !== 'string' || typeof goal.owner !== 'string' || !Number.isInteger(goal.generation) || typeof goal.specDigest !== 'string' || typeof goal.workspaceDir !== 'string') throw new BrokerError('BROKER_CONFIGURATION', 'a fully bound goal is required', 500)
  if (typeof leaseToken !== 'string' || !leaseToken) throw new BrokerError('BROKER_CONFIGURATION', 'a private lease token is required', 500)
  if (!ROLES.has(role)) throw new BrokerError('BROKER_CONFIGURATION', 'role must be worker or reviewer', 400)
  const grantExpiresAt = Date.parse(goal.grant?.expiresAt)
  if (!Number.isFinite(grantExpiresAt)) throw new BrokerError('GRANT_INACTIVE', 'goal has no finite grant expiry', 403)
  const binding = Object.freeze({ id: goal.id, owner: goal.owner, generation: goal.generation, specDigest: goal.specDigest, workspaceDir: path.resolve(goal.workspaceDir), grantExpiresAt: goal.grant.expiresAt })
  const goalSnapshot = structuredClone(goal)

  const guard = current => {
    if (current.id !== binding.id) throw new BrokerError('SCOPE_DRIFT', 'goal binding changed', 403)
    if (current.owner !== binding.owner) throw new BrokerError('OWNER_DRIFT', 'goal owner changed', 403)
    if (current.generation !== binding.generation || current.specDigest !== binding.specDigest) throw new BrokerError('SCOPE_DRIFT', 'goal scope changed since confirmation', 403)
    if (goalSpecDigest(current.spec) !== current.specDigest || current.grant?.expiresAt !== binding.grantExpiresAt) throw new BrokerError('SCOPE_DRIFT', 'goal grant or scope content changed', 403)
    if (path.resolve(current.workspaceDir) !== binding.workspaceDir) throw new BrokerError('WORKSPACE_DRIFT', 'goal workspace changed', 403)
    assertLeaseIntegrity(current, leaseToken)
  }

  const underLease = operation => goals.withLease(binding.id, leaseToken, async current => { guard(current); return operation(current) })

  const workspaceState = () => underLease(async current => {
    const readPaths = [...current.spec.readPaths].sort()
    const readFiles = []
    for (const relative of readPaths) readFiles.push(await regularFile(current.workspaceDir, relative))
    const node = await fs.realpath(process.execPath)
    const result = await runFileHelper({ node, workspaceDir: current.workspaceDir, request: { op: 'snapshot', workspaceDir: current.workspaceDir, readPaths }, readFiles })
    return verifySnapshot(current, result)
  })

  const applyProposal = proposal => {
    if (role !== 'worker') throw new BrokerError('READ_ONLY_ROLE', 'reviewer access is read-only', 403)
    return underLease(async current => {
      const files = validateProposal(current, proposal)
      const canonicalRoot = await fs.realpath(current.workspaceDir)
      const paths = files.map(file => file.path)
      const tempNames = {}
      for (const relative of paths) tempNames[relative] = `${relative}.${crypto.randomUUID()}.tmp`
      const writeFiles = []
      for (const relative of paths) writeFiles.push(await regularFile(current.workspaceDir, relative))
      for (const relative of paths) writeFiles.push(path.join(canonicalRoot, tempNames[relative]))
      const node = await fs.realpath(process.execPath)
      const result = await runFileHelper({ node, workspaceDir: canonicalRoot, request: { op: 'apply', workspaceDir: canonicalRoot, files, tempNames }, writeFiles })
      if (!result || result.ok !== true) throw new BrokerError('FILE_HELPER_FAILED', 'sandboxed file replacement failed')
      return { applied: paths }
    })
  }

  const isAuthorityCurrent = async () => {
    if (await goals.isPaused()) return false
    const current = await goals.get(binding.id).catch(() => null)
    if (!current) return false
    if (current.owner !== binding.owner || current.generation !== binding.generation || current.specDigest !== binding.specDigest || path.resolve(current.workspaceDir) !== binding.workspaceDir) return false
    if (current.status !== 'running' || current.lease?.token !== leaseToken || current.lease?.generation !== current.generation) return false
    if (!Number.isFinite(current.lease?.expiresAt) || current.lease.expiresAt <= Date.now()) return false
    if (!Number.isFinite(Date.parse(current.grant?.expiresAt)) || Date.parse(current.grant.expiresAt) <= Date.now()) return false
    if (grantFailureReason(current)) return false
    if (goalSpecDigest(current.spec) !== current.specDigest || current.grant.expiresAt !== binding.grantExpiresAt) return false
    return true
  }

  // Validate scope and synchronously launch under the goal lock, then return so
  // the long check wait never holds the JSON lock (heartbeat/pause stay live).
  const admitAndLaunch = async launch => {
    let launched
    try {
      await goals.withLease(binding.id, leaseToken, current => { guard(current); launched = launch() })
      return launched
    } catch (error) {
      // Admission failed after the child was launched: never leave an orphan.
      if (launched) {
        try { process.kill(-launched.child.pid, 'SIGKILL') } catch {}
        await launched.completion.catch(() => {})
      }
      throw error
    }
  }

  const runChecks = async ({ signal, timeoutMs = 30000, checks } = {}) => {
    if (signal?.aborted) throw new BrokerError('ABORTED', 'goal check cancelled before launch')
    const internal = new AbortController()
    const forward = () => internal.abort(signal?.reason instanceof Error ? signal.reason : new Error('goal check aborted'))
    signal?.addEventListener('abort', forward, { once: true })
    const expiry = Date.parse(binding.grantExpiresAt)
    const remaining = Number.isFinite(expiry) ? Math.max(1, expiry - Date.now()) : timeoutMs
    const monitor = setInterval(() => { void isAuthorityCurrent().then(current => { if (!current) internal.abort(new Error('goal authority changed during checks')) }).catch(() => {}) }, 1000)
    try {
      if (!(await isAuthorityCurrent())) throw new BrokerError('GRANT_INACTIVE', 'goal authority is no longer active', 403)
      return await runSandboxChecks(goalSnapshot, { signal: internal.signal, timeoutMs: Math.min(timeoutMs, remaining), checks: checks ?? goalSnapshot.spec.checks, role: 'reviewer', beforeSpawn: admitAndLaunch })
    } finally {
      clearInterval(monitor)
      signal?.removeEventListener('abort', forward)
    }
  }

  // Optional ACP filesystem callback adapter bound to the trusted host session.
  const filesystemFor = nativeSessionId => {
    if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim() || nativeSessionId.length > 200) throw new BrokerError('ACP_BINDING', 'a host nativeSessionId is required', 400)
    const assertSession = params => { if (!params || params.sessionId !== nativeSessionId) throw new BrokerError('ACP_BINDING', 'ACP session does not match the bound host session', 403) }
    const relativePath = value => {
      if (typeof value !== 'string' || !value) throw new BrokerError('PATH_DENIED', 'approved path is required')
      const relative = path.isAbsolute(value) ? path.relative(binding.workspaceDir, value) : value
      if (!goalSnapshot.spec.readPaths.includes(relative)) throw new BrokerError('PATH_DENIED', 'path is not in the approved scope')
      return relative
    }
    return Object.freeze({
      readTextFile: async params => {
        assertSession(params)
        const state = await workspaceState()
        const file = state.files.find(candidate => candidate.path === relativePath(params.path))
        if (!file) throw new BrokerError('PATH_DENIED', 'path is not in the approved read scope', 403)
        return { content: file.content }
      },
      writeTextFile: async params => {
        assertSession(params)
        await applyProposal({ files: [{ path: relativePath(params.path), content: params.content }] })
        return {}
      },
    })
  }

  return Object.freeze({ workspaceState, applyProposal, runChecks, filesystemFor, role, binding: () => binding })
}
