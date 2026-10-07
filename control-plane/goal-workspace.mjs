import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { validateGoalSpec } from './goal-store.mjs'

function inside(root, file) { return file.startsWith(root + path.sep) }
export async function regularFile(root, relative) {
  const realRoot = await fs.realpath(root)
  const file = path.resolve(realRoot, relative)
  if (!inside(realRoot, file)) throw new Error('file escapes approved workspace')
  const real = await fs.realpath(file)
  if (real !== file || !inside(realRoot, real)) throw new Error('symlink paths are not supported')
  if (!(await fs.lstat(file)).isFile()) throw new Error('only regular files are supported')
  return file
}

export async function prepareWorkspace(goal) {
  const resolvedSource = await fs.realpath(goal.spec.sourceDir)
  validateGoalSpec({ ...goal.spec, sourceDir: resolvedSource })
  await fs.mkdir(goal.workspaceDir, { recursive: true, mode: 0o700 })
  await fs.chmod(goal.workspaceDir, 0o700)
  const total = []
  for (const relative of goal.spec.readPaths) {
    const source = await regularFile(goal.spec.sourceDir, relative)
    const content = await fs.readFile(source)
    if (content.length > 80000) throw new Error('approved input file exceeds 80 KiB')
    total.push(content.length)
    if (total.reduce((a, b) => a + b, 0) > 160000) throw new Error('approved context exceeds 160 KiB')
    if (/\b(?:sk-|apikey_)[A-Za-z0-9_-]{20,}|-----BEGIN .*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{24,}/.test(content.toString())) throw new Error('possible credential in approved input; review before sending to a provider')
    const target = path.resolve(goal.workspaceDir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    try { await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await fs.readFile(target)).equals(content)) throw error
    }
  }
  await fs.writeFile(path.join(goal.workspaceDir, '.prepared.json'), JSON.stringify({ specDigest: goal.specDigest }), { mode: 0o600 })
}

export async function workspaceState(goal) {
  const files = []
  const hash = crypto.createHash('sha256')
  for (const relative of [...goal.spec.readPaths].sort()) {
    const file = await regularFile(goal.workspaceDir, relative)
    const content = await fs.readFile(file, 'utf8')
    hash.update(JSON.stringify([relative, content]))
    files.push({ path: relative, content, writable: goal.spec.writePaths.includes(relative) })
  }
  return { files, artifactRef: `sha256:${hash.digest('hex')}` }
}

export async function applyProposal(goal, proposal) {
  if (!Array.isArray(proposal?.files) || proposal.files.length > goal.spec.writePaths.length) throw new Error('invalid proposed file list')
  const seen = new Set()
  for (const item of proposal.files) {
    if (!item || !goal.spec.writePaths.includes(item.path) || seen.has(item.path) || typeof item.content !== 'string' || Buffer.byteLength(item.content) > 80000) throw new Error('proposal exceeds approved write scope')
    seen.add(item.path)
    await regularFile(goal.workspaceDir, item.path)
  }
  for (const item of proposal.files) {
    const file = await regularFile(goal.workspaceDir, item.path)
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(item.content); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, file)
  }
}

export async function runChecks(goal, { signal, timeoutMs = 30000 } = {}) {
  if (process.platform !== 'darwin') throw new Error('this release requires macOS Seatbelt for verification; no unsandboxed fallback')
  const node = await fs.realpath(process.execPath)
  const root = await fs.realpath(goal.workspaceDir)
  const quote = value => JSON.stringify(value)
  const profile = `(version 1)(allow default)(deny network*)(deny process-exec)(allow process-exec (literal ${quote(node)}))(deny file-read* (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/Volumes"))(allow file-read-metadata)(allow file-read* (subpath ${quote(root)}))(deny file-write*)(allow file-write* (literal "/dev/null") ${goal.spec.writePaths.map(relative => `(literal ${quote(path.join(root, relative))})`).join(' ')})(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))`
  const results = []
  for (const check of goal.spec.checks) {
    if (signal?.aborted) throw signal.reason
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, node, ...check.args], { cwd: root, detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_COLOR: '1', GOAL_ITERATION: String(goal.iterations ?? 0) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', ended = false, timedOut = false
      const collect = chunk => { if (output.length < 12000) output += chunk.toString().slice(0, 12000 - output.length) }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      const stop = () => { if (!ended) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
      const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
      signal?.addEventListener('abort', stop, { once: true })
      child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error) })
      child.once('close', (code, termSignal) => {
        ended = true; clearTimeout(timer); signal?.removeEventListener('abort', stop)
        resolve({ name: check.name, args: check.args, exitCode: code, signal: termSignal, timedOut, output })
      })
    })
    results.push(result)
    if (signal?.aborted) throw signal.reason
  }
  return results
}
