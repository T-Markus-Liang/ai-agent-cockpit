// V25 interface-layer tests for control-plane/native-sandbox.mjs.
//
// Two groups: structural assertions on the profile/spec/env shape, and real
// enforcement tests that invoke the genuine /usr/bin/sandbox-exec helper and
// assert the OS itself denies the operation. The real tests are the load-bearing
// ones: they prove the boundary is enforced by Seatbelt, not by the working
// directory (cwd is not an isolation proof).
//
// r2 adds the NS-E001/NS-N001 regression set: the read boundary is default-deny,
// so an UNLISTED private directory (e.g. /private/var/tmp) is no longer readable
// merely because it was not enumerated, and a non-boolean denyNetwork is
// rejected instead of silently disabling the network deny.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  NativeSandboxError,
  SANDBOX_EXEC,
  SYSTEM_READ_SUBPATHS,
  assertSandboxAvailable,
  buildSandboxProfile,
  sandboxEnv,
  wrapWithSandbox,
} from '../control-plane/native-sandbox.mjs'

const MAC = { skip: process.platform !== 'darwin' }

// A resident fixture directory under `base`, realpath'd so the test sees the
// canonical form Seatbelt actually matches (e.g. /var/tmp -> /private/var/tmp).
const makeDir = (t, base, prefix = 'native-sandbox-') => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
// Unlisted private temp trees used to be readable by default; both are outside
// SYSTEM_READ_SUBPATHS so they exercise the deny-by-default read boundary.
const tmpdir = t => makeDir(t, os.tmpdir())
const varTmpDir = t => makeDir(t, '/var/tmp')

function spawnResult(command, args, { timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: '/', env: sandboxEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => finish({ code: -1, stdout, stderr, error }))
    child.once('close', code => finish({ code, stdout, stderr }))
  })
}

// Wrap a whitelisted command exactly as production would, then run it.
const runWrapped = (command, args, spec) => {
  const wrapped = wrapWithSandbox(command, args, spec)
  return spawnResult(wrapped.command, wrapped.args)
}

// Run an arbitrary command against a profile directly (bypassing the wrapper's
// own whitelist guard) so the OS-level exec boundary can be probed in isolation.
const runProfile = (command, args, spec) => spawnResult(SANDBOX_EXEC, ['-p', buildSandboxProfile(spec), command, ...args])

// The read boundary is only meaningful if the target is really outside every
// re-allowed root; assert it so a test cannot pass for the wrong reason.
const assertUnlisted = dir => assert.ok(
  !SYSTEM_READ_SUBPATHS.some(subpath => dir === subpath || dir.startsWith(`${subpath}/`)),
  `fixture ${dir} must not sit under a re-allowed system read root`,
)

// --- structural -----------------------------------------------------------------

test('buildSandboxProfile emits every enforced clause with read deny-by-default', () => {
  const profile = buildSandboxProfile({
    execLiterals: ['/bin/echo'],
    workspaceDir: '/synthetic/ws',
    readLiterals: ['/synthetic/ws/read.txt'],
    writeLiterals: ['/synthetic/ws/write.txt'],
  })
  const required = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny process-exec)',
    '(allow process-exec (literal "/bin/echo"))',
    '(deny file-read*)',
    '(allow file-read* (literal "/")',
    '(subpath "/System")',
    '(subpath "/usr")',
    '(subpath "/bin")',
    '(subpath "/sbin")',
    '(subpath "/Library")',
    '(subpath "/private/etc")',
    '(subpath "/dev")',
    '(literal "/bin/echo")',
    '(subpath "/synthetic/ws")',
    '(literal "/synthetic/ws/read.txt")',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (subpath "/synthetic/ws") (literal "/synthetic/ws/write.txt"))',
    '(deny mach-lookup (global-name "com.apple.securityd"))',
  ]
  for (const clause of required) assert.ok(profile.includes(clause), `profile is missing clause: ${clause}`)
  // The r1 hole was a blanket metadata allow widening every unlisted path.
  assert.ok(!profile.includes('(allow file-read-metadata)'), 'the blanket metadata allow must be gone')
  // denyNetwork=false drops the network clause but keeps the rest.
  assert.ok(!buildSandboxProfile({ execLiterals: ['/bin/echo'], denyNetwork: false }).includes('(deny network*)'))
})

test('SYSTEM_READ_SUBPATHS is the frozen re-allowed system read set', () => {
  assert.deepEqual([...SYSTEM_READ_SUBPATHS], ['/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/etc', '/dev'])
  assert.ok(Object.isFrozen(SYSTEM_READ_SUBPATHS))
})

