// NativeSandbox: reusable macOS Seatbelt primitives for wrapping a native
// process.exec call in an OS-enforced sandbox.
//
// This is the V25 interface layer only. It builds profiles and command shapes;
// it does not spawn anything and it is not yet wired into native-acp-executor.
// The profile shape mirrors the proven helper profile in goal-access-broker.mjs
// (allow default for system libraries, explicit denies for user/temp/volume
// reads, no network, no exec beyond an explicit literal whitelist, writes only
// to exact literals). The decisive property is that the boundary is enforced by
// the operating system, not by the working directory: cwd is not an isolation
// proof, Seatbelt is.
//
// Following the goal-access-broker precedent there is no unsandboxed fallback:
// when Seatbelt is unavailable the caller must fail closed with SANDBOX_REQUIRED.
import fs from 'node:fs'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

// User, temp and volume read trees denied by default so that an unrelated
// process cannot exfiltrate private files merely by being spawned under one.
export const DEFAULT_DENY_READ_SUBPATHS = Object.freeze(['/Users', '/private/var/folders', '/private/tmp', '/Volumes'])

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

// Fail closed when Seatbelt is not available. Mirrors the goal-access-broker
// guard: a non-darwin host, or a darwin host without the sandbox-exec helper,
// is refused outright — there is no unsandboxed fallback path.
export function assertSandboxAvailable() {
  if (process.platform !== 'darwin') throw new NativeSandboxError('SANDBOX_REQUIRED', 'macOS Seatbelt is required (/usr/bin/sandbox-exec); no unsandboxed fallback')
  if (!fs.existsSync(SANDBOX_EXEC)) throw new NativeSandboxError('SANDBOX_REQUIRED', 'macOS Seatbelt is required (/usr/bin/sandbox-exec); no unsandboxed fallback')
}

// Build a Seatbelt profile string from a spec. The spec is trusted configuration
// supplied by the host, but every path is still validated to be an absolute
// literal so a relative or empty value cannot silently widen the boundary.
export function buildSandboxProfile(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('a sandbox spec object is required')
  const { execLiterals, readLiterals = [], writeLiterals = [], workspaceDir, denyNetwork = true, extraDenyReadSubpaths = [] } = spec
  if (!Array.isArray(execLiterals) || execLiterals.length === 0) fail('execLiterals must be a non-empty array')
  assertAbsoluteList(execLiterals, 'execLiterals')
  assertAbsoluteList(readLiterals, 'readLiterals')
  assertAbsoluteList(writeLiterals, 'writeLiterals')
  assertAbsoluteList(extraDenyReadSubpaths, 'extraDenyReadSubpaths')
  if (workspaceDir !== undefined) assertAbsolute(workspaceDir, 'workspaceDir')

  const clauses = ['(version 1)', '(allow default)']
  if (denyNetwork) clauses.push('(deny network*)')

  // Only explicitly whitelisted binaries may be executed.
  clauses.push('(deny process-exec)')
  for (const literal of execLiterals) clauses.push(`(allow process-exec (literal ${quote(literal)}))`)

  const denyRead = [...DEFAULT_DENY_READ_SUBPATHS, ...extraDenyReadSubpaths].map(subpath => `(subpath ${quote(subpath)})`).join(' ')
  clauses.push(`(deny file-read* ${denyRead})`)
  clauses.push('(allow file-read-metadata)')
  const allowRead = [
    ...execLiterals.map(literal => `(literal ${quote(literal)})`),
    ...(workspaceDir === undefined ? [] : [`(subpath ${quote(workspaceDir)})`]),
    ...readLiterals.map(literal => `(literal ${quote(literal)})`),
  ].join(' ')
  clauses.push(`(allow file-read* ${allowRead})`)

  clauses.push('(deny file-write*)')
  const allowWrite = ['/dev/null', ...writeLiterals].map(literal => `(literal ${quote(literal)})`).join(' ')
  clauses.push(`(allow file-write* ${allowWrite})`)

  clauses.push('(deny mach-lookup (global-name "com.apple.securityd"))')

  return clauses.join('')
}

// Minimal environment for a sandboxed child. A fresh object each call so a
// caller cannot mutate a shared constant, and no host environment is inherited.
export function sandboxEnv() {
  return { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_COLOR: '1' }
}

// Compose the command that runs `command args` under Seatbelt. The wrapped
// command must itself be one of the exec whitelist literals: wrapping is only a
// mechanism to enforce the boundary, it must never broaden it by introducing a
// command the profile would not permit.
export function wrapWithSandbox(command, args, spec) {
  if (!Array.isArray(args)) fail('args must be an array')
  assertSandboxAvailable()
  const profile = buildSandboxProfile(spec)
  if (!spec.execLiterals.includes(command)) fail('command must be one of spec.execLiterals')
  return { command: SANDBOX_EXEC, args: ['-p', profile, command, ...args] }
}
