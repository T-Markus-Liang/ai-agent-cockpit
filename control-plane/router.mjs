import { spawn } from 'node:child_process'

const DEFAULT_JEV = '/Users/markus/.local/bin/jev-eval'

function scoreCandidate(candidate) {
  const capabilities = new Set(candidate.capabilities ?? [])
  const limitations = (candidate.limitations ?? []).join(' ').toLowerCase()
  let score = 0
  if (capabilities.has('native.session.load') || capabilities.has('native.session.resume')) score += 5
  if (capabilities.has('acp')) score += 2
  if (capabilities.has('mcp')) score += 1
  if (capabilities.has('cli')) score += 1
  if (limitations.includes('auth') || limitations.includes('认证')) score -= 4
  if (limitations.includes('gui-only') || limitations.includes('gui')) score -= 5
  return score
}

function eligible(candidate, policy = {}) {
  const capabilities = new Set(candidate.capabilities ?? [])
  if (policy.requireNativeResume && !(capabilities.has('native.session.load') || capabilities.has('native.session.resume'))) return false
  if (policy.requireMcp && !capabilities.has('mcp')) return false
  if (policy.externalMessage === false && capabilities.has('external.message')) return false
  return candidate.status !== 'unavailable'
}

async function jevAdvice({ goal, candidates, policy, command = DEFAULT_JEV } = {}) {
  const state = { goal, candidates, policy }
  const questions = {
    route: {
      type: 'choice',
      instructions: 'Choose the best first worker. Prefer verified native session/load or resume and coding/tool support; avoid explicit authentication or GUI-only limitations.',
      criteria: Object.fromEntries(candidates.map((candidate) => [candidate.id, `${candidate.provider ?? candidate.id}; capabilities=${(candidate.capabilities ?? []).join(',')}; limitations=${(candidate.limitations ?? []).join(';')}`])),
    },
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`jev-eval exited ${code}: ${stderr.slice(0, 500)}`))
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(new Error(`jev-eval returned invalid JSON: ${error.message}`)) }
    })
    child.stdin.end(JSON.stringify({ state, questions }))
  })
}

export async function buildRoutePlan({ goal, candidates = [], policy = {}, useJev = false, jevCommand } = {}) {
  if (!goal?.trim()) throw new Error('goal is required')
  const normalized = candidates.map((candidate) => ({ ...candidate, score: scoreCandidate(candidate), eligible: eligible(candidate, policy) }))
  const eligibleCandidates = normalized.filter((candidate) => candidate.eligible).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  let advisory
  if (useJev && eligibleCandidates.length > 0) {
    try { advisory = await jevAdvice({ goal, candidates: eligibleCandidates, policy, command: jevCommand }) } catch (error) { advisory = { error: String(error) } }
  }
  const choice = advisory?.answers?.route?.choice
  const confidence = Number(advisory?.answers?.route?.confidence ?? 0)
  const selected = confidence >= 0.7 ? eligibleCandidates.find((candidate) => candidate.id === choice) ?? eligibleCandidates[0] : eligibleCandidates[0]
  return {
    type: 'RoutePlan',
    version: 1,
    goal,
    policy,
    selected: selected ? { id: selected.id, provider: selected.provider, score: selected.score } : null,
    candidates: normalized,
    advisory: advisory ? { choice, confidence, model: advisory.model, error: advisory.error } : undefined,
    requiresApproval: true,
    sideEffects: false,
  }
}