test('spec validation rejects empty exec whitelists and relative paths', () => {
  const invalid = [
    () => buildSandboxProfile(),
    () => buildSandboxProfile({}),
    () => buildSandboxProfile({ execLiterals: [] }),
    () => buildSandboxProfile({ execLiterals: 'bin/echo' }),
    () => buildSandboxProfile({ execLiterals: ['bin/echo'] }),
    () => buildSandboxProfile({ execLiterals: ['/bin/echo'], workspaceDir: 'relative/ws' }),
    () => buildSandboxProfile({ execLiterals: ['/bin/echo'], readLiterals: ['relative'] }),
    () => buildSandboxProfile({ execLiterals: ['/bin/echo'], writeLiterals: ['relative'] }),
  ]
  for (const build of invalid) assert.throws(build, error => error instanceof NativeSandboxError && error.code === 'INVALID_SPEC')
})

// NS-N001: a non-boolean must never be interpreted by JS truthiness. In r1
// `denyNetwork: 0` was accepted and silently omitted the network deny (the
// auditor's malformed-network-option repro); now it must be rejected.
test('denyNetwork must be a real boolean, never JS truthiness (NS-N001 repro)', () => {
  for (const value of [0, 1, 'true', 'false', null, [], {}]) {
    assert.throws(
      () => buildSandboxProfile({ execLiterals: ['/bin/echo'], denyNetwork: value }),
      error => error instanceof NativeSandboxError && error.code === 'INVALID_SPEC',
      `denyNetwork: ${JSON.stringify(value)} must be rejected`,
    )
  }
  assert.throws(() => buildSandboxProfile({ execLiterals: ['/bin/echo'], denyNetwork: 0 }))
  // A genuine boolean is still honoured both ways.
  assert.ok(buildSandboxProfile({ execLiterals: ['/bin/echo'], denyNetwork: true }).includes('(deny network*)'))
  assert.ok(!buildSandboxProfile({ execLiterals: ['/bin/echo'], denyNetwork: false }).includes('(deny network*)'))
})

// NS-N001: unknown keys are rejected so a typo cannot silently disable a rule.
test('unknown configuration keys are rejected (NS-N001)', () => {
  for (const spec of [
    { execLiterals: ['/bin/echo'], allowNetwork: true },
    { execLiterals: ['/bin/echo'], extraDenyReadSubpaths: ['/tmp'] },
    { execLiterals: ['/bin/echo'], denynetwork: false },
    { execLiterals: ['/bin/echo'], workspace: '/synthetic/ws' },
  ]) {
    assert.throws(
      () => buildSandboxProfile(spec),
      error => error instanceof NativeSandboxError && error.code === 'INVALID_SPEC' && /unknown sandbox spec key/.test(error.message),
    )
  }
})

test('quotes and backslashes in literals are escaped, not left to break the profile', () => {
  const literal = '/bin/we"ird\\path'
  const profile = buildSandboxProfile({ execLiterals: [literal] })
  assert.ok(profile.includes(`(literal ${JSON.stringify(literal)})`), profile)
  assert.ok(!profile.includes('we"ird'), 'the raw unescaped quote must not survive into the profile')
})

test('a symlinked workspace path is canonicalized into the emitted grant', MAC, t => {
  const aliasDir = fs.mkdtempSync('/var/tmp/native-sandbox-alias-')
  const canonDir = fs.realpathSync(aliasDir)
  t.after(() => fs.rmSync(canonDir, { recursive: true, force: true }))
  assert.notEqual(aliasDir, canonDir, '/var/tmp must differ from its canonical /private/var/tmp form for this test to bite')
  const profile = buildSandboxProfile({ execLiterals: ['/bin/cat'], workspaceDir: aliasDir })
  assert.ok(profile.includes(`(subpath ${JSON.stringify(canonDir)})`), 'the canonical workspace form must be granted')
  assert.ok(!profile.includes(`(subpath ${JSON.stringify(aliasDir)})`), 'the alias form must not be emitted')
})

test('wrapWithSandbox shapes the command and refuses a command outside the whitelist', MAC, () => {
  const spec = { execLiterals: ['/bin/echo'] }
  const wrapped = wrapWithSandbox('/bin/echo', ['hello'], spec)
  assert.equal(wrapped.command, SANDBOX_EXEC)
  assert.equal(wrapped.args[0], '-p')
  assert.equal(typeof wrapped.args[1], 'string')
  assert.ok(wrapped.args[1].includes('(deny network*)'))
  assert.ok(wrapped.args[1].includes('(deny file-read*)'))
  assert.equal(wrapped.args[2], '/bin/echo')
  assert.deepEqual(wrapped.args.slice(3), ['hello'])
  assert.throws(() => wrapWithSandbox('/usr/bin/true', [], spec), error => error instanceof NativeSandboxError && error.code === 'INVALID_SPEC')
  assert.throws(() => wrapWithSandbox('echo', [], spec), error => error instanceof NativeSandboxError && error.code === 'INVALID_SPEC')
})

