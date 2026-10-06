import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentCapability } from './contracts.mjs'
import { indexLocalSessions } from './session-index.mjs'
import { CezarAdapter } from '../adapters/engines/cezar.mjs'

const home = os.homedir()

async function commandExists(command) {
  try {
    const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    for (const entry of entries) if (existsSync(path.join(entry, command))) return path.join(entry, command)
  } catch {
    // A missing or unreadable PATH is evidence of unknown, not permission to guess.
  }
  return undefined
}

function appDetected(appPath, commandPath) {
  return Boolean(existsSync(appPath) || commandPath)
}

export async function probeFeatureMap({ sessionSnapshot, cezar = new CezarAdapter() } = {}) {
  const snapshot = sessionSnapshot ?? await indexLocalSessions({ limit: 1 })
  const source = (provider) => snapshot.sources.find((item) => item.provider === provider)
  const codex = await commandExists('codex')
  const claude = await commandExists('claude')
  const opencode = existsSync(path.join(home, '.opencode/bin/opencode')) ? path.join(home, '.opencode/bin/opencode') : await commandExists('opencode')
  const kimi = existsSync(path.join(home, '.kimi-code/bin/kimi')) ? path.join(home, '.kimi-code/bin/kimi') : await commandExists('kimi')
  const workbuddy = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
  const devin = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin'
  const antigravity = '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
  let cezarHealth
  try { cezarHealth = await cezar.health() } catch (error) { cezarHealth = { error: error.message } }

  const capability = (input) => createAgentCapability({ evidenceAt: new Date().toISOString(), ...input })
  const result = [
    capability({ agentId: 'codex-local', provider: 'codex', role: 'chief', transport: 'acp', status: codex ? 'ready' : 'unavailable', capabilities: ['session.metadata.read', 'acp'], limitations: codex ? [] : ['未发现 codex 可执行入口'] }),
    capability({ agentId: 'opencode-local', provider: 'opencode', role: 'worker', transport: 'acp', status: opencode ? 'ready' : 'unavailable', capabilities: ['session.metadata.read', 'acp', 'fallback'], limitations: opencode ? [] : ['未发现 opencode 可执行入口'] }),
    capability({ agentId: 'kimi-local', provider: 'kimi', role: 'worker', transport: 'acp', status: kimi ? 'ready' : 'unavailable', capabilities: ['session.metadata.read', 'acp', 'fallback'], limitations: kimi ? [] : ['未发现 kimi 可执行入口'] }),
    capability({ agentId: 'workbuddy-local', provider: 'workbuddy', role: 'worker', transport: 'acp', status: appDetected(path.join(home, 'Library/Application Support/WorkBuddy AI'), workbuddy) ? 'unknown' : 'unavailable', capabilities: ['acp', 'fallback'], limitations: source('workbuddy')?.limitations ?? ['未验证旧会话索引和认证'] }),
    capability({ agentId: 'devin-local', provider: 'devin', role: 'worker', transport: 'acp', status: appDetected(path.join(home, 'Library/Application Support/Devin'), devin) ? 'unknown' : 'unavailable', capabilities: ['acp', 'fallback'], limitations: source('devin')?.limitations ?? ['未验证真实 prompt、旧会话恢复和认证'] }),
    capability({ agentId: 'claude-local', provider: 'claude', role: 'worker', transport: 'cli', status: claude ? 'ready' : 'unavailable', capabilities: ['cli'], limitations: ['本版本未读取 ~/.claude 历史'] }),
    capability({ agentId: 'antigravity-local', provider: 'antigravity', role: 'worker', transport: 'http', status: existsSync(path.join(home, 'Library/Application Support/Antigravity')) ? 'unknown' : 'unavailable', capabilities: ['provider.proxy', 'fallback'], limitations: source('antigravity')?.limitations ?? ['未验证 GUI 会话 API'] }),
    capability({ agentId: 'cezar-local', provider: 'cezar', role: 'worker', transport: 'http', status: cezarHealth?.capabilities ? 'ready' : 'unknown', capabilities: ['runs', 'worktrees', 'review-gate', ...(cezarHealth?.capabilities?.dispatch ? ['dispatch'] : [])], limitations: cezarHealth?.error ? [cezarHealth.error] : [] }),
  ]
  return { type: 'FeatureMapSnapshot', version: 1, scannedAt: new Date().toISOString(), capabilities: result, evidence: { sessionSources: snapshot.sources.length, cezarHealth: cezarHealth?.status ?? 'unknown' } }
}
