import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon, PackageCheckIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
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

const API = 'http://127.0.0.1:4324/api/control-plane'

async function readTaskDetail(taskId: string): Promise<TaskDetail> {
  const response = await fetch(`${API}/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<TaskDetail>
}

async function readCompletionPlan(taskId: string): Promise<CompletionPlan> {
  const response = await fetch(`${API}/tasks/${encodeURIComponent(taskId)}/completion-plan`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<CompletionPlan>
}

/* The eight Execution states (control-plane/contracts.mjs EXECUTION_STATUSES). The word is
 * neutral; the colour lives in the dot, per the design system's single-carrier rule. `pulse`
 * marks the states that are still transitioning — a run that has neither succeeded nor failed. */
const EXECUTION_STATUS_LABELS: Record<string, string> = {
  queued: '排队中', running: '执行中', verifying: '验证中', reviewing: '复核中',
  succeeded: '已成功', failed: '失败', blocked: '已阻塞', cancelled: '已取消',
}
const EXECUTION_STATUS_TONES: Record<string, { tone: StatusDotTone; pulse?: boolean }> = {
  queued: { tone: 'pending' }, running: { tone: 'pending', pulse: true }, verifying: { tone: 'pending', pulse: true },
  reviewing: { tone: 'violet', pulse: true }, succeeded: { tone: 'success' }, failed: { tone: 'danger' },
  blocked: { tone: 'danger' }, cancelled: { tone: 'neutral' },
}
/* The seven Evidence kinds (control-plane/contracts.mjs createEvidence). */
const EVIDENCE_KIND_LABELS: Record<string, string> = {
  command: '命令', test: '测试', diff: '差异', log: '日志', screenshot: '截图', review: '复核', message: '消息',
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
  const label = EXECUTION_STATUS_LABELS[status] ?? status
  const presentation = EXECUTION_STATUS_TONES[status] ?? { tone: 'neutral' as StatusDotTone }
  return <Pill dot={presentation.tone} pulse={presentation.pulse} aria-label={`执行状态：${label}`}>{label}</Pill>
}

function EvidenceRow({ item }: { item: Evidence }) {
  const kind = EVIDENCE_KIND_LABELS[item.kind] ?? item.kind
  return <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 text-xs">
    <span className="font-medium">{kind}</span>
    {item.verdict ? <span className={cn('inline-flex items-center gap-1', item.verdict === 'passed' ? 'text-success' : 'text-danger')}>
      <StatusDot tone={item.verdict === 'passed' ? 'success' : 'danger'} role="img" aria-label={`判定：${item.verdict === 'passed' ? '通过' : '失败'}`} />
      {item.verdict === 'passed' ? '通过' : '失败'}
    </span> : null}
    {typeof item.exitCode === 'number' ? <span className="font-mono text-muted-foreground">退出码 {item.exitCode}</span> : null}
    {item.artifactRef ? <span className="font-mono text-muted-foreground" title={item.artifactRef}>副本 {truncate(item.artifactRef, 24)}</span> : null}
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
  return <div className="border-t px-4 py-2 first:border-t-0">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ExecutionStatusBadge status={execution.status} />
      <span className="font-mono text-xs">{execution.workerId}</span>
      <span className="text-xs text-muted-foreground">第 {execution.attempt} 次</span>
      {execution.parentExecutionId ? <span className="text-xs text-info" title={execution.parentExecutionId}>复核子执行 · 父执行 {shortId(execution.parentExecutionId)}</span> : null}
      {execution.artifactRef ? <span className="font-mono text-[10px] text-muted-foreground" title={execution.artifactRef}>副本 {truncate(execution.artifactRef, 24)}</span> : null}
      <span className="font-mono text-[10px] text-muted-foreground">{shortId(execution.id)}</span>
      <Button size="sm" variant="ghost" className="ml-auto" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}执行 ${execution.id} 的证据`} onClick={onToggle}>
        {expanded ? <ChevronDownIcon className="mr-1 size-3.5" aria-hidden="true" /> : <ChevronRightIcon className="mr-1 size-3.5" aria-hidden="true" />}
        证据 {evidence.length}
      </Button>
    </div>
    {expanded ? (evidence.length === 0
      ? <p className="mt-1 pl-1 text-xs text-muted-foreground">该执行暂无证据。</p>
      : <ul aria-label="证据列表" className="mt-1 border-l pl-3">{evidence.map((item) => <EvidenceRow key={item.id} item={item} />)}</ul>) : null}
  </div>
}

