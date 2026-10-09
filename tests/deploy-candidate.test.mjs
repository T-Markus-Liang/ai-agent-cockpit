import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  migrateWechatAcpConfig,
  generateAuthorityCandidates,
  resolveServiceAuthorityPaths,
  verifyGoalsAuthorityCandidate,
  DeployCandidateError,
  DEFAULT_CLIENTS,
} from '../control-plane/deploy-candidate.mjs'
import { createRequestAuthority, AuthorityError } from '../control-plane/request-authority.mjs'
import { PRINCIPAL_TTL_MS } from '../control-plane/identity-pairing.mjs'

// Fully synthetic harness: every path lives in an fs.mkdtempSync tree. No
// production state (~/.local/state, ~/.wechat-acp), no launchd, no git, no
// network beyond 127.0.0.1 ephemeral ports for the in-process goals preflight.
const sha256hex = value => crypto.createHash('sha256').update(value).digest('hex')
const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-candidate-'))

const baseConfig = () => ({
  controlPlaneUrl: 'http://127.0.0.1:4324',
  recovery: { enabled: true, sweepMs: 5000, maxAttempts: 3, baseDelayMs: 15000, replyMaxAttempts: 96, replyMaxDelayMs: 900000 },
  session: {
    resume: 'auto',
    idleTimeoutMs: 86400000,
    maxConcurrentUsers: 1,
    promptTimeoutMs: 300000,
    startupTimeoutMs: 60000,
    turnEndMessage: '',
  },
})

const writeSource = (dir, value) => {
  const sourcePath = path.join(dir, 'source.json')
  fs.writeFileSync(sourcePath, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return sourcePath
}

// ---------------------------------------------------------------------------
// 1a. configuration migration
// ---------------------------------------------------------------------------

test('legacy promptTimeoutMs migrates to grantDeadlineMs with a deprecation record; rollback holds the original bytes', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sourcePath = writeSource(dir, baseConfig())
  const targetPath = path.join(dir, 'candidate', 'wechat-acp.json')
  const { bytes, report, rollbackPath } = migrateWechatAcpConfig({ sourcePath, targetPath })
  const candidate = JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  assert.equal(candidate.session.grantDeadlineMs, 300000)
  assert.equal(Object.hasOwn(candidate.session, 'promptTimeoutMs'), false)
  assert.equal(Object.hasOwn(candidate.session, 'foregroundWaitMs'), false) // legacy key has no foreground semantics
  assert.equal(report.migrated, true)
  assert.equal(report.deprecations.length, 1)
  assert.match(report.deprecations[0], /promptTimeoutMs migrated to .*grantDeadlineMs=300000/)
  assert.equal(report.warnings.length, 0)
  assert.equal(report.sourceSha256, sha256hex(fs.readFileSync(sourcePath)))
  assert.equal(report.candidateSha256, sha256hex(fs.readFileSync(targetPath)))
  assert.equal(bytes, fs.statSync(targetPath).size)
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600)
  // rollback is a byte-identical copy of the source, mode 0600
  assert.equal(rollbackPath, `${targetPath}.rollback`)
  assert.deepEqual(fs.readFileSync(rollbackPath), fs.readFileSync(sourcePath))
  assert.equal(fs.statSync(rollbackPath).mode & 0o777, 0o600)
  // simulated rollback: restoring the rollback file reproduces the source byte-for-byte
  const restored = path.join(dir, 'restored.json')
  fs.writeFileSync(restored, fs.readFileSync(rollbackPath))
  assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(sourcePath))
})

test('both keys present and equal: legacy key removed, deprecation recorded', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = baseConfig()
  config.session.grantDeadlineMs = 300000
  const sourcePath = writeSource(dir, config)
  const targetPath = path.join(dir, 'wechat-acp.json')
  const { report } = migrateWechatAcpConfig({ sourcePath, targetPath })
  const candidate = JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  assert.equal(candidate.session.grantDeadlineMs, 300000)
  assert.equal(Object.hasOwn(candidate.session, 'promptTimeoutMs'), false)
  assert.equal(report.migrated, true)
  assert.equal(report.deprecations.length, 1)
  assert.match(report.deprecations[0], /identical to/)
})

