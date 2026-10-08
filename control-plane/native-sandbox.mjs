// NativeSandbox: reusable macOS Seatbelt primitives for wrapping a native
// process.exec call in an OS-enforced sandbox.
//
// This is the V25 interface layer only. It builds profiles and command shapes;
// it does not spawn anything and it is not yet wired into native-acp-executor.
//
// Hardening (r2, per M02-NS-E001): read access is DENY-BY-DEFAULT. The r1 shape
// ("allow default" plus four fixed deny trees) treated every directory outside
// that small list — e.g. /private/var/tmp — as readable, so an unlisted private
// tree was implicitly public. The profile now emits a blanket (deny file-read*)
// and re-allows only: the read-only system roots a native binary needs to load
// and start, the Grant-authorized workspace, and the explicit read literals.
// The boundary is enforced by the operating system, not by the working
// directory: cwd is not an isolation proof, Seatbelt is.
//
// Like the goal-access-broker precedent there is no unsandboxed fallback: when
// Seatbelt is unavailable the caller must fail closed with SANDBOX_REQUIRED.
import fs from 'node:fs'
import path from 'node:path'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

// Read-only system roots re-allowed on top of the default read deny. These are
// what a native binary loads/reads to start (dyld, libSystem, the shell's
// variant selector). They are read-only system content, never user data.
//   /dev holds the null/urandom character devices; /private/etc holds system
//   configuration (hosts, ssl); /etc is a separate mount view of the same data
//   that Seatbelt matches by presented path, so both forms are listed.
// Residual surface and trade-offs are recorded in the r2 handoff.
export const SYSTEM_READ_SUBPATHS = Object.freeze([
  '/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/etc', '/dev',
])

export class NativeSandboxError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NativeSandboxError'
    this.code = code
  }
}

const fail = (message, code = 'INVALID_SPEC') => { throw new NativeSandboxError(code, message) }

// Seatbelt string literals are quoted with double quotes; JSON string encoding
// escapes exactly the `"` and `\` characters that would otherwise break out of
// the literal (and any control characters), so it is the correct escaper.
const quote = value => JSON.stringify(value)

const assertAbsolute = (value, label) => {
  if (typeof value !== 'string' || !value.startsWith('/')) fail(`${label} must be an absolute path`)
}

const assertAbsoluteList = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  for (const entry of value) assertAbsolute(entry, `${label} entry`)
}

// Resolve a path to the canonical form Seatbelt actually matches. Seatbelt
// matches the path as presented, so a grant written as /var/tmp/x does NOT
// authorize access through the canonical /private/var/tmp/x (and vice versa):
// grants are only effective when they use the canonical form. realpath() the
// deepest existing ancestor and re-append the missing tail, so a grant for a
// not-yet-created file under a symlinked directory (/var/tmp/ws/new) still
// canonicalizes. A path that does not exist yet loses nothing.
const canonicalPath = value => {
  const resolved = path.resolve(value)
  const tail = []
  let current = resolved
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    tail.unshift(path.basename(current))
    current = parent
  }
  let real
  try { real = fs.realpathSync(current) } catch { return resolved }
  return tail.length === 0 ? real : path.join(real, ...tail)
}

// The spec is trusted configuration supplied by the host, but it is validated
// strictly and canonicalized before any clause is emitted: unknown keys are
// rejected (so a typo cannot silently disable a rule), booleans must be real
// booleans (never JS truthiness — denyNetwork:0 must NOT mean "allow network"),
// and every path must be an absolute literal.
const KNOWN_SPEC_KEYS = new Set(['execLiterals', 'readLiterals', 'writeLiterals', 'workspaceDir', 'denyNetwork'])

const normalizeSpec = spec => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('a sandbox spec object is required')
  for (const key of Object.keys(spec)) if (!KNOWN_SPEC_KEYS.has(key)) fail(`unknown sandbox spec key: ${key}`)
  const { execLiterals, readLiterals = [], writeLiterals = [], workspaceDir, denyNetwork = true } = spec
  if (!Array.isArray(execLiterals) || execLiterals.length === 0) fail('execLiterals must be a non-empty array')
  assertAbsoluteList(execLiterals, 'execLiterals')
  assertAbsoluteList(readLiterals, 'readLiterals')
  assertAbsoluteList(writeLiterals, 'writeLiterals')
  if (workspaceDir !== undefined) assertAbsolute(workspaceDir, 'workspaceDir')
  if (typeof denyNetwork !== 'boolean') fail('denyNetwork must be a boolean')
  return {
    execLiterals: execLiterals.map(canonicalPath),
    readLiterals: readLiterals.map(canonicalPath),
    writeLiterals: writeLiterals.map(canonicalPath),
    workspaceDir: workspaceDir === undefined ? undefined : canonicalPath(workspaceDir),
    denyNetwork,
  }
}

