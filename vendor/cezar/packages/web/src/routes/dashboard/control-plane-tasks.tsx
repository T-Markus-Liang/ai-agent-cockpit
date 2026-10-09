import { useQuery } from '@tanstack/react-query'
import { ActivityIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { fill, useLocale } from '@/components/locale-provider'
import { ControlPlaneTaskDetail } from './control-plane-executions'

type Task = { id: string; goal: string; status: string; updatedAt: string; executionIds?: string[] }
type TasksResponse = { tasks?: Task[] }

async function readTasks(): Promise<TasksResponse> {
  // Same-origin read proxy (AUI-03): the server holds the control-plane token;
  // the browser never sees 127.0.0.1:4324 or a credential.
  const response = await fetch('/api/v1/personal-ai-os/control-plane/tasks', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json() as { available?: boolean; body?: TasksResponse }
  if (envelope.available !== true) throw new Error('control-plane unavailable')
  return envelope.body ?? {}
}

// ENGLISH source strings, translated at render via `t` — an unknown status falls through to its
// raw value (control-plane statuses are a closed enum, but the card never invents a label).
const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', planned: 'Planned', queued: 'Queued', running: 'Running', verifying: 'Verifying',
  reviewing: 'In review', ready: 'Ready to deliver', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled', completed: 'Completed',
}

export function ControlPlaneTasks() {
  const { t } = useLocale()
  const query = useQuery({ queryKey: ['personal-ai-os-control-plane-tasks'], queryFn: readTasks, refetchInterval: 10_000, retry: false })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const tasks = query.data?.tasks ?? []
  return <Card data-dashboard-module="control-plane-tasks" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between border-b px-4 py-3">
      <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ActivityIcon className="size-4" aria-hidden="true" />{t('Control-plane tasks')}</h2><p className="text-xs text-muted-foreground">{t('Personal AI OS Task / Execution state')}</p></div>
      <span className="text-xs text-muted-foreground">{fill(t('{count} items'), { count: tasks.length })}</span>
    </div>
    {query.isPending ? <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />{t('Reading control-plane…')}</div> : query.isError ? <div className="flex items-center gap-2 p-4 text-xs text-warning"><CircleAlertIcon className="size-3.5" aria-hidden="true" />{t("The control-plane is unavailable; Cezar's native tasks are unaffected")}</div> : tasks.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{t('No control-plane tasks')}</p> : <div className="divide-y">{tasks.slice(0, 5).map((task) => {
      const selected = task.id === selectedId
      return <div key={task.id}>
        <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none" aria-expanded={selected} aria-label={fill(t(selected ? 'Hide execution details for task {id}' : 'Show execution details for task {id}'), { id: task.id })} onClick={() => setSelectedId(selected ? null : task.id)}>
          <div className="min-w-0"><p className="truncate text-sm">{task.goal}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{task.id} · {fill(t('{count} executions'), { count: task.executionIds?.length ?? 0 })}</p></div>
          <span className="shrink-0 text-xs text-muted-foreground">{t(STATUS_LABELS[task.status] ?? task.status)}</span>
        </button>
        {selected ? <ControlPlaneTaskDetail taskId={task.id} /> : null}
      </div>
    })}</div>}
  </Card>
}