test('conflicting legacy and modern keys refuse with config-conflict and zero writes', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = baseConfig()
  config.session.grantDeadlineMs = 600000
  const sourcePath = writeSource(dir, config)
  const targetPath = path.join(dir, 'wechat-acp.json')
  assert.throws(() => migrateWechatAcpConfig({ sourcePath, targetPath }),
    error => error instanceof DeployCandidateError && error.code === 'config-conflict')
  assert.equal(fs.existsSync(targetPath), false)
  assert.equal(fs.existsSync(`${targetPath}.rollback`), false)
})

test('only the modern key: config passes through unchanged, migrated=false', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = baseConfig()
  delete config.session.promptTimeoutMs
  config.session.grantDeadlineMs = 300000
  const sourcePath = writeSource(dir, config)
  const targetPath = path.join(dir, 'wechat-acp.json')
  const { report } = migrateWechatAcpConfig({ sourcePath, targetPath })
  const candidate = JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  assert.deepEqual(candidate, config)
  assert.equal(report.migrated, false)
  assert.equal(report.deprecations.length, 0)
})

test('invalid time fields refuse with config-invalid-time and zero writes', t => {
  const badValues = [0, -1, 1.5, '300000', Number.MAX_SAFE_INTEGER + 1, 2 ** 53, null, true]
  for (const key of ['promptTimeoutMs', 'foregroundWaitMs', 'grantDeadlineMs', 'startupTimeoutMs', 'idleTimeoutMs']) {
    for (const value of badValues) {
      const dir = mkdtemp()
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
      const config = baseConfig()
      delete config.session.promptTimeoutMs
      config.session[key] = value
      const sourcePath = writeSource(dir, config)
      const targetPath = path.join(dir, 'wechat-acp.json')
      assert.throws(() => migrateWechatAcpConfig({ sourcePath, targetPath }),
        error => error instanceof DeployCandidateError && error.code === 'config-invalid-time',
        `session.${key}=${JSON.stringify(value)} must be refused`)
      assert.equal(fs.existsSync(targetPath), false)
    }
  }
  // recovery.*Ms fields are validated the same way
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = baseConfig()
  config.recovery.sweepMs = -5
  const sourcePath = writeSource(dir, config)
  assert.throws(() => migrateWechatAcpConfig({ sourcePath, targetPath: path.join(dir, 'out.json') }),
    error => error instanceof DeployCandidateError && error.code === 'config-invalid-time')
  // non-*Ms recovery fields (maxAttempts) are not time fields and stay untouched
  assert.equal(baseConfig().recovery.maxAttempts, 3)
})

test('malformed JSON refuses with config-invalid; non-object top level refuses too', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => migrateWechatAcpConfig({ sourcePath: writeSource(dir, '{not json'), targetPath: path.join(dir, 'a.json') }),
    error => error instanceof DeployCandidateError && error.code === 'config-invalid')
  assert.throws(() => migrateWechatAcpConfig({ sourcePath: writeSource(dir, '[1,2,3]'), targetPath: path.join(dir, 'b.json') }),
    error => error instanceof DeployCandidateError && error.code === 'config-invalid')
  assert.throws(() => migrateWechatAcpConfig({ sourcePath: path.join(dir, 'missing.json'), targetPath: path.join(dir, 'c.json') }),
    error => error instanceof DeployCandidateError && error.code === 'config-invalid')
})

test('unknown top-level and session keys are preserved and listed as warnings', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const config = baseConfig()
  config.futureFeature = { experimental: true }
  config.session.futureKnob = 'keep-me'
  const sourcePath = writeSource(dir, config)
  const targetPath = path.join(dir, 'wechat-acp.json')
  const { report } = migrateWechatAcpConfig({ sourcePath, targetPath })
  const candidate = JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  assert.deepEqual(candidate.futureFeature, { experimental: true })
  assert.equal(candidate.session.futureKnob, 'keep-me')
  assert.equal(report.warnings.length, 2)
  assert.ok(report.warnings.some(w => w.includes('top-level key "futureFeature"')))
  assert.ok(report.warnings.some(w => w.includes('session key "futureKnob"')))
})

