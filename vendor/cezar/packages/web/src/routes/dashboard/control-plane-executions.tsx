import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon, PackageCheckIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { fill, useLocale } from '@/components/locale-provider'
import { Pill } from '@/components/pill'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { cn } from '@/lib/utils'

/* Read-only Execution / Evidence / completion-plan detail for one control-plane task.
 * Everything is fetched from the control-plane gateway on 127.0.0.1:4324, same origin-free
 * pattern as `control-plane-approvals.tsx` / `control-plane-tasks.tsx`. This panel NEVER
 * invents data: a failed fetch shows an honest "unreachable" state with a retry, an empty
 * list shows an empty state, and the completion plan is only claimed `ready` when the
 * gateway says so. No write happens here — completing a task stays out of this batch. */

type Execution = {
  id: string
  taskId: string
  workerId: string
  role?: string
  status: string
  attempt: number
  parentExecutionId?: string
  startedAt?: string
  finishedAt?: string
  artifactRef?: string
}
type Evidence = {
  id: string
  executionId: string
  kind: string
  summary: string
  source?: string
  capturedAt: string
  exitCode?: number
  verdict?: string
  artifactRef?: string
  reviewOfExecutionId?: string
}
type TaskDetail = { task?: { id: string; goal: string; status: string }; executions?: Execution[]; evidence?: Evidence[] }
type CompletionPlan = { action?: string; target?: string; ready?: boolean; reasons?: string[]; parametersDigest?: string }
type ProxyEnvelope<T> = { available?: boolean; body?: T }

// Same-origin read proxy (AUI-03): the server holds the control-plane token;
// the browser never sees 127.0.0.1:4324 or a credential.
async function readProxied<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1/personal-ai-os/control-plane/${path}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json() as ProxyEnvelope<T> & { upstreamStatus?: number }
  if (envelope.available !== true) throw new Error('control-plane unavailable')
  // An upstream error is still an error: surface the card's honest
  // "unreachable + retry" state instead of rendering an empty body.
  if (typeof envelope.upstreamStatus === 'number' && envelope.upstreamStatus >= 400) {
    throw new Error(`upstream HTTP ${envelope.upstreamStatus}`)
  }
  return (envelope.body ?? {}) as T
}

async function readTaskDetail(taskId: string): Promise<TaskDetail> {
  return readProxied(`tasks/${encodeURIComponent(taskId)}`)
}

async function readCompletionPlan(taskId: string): Promise<CompletionPlan> {
  return readProxied(`tasks/${encodeURIComponent(taskId)}/completion-plan`)
}

/* The eight Execution states (control-plane/contracts.mjs EXECUTION_STATUSES). The word is
 * neutral; the colour lives in the dot, per the design system's single-carrier rule. `pulse`
 * marks the states that are still transitioning — a run that has neither succeeded nor failed.
 * The label itself is an ENGLISH source string translated at render (see locale-provider `t`). */
const EXECUTION_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued', running: 'Running', verifying: 'Verifying', reviewing: 'Reviewing',
  succeeded: 'Succeeded', failed: 'Failed', blocked: 'Blocked', cancelled: 'Cancelled',
}
const EXECUTION_STATUS_TONES: Record<string, { tone: StatusDotTone; pulse?: boolean }> = {
  queued: { tone: 'pending' }, running: { tone: 'pending', pulse: true }, verifying: { tone: 'pending', pulse: true },
  reviewing: { tone: 'violet', pulse: true }, succeeded: { tone: 'success' }, failed: { tone: 'danger' },
  blocked: { tone: 'danger' }, cancelled: { tone: 'neutral' },
}
/* The seven Evidence kinds (control-plane/contracts.mjs createEvidence) — also English source
 * strings translated at render. */
const EVIDENCE_KIND_LABELS: Record<string, string> = {
  command: 'Command', test: 'Test', diff: 'Diff', log: 'Log', screenshot: 'Screenshot', review: 'Review', message: 'Message',
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}
function stamp(value: string): string {
  return value.replace('T', ' ').slice(0, 19)
}

function ExecutionStatusBadge({ status }: { status: string }) {
  const { t } = useLocale()
  const label = t(EXECUTION_STATUS_LABELS[status] ?? status)
  const presentation = EXECUTION_STATUS_TONES[status] ?? { tone: 'neutral' as StatusDotTone }
  return <Pill dot={presentation.tone} pulse={presentation.pulse} aria-label={fill(t('Execution status: {status}'), { status: label })}>{label}</Pill>
}

function EvidenceRow({ item }: { item: Evidence }) {
  const { t } = useLocale()
  const kind = t(EVIDENCE_KIND_LABELS[item.kind] ?? item.kind)
  return <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-xs">
    <span className="font-medium">{kind}</span>
    {item.verdict ? <span className={cn('inline-flex items-center gap-1', item.verdict === 'passed' ? 'text-success' : 'text-danger')}>
      <StatusDot tone={item.verdict === 'passed' ? 'success' : 'danger'} role="img" aria-label={fill(t('Verdict: {verdict}'), { verdict: t(item.verdict === 'passed' ? 'Passed' : 'Failed') })} />
      {t(item.verdict === 'passed' ? 'Passed' : 'Failed')}
    </span> : null}
    {typeof item.exitCode === 'number' ? <span className="font-mono text-muted-foreground">{fill(t('Exit code {code}'), { code: item.exitCode })}</span> : null}
    {item.artifactRef ? <span className="font-mono text-muted-foreground" title={item.artifactRef}>{fill(t('Copy {ref}'), { ref: truncate(item.artifactRef, 24) })}</span> : null}
    <span className="text-muted-foreground">{truncate(item.summary, 160)}</span>
    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{stamp(item.capturedAt)}</span>
  </li>
}

