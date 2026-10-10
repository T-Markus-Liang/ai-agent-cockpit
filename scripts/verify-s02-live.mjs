#!/usr/bin/env node
// S02 live deployment acceptance probe (read-only business matrix).
// Verifies the per-client authority identities installed by the S02 deploy
// batch against the LIVE loopback goals (:4326) and memory (:4325) services.
// Tokens are read from the client tokenFiles and never printed, logged, or
// otherwise emitted. Every check is read-only or provably state-preserving:
// denied writes are rejected before any endpoint body runs (both services
// authenticate+authorize up front), so a 403 probe cannot mutate state.
// Usage: node scripts/verify-s02-live.mjs ; exit 0 = all checks pass.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const GOALS = 'http://127.0.0.1:4326'
const MEMORY = 'http://127.0.0.1:4325'
const PROBE_USER = 's02-probe'
const FORGED = 'A'.repeat(43)
const TOKEN_FILES = {
  'bridge-goals': path.join(os.homedir(), '.local/state/personal-ai-os/goals/api-token'),
  'bridge-memory': path.join(os.homedir(), '.local/state/personal-ai-os/mem0/api-token'),
  'ui-proxy-goals': path.join(os.homedir(), 'personal-ai-os-staging/s02-latest/candidate/tokens/ui-proxy-goals.token'),
  'ui-proxy-memory': path.join(os.homedir(), 'personal-ai-os-staging/s02-latest/candidate/tokens/ui-proxy-memory.token'),
}

const tokens = {}
for (const [name, file] of Object.entries(TOKEN_FILES)) {
  try { tokens[name] = (await fs.readFile(file, 'utf8')).trim() } catch { tokens[name] = null }
}

const results = []
async function check(label, fn) {
  try {
    const detail = await fn()
    results.push({ label, pass: true, ...detail })
    console.log(`PASS  ${label}${detail.detail ? ` — ${detail.detail}` : ''}`)
  } catch (error) {
    results.push({ label, pass: false, detail: String(error.message ?? error) })
    console.log(`FAIL  ${label} — ${error.message ?? error}`)
  }
}
const expectStatus = (response, wanted) => {
  if (response.status !== wanted) throw new Error(`expected HTTP ${wanted}, got ${response.status}`)
}
async function goalsGet(token) {
  return fetch(`${GOALS}/api/goals`, { signal: AbortSignal.timeout(5000), headers: token ? { Authorization: `Bearer ${token}` } : {} })
}
async function memoryPost(endpoint, body, token) {
  return fetch(`${MEMORY}${endpoint}`, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
}

// --- goals ---
await check('goals health no-auth 200', async () => { const r = await fetch(`${GOALS}/health`); expectStatus(r, 200); return {} })
await check('goals GET no-auth 401', async () => { expectStatus(await goalsGet(null), 401); return {} })
await check('goals GET forged 401', async () => { expectStatus(await goalsGet(FORGED), 401); return {} })
if (tokens['bridge-goals']) {
  await check('goals GET bridge-goals(operator) 200', async () => {
    const r = await goalsGet(tokens['bridge-goals']); expectStatus(r, 200)
    const body = await r.json()
    return { detail: `goalCount=${body.goals?.length ?? '?'}` }
  })
}
if (tokens['ui-proxy-goals']) {
  await check('goals viewer POST pause-all 403 + zero change', async () => {
    const before = (await (await goalsGet(tokens['ui-proxy-goals'])).json())?.paused
    const r = await fetch(`${GOALS}/api/goals/pause-all`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${tokens['ui-proxy-goals']}` } })
    expectStatus(r, 403)
    const after = (await (await goalsGet(tokens['ui-proxy-goals'])).json())?.paused
    if (before !== after) throw new Error(`paused mutated: ${before} -> ${after}`)
    return { detail: `paused=${after} unchanged` }
  })
}

// --- memory ---
await check('memory health no-auth 200', async () => { const r = await fetch(`${MEMORY}/health`); expectStatus(r, 200); return {} })
await check('memory search no-auth 401', async () => { expectStatus(await memoryPost('/v1/search', { user_id: PROBE_USER, query: 's02 probe' }, null), 401); return {} })
await check('memory search forged 401', async () => { expectStatus(await memoryPost('/v1/search', { user_id: PROBE_USER, query: 's02 probe' }, FORGED), 401); return {} })
if (tokens['bridge-memory']) {
  await check('memory search bridge-memory(chief) 200', async () => {
    const r = await memoryPost('/v1/search', { user_id: PROBE_USER, query: 's02 probe', limit: 1 }, tokens['bridge-memory']); expectStatus(r, 200)
    const body = await r.json().catch(() => ({}))
    return { detail: `results=${body.results?.length ?? '?'}` }
  })
}
if (tokens['ui-proxy-memory']) {
  await check('memory search ui-proxy-memory(viewer) 200', async () => {
    expectStatus(await memoryPost('/v1/search', { user_id: PROBE_USER, query: 's02 probe', limit: 1 }, tokens['ui-proxy-memory']), 200)
    return {}
  })
  await check('memory viewer POST turns 403', async () => {
    const r = await memoryPost('/v1/turns', { event_id: 's02-probe', user_id: PROBE_USER, role: 'user', text: 's02 probe (must be rejected)' }, tokens['ui-proxy-memory'])
    expectStatus(r, 403)
    return {}
  })
}
// Staged ui-proxy tokens are an S05 wiring prerequisite; report absence without failing.
for (const name of ['ui-proxy-goals', 'ui-proxy-memory']) {
  if (!tokens[name]) console.log(`SKIP  ${name} staged token not found at ${TOKEN_FILES[name]} (S05 wiring prerequisite, not an S02 gate)`)
}

const failed = results.filter((r) => !r.pass).length
console.log(JSON.stringify({ type: 'S02LiveVerification', checks: results.length, failed, tokensExposed: 0 }))
process.exit(failed ? 1 : 0)
