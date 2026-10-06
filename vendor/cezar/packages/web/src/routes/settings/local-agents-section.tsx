import { useQuery } from '@tanstack/react-query'
import { ExternalLinkIcon, TerminalIcon } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLocale } from '@/components/locale-provider'

type Adapter = { name: string; provider: string; kind: string; channel: string; command?: string; url?: string; status: 'connected' | 'available' | 'unknown' | 'unavailable' | 'gui-only'; note: string }
const ADAPTERS: Adapter[] = [
  { name: 'Codex', provider: 'codex', kind: 'ACP / app-server', channel: 'codex-official', command: 'codex app-server', status: 'connected', note: '独立本机 Agent 通道' },
  { name: 'Codex App', provider: 'codex-app', kind: 'GUI / desktop app', channel: 'codex-app', status: 'gui-only', note: 'Codex App 的旧会话由 App 自己管理，控制面不静默操作 GUI' },
  { name: 'OpenCode', provider: 'opencode', kind: 'ACP', channel: 'opencode', command: 'opencode acp', status: 'available', note: '可作为本机 fallback 和独立工作流' },
  { name: 'Claude Code', provider: 'claude', kind: 'CLI / ACP', channel: 'claude', command: 'claude', status: 'available', note: '检测到配置入口，需完成登录后启用' },
  { name: 'Kimi CLI', provider: 'kimi', kind: 'ACP / CLI', channel: 'kimi', command: 'kimi acp', status: 'available', note: '支持 ACP；旧会话可通过 kimi --session 选择恢复' },
  { name: 'WorkBuddy', provider: 'workbuddy', kind: 'ACP / CLI', channel: 'workbuddy', command: 'codebuddy --acp', status: 'available', note: '检测到内置 CodeBuddy CLI；可通过 ACP 接入新会话' },
  { name: 'Antigravity', provider: 'antigravity', kind: 'OpenAI-compatible proxy', channel: 'antigravity', url: 'http://127.0.0.1:8080', status: 'available', note: '通过本机 Gemini 反代接入' },
  { name: 'Devin', provider: 'devin', kind: 'ACP / desktop CLI', channel: 'devin', command: 'devin acp', status: 'available', note: '已发现 Devin ACP；旧会话需通过 Devin 自身 session 参数选择' },
  { name: 'Devin Cloud', provider: 'devin-cloud', kind: 'Cloud Agent', channel: 'devin-cloud', status: 'unknown', note: '仅显示入口证据；未自动创建云端任务或读取认证' },
  { name: 'GitHub Actions', provider: 'github-actions', kind: 'CI / remote', channel: 'github-actions', command: 'gh workflow', status: 'unknown', note: '仅发现 CLI；未触发 workflow' },
  { name: 'DeepSeek Harness', provider: 'deepseek-harness', kind: 'GUI / desktop host', channel: 'deepseek-harness', status: 'gui-only', note: '当前只有桌面 App 和内部 IPC，没有可验证的 CLI/ACP 端口' },
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
    const capability = capabilities.get(adapter.provider)
    if (!capability) return adapter
    const status = capability.status === 'ready' ? 'connected' : capability.status === 'unknown' ? 'unknown' : 'unavailable'
    const note = live.data?.conversation?.provider === adapter.provider ? `微信主 Agent（配置） · ${adapter.note}` : adapter.note
    return { ...adapter, status, note: capability.limitations?.[0] ? `${note} · ${capability.limitations[0]}` : note }
  }
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6" data-slot="local-agents-settings">
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><TerminalIcon className="size-4" />{t('Local agents')}</CardTitle><CardDescription>{t('本机 Agent 通道、协议和可用状态。')}</CardDescription></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">{ADAPTERS.map(statusFor).map((adapter) => <div key={adapter.channel} className="rounded-md border border-border bg-card-2 p-3">
        <div className="flex items-center justify-between gap-3"><div className="font-medium">{adapter.name}</div><span className={`text-xs ${adapter.status === 'connected' ? 'text-success' : adapter.status === 'unknown' || adapter.status === 'gui-only' ? 'text-warning' : adapter.status === 'unavailable' ? 'text-danger' : 'text-muted-foreground'}`}>{adapter.status === 'connected' ? '已连接' : adapter.status === 'available' ? '可接入' : adapter.status === 'unknown' ? '已发现/待验证' : adapter.status === 'unavailable' ? '不可用' : 'GUI-only'}</span></div>
        <div className="mt-1 text-xs text-muted-foreground">{adapter.kind} · {adapter.channel}</div><p className="mt-2 text-xs text-soft-foreground">{adapter.note}</p>
        {adapter.command ? <code className="mt-2 block rounded bg-muted px-2 py-1 text-[11px]">{adapter.command}</code> : null}
        {adapter.url ? <a className="mt-2 inline-flex items-center gap-1 text-xs text-violet underline" href={adapter.url} target="_blank" rel="noreferrer">{adapter.url}<ExternalLinkIcon className="size-3" /></a> : null}
      </div>)}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle>Mem0 共享记忆</CardTitle><CardDescription>近期上下文、完整原文归档与跨模型长期语义记忆。</CardDescription></CardHeader>
      <CardContent><p className="text-sm">{live.data?.services?.memory?.status === 'ready' ? `已连接 · 待提炼 ${live.data.services.memory.ingestion?.pending ?? 0} · 重试 ${live.data.services.memory.ingestion?.retrying ?? 0}` : '长期检索暂不可用；微信继续使用本地上下文'}</p>
        <p className="mt-2 text-xs text-muted-foreground">本地 Qdrant + SQLite；事实提炼使用已有 Kimi API，不是全离线推理。</p></CardContent>
    </Card>
  </div>
}