test('sandboxEnv returns a fresh minimal environment', () => {
  const env = sandboxEnv()
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_COLOR: '1' })
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'NO_COLOR', 'PATH'])
  assert.notStrictEqual(sandboxEnv(), sandboxEnv())
})

test('assertSandboxAvailable fails closed with SANDBOX_REQUIRED when Seatbelt is missing', MAC, () => {
  assert.doesNotThrow(() => assertSandboxAvailable())
  const original = fs.existsSync
  try {
    fs.existsSync = () => false
    assert.throws(() => assertSandboxAvailable(), error => error instanceof NativeSandboxError && error.code === 'SANDBOX_REQUIRED' && /sandbox-exec/.test(error.message))
  } finally {
    fs.existsSync = original
  }
})

// --- real Seatbelt enforcement --------------------------------------------------

test('real Seatbelt: a whitelisted command runs and reaches stdout', MAC, async t => {
  tmpdir(t)
  const result = await runWrapped('/bin/echo', ['hello'], { execLiterals: ['/bin/echo'] })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'hello')
})

test('real Seatbelt: an unlisted private temp file is denied without a grant (NS-E001 repro)', MAC, async t => {
  const dir = varTmpDir(t)
  assertUnlisted(dir)
  const file = path.join(dir, 'synthetic-unlisted.txt')
  fs.writeFileSync(file, 'synthetic-unlisted-private')
  // r1 read this via allow-default; deny-by-default must refuse it.
  const denied = await runWrapped('/bin/cat', [file], { execLiterals: ['/bin/cat'] })
  assert.notEqual(denied.code, 0, 'an unlisted private path must not be readable by default')
  assert.equal(denied.stdout, '', 'no unlisted content may leak to stdout')
  // The only way to open it is an exact literal grant.
  const granted = await runWrapped('/bin/cat', [file], { execLiterals: ['/bin/cat'], readLiterals: [file] })
  assert.equal(granted.code, 0, granted.stderr)
  assert.equal(granted.stdout, 'synthetic-unlisted-private')
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-unlisted-private')
})

test('real Seatbelt: a private read under the OS temp tree is denied by default', MAC, async t => {
  const dir = tmpdir(t)
  assertUnlisted(dir)
  const secret = path.join(dir, 'secret')
  fs.writeFileSync(secret, 'synthetic-private')
  const denied = await runWrapped('/bin/cat', [secret], { execLiterals: ['/bin/cat'] })
  assert.notEqual(denied.code, 0, 'reading a default-denied file must fail')
  assert.equal(denied.stdout, '')
  assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic-private')
})

test('real Seatbelt: a workspace symlink cannot escape the workspace', MAC, async t => {
  const base = varTmpDir(t)
  const ws = path.join(base, 'ws'); fs.mkdirSync(ws)
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside)
  const secret = path.join(outside, 'secret.txt'); fs.writeFileSync(secret, 'outside-secret')
  const inside = path.join(ws, 'inside.txt'); fs.writeFileSync(inside, 'inside-ok')
  fs.symlinkSync(secret, path.join(ws, 'link.txt'))
  const spec = { execLiterals: ['/bin/cat'], workspaceDir: ws }
  // control: the real workspace file is readable.
  const control = await runWrapped('/bin/cat', [inside], spec)
  assert.equal(control.code, 0, control.stderr)
  assert.equal(control.stdout, 'inside-ok')
  // the symlink resolves outside the granted subpath and must be refused.
  const escaped = await runWrapped('/bin/cat', [path.join(ws, 'link.txt')], spec)
  assert.notEqual(escaped.code, 0, 'a symlink pointing outside the workspace must be denied')
  assert.equal(escaped.stdout, '', 'no out-of-workspace content may leak')
  // and the target is not readable directly either.
  const direct = await runWrapped('/bin/cat', [secret], spec)
  assert.notEqual(direct.code, 0)
})

test('real Seatbelt: a grant is only effective through its canonical path', MAC, async t => {
  const aliasDir = fs.mkdtempSync('/var/tmp/native-sandbox-canon-')
  const canonDir = fs.realpathSync(aliasDir)
  t.after(() => fs.rmSync(canonDir, { recursive: true, force: true }))
  const canonFile = path.join(canonDir, 'inside.txt')
  fs.writeFileSync(canonFile, 'canon-ok')
  const spec = { execLiterals: ['/bin/cat'], workspaceDir: aliasDir }
  const viaCanon = await runWrapped('/bin/cat', [canonFile], spec)
  assert.equal(viaCanon.code, 0, viaCanon.stderr)
  assert.equal(viaCanon.stdout, 'canon-ok')
  // Seatbelt matches the path as presented, so the /var alias is not authorized.
  const viaAlias = await runWrapped('/bin/cat', [path.join(aliasDir, 'inside.txt')], spec)
  assert.notEqual(viaAlias.code, 0, 'the alias of a granted path is not itself granted')
})

