#!/usr/bin/env node
/**
 * scripts/dependency-audit.mjs — dependency / license / lifecycle-script / telemetry audit.
 *
 * Read-only, zero-dependency, pure Node ESM. It only reads repository files:
 *   - package.json, package-lock.json
 *   - node_modules/<pkg>/package.json
 *   - vendor/cezar/package.json + each vendor/cezar/packages workspace package.json + vendor/cezar/package-lock.json
 *   - vendor/wechat-acp/package.json + vendor/wechat-acp/package-lock.json
 * It never installs, modifies or fetches anything and never touches the network.
 *
 * What it reports (JSON shape):
 *   { ok, generatedAt, root, directDependencies,
 *     pinDrift[], licenses { allowlisted[], unknown[] },
 *     installScripts[], telemetryHits[], vendorSummary { cezar, wechatAcp } }
 *
 * Exit-code semantics:
 *   1  — pinDrift is non-empty OR licenses.unknown is non-empty. These are the two
 *        hard violations: a dependency that does not resolve to the pinned version, or a
 *        shipped package whose license is undeclared / outside the allowlist.
 *   0  — otherwise.
 *   installScripts[] and telemetryHits[] are REPORTING-ONLY and never fail the run. They
 *   are audit objects, not violations: a lifecycle script is a legitimate npm mechanism
 *   that merely deserves a human eyeball, and a keyword hit (e.g. the literal string
 *   "telemetry" inside a package literally named pi-telemetry) is a lead to read, not a
 *   proven data flow. Failing on either would force the allowlist to encode intent it
 *   cannot express and would train readers to ignore the exit code.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// SPDX identifiers accepted without review. Anything else (missing field, a value not in
// this set) lands in licenses.unknown and fails the run.
const ALLOWLIST = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'CC0-1.0', 'Unlicense', '0BSD', 'Python-2.0',
])

// Telemetry surface keywords for the bounded direct-dependency text scan.
const TELEMETRY_KEYWORDS = [
  'telemetry', 'analytics', 'phone-home', 'posthog', 'segment',
  'sentry.io', '/v1/track', 'collectMetrics',
]

// Lifecycle hooks that run code implicitly on install/pack and therefore deserve listing.
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare']

const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json'])
const MAX_FILE_BYTES = 512 * 1024 // single file budget; larger files are skipped, not truncated
const MAX_HITS_PER_PACKAGE = 10 // anti-flood cap; a package is flagged with truncated:true beyond it
const MAX_SCAN_DEPTH = 12 // bounded directory walk
const SKIP_DIRS = new Set(['node_modules', '.git'])

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Normalize pkg.license (string) or pkg.licenses (array) to a single comparable string. */
function normalizeLicense(license, licenses) {
  if (typeof license === 'string' && license.trim()) return license.trim()
  if (typeof license === 'object' && license && typeof license.type === 'string') return license.type.trim()
  if (Array.isArray(licenses)) {
    const parts = licenses.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter(Boolean)
    if (parts.length) return parts.join(' OR ')
  }
  if (typeof licenses === 'string' && licenses.trim()) return licenses.trim()
  return null
}

const isExactPin = (spec) => typeof spec === 'string' && /^\d/.test(spec)

const compareName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// ---------------------------------------------------------------------------
// 1. pin integrity: package.json dependencies + overrides vs package-lock resolution
// ---------------------------------------------------------------------------

