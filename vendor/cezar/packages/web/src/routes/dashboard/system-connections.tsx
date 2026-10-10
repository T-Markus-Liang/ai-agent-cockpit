import { useQuery } from '@tanstack/react-query'
import { CheckCircle2Icon, CircleHelpIcon, ExternalLinkIcon, XCircleIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import { useHealth } from '@/api/queries'
import { Card } from '@/components/ui/card'
import { fill, useLocale } from '@/components/locale-provider'

type Probe = { status: 'connected' | 'available' | 'unavailable' | 'gui-only'; note: string; href?: string }
type FeatureMapResponse = {
  capabilities?: Array<{ provider?: string; status?: string; capabilities?: string[]; limitations?: string[] }>
  conversation?: { provider?: string }
  services?: { memory?: { status?: string; engine?: string; ingestion?: { pending?: number; retrying?: number } } }
}

async function probe(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<Record<string, unknown>>
}

// `role="img"` + aria-label is the design system's habit for a status marker (see the verdict
// dot in `control-plane-executions.tsx`): the colour is the carrier, so the marker announces
// itself as one unit instead of a bare unlabelled icon beside some text.
function Status({ probe: item }: { probe: Probe }) {
  const { t } = useLocale()
  const label = item.status === 'connected' ? t('Connected') : item.status === 'available' ? t('Available') : item.status === 'gui-only' ? 'GUI-only' : t('Unavailable')
  const Icon = item.status === 'connected' || item.status === 'available' ? CheckCircle2Icon : item.status === 'gui-only' ? CircleHelpIcon : XCircleIcon
  return <span role="img" aria-label={label} className={`inline-flex items-center gap-1 text-xs ${item.status === 'unavailable' ? 'text-danger' : item.status === 'gui-only' ? 'text-warning' : 'text-success'}`}><Icon className="size-3.5" aria-hidden="true" />{label}</span>
}

export function SystemConnections() {
  const { t } = useLocale()
  const health = useHealth().data
  const wechat = useQuery({ queryKey: ['local-wechat-status'], queryFn: () => probe('http://127.0.0.1:4322/api/wechat/status'), refetchInterval: 15_000 })
  const antigravity = useQuery({ queryKey: ['local-antigravity-health'], queryFn: () => probe('http://127.0.0.1:8080/health'), refetchInterval: 15_000 })
  const featureMap = useQuery({ queryKey: ['personal-ai-os-feature-map'], queryFn: () => probe('http://127.0.0.1:4324/api/control-plane/capabilities') as Promise<FeatureMapResponse>, refetchInterval: 30_000, retry: false })
  const checks = new Map((health?.checks ?? []).map((check) => [check.name, check]))
  const primary = featureMap.data?.conversation?.provider
  const memory = featureMap.data?.services?.memory
  const acpNote = (provider: string) => primary === provider ? t('WeChat primary agent (configured)') : t('Standalone ACP / fallback channel')
  const capabilities = new Map((featureMap.data?.capabilities ?? []).map((capability) => [capability.provider ?? '', capability]))
  const controlPlaneProbe = (provider: string, fallback: Probe): Probe => {
    const capability = capabilities.get(provider)
    if (!capability) return fallback
    const status = capability.status === 'ready' ? 'connected' : capability.status === 'unknown' ? 'available' : 'unavailable'
    const limitation = capability.limitations?.[0]
    return { ...fallback, status, note: limitation ? `${fallback.note} · ${limitation}` : fallback.note }
  }
  // Agent names and notes are built already-translated here (some carry interpolated values),
  // so the render layer prints `item.note` verbatim. A brand name stays itself in every locale
  // — it is not in the table, so `t` returns it unchanged.
  const agents: Array<[string, Probe]> = [
    [t('WeChat Bot'), { status: wechat.data?.status === 'connected' ? 'connected' : 'unavailable', note: wechat.data?.status === 'connected' ? t('Local WeChat bridge is healthy') : t('Open settings to regenerate the QR code') }],
    [t('Shared Mem0 memory'), { status: memory?.status === 'ready' ? 'connected' : 'unavailable', note: memory?.status === 'ready' ? fill(t('Local storage · {pending} pending · {retrying} retrying'), { pending: memory.ingestion?.pending ?? 0, retrying: memory.ingestion?.retrying ?? 0 }) : t('Long-term retrieval is unavailable; WeChat keeps using local context') }],
    ['Codex', controlPlaneProbe('codex', { status: checks.get('codex')?.available ? 'connected' : 'unavailable', note: acpNote('codex') })],
    ['Codex App', controlPlaneProbe('codex-app', { status: 'available', note: t('GUI-only; old sessions are managed by the Codex App') })],
    ['OpenCode', controlPlaneProbe('opencode', { status: checks.get('opencode')?.available ? 'available' : 'unavailable', note: acpNote('opencode') })],
    ['Kimi CLI', controlPlaneProbe('kimi', { status: 'available', note: fill(t('{boundary} / old sessions available via kimi --session'), { boundary: acpNote('kimi') }) })],
    ['Antigravity Gemini', { status: antigravity.data?.status === 'ok' ? 'connected' : 'unavailable', note: t('Local OpenAI-compatible proxy'), href: 'http://127.0.0.1:8080' }],
    ['WorkBuddy', controlPlaneProbe('workbuddy', { status: 'available', note: t('codebuddy --acp; old sessions need an explicit resume') })],
    ['Claude Code', controlPlaneProbe('claude', { status: checks.get('claude')?.available ? 'connected' : 'unavailable', note: 'CLI / ACP' })],
    ['Devin ACP', controlPlaneProbe('devin', { status: 'available', note: t('Devin ACP discovered; old sessions need an explicit resume') })],
    ['Devin Cloud', controlPlaneProbe('devin-cloud', { status: 'available', note: t('Cloud entry discovered; auth/billing unverified') })],
    ['GitHub Actions', controlPlaneProbe('github-actions', { status: 'available', note: t('CI entry discovered; workflows not triggered') })],
    ['DeepSeek Harness', controlPlaneProbe('deepseek-harness', { status: 'available', note: t('GUI-only; no stable CLI/ACP control channel') })],
  ]
  return <Card data-dashboard-module="connections" className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <div><h2 className="text-sm font-semibold">{t('System connections')}</h2><p className="text-xs text-muted-foreground">{t('Live boundary of the primary agent, fallback, WeChat and local apps.')}</p></div>
      <div className="flex items-center gap-3">
        <RouterLink to="/settings/global/wechat" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
          {wechat.data?.status === 'connected' ? t('WeChat connected') : t('Connect WeChat')}
        </RouterLink>
        <a href="/settings/global/local-agents" className="text-xs text-violet underline">{t('Manage connections')}</a>
      </div>
    </div>
    <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">{agents.map(([name, item]) => <div key={name} className="rounded-md border border-border bg-card-2 p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{name}</span><Status probe={item} /></div><p className="mt-1 text-xs text-soft-foreground">{item.note}</p>{item.href ? <a href={item.href} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-violet underline">{item.href}<ExternalLinkIcon className="size-3" aria-hidden="true" /></a> : null}</div>)}</div>
  </Card>
}
