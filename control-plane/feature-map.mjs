import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentCapability } from './contracts.mjs'
import { indexLocalSessions } from './session-index.mjs'
import { CezarAdapter } from '../adapters/engines/cezar.mjs'

const home = os.homedir()

function configuredPreset() {
  try { return JSON.parse(readFileSync(new URL('../config/wechat-acp.json', import.meta.url), 'utf8')).agent?.preset }
  catch { return undefined }
}

async function probeMemoryHealth() {
  try {
    const response = await fetch('http://127.0.0.1:4325/health', { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return { status: 'unavailable' }
    const health = await response.json()
    if (health.status !== 'ok' || health.engine !== 'mem0-oss') return { status: 'unavailable' }
    return { status: 'ready', engine: 'mem0-oss', version: health.version,
      ingestion: { pending: health.ingestion?.pending ?? 0, retrying: health.ingestion?.retrying ?? 0 } }
  } catch { return { status: 'unavailable' } }
}

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

export async function probeFeatureMap({ sessionSnapshot, cezar = new CezarAdapter(), conversationPreset = configuredPreset(), memoryProbe = probeMemoryHealth } = {}) {
  const snapshot = sessionSnapshot ?? await indexLocalSessions({ limit: 1 })
  const source = (provider) => snapshot.sources.find((item) => item.provider === provider)
  const codex = await commandExists('codex')
  const claude = await commandExists('claude')
  const opencode = existsSync(path.join(home, '.opencode/bin/opencode')) ? path.join(home, '.opencode/bin/opencode') : await commandExists('opencode')
  const kimi = existsSync(path.join(home, '.kimi-code/bin/kimi')) ? path.join(home, '.kimi-code/bin/kimi') : await commandExists('kimi')
  const workbuddy = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
  const devin = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin'
  const antigravity = '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
  const codexApp = '/Applications/Codex.app/Contents/MacOS/Codex'
  const deepseekHarness = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
  const devinCloudConfig = path.join(home, '.config/devin/config.json')
  const gh = await commandExists('gh')
  let cezarHealth
  const memoryHealth = await memoryProbe()
  try { cezarHealth = await cezar.health() } catch (error) { cezarHealth = { error: error.message } }
  const primaryProvider = /^(codex|opencode|kimi|workbuddy|devin|claude)(?:-|$)/.exec(conversationPreset ?? '')?.[1]

  const capability = (input) => createAgentCapability({ evidenceAt: new Date().toISOString(), ...input })
  const result = [
    capability({ agentId: 'codex-local', provider: 'codex', role: primaryProvider === 'codex' ? 'chief' : 'worker', transport: 'acp', status: codex ? 'ready' : 'unavailable', capabilities: ['session.metadata.read', 'acp'], limitations: codex ? [] : ['未发现 codex 可执行入口'] }),
    capability({ agentId: 'codex-app', provider: 'codex-app', role: 'worker', transport: 'gui', status: appDetected(path.join(home, 'Library/Application Support/Codex'), codexApp) ? 'unknown' : 'unavailable', capabilities: ['gui'], limitations: ['GUI App 没有被控制面自动操作；旧会话由 Codex App 自己管理'] }),
    capability({ agentId: 'opencode-local', provider: 'opencode', role: 'worker', transport: 'acp', status: opencode ? 'ready' : 'unavailable', capabilities: ['session.metadata.read', 'acp', 'fallback'], limitations: opencode ? [] : ['未发现 opencode 可执行入口'] }),
    capability({ agentId: 'kimi-local', provider: 'kimi', role: primaryProvider === 'kimi' ? 'chief' : 'worker', transport: 'acp', status: kimi ? 'ready' : 'unavailable', capabilities: ['session.metadata.read', 'acp', 'fallback'], limitations: kimi ? [] : ['未发现 kimi 可执行入口'] }),
    capability({ agentId: 'workbuddy-local', provider: 'workbuddy', role: 'worker', transport: 'acp', status: appDetected(path.join(home, 'Library/Application Support/WorkBuddy AI'), workbuddy) ? 'unknown' : 'unavailable', capabilities: ['acp', 'fallback'], limitations: source('workbuddy')?.limitations ?? ['未验证旧会话索引和认证'] }),
    capability({ agentId: 'devin-local', provider: 'devin', role: 'worker', transport: 'acp', status: appDetected(path.join(home, 'Library/Application Support/Devin'), devin) ? 'unknown' : 'unavailable', capabilities: ['acp', 'fallback'], limitations: source('devin')?.limitations ?? ['未验证真实 prompt、旧会话恢复和认证'] }),
    capability({ agentId: 'claude-local', provider: 'claude', role: 'worker', transport: 'cli', status: claude ? 'ready' : 'unavailable', capabilities: ['cli'], limitations: ['本版本未读取 ~/.claude 历史'] }),
    capability({ agentId: 'antigravity-local', provider: 'antigravity', role: 'worker', transport: 'http', status: existsSync(path.join(home, 'Library/Application Support/Antigravity')) ? 'unknown' : 'unavailable', capabilities: ['provider.proxy', 'fallback'], limitations: source('antigravity')?.limitations ?? ['未验证 GUI 会话 API'] }),
    capability({ agentId: 'deepseek-harness-app', provider: 'deepseek-harness', role: 'worker', transport: 'gui', status: appDetected(path.join(home, 'Library/Application Support/@deepseek-ai'), deepseekHarness) || existsSync(path.join(home, '.config/dsh-crew')) ? 'unknown' : 'unavailable', capabilities: ['gui'], limitations: ['只有桌面 App/内部 IPC；没有可验证的 CLI/ACP 控制通道'] }),
    capability({ agentId: 'devin-cloud', provider: 'devin-cloud', role: 'worker', transport: 'http', status: existsSync(devinCloudConfig) ? 'unknown' : 'unavailable', capabilities: ['cloud.task'], limitations: ['未读取认证内容；未验证云端任务、计费、权限或旧会话'] }),
    capability({ agentId: 'github-actions', provider: 'github-actions', role: 'worker', transport: 'cli', status: gh ? 'unknown' : 'unavailable', capabilities: ['ci'], limitations: ['只发现 gh 入口；未创建、触发或支付任何 workflow'] }),
    capability({ agentId: 'cezar-local', provider: 'cezar', role: 'worker', transport: 'http', status: cezarHealth?.capabilities ? 'ready' : 'unknown', capabilities: ['runs', 'worktrees', 'review-gate', ...(cezarHealth?.capabilities?.dispatch ? ['dispatch'] : [])], limitations: cezarHealth?.error ? [cezarHealth.error] : [] }),
  ]
  return { type: 'FeatureMapSnapshot', version: 1, scannedAt: new Date().toISOString(), capabilities: result,
    conversation: { preset: conversationPreset, provider: primaryProvider, evidence: 'configuration' },
    services: { memory: memoryHealth },
    evidence: { sessionSources: snapshot.sources.length, cezarHealth: cezarHealth?.status ?? 'unknown' } }
}