test('two dry runs are byte-identical and write nothing; output is deterministic under key reordering', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sourcePath = writeSource(dir, baseConfig())
  const targetPath = path.join(dir, 'wechat-acp.json')
  const first = migrateWechatAcpConfig({ sourcePath, targetPath, dryRun: true })
  const second = migrateWechatAcpConfig({ sourcePath, targetPath, dryRun: true })
  assert.equal(first.bytes, second.bytes)
  assert.deepEqual(first.report, second.report)
  assert.equal(fs.existsSync(targetPath), false) // dryRun writes nothing
  assert.deepEqual(fs.readdirSync(dir), ['source.json'])

  // Same semantics, shuffled key order -> identical candidate bytes
  const shuffled = {
    session: Object.fromEntries(Object.entries(baseConfig().session).reverse()),
    recovery: baseConfig().recovery,
    controlPlaneUrl: baseConfig().controlPlaneUrl,
  }
  const shuffledPath = writeSource(dir, shuffled)
  const third = migrateWechatAcpConfig({ sourcePath: shuffledPath, targetPath, dryRun: true })
  assert.equal(third.report.candidateSha256, first.report.candidateSha256)
  assert.equal(third.bytes, first.bytes)
  // dry-run results carry no rollback path and no wall-clock fields
  assert.equal(Object.hasOwn(first, 'rollbackPath'), false)
  assert.deepEqual(Object.keys(first.report).sort(), ['candidateSha256', 'deprecations', 'migrated', 'sourceSha256', 'warnings'])
})

test('re-running the migration atomically replaces the target and the rollback reflects the latest source', t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const targetPath = path.join(dir, 'wechat-acp.json')
  const firstSource = writeSource(dir, baseConfig())
  migrateWechatAcpConfig({ sourcePath: firstSource, targetPath })
  const second = baseConfig()
  second.session.promptTimeoutMs = 420000
  const secondSource = writeSource(dir, second)
  migrateWechatAcpConfig({ sourcePath: secondSource, targetPath })
  const candidate = JSON.parse(fs.readFileSync(targetPath, 'utf8'))
  assert.equal(candidate.session.grantDeadlineMs, 420000)
  assert.deepEqual(fs.readFileSync(`${targetPath}.rollback`), fs.readFileSync(secondSource))
})

// ---------------------------------------------------------------------------
// 1b. authority candidates
// ---------------------------------------------------------------------------

test('the default four clients produce per-service authority files, 0600 token files and a token-free mapping', async t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const candidateDir = path.join(dir, 'candidate')
  const nowMs = 1_800_000_000_000
  const { mapping, tokenFiles, authorityFiles } = await generateAuthorityCandidates({ candidateDir, now: () => nowMs })

  assert.equal(mapping.length, 4)
  assert.deepEqual(mapping.map(c => c.name), DEFAULT_CLIENTS.map(c => c.name))
  assert.equal(tokenFiles.length, 4)
  assert.equal(authorityFiles.length, 2)

  for (const entry of mapping) {
    assert.equal(entry.principalId, entry.name)
    assert.equal(entry.expiresAt, nowMs + PRINCIPAL_TTL_MS)
    assert.match(entry.tokenDigest, /^[a-f0-9]{64}$/)
    assert.equal(Object.hasOwn(entry, 'token'), false)
  }

  const goalsDoc = JSON.parse(fs.readFileSync(path.join(candidateDir, 'goals', 'authority.json'), 'utf8'))
  const memoryDoc = JSON.parse(fs.readFileSync(path.join(candidateDir, 'memory', 'authority.json'), 'utf8'))
  const goalsById = Object.fromEntries(goalsDoc.principals.map(p => [p.id, p]))
  const memoryById = Object.fromEntries(memoryDoc.principals.map(p => [p.id, p]))
  assert.equal(goalsById['wechat-bridge-goals'].role, 'operator')
  assert.equal(goalsById['ui-proxy-goals'].role, 'viewer')
  assert.equal(memoryById['wechat-bridge-memory'].role, 'chief')
  assert.equal(memoryById['ui-proxy-memory'].role, 'viewer')
  assert.equal(goalsDoc.principals.length, 2)
  assert.equal(memoryDoc.principals.length, 2)

  // token files: mode 0600, token + newline, digest matches the mapping
  const tokens = new Map()
  for (const file of tokenFiles) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const raw = fs.readFileSync(file, 'utf8')
    assert.ok(raw.endsWith('\n') && !raw.slice(0, -1).includes('\n'))
    tokens.set(path.basename(file, '.token'), raw.trim())
  }
  for (const entry of mapping) assert.equal(sha256hex(tokens.get(entry.name)), entry.tokenDigest)

  // mapping.json and authority files contain NO plaintext token (recursive scan
  // of every candidate file outside tokens/)
  const scan = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? scan(path.join(root, e.name)) : [path.join(root, e.name)])
  const publicFiles = scan(candidateDir).filter(file => !file.includes(`${path.sep}tokens${path.sep}`))
  assert.ok(publicFiles.length >= 3) // mapping.json + 2 authority files
  for (const file of publicFiles) {
    const content = fs.readFileSync(file, 'utf8')
    for (const token of tokens.values()) assert.equal(content.includes(token), false, `${file} must not contain a plaintext token`)
  }
  assert.equal(fs.statSync(path.join(candidateDir, 'mapping.json')).mode & 0o777, 0o600)
})

