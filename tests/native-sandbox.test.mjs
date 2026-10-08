// V25 interface-layer tests for control-plane/native-sandbox.mjs.
//
// Two groups: structural assertions on the profile/spec/env shape, and real
// enforcement tests that invoke the genuine /usr/bin/sandbox-exec helper and
// assert the OS itself denies the operation. The real tests are the load-bearing
// ones: they prove the boundary is enforced by Seatbelt, not by the working
// directory (cwd is not an isolation proof).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  NativeSandboxError,
  SANDBOX_EXEC,
  DEFAULT_DENY_READ_SUBPATHS,
  assertSandboxAvailable,
  buildSandboxProfile,
  sandboxEnv,
  wrapWithSandbox,
} from '../control-plane/native-sandbox.mjs'

const MAC = { skip: process.platform !== 'darwin' }

// Resident temp dir under the platform tmp tree (realpath so assertions see the
// canonical /private/var/folders form the deny subpaths actually target).
const tmpdir = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-sandbox-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

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

// --- structural -----------------------------------------------------------------

test('buildSandboxProfile emits every enforced clause', () => {
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
    '(deny file-read*',
    '(subpath "/Users")',
    '(subpath "/private/var/folders")',
    '(subpath "/private/tmp")',
    '(subpath "/Volumes")',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/bin/echo") (subpath "/synthetic/ws") (literal "/synthetic/ws/read.txt"))',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/synthetic/ws/write.txt"))',
    '(deny mach-lookup (global-name "com.apple.securityd"))',
  ]
  for (const clause of required) assert.ok(profile.includes(clause), `profile is missing clause: ${clause}`)
  // denyNetwork=false drops the network clause but keeps the rest.
  assert.ok(!buildSandboxProfile({ execLiterals: ['/bin/echo'], denyNetwork: false }).includes('(deny network*)'))
})

test('DEFAULT_DENY_READ_SUBPATHS is the frozen default deny set', () => {
  assert.deepEqual([...DEFAULT_DENY_READ_SUBPATHS], ['/Users', '/private/var/folders', '/private/tmp', '/Volumes'])
  assert.ok(Object.isFrozen(DEFAULT_DENY_READ_SUBPATHS))
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

test('quotes and backslashes in literals are escaped, not left to break the profile', () => {
  const literal = '/bin/we"ird\\path'
  const profile = buildSandboxProfile({ execLiterals: [literal] })
  assert.ok(profile.includes(`(literal ${JSON.stringify(literal)})`), profile)
  assert.ok(!profile.includes('we"ird'), 'the raw unescaped quote must not survive into the profile')
})

test('wrapWithSandbox shapes the command and refuses a command outside the whitelist', MAC, () => {
  const spec = { execLiterals: ['/bin/echo'] }
  const wrapped = wrapWithSandbox('/bin/echo', ['hello'], spec)
  assert.equal(wrapped.command, SANDBOX_EXEC)
  assert.equal(wrapped.args[0], '-p')
  assert.equal(typeof wrapped.args[1], 'string')
  assert.ok(wrapped.args[1].includes('(deny network*)'))
  assert.equal(wrapped.args[2], '/bin/echo')
  assert.deepEqual(wrapped.args.slice(3), ['hello'])
  assert.throws(() => wrapWithSandbox('/usr/bin/true', [], spec), error => error instanceof NativeSandboxError && error.code === 'INVALID_SPEC')
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

test('real Seatbelt: network is denied while a local listener is reachable from the host', MAC, async t => {
  // Distinguish "Seatbelt denied the network" from "nothing was listening" by
  // proving a listener exists and is reachable from the (unsandboxed) host, then
  // showing curl fails only inside the sandbox; an in-sandbox echo baseline
  // proves the sandbox itself is otherwise working.
  let server = null
  try {
    server = await new Promise((resolve, reject) => {
      const candidate = http.createServer((request, response) => { response.writeHead(200); response.end('ok') })
      candidate.once('error', reject)
      candidate.listen(4324, '127.0.0.1', () => resolve(candidate))
    })
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error // a foreign listener already owns the port
  }
  t.after(() => server?.close())
  const status = await new Promise(resolve => {
    const request = http.get('http://127.0.0.1:4324/health', response => { response.resume(); resolve(response.statusCode) })
    request.on('error', error => resolve(`ERR:${error.code}`))
    request.setTimeout(2000, () => { request.destroy(); resolve('timeout') })
  })
  if (typeof status !== 'number') { t.skip(`no listener on 127.0.0.1:4324 (${status})`); return }

  const spec = { execLiterals: ['/usr/bin/curl', '/bin/echo'] }
  const baseline = await runWrapped('/bin/echo', ['sandbox-alive'], spec)
  assert.equal(baseline.code, 0, 'the sandbox baseline must run so a curl failure is attributable to the network deny')
  const curled = await runWrapped('/usr/bin/curl', ['--max-time', '2', '-s', 'http://127.0.0.1:4324/health'], spec)
  assert.notEqual(curled.code, 0, `deny network* must block an otherwise reachable listener (curl exited ${curled.code})`)
})

test('real Seatbelt: a private read outside the literal set is denied', MAC, async t => {
  const dir = tmpdir(t)
  const secret = path.join(dir, 'secret')
  fs.writeFileSync(secret, 'synthetic-private')
  // The temp dir resolves under a default deny-read subpath; assert it so the
  // test cannot silently pass for the wrong reason.
  assert.ok(DEFAULT_DENY_READ_SUBPATHS.some(subpath => dir === subpath || dir.startsWith(`${subpath}/`)), `temp dir ${dir} is not under a denied read subpath`)
  const result = await runWrapped('/bin/cat', [secret], { execLiterals: ['/bin/cat'] })
  assert.notEqual(result.code, 0, 'reading a denied file must fail')
  assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic-private')
})