export function ControlPlaneTaskDetail({ taskId }: { taskId: string }) {
  const detail = useQuery({ queryKey: ['personal-ai-os-control-plane-task', taskId], queryFn: () => readTaskDetail(taskId), refetchInterval: 10_000, retry: false })
  const plan = useQuery({ queryKey: ['personal-ai-os-control-plane-completion-plan', taskId], queryFn: () => readCompletionPlan(taskId), refetchInterval: 10_000, retry: false })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const executions = detail.data?.executions ?? []
  const allEvidence = detail.data?.evidence ?? []
  const evidenceFor = (executionId: string) => allEvidence.filter((item) => item.executionId === executionId)

  return <div className="border-t bg-muted/20">
    <section role="region" aria-label="Execution 列表" className="px-4 py-3">
      <h3 className="text-xs font-semibold">Execution 列表 · 任务 {shortId(taskId)}</h3>
      {detail.isPending ? <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />正在读取执行详情…</p>
        : detail.isError ? <div className="mt-2 flex items-center gap-2 text-xs text-warning"><CircleAlertIcon className="size-3.5" aria-hidden="true" />控制面暂不可达，无法读取该任务的执行详情
          <Button size="sm" variant="outline" className="ml-2" onClick={() => void detail.refetch()}><RefreshCwIcon className="mr-1 size-3.5" aria-hidden="true" />重试</Button></div>
        : executions.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">该任务暂无 Execution。</p>
        : <div className="mt-2">{executions.map((execution) => <ExecutionRow key={execution.id} execution={execution} evidence={evidenceFor(execution.id)} expanded={Boolean(expanded[execution.id])}
            onToggle={() => setExpanded((current) => ({ ...current, [execution.id]: !current[execution.id] }))} />)}</div>}
    </section>

    <section role="region" aria-label="完成验收条件" className="border-t px-4 py-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold"><PackageCheckIcon className="size-3.5" aria-hidden="true" />完成验收条件</h3>
      {plan.isPending ? <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />正在读取完成条件…</p>
        : plan.isError ? <div className="mt-2 flex items-center gap-2 text-xs text-warning"><CircleAlertIcon className="size-3.5" aria-hidden="true" />完成条件暂不可达，无法判断该任务是否可以完成
          <Button size="sm" variant="outline" className="ml-2" onClick={() => void plan.refetch()}><RefreshCwIcon className="mr-1 size-3.5" aria-hidden="true" />重试</Button></div>
        : plan.data?.ready ? <p className="mt-2 text-xs text-success">满足固定验收条件：全部 Execution 已进入终态，存在 succeeded 的 root worker，且 artifactRef 与独立 review 证据齐备。完成操作需另行审批，本页不会触发。</p>
        : <div className="mt-2 text-xs">
          <p className="text-muted-foreground">尚不满足完成条件：</p>
          {(plan.data?.reasons ?? []).length === 0
            ? <p className="mt-1 text-muted-foreground">控制面未给出具体原因，请查看该任务的执行记录。</p>
            : <ul aria-label="未满足的完成条件" className="mt-1 list-disc space-y-0.5 pl-4">{(plan.data?.reasons ?? []).map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        </div>}
      {plan.data?.parametersDigest ? <p className="mt-2 font-mono text-[10px] text-muted-foreground" title={plan.data.parametersDigest}>参数摘要 {truncate(plan.data.parametersDigest, 32)}</p> : null}
    </section>
  </div>
}