test('real Seatbelt: the workspace is read/write while outside stays denied', MAC, async t => {
  const dir = varTmpDir(t)
  const ws = path.join(dir, 'ws'); fs.mkdirSync(ws)
  const insideRead = path.join(ws, 'read.txt'); fs.writeFileSync(insideRead, 'ws-content')
  const read = await runWrapped('/bin/cat', [insideRead], { execLiterals: ['/bin/cat'], workspaceDir: ws })
  assert.equal(read.code, 0, read.stderr)
  assert.equal(read.stdout, 'ws-content')

  const wsWrite = path.join(ws, 'written.txt')
  const outsideWrite = path.join(dir, 'outside.txt')
  const shell = { execLiterals: ['/bin/sh', '/bin/bash'], workspaceDir: ws }
  const wrote = await runWrapped('/bin/sh', ['-c', `printf ws > ${wsWrite}`], shell)
  assert.equal(wrote.code, 0, wrote.stderr)
  assert.equal(fs.readFileSync(wsWrite, 'utf8'), 'ws')
  const blocked = await runWrapped('/bin/sh', ['-c', `printf x > ${outsideWrite}`], shell)
  assert.notEqual(blocked.code, 0, 'a write outside the workspace/literals must fail')
  assert.equal(fs.existsSync(outsideWrite), false)
})

test('real Seatbelt: a write outside the literal set is denied and leaves no file', MAC, async t => {
  const dir = tmpdir(t)
  const target = path.join(dir, 'escaped.txt')
  // /bin/sh re-execs /bin/bash as its variant, so both literals are needed for
  // the shell itself to start; the point of the test is the write target.
  const result = await runWrapped('/bin/sh', ['-c', `printf x > ${target}`], { execLiterals: ['/bin/sh', '/bin/bash'] })
  assert.notEqual(result.code, 0, 'a write with no matching literal must fail')
  assert.equal(fs.existsSync(target), false)
})

test('real Seatbelt: a literal write target is allowed and holds the right bytes', MAC, async t => {
  const dir = tmpdir(t)
  const target = path.join(dir, 'allowed.txt')
  const result = await runWrapped('/bin/sh', ['-c', `printf abc > ${target}`], { execLiterals: ['/bin/sh', '/bin/bash'], writeLiterals: [target] })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(fs.readFileSync(target, 'utf8'), 'abc')
})

test('real Seatbelt: exec outside the whitelist is denied by the profile', MAC, async () => {
  const spec = { execLiterals: ['/bin/echo'] }
  // Same profile, two commands: the whitelisted one runs, the other does not.
  const blocked = await runProfile('/usr/bin/true', [], spec)
  assert.notEqual(blocked.code, 0, 'a non-whitelisted exec must fail')
  const allowed = await runProfile('/bin/echo', ['ok'], spec)
  assert.equal(allowed.code, 0, allowed.stderr)
})

test('real Seatbelt: a self-built loopback listener is reachable only when the grant allows network', MAC, async t => {
  // Distinguish "Seatbelt denied the network" from "nothing was listening": a
  // unique nonce served from a self-built 127.0.0.1 listener is compared, and a
  // denied request must never arrive (request counter unchanged). No foreign or
  // production port is used.
  const nonce = crypto.randomBytes(16).toString('hex')
  let requests = 0
  const server = http.createServer((request, response) => { requests++; response.writeHead(200); response.end(nonce) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/synthetic-${nonce}`
  const curl = ['-q', '--max-time', '2', '-s', '--noproxy', '*', url]

  const allowed = await runWrapped('/usr/bin/curl', curl, { execLiterals: ['/usr/bin/curl'], denyNetwork: false })
  assert.equal(allowed.code, 0, allowed.stderr)
  assert.equal(allowed.stdout, nonce, 'the allowed request must return the self-built nonce')

  const before = requests
  const denied = await runWrapped('/usr/bin/curl', curl, { execLiterals: ['/usr/bin/curl'], denyNetwork: true })
  assert.notEqual(denied.code, 0, 'deny network* must block an otherwise reachable listener')
  assert.equal(denied.stdout, '')
  assert.equal(requests, before, 'the denied request must never reach the listener')
})