function auditPins(rootPkg, lock) {
  const lockPackages = lock?.packages ?? {}
  const resolvedVersion = (name) => lockPackages[`node_modules/${name}`]?.version ?? null
  const drift = []
  const seen = new Set()

  for (const source of ['dependencies', 'overrides']) {
    const table = rootPkg[source]
    if (!table || typeof table !== 'object') continue
    for (const [name, spec] of Object.entries(table)) {
      const key = `${source}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      const resolved = resolvedVersion(name)
      if (!resolved) {
        drift.push({ name, source, spec, resolved: null, issue: 'missing-in-lock' })
        continue
      }
      if (isExactPin(spec) && resolved !== spec) {
        drift.push({ name, source, spec, resolved, issue: 'version-drift' })
      }
      // Non-exact specs (ranges) are only checked for presence; this repo pins exactly.
    }
  }
  drift.sort((a, b) => compareName(a, b) || a.source.localeCompare(b.source))
  return drift
}

// ---------------------------------------------------------------------------
// 2. license inventory over the full lock graph (incl. transitive deps)
// ---------------------------------------------------------------------------

function auditLicenses(lock) {
  const lockPackages = lock?.packages ?? {}
  const allowlisted = []
  const unknown = []

  for (const [key, entry] of Object.entries(lockPackages)) {
    if (!key) continue // the root project itself, not a dependency
    const derived = key.replace(/^.*node_modules\//, '')
    const diskPath = join(ROOT, key, 'package.json')
    const disk = existsSync(diskPath) ? readJson(diskPath) : null

    let license = disk ? normalizeLicense(disk.license, disk.licenses) : null
    let source = license ? 'node_modules' : null
    if (!license) {
      // Package not present on disk (e.g. an optional cross-platform binary for another OS);
      // fall back to the lockfile's own resolution metadata rather than declaring a false unknown.
      license = normalizeLicense(entry.license, entry.licenses)
      if (license) source = 'lock'
    }

    const record = {
      name: disk?.name ?? entry.name ?? derived,
      version: entry.version ?? disk?.version ?? null,
      license: license ?? null,
      source: source ?? 'unresolved',
      optional: Boolean(entry.optional),
    }
    if (license && ALLOWLIST.has(license)) allowlisted.push(record)
    else unknown.push(record)
  }

  allowlisted.sort(compareName)
  unknown.sort(compareName)
  return { allowlisted, unknown }
}

// ---------------------------------------------------------------------------
// 3. lifecycle-script inventory over the lock graph
// ---------------------------------------------------------------------------

function auditInstallScripts(lock) {
  const lockPackages = lock?.packages ?? {}
  const out = []

  for (const [key, entry] of Object.entries(lockPackages)) {
    if (!key) continue
    const diskPath = join(ROOT, key, 'package.json')
    const disk = existsSync(diskPath) ? readJson(diskPath) : null
    const scripts = disk?.scripts ?? {}
    const hooks = LIFECYCLE_HOOKS.filter((hook) => typeof scripts[hook] === 'string')
    const hasInstallScript = Boolean(entry.hasInstallScript)
    if (!hasInstallScript && hooks.length === 0) continue
    out.push({
      name: disk?.name ?? entry.name ?? key.replace(/^.*node_modules\//, ''),
      version: entry.version ?? disk?.version ?? null,
      hasInstallScript,
      hooks,
    })
  }

  out.sort(compareName)
  return out
}

// ---------------------------------------------------------------------------
// 4. telemetry surface scan — direct dependencies only, bounded
// ---------------------------------------------------------------------------

function looksMinified(content) {
  const newlines = content.indexOf('\n')
  return (newlines === -1 && content.length > 1000) || (content.length > 20000 && !content.includes('\n  ') && content.split('\n').length < 4)
}

function scanDir(dir, patterns, hits, budget) {
  if (budget.remaining <= 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of entries) {
    if (budget.remaining <= 0) return
    const full = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue
      if (budget.depth > MAX_SCAN_DEPTH) continue
      budget.depth += 1
      scanDir(full, patterns, hits, budget)
      budget.depth -= 1
      continue
    }
    if (!dirent.isFile()) continue
    if (!SCAN_EXTENSIONS.has(extname(dirent.name))) continue // .map (and everything else) skipped
    let size
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue
    let content
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (looksMinified(content)) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase()
      for (const keyword of patterns) {
        if (!lower.includes(keyword)) continue
        if (budget.remaining <= 0) return
        hits.push({ file: full.slice(ROOT.length + 1), line: i + 1, keyword })
        budget.remaining -= 1
      }
    }
  }
}

function auditTelemetry(rootPkg, lock) {
  const names = Object.keys(rootPkg.dependencies ?? {}).sort()
  const lockPackages = lock?.packages ?? {}
  const results = []
  for (const name of names) {
    const dir = join(ROOT, 'node_modules', name)
    const hits = []
    const budget = { remaining: MAX_HITS_PER_PACKAGE, depth: 0 }
    if (existsSync(dir)) scanDir(dir, TELEMETRY_KEYWORDS, hits, budget)
    results.push({
      package: name,
      version: lockPackages[`node_modules/${name}`]?.version ?? null,
      hitCount: hits.length,
      truncated: budget.remaining <= 0,
      hits,
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// 5. vendor summary
// ---------------------------------------------------------------------------

function collectLifecycleHooks(pkg) {
  const scripts = pkg?.scripts ?? {}
  return LIFECYCLE_HOOKS.filter((hook) => typeof scripts[hook] === 'string')
}

function lockInstallScripts(lockPath) {
  const lock = readJson(lockPath)
  if (!lock) return { present: false }
  const found = []
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key) continue
    if (entry.hasInstallScript) found.push({ name: key.replace(/^.*node_modules\//, ''), version: entry.version ?? null })
  }
  found.sort(compareName)
  return { present: true, lockfileVersion: lock.lockfileVersion ?? null, packageCount: Object.keys(lock.packages ?? {}).length, hasInstallScript: found }
}

function vendorSummary() {
  const cezarDir = join(ROOT, 'vendor', 'cezar')
  const wechatDir = join(ROOT, 'vendor', 'wechat-acp')

  const cezarRoot = readJson(join(cezarDir, 'package.json'))
  const declared = new Set(Array.isArray(cezarRoot?.workspaces) ? cezarRoot.workspaces : [])
  // Enumerate every packages/* directory that carries a package.json, so an on-disk package
  // that is NOT a declared workspace still surfaces rather than being silently omitted.
  let wsDirs = []
  try {
    wsDirs = readdirSync(join(cezarDir, 'packages'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `packages/${d.name}`)
      .filter((rel) => existsSync(join(cezarDir, rel, 'package.json')))
  } catch {
    wsDirs = []
  }
  const workspaces = []
  for (const ws of wsDirs) {
    const wsPkg = readJson(join(cezarDir, ws, 'package.json'))
    if (!wsPkg) continue
    const license = normalizeLicense(wsPkg.license, wsPkg.licenses)
    workspaces.push({
      path: ws,
      name: wsPkg.name ?? null,
      version: wsPkg.version ?? null,
      private: Boolean(wsPkg.private),
      declaredWorkspace: declared.has(ws),
      license: license ?? null,
      licenseAllowlisted: license ? ALLOWLIST.has(license) : false,
      lifecycleHooks: collectLifecycleHooks(wsPkg),
    })
  }
  workspaces.sort(compareName)

  const wechatPkg = readJson(join(wechatDir, 'package.json'))
  const wechatLicense = normalizeLicense(wechatPkg?.license, wechatPkg?.licenses)

  const scopeOf = (pkg) => ({
    name: pkg?.name ?? null,
    version: pkg?.version ?? null,
    private: Boolean(pkg?.private),
    license: normalizeLicense(pkg?.license, pkg?.licenses) ?? null,
    lifecycleHooks: collectLifecycleHooks(pkg),
  })

  return {
    cezar: {
      ...scopeOf(cezarRoot),
      workspaces,
      lock: lockInstallScripts(join(cezarDir, 'package-lock.json')),
    },
    wechatAcp: {
      ...scopeOf(wechatPkg),
      dependencies: Object.keys(wechatPkg?.dependencies ?? {}).sort(),
      lock: lockInstallScripts(join(wechatDir, 'package-lock.json')),
      licenseAllowlisted: wechatLicense ? ALLOWLIST.has(wechatLicense) : false,
    },
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const rootPkg = readJson(join(ROOT, 'package.json'))
  const lock = readJson(join(ROOT, 'package-lock.json'))
  if (!rootPkg || !lock) {
    console.error('dependency-audit: cannot read package.json / package-lock.json at repo root')
    process.exit(2)
  }

  const pinDrift = auditPins(rootPkg, lock)
  const licenses = auditLicenses(lock)
  const installScripts = auditInstallScripts(lock)
  const telemetryHits = auditTelemetry(rootPkg, lock)
  const vendor = vendorSummary()

  const ok = pinDrift.length === 0 && licenses.unknown.length === 0
  const report = {
    ok,
    generatedAt: new Date().toISOString(),
    root: { name: rootPkg.name ?? null, version: rootPkg.version ?? null, lockfileVersion: lock.lockfileVersion ?? null },
    directDependencies: Object.keys(rootPkg.dependencies ?? {}).sort(),
    pinDrift,
    licenses,
    installScripts,
    telemetryHits,
    vendorSummary: vendor,
  }

  // ---- human-readable summary ----
  const line = '─'.repeat(72)
  console.log(line)
  console.log(`dependency-audit — ${report.root.name}@${report.root.version} (lockfile v${report.root.lockfileVersion})`)
  console.log(line)

  console.log(`\n[1] pin integrity (dependencies + overrides vs package-lock):`)
  if (pinDrift.length === 0) {
    console.log('    OK — every pinned dependency resolves to its exact version in the lock.')
  } else {
    for (const d of pinDrift) console.log(`    DRIFT ${d.source} ${d.name}: spec=${d.spec} resolved=${d.resolved ?? '(absent)'} [${d.issue}]`)
  }

  console.log(`\n[2] licenses (full lock graph):`)
  console.log(`    allowlisted=${licenses.allowlisted.length}  unknown=${licenses.unknown.length}`)
  for (const u of licenses.unknown) console.log(`    UNKNOWN ${u.name}@${u.version} license=${u.license ?? '(none)'} source=${u.source}`)

  console.log(`\n[3] lifecycle install scripts (report-only):`)
  if (installScripts.length === 0) console.log('    (none)')
  for (const s of installScripts) console.log(`    ${s.name}@${s.version} hasInstallScript=${s.hasInstallScript} hooks=[${s.hooks.join(',')}]`)

  console.log(`\n[4] telemetry keyword scan (direct deps only, report-only, cap ${MAX_HITS_PER_PACKAGE}/pkg):`)
  for (const t of telemetryHits) {
    const note = t.truncated ? ' (truncated)' : ''
    console.log(`    ${t.package}@${t.version}: ${t.hitCount} hit(s)${note}`)
    for (const h of t.hits) console.log(`        ${h.file}:${h.line} [${h.keyword}]`)
  }

  console.log(`\n[5] vendor:`)
  console.log(`    cezar (${vendor.cezar.name}@${vendor.cezar.version}) license=${vendor.cezar.license ?? '(none)'} workspaces=${vendor.cezar.workspaces.length}`)
  for (const w of vendor.cezar.workspaces) console.log(`        ${w.name} license=${w.license ?? '(none)'}${w.lifecycleHooks.length ? ` hooks=[${w.lifecycleHooks.join(',')}]` : ''}`)
  console.log(`        lock hasInstallScript: ${vendor.cezar.lock.hasInstallScript.map((x) => x.name).join(', ') || '(none)'}`)
  console.log(`    wechat-acp (${vendor.wechatAcp.name}@${vendor.wechatAcp.version}) license=${vendor.wechatAcp.license ?? '(none)'}`)
  console.log(`        lock hasInstallScript: ${vendor.wechatAcp.lock.hasInstallScript.map((x) => x.name).join(', ') || '(none)'}`)

  console.log(`\n${line}`)
  console.log(ok ? 'RESULT: ok=true (exit 0)' : `RESULT: ok=false — violations: ${pinDrift.length} pin drift, ${licenses.unknown.length} unknown license (exit 1)`)
  console.log(line)

  // ---- full JSON report ----
  console.log(JSON.stringify(report, null, 2))

  if (!ok) process.exitCode = 1
}

main()
