import { useQuery } from '@tanstack/react-query'
import { ShieldCheckIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { fill, useLocale } from '@/components/locale-provider'

type Approval = { id: string; action: string; target: string; parametersDigest: string; decision: string; createdAt: string; expiresAt?: string }
type ApprovalsResponse = { approvals?: Approval[] }

async function readApprovals(): Promise<ApprovalsResponse> {
  // Same-origin read proxy (AUI-03): the server holds the control-plane token and
  // the browser never sees 127.0.0.1:4324. The list is read-only — decisions are
  // NOT made from the browser: strict-mode control plane requires an operator
  // principal (approvedBy is stamped from the authenticated principal server-side),
  // and the dashboard's ui-proxy credential is viewer-only by the approved minimal
  // mapping. The old hardcoded `dashboard-local-user` write was removed (AUI3-F003).
  const response = await fetch('/api/v1/personal-ai-os/control-plane/approvals?decision=pending&limit=20', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json() as { available?: boolean; body?: ApprovalsResponse; upstreamStatus?: number }
  if (envelope.available !== true) throw new Error('control-plane unavailable')
  if (typeof envelope.upstreamStatus === 'number' && envelope.upstreamStatus >= 400) {
    throw new Error(`upstream HTTP ${envelope.upstreamStatus}`)
  }
  return envelope.body ?? {}
}

export function ControlPlaneApprovals() {
  const { t } = useLocale()
  const query = useQuery({ queryKey: ['personal-ai-os-control-plane-approvals'], queryFn: readApprovals, refetchInterval: 10_000, retry: false })
  const approvals = query.data?.approvals ?? []
  if (query.isError || (!query.isPending && approvals.length === 0)) return null
  return <Card data-dashboard-module="control-plane-approvals" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between border-b px-4 py-3">
      <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheckIcon className="size-4" aria-hidden="true" />{t('Pending approvals')}</h2><p className="text-xs text-muted-foreground">{t('Target, parameter digest and expiry are verified before approving')}</p></div>
      <span className="text-xs text-warning">{fill(t('{count} items'), { count: approvals.length })}</span>
    </div>
    <div className="divide-y">{approvals.map((approval) => <div key={approval.id} className="px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{approval.action} · {approval.target}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{approval.parametersDigest} · {approval.id}</p></div></div>)}</div>
    <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t('Read-only: decisions are made through WeChat or the operator console, not from the browser.')}</p>
  </Card>
}
