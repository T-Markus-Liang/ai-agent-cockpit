import { ExternalLinkIcon, TerminalIcon } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLocale } from '@/components/locale-provider'

type Adapter = { name: string; kind: string; channel: string; command?: string; url?: string; status: 'connected' | 'available' | 'gui-only'; note: string }
const ADAPTERS: Adapter[] = [
  { name: 'Codex', kind: 'ACP / app-server', channel: 'codex-official', command: 'codex app-server', status: 'connected', note: '当前微信主 Agent' },
  { name: 'OpenCode', kind: 'ACP', channel: 'opencode', command: 'opencode acp', status: 'available', note: '可作为本机 fallback 和独立工作流' },
  { name: 'Claude Code', kind: 'CLI / ACP', channel: 'claude', command: 'claude', status: 'available', note: '检测到配置入口，需完成登录后启用' },
  { name: 'Kimi CLI', kind: 'ACP / CLI', channel: 'kimi', command: 'kimi acp', status: 'available', note: '支持 ACP；旧会话可通过 kimi --session 选择恢复' },
  { name: 'WorkBuddy', kind: 'ACP / CLI', channel: 'workbuddy', command: 'codebuddy --acp', status: 'available', note: '检测到内置 CodeBuddy CLI；可通过 ACP 接入新会话' },
  { name: 'Antigravity', kind: 'OpenAI-compatible proxy', channel: 'antigravity', url: 'http://127.0.0.1:8080', status: 'available', note: '通过本机 Gemini 反代接入' },
  { name: 'Devin', kind: 'GUI / future adapter', channel: 'devin', status: 'gui-only', note: '当前只有桌面 App，需官方 API/CLI 才能安全调度' },
  { name: 'DeepSeek Harness', kind: 'GUI / desktop host', channel: 'deepseek-harness', status: 'gui-only', note: '当前只有桌面 App 和内部 IPC，没有可验证的 CLI/ACP 端口' },
]

export function LocalAgentsSection() {
  const { t } = useLocale()
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6" data-slot="local-agents-settings">
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><TerminalIcon className="size-4" />{t('Local agents')}</CardTitle><CardDescription>{t('本机 Agent 通道、协议和可用状态。')}</CardDescription></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">{ADAPTERS.map((adapter) => <div key={adapter.channel} className="rounded-md border border-border bg-card-2 p-3">
        <div className="flex items-center justify-between gap-3"><div className="font-medium">{adapter.name}</div><span className="text-xs text-muted-foreground">{adapter.status === 'connected' ? '已连接' : adapter.status === 'available' ? '可接入' : 'GUI-only'}</span></div>
        <div className="mt-1 text-xs text-muted-foreground">{adapter.kind} · {adapter.channel}</div><p className="mt-2 text-xs text-soft-foreground">{adapter.note}</p>
        {adapter.command ? <code className="mt-2 block rounded bg-muted px-2 py-1 text-[11px]">{adapter.command}</code> : null}
        {adapter.url ? <a className="mt-2 inline-flex items-center gap-1 text-xs text-violet underline" href={adapter.url} target="_blank" rel="noreferrer">{adapter.url}<ExternalLinkIcon className="size-3" /></a> : null}
      </div>)}</CardContent>
    </Card>
  </div>
}
