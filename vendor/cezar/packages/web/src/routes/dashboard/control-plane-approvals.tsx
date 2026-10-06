import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CircleAlertIcon, ShieldCheckIcon, XIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/components/locale-provider'

type Approval = { id: string; action: string; target: string; parametersDigest: string; decision: string; createdAt: string; expiresAt?: string }
type ApprovalsResponse = { approvals?: Approval[] }

async function readApprovals(): Promise<ApprovalsResponse> {
  const response = await fetch('http://127.0.0.1:4324/api/control-plane/approvals?decision=pending&limit=20', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<ApprovalsResponse>
}

async function decideApproval({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) {
  const response = await fetch(`http://127.0.0.1:4324/api/control-plane/approvals/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `dashboard-approval-${id}-${decision}-${crypto.randomUUID()}` },
    body: JSON.stringify({ decision, approvedBy: 'dashboard-local-user' }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export function ControlPlaneApprovals() {
  const { t } = useLocale()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['personal-ai-os-control-plane-approvals'], queryFn: readApprovals, refetchInterval: 10_000, retry: false })
  const decide = useMutation({ mutationFn: decideApproval, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['personal-ai-os-control-plane-approvals'] }) })
  const approvals = query.data?.approvals ?? []
  if (query.isError || (!query.isPending && approvals.length === 0)) return null
  return <Card data-dashboard-module="control-plane-approvals" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between border-b px-4 py-3">
      <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheckIcon className="size-4" />{t('待审批动作')}</h2><p className="text-xs text-muted-foreground">{t('批准前会校验目标、参数摘要和有效期')}</p></div>
      <span className="text-xs text-amber-500">{approvals.length} 个</span>
    </div>
    <div className="divide-y">{approvals.map((approval) => <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{approval.action} · {approval.target}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{approval.parametersDigest} · {approval.id}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: approval.id, decision: 'rejected' })}><XIcon className="mr-1 size-3.5" />{t('拒绝')}</Button><Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: approval.id, decision: 'approved' })}><CheckIcon className="mr-1 size-3.5" />{t('批准')}</Button></div></div>)}</div>
    {decide.isError ? <p className="flex items-center gap-2 px-4 py-2 text-xs text-danger"><CircleAlertIcon className="size-3.5" />{decide.error.message}</p> : null}
  </Card>
}

