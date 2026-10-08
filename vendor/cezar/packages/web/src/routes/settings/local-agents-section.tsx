import { useQuery } from '@tanstack/react-query'
import { ExternalLinkIcon, TerminalIcon } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { fill, useLocale } from '@/components/locale-provider'

type Adapter = { name: string; provider: string; kind: string; channel: string; command?: string; url?: string; status: 'connected' | 'available' | 'unknown' | 'unavailable' | 'gui-only'; note: string }
// Notes carry the ENGLISH source string; `statusFor` resolves them through `t` (see
// locale-provider) before the render layer prints `adapter.note` verbatim. Brand and command
// names ('Codex', 'Kimi CLI', 'codebuddy --acp', …) stay themselves in every locale — they are not
// in the table, so `t` returns them unchanged.
const ADAPTERS: Adapter[] = [
  { name: 'Codex', provider: 'codex', kind: 'ACP / app-server', channel: 'codex-official', command: 'codex app-server', status: 'connected', note: 'Standalone local agent channel' },
  { name: 'Codex App', provider: 'codex-app', kind: 'GUI / desktop app', channel: 'codex-app', status: 'gui-only', note: 'Codex App manages its own old sessions; the control plane does not silently drive the GUI' },
  { name: 'OpenCode', provider: 'opencode', kind: 'ACP', channel: 'opencode', command: 'opencode acp', status: 'available', note: 'Usable as a local fallback and an independent workflow' },
  { name: 'Claude Code', provider: 'claude', kind: 'CLI / ACP', channel: 'claude', command: 'claude', status: 'available', note: 'Config entry point detected; sign in to enable it' },
  { name: 'Kimi CLI', provider: 'kimi', kind: 'ACP / CLI', channel: 'kimi', command: 'kimi acp', status: 'available', note: 'ACP supported; old sessions can be resumed via kimi --session' },
  { name: 'WorkBuddy', provider: 'workbuddy', kind: 'ACP / CLI', channel: 'workbuddy', command: 'codebuddy --acp', status: 'available', note: 'Bundled CodeBuddy CLI detected; new sessions can join via ACP' },
  { name: 'Antigravity', provider: 'antigravity', kind: 'OpenAI-compatible proxy', channel: 'antigravity', url: 'http://127.0.0.1:8080', status: 'available', note: 'Reached through the local Gemini reverse proxy' },
  { name: 'Devin', provider: 'devin', kind: 'ACP / desktop CLI', channel: 'devin', command: 'devin acp', status: 'available', note: 'Devin ACP discovered; old sessions are chosen with Devin own session arguments' },
  { name: 'Devin Cloud', provider: 'devin-cloud', kind: 'Cloud Agent', channel: 'devin-cloud', status: 'unknown', note: 'Shows entry evidence only; no cloud task is created and no auth is read automatically' },
  { name: 'GitHub Actions', provider: 'github-actions', kind: 'CI / remote', channel: 'github-actions', command: 'gh workflow', status: 'unknown', note: 'CLI detected only; no workflow is triggered' },
  { name: 'DeepSeek Harness', provider: 'deepseek-harness', kind: 'GUI / desktop host', channel: 'deepseek-harness', status: 'gui-only', note: 'Only a desktop app and internal IPC today; no verifiable CLI/ACP port' },
]

type FeatureMap = {
  capabilities?: Array<{ provider?: string; status?: string; limitations?: string[] }>
  conversation?: { provider?: string }
  services?: { memory?: { status?: string; ingestion?: { pending?: number; retrying?: number } } }
}

async function featureMap(): Promise<FeatureMap> {
  const response = await fetch('http://127.0.0.1:4324/api/control-plane/capabilities', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<FeatureMap>
}

export function LocalAgentsSection() {
  const { t } = useLocale()
  const live = useQuery({ queryKey: ['personal-ai-os-feature-map-settings'], queryFn: featureMap, refetchInterval: 30_000, retry: false })
  const capabilities = new Map((live.data?.capabilities ?? []).map((capability) => [capability.provider ?? '', capability]))
  const statusFor = (adapter: Adapter): Adapter => {
    // Notes are resolved here (already translated for the active locale) so the render layer
    // prints `note` verbatim; a limitation is an opaque server string and is appended as-is.
    const note = t(adapter.note)
    const capability = capabilities.get(adapter.provider)
    if (!capability) return { ...adapter, note }
    const status = capability.status === 'ready' ? 'connected' : capability.status === 'unknown' ? 'unknown' : 'unavailable'
    const withPrimary = live.data?.conversation?.provider === adapter.provider ? `${t('WeChat primary agent (configured)')} · ${note}` : note
    return { ...adapter, status, note: capability.limitations?.[0] ? `${withPrimary} · ${capability.limitations[0]}` : withPrimary }
  }
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6" data-slot="local-agents-settings">
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><TerminalIcon className="size-4" aria-hidden="true" />{t('Local agents')}</CardTitle><CardDescription>{t('Local agent channels, protocols and availability.')}</CardDescription></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">{ADAPTERS.map(statusFor).map((adapter) => <div key={adapter.channel} className="rounded-md border border-border bg-card-2 p-3">
        <div className="flex items-center justify-between gap-3"><div className="font-medium">{adapter.name}</div><span className={`text-xs ${adapter.status === 'connected' ? 'text-success' : adapter.status === 'unknown' || adapter.status === 'gui-only' ? 'text-warning' : adapter.status === 'unavailable' ? 'text-danger' : 'text-muted-foreground'}`}>{adapter.status === 'connected' ? t('Connected') : adapter.status === 'available' ? t('Available') : adapter.status === 'unknown' ? t('Discovered / unverified') : adapter.status === 'unavailable' ? t('Unavailable') : 'GUI-only'}</span></div>
        <div className="mt-1 text-xs text-muted-foreground">{adapter.kind} · {adapter.channel}</div><p className="mt-2 text-xs text-soft-foreground">{adapter.note}</p>
        {adapter.command ? <code className="mt-2 block rounded bg-muted px-2 py-1 text-[11px]">{adapter.command}</code> : null}
        {adapter.url ? <a className="mt-2 inline-flex items-center gap-1 text-xs text-violet underline" href={adapter.url} target="_blank" rel="noreferrer">{adapter.url}<ExternalLinkIcon className="size-3" aria-hidden="true" /></a> : null}
      </div>)}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle>{t('Shared Mem0 memory')}</CardTitle><CardDescription>{t('Recent context, full transcript archive and cross-model long-term semantic memory.')}</CardDescription></CardHeader>
      <CardContent><p className="text-sm">{live.data?.services?.memory?.status === 'ready' ? fill(t('Connected · {pending} pending · {retrying} retrying'), { pending: live.data.services.memory.ingestion?.pending ?? 0, retrying: live.data.services.memory.ingestion?.retrying ?? 0 }) : t('Long-term retrieval is unavailable; WeChat keeps using local context')}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('Local Qdrant + SQLite; fact extraction uses the existing Kimi API, not fully offline inference.')}</p></CardContent>
    </Card>
  </div>
}