// Emit the profile from an already-normalized spec. Rules are ordered
// base-then-specific: Seatbelt uses the LAST matching clause, so the blanket
// (deny file-read*) followed by explicit (allow file-read* ...) literals is the
// default-deny-read boundary.
const profileFromNormalized = ({ execLiterals, readLiterals, writeLiterals, workspaceDir, denyNetwork }) => {
  const clauses = ['(version 1)', '(allow default)']
  if (denyNetwork) clauses.push('(deny network*)')

  // Only explicitly whitelisted binaries may be executed.
  clauses.push('(deny process-exec)')
  for (const literal of execLiterals) clauses.push(`(allow process-exec (literal ${quote(literal)}))`)

  // Reads are deny-by-default. Literal "/" is re-allowed for metadata only so
  // the kernel can traverse absolute paths at all; the system roots, the exec
  // binaries themselves, the workspace and the read literals are the only
  // content that becomes readable.
  clauses.push('(deny file-read*)')
  const allowRead = [
    '(literal "/")',
    ...SYSTEM_READ_SUBPATHS.map(subpath => `(subpath ${quote(subpath)})`),
    ...execLiterals.map(literal => `(literal ${quote(literal)})`),
    ...(workspaceDir === undefined ? [] : [`(subpath ${quote(workspaceDir)})`]),
    ...readLiterals.map(literal => `(literal ${quote(literal)})`),
  ].join(' ')
  clauses.push(`(allow file-read* ${allowRead})`)

  // Writes stay deny-by-default: /dev/null, the authorized workspace and the
  // explicit write literals only.
  clauses.push('(deny file-write*)')
  const allowWrite = [
    '(literal "/dev/null")',
    ...(workspaceDir === undefined ? [] : [`(subpath ${quote(workspaceDir)})`]),
    ...writeLiterals.map(literal => `(literal ${quote(literal)})`),
  ].join(' ')
  clauses.push(`(allow file-write* ${allowWrite})`)

  clauses.push('(deny mach-lookup (global-name "com.apple.securityd"))')

  return clauses.join('')
}

// Fail closed when Seatbelt is not available. Mirrors the goal-access-broker
// guard: a non-darwin host, or a darwin host without the sandbox-exec helper,
// is refused outright — there is no unsandboxed fallback path.
export function assertSandboxAvailable() {
  if (process.platform !== 'darwin') throw new NativeSandboxError('SANDBOX_REQUIRED', 'macOS Seatbelt is required (/usr/bin/sandbox-exec); no unsandboxed fallback')
  if (!fs.existsSync(SANDBOX_EXEC)) throw new NativeSandboxError('SANDBOX_REQUIRED', 'macOS Seatbelt is required (/usr/bin/sandbox-exec); no unsandboxed fallback')
}

// Build a Seatbelt profile string from a spec.
export function buildSandboxProfile(spec) {
  return profileFromNormalized(normalizeSpec(spec))
}

// Minimal environment for a sandboxed child. A fresh object each call so a
// caller cannot mutate a shared constant, and no host environment is inherited.
export function sandboxEnv() {
  return { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_COLOR: '1' }
}

// Compose the command that runs `command args` under Seatbelt. The wrapped
// command must itself be one of the exec whitelist literals: wrapping is only a
// mechanism to enforce the boundary, it must never broaden it by introducing a
// command the profile would not permit. The emitted target is canonicalized so
// it matches the literal the profile actually allows.
export function wrapWithSandbox(command, args, spec) {
  if (!Array.isArray(args)) fail('args must be an array')
  assertSandboxAvailable()
  assertAbsolute(command, 'command')
  const normalized = normalizeSpec(spec)
  const target = canonicalPath(command)
  if (!normalized.execLiterals.includes(target)) fail('command must be one of spec.execLiterals')
  return { command: SANDBOX_EXEC, args: ['-p', profileFromNormalized(normalized), target, ...args] }
}