function ExecutionRow({ execution, evidence, expanded, onToggle }: {
  execution: Execution
  evidence: Evidence[]
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useLocale()
  return <div className="border-t px-4 py-2 first:border-t-0">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ExecutionStatusBadge status={execution.status} />
      <span className="font-mono text-xs">{execution.workerId}</span>
      <span className="text-xs text-muted-foreground">{fill(t('Attempt {attempt}'), { attempt: execution.attempt })}</span>
      {execution.parentExecutionId ? <span className="text-xs text-info" title={execution.parentExecutionId}>{fill(t('Review child · parent {id}'), { id: shortId(execution.parentExecutionId) })}</span> : null}
      {execution.artifactRef ? <span className="font-mono text-[10px] text-muted-foreground" title={execution.artifactRef}>{fill(t('Copy {ref}'), { ref: truncate(execution.artifactRef, 24) })}</span> : null}
      <span className="font-mono text-[10px] text-muted-foreground">{shortId(execution.id)}</span>
      <Button size="sm" variant="ghost" className="ml-auto" aria-expanded={expanded} aria-label={fill(t(expanded ? 'Hide evidence for execution {id}' : 'Show evidence for execution {id}'), { id: execution.id })} onClick={onToggle}>
        {expanded ? <ChevronDownIcon className="mr-1 size-3.5" aria-hidden="true" /> : <ChevronRightIcon className="mr-1 size-3.5" aria-hidden="true" />}
        {fill(t('Evidence {count}'), { count: evidence.length })}
      </Button>
    </div>
    {expanded ? (evidence.length === 0
      ? <p className="mt-1 pl-1 text-xs text-muted-foreground">{t('No evidence for this execution.')}</p>
      : <ul aria-label={t('Evidence list')} className="mt-1 border-l pl-3">{evidence.map((item) => <EvidenceRow key={item.id} item={item} />)}</ul>) : null}
  </div>
}

export function ControlPlaneTaskDetail({ taskId }: { taskId: string }) {
  const { t } = useLocale()
  const detail = useQuery({ queryKey: ['personal-ai-os-control-plane-task', taskId], queryFn: () => readTaskDetail(taskId), refetchInterval: 10_000, retry: false })
  const plan = useQuery({ queryKey: ['personal-ai-os-control-plane-completion-plan', taskId], queryFn: () => readCompletionPlan(taskId), refetchInterval: 10_000, retry: false })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const executions = detail.data?.executions ?? []
  const allEvidence = detail.data?.evidence ?? []
  const evidenceFor = (executionId: string) => allEvidence.filter((item) => item.executionId === executionId)

  return <div className="border-t bg-muted/20">
    <section role="region" aria-label={t('Execution list')} className="px-4 py-3">
      <h3 className="text-xs font-semibold">{fill(t('Execution list · task {id}'), { id: shortId(taskId) })}</h3>
      {detail.isPending ? <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />{t('Loading execution details…')}</p>
        : detail.isError ? <div className="mt-2 flex items-center gap-2 text-xs text-warning"><CircleAlertIcon className="size-3.5" aria-hidden="true" />{t("The control-plane is unreachable; cannot read this task's execution details")}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => void detail.refetch()}><RefreshCwIcon className="mr-1 size-3.5" aria-hidden="true" />{t('Retry')}</Button></div>
        : executions.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">{t('No Execution for this task.')}</p>
        : <div className="mt-2">{executions.map((execution) => <ExecutionRow key={execution.id} execution={execution} evidence={evidenceFor(execution.id)} expanded={Boolean(expanded[execution.id])}
            onToggle={() => setExpanded((current) => ({ ...current, [execution.id]: !current[execution.id] }))} />)}</div>}
    </section>

    <section role="region" aria-label={t('Completion acceptance conditions')} className="border-t px-4 py-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold"><PackageCheckIcon className="size-3.5" aria-hidden="true" />{t('Completion acceptance conditions')}</h3>
      {plan.isPending ? <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />{t('Loading completion conditions…')}</p>
        : plan.isError ? <div className="mt-2 flex items-center gap-2 text-xs text-warning"><CircleAlertIcon className="size-3.5" aria-hidden="true" />{t('Completion conditions are unreachable; cannot tell whether this task can be completed')}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => void plan.refetch()}><RefreshCwIcon className="mr-1 size-3.5" aria-hidden="true" />{t('Retry')}</Button></div>
        : plan.data?.ready ? <p className="mt-2 text-xs text-success">{t('The fixed acceptance conditions are met: every Execution has reached a terminal state, a succeeded root worker exists, and the artifactRef and independent review evidence are all present. Completing requires separate approval; this page will not trigger it.')}</p>
        : <div className="mt-2 text-xs">
          <p className="text-muted-foreground">{t('Completion conditions not met yet:')}</p>
          {(plan.data?.reasons ?? []).length === 0
            ? <p className="mt-1 text-muted-foreground">{t("The control-plane gave no specific reason; check this task's execution records.")}</p>
            : <ul aria-label={t('Unmet completion conditions')} className="mt-1 list-disc space-y-0.5 pl-4">{(plan.data?.reasons ?? []).map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        </div>}
      {plan.data?.parametersDigest ? <p className="mt-2 font-mono text-[10px] text-muted-foreground" title={plan.data.parametersDigest}>{fill(t('Parameter digest {digest}'), { digest: truncate(plan.data.parametersDigest, 32) })}</p> : null}
    </section>
  </div>
}