test('candidate authority files are consumable verbatim by createRequestAuthority', async t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const candidateDir = path.join(dir, 'candidate')
  await generateAuthorityCandidates({ candidateDir })
  const doc = JSON.parse(fs.readFileSync(path.join(candidateDir, 'goals', 'authority.json'), 'utf8'))
  const authority = createRequestAuthority(doc) // must not throw AUTH_CONFIGURATION
  const operatorToken = fs.readFileSync(path.join(candidateDir, 'tokens', 'wechat-bridge-goals.token'), 'utf8').trim()
  const principal = authority.authenticate({ authorization: `Bearer ${operatorToken}` })
  assert.equal(principal.id, 'wechat-bridge-goals')
  assert.equal(principal.role, 'operator')
  assert.throws(() => authority.authenticate({ authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }),
    error => error instanceof AuthorityError && error.code === 'AUTH_REQUIRED')
})

test('invalid client definitions refuse with invalid-client and zero writes', async t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const expectRefusal = async clients => {
    const candidateDir = path.join(dir, `candidate-${crypto.randomBytes(4).toString('hex')}`)
    await assert.rejects(() => generateAuthorityCandidates({ candidateDir, clients }),
      error => error instanceof DeployCandidateError && error.code === 'invalid-client')
    assert.equal(fs.existsSync(candidateDir), false) // zero writes
  }
  await expectRefusal([
    { name: 'dup', service: 'goals', role: 'viewer' },
    { name: 'dup', service: 'memory', role: 'viewer' },
  ])
  await expectRefusal([{ name: 'x', service: 'slack', role: 'viewer' }])
  await expectRefusal([{ name: 'x', service: 'goals', role: 'root' }])
  await expectRefusal([{ name: '../escape', service: 'goals', role: 'viewer' }])
  await expectRefusal([{ name: '', service: 'goals', role: 'viewer' }])
  await expectRefusal([])
  await expectRefusal([{ name: 'x', service: 'goals' }])
})

// ---------------------------------------------------------------------------
// 1c. authority path resolution
// ---------------------------------------------------------------------------

