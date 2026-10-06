import { useQuery } from '@tanstack/react-query'
import { CheckCircle2Icon, CircleHelpIcon, ExternalLinkIcon, XCircleIcon } from 'lucide-react'
import { Link as RouterLink } from 'react-router'

import { useHealth } from '@/api/queries'
import { Card } from '@/components/ui/card'
import { useLocale } from '@/components/locale-provider'

type Probe = { status: 'connected' | 'available' | 'unavailable' | 'gui-only'; note: string; href?: string }
type FeatureMapResponse = { capabilities?: Array<{ provider?: string; status?: string; capabilities?: string[]; limitations?: string[] }> }

async function probe(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(path, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<Record<string, unknown>>
}

function Status({ probe: item }: { probe: Probe }) {
  const label = item.status === 'connected' ? '已连接' : item.status === 'available' ? '可接入' : item.status === 'gui-only' ? 'GUI-only' : '不可用'
  const Icon = item.status === 'connected' || item.status === 'available' ? CheckCircle2Icon : item.status === 'gui-only' ? CircleHelpIcon : XCircleIcon
  return <span className={`inline-flex items-center gap-1 text-xs ${item.status === 'unavailable' ? 'text-danger' : item.status === 'gui-only' ? 'text-warning' : 'text-success'}`}><Icon className="size-3.5" />{label}</span>
}

export function SystemConnections() {
  const { t } = useLocale()
  const health = useHealth().data
  const wechat = useQuery({ queryKey: ['local-wechat-status'], queryFn: () => probe('http://127.0.0.1:4322/api/wechat/status'), refetchInterval: 15_000 })
  const antigravity = useQuery({ queryKey: ['local-antigravity-health'], queryFn: () => probe('http://127.0.0.1:8080/health'), refetchInterval: 15_000 })
  const featureMap = useQuery({ queryKey: ['personal-ai-os-feature-map'], queryFn: () => probe('http://127.0.0.1:4324/api/control-plane/capabilities') as Promise<FeatureMapResponse>, refetchInterval: 30_000, retry: false })
  const checks = new Map((health?.checks ?? []).map((check) => [check.name, check]))
  const capabilities = new Map((featureMap.data?.capabilities ?? []).map((capability) => [capability.provider ?? '', capability]))
  const controlPlaneProbe = (provider: string, fallback: Probe): Probe => {
    const capability = capabilities.get(provider)
    if (!capability) return fallback
    const status = capability.status === 'ready' ? 'connected' : capability.status === 'unknown' ? 'available' : 'unavailable'
    const limitation = capability.limitations?.[0]
    return { ...fallback, status, note: limitation ? `${fallback.note} · ${limitation}` : fallback.note }
  }
  const agents: Array<[string, Probe]> = [
    ['微信 Bot', { status: wechat.data?.status === 'connected' ? 'connected' : 'unavailable', note: wechat.data?.status === 'connected' ? '本机微信桥正常' : '打开设置重新生成二维码' }],
    ['Codex', controlPlaneProbe('codex', { status: checks.get('codex')?.available ? 'connected' : 'unavailable', note: '主 ACP / app-server' })],
    ['Codex App', controlPlaneProbe('codex-app', { status: 'available', note: 'GUI-only；旧会话由 Codex App 管理' })],
    ['OpenCode', controlPlaneProbe('opencode', { status: checks.get('opencode')?.available ? 'available' : 'unavailable', note: 'ACP fallback' })],
    ['Kimi CLI', controlPlaneProbe('kimi', { status: 'available', note: 'ACP fallback / 旧会话可用 kimi --session' })],
    ['Antigravity Gemini', { status: antigravity.data?.status === 'ok' ? 'connected' : 'unavailable', note: '本机 OpenAI-compatible 反代', href: 'http://127.0.0.1:8080' }],
    ['WorkBuddy', controlPlaneProbe('workbuddy', { status: 'available', note: 'codebuddy --acp；旧会话需显式 resume' })],
    ['Claude Code', controlPlaneProbe('claude', { status: checks.get('claude')?.available ? 'connected' : 'unavailable', note: 'CLI / ACP' })],
    ['Devin ACP', controlPlaneProbe('devin', { status: 'available', note: '已发现 Devin ACP；旧会话需显式恢复' })],
    ['DeepSeek Harness', controlPlaneProbe('deepseek-harness', { status: 'available', note: 'GUI-only；没有稳定 CLI/ACP 控制通道' })],
  ]
  return <Card data-dashboard-module="connections" className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <div><h2 className="text-sm font-semibold">{t('系统连接')}</h2><p className="text-xs text-muted-foreground">{t('主 Agent、fallback、微信和本机 App 的实时边界')}</p></div>
      <div className="flex items-center gap-3">
        <RouterLink to="/settings/global/wechat" className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
          {wechat.data?.status === 'connected' ? t('微信已连接') : t('连接微信')}
        </RouterLink>
        <a href="/settings/global/local-agents" className="text-xs text-violet underline">{t('管理连接')}</a>
      </div>
    </div>
    <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">{agents.map(([name, item]) => <div key={name} className="rounded-md border border-border bg-card-2 p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{name}</span><Status probe={item} /></div><p className="mt-1 text-xs text-soft-foreground">{item.note}</p>{item.href ? <a href={item.href} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-violet underline">{item.href}<ExternalLinkIcon className="size-3" /></a> : null}</div>)}</div>
  </Card>
}