test('resolveServiceAuthorityPaths: defaults, env override, plist override, precedence', () => {
  const homeDir = '/home/tester'
  const defaults = resolveServiceAuthorityPaths({ env: {}, homeDir })
  assert.deepEqual(defaults, {
    goals: { path: '/home/tester/.local/state/personal-ai-os/goals/authority.json', source: 'default' },
    memory: { path: '/home/tester/.local/state/personal-ai-os/mem0/authority.json', source: 'default' },
  })

  const envOverride = resolveServiceAuthorityPaths({
    env: { GOALS_AUTH_FILE: '/custom/goals.json', MEMORY_AUTH_FILE: '/custom/memory.json' },
    homeDir,
  })
  assert.deepEqual(envOverride.goals, { path: '/custom/goals.json', source: 'env' })
  assert.deepEqual(envOverride.memory, { path: '/custom/memory.json', source: 'env' })

  const plistTexts = {
    goalsPlist: '<plist><dict><key>EnvironmentVariables</key><dict><key>GOALS_AUTH_FILE</key><string>/plist/goals.json</string></dict></dict></plist>',
    memoryPlist: '<plist><dict><key>EnvironmentVariables</key><dict><key>MEMORY_AUTH_FILE</key>   <string>/plist/memory.json</string></dict></dict></plist>',
  }
  const plistOverride = resolveServiceAuthorityPaths({ env: {}, homeDir, plistTexts })
  assert.deepEqual(plistOverride.goals, { path: '/plist/goals.json', source: 'plist' })
  assert.deepEqual(plistOverride.memory, { path: '/plist/memory.json', source: 'plist' })

  // explicit env wins over plist
  const both = resolveServiceAuthorityPaths({ env: { GOALS_AUTH_FILE: '/env/goals.json' }, homeDir, plistTexts })
  assert.deepEqual(both.goals, { path: '/env/goals.json', source: 'env' })
  assert.deepEqual(both.memory, { path: '/plist/memory.json', source: 'plist' })
})

// ---------------------------------------------------------------------------
// 1d. isolated goals preflight (real service, real loopback HTTP)
// ---------------------------------------------------------------------------

test('verifyGoalsAuthorityCandidate: the full seven-check matrix passes against a generated candidate', async t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const candidateDir = path.join(dir, 'candidate')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir)
  const { mapping } = await generateAuthorityCandidates({ candidateDir })
  const beforeSha = sha256hex(fs.readFileSync(path.join(candidateDir, 'goals', 'authority.json')))

  assert.equal(Object.hasOwn(process.env, 'GOALS_AUTH_FILE'), false)
  const { pass, results } = await verifyGoalsAuthorityCandidate({ candidateDir, stateDir, mapping })

  assert.equal(pass, true)
  assert.ok(results.length >= 10) // granular records for the seven matrix items
  assert.ok(results.every(r => r.pass), JSON.stringify(results))
  const names = results.map(r => r.check)
  for (const expected of [
    'unauthenticated-request-denied', 'forged-token-denied',
    'viewer-read-allowed', 'viewer-write-denied', 'viewer-write-zero-mutation',
    'operator-create-allowed', 'operator-create-visible',
    'expired-principal-denied',
    'rotation-old-token-denied', 'rotation-new-token-allowed', 'authority-file-restored',
    'missing-authority-fails-closed',
  ]) assert.ok(names.includes(expected), `missing check ${expected}`)

  // env restored; candidate authority file byte-identical after the tamper checks
  assert.equal(Object.hasOwn(process.env, 'GOALS_AUTH_FILE'), false)
  assert.equal(sha256hex(fs.readFileSync(path.join(candidateDir, 'goals', 'authority.json'))), beforeSha)
  // no server left listening: a second run against a fresh state dir also passes
  const stateDir2 = path.join(dir, 'state-2')
  fs.mkdirSync(stateDir2)
  const second = await verifyGoalsAuthorityCandidate({ candidateDir, stateDir: stateDir2, mapping })
  assert.equal(second.pass, true)
})

test('verifyGoalsAuthorityCandidate: a broken candidate reports pass=false without throwing', async t => {
  const dir = mkdtemp()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const candidateDir = path.join(dir, 'candidate')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(stateDir)
  const { mapping } = await generateAuthorityCandidates({ candidateDir })
  // break the candidate: drop the operator principal from the goals authority
  const authFile = path.join(candidateDir, 'goals', 'authority.json')
  const doc = JSON.parse(fs.readFileSync(authFile, 'utf8'))
  doc.principals = doc.principals.filter(p => p.role !== 'operator')
  fs.writeFileSync(authFile, JSON.stringify(doc), { mode: 0o600 })
  const { pass, results } = await verifyGoalsAuthorityCandidate({ candidateDir, stateDir, mapping })
  assert.equal(pass, false)
  assert.ok(results.some(r => !r.pass))
  assert.equal(Object.hasOwn(process.env, 'GOALS_AUTH_FILE'), false)
})
