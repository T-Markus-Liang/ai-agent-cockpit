import { useQuery } from '@tanstack/react-query'
import { ActivityIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useLocale } from '@/components/locale-provider'

type Task = { id: string; goal: string; status: string; updatedAt: string; executionIds?: string[] }
type TasksResponse = { tasks?: Task[] }

async function readTasks(): Promise<TasksResponse> {
  const response = await fetch('http://127.0.0.1:4324/api/control-plane/tasks', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<TasksResponse>
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', planned: '已规划', queued: '排队中', running: '执行中', verifying: '验证中',
  reviewing: 'Review 中', ready: '待交付', blocked: '已阻塞', failed: '失败', cancelled: '已取消', completed: '已完成',
}

export function ControlPlaneTasks() {
  const { t } = useLocale()
  const query = useQuery({ queryKey: ['personal-ai-os-control-plane-tasks'], queryFn: readTasks, refetchInterval: 10_000, retry: false })
  const tasks = query.data?.tasks ?? []
  return <Card data-dashboard-module="control-plane-tasks" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between border-b px-4 py-3">
      <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ActivityIcon className="size-4" />{t('控制面任务')}</h2><p className="text-xs text-muted-foreground">{t('Personal AI OS Task / Execution 状态')}</p></div>
      <span className="text-xs text-muted-foreground">{tasks.length} 个</span>
    </div>
    {query.isPending ? <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" />{t('正在读取控制面…')}</div> : query.isError ? <div className="flex items-center gap-2 p-4 text-xs text-warning"><CircleAlertIcon className="size-3.5" />{t('控制面暂不可用；不会影响 Cezar 原生任务')}</div> : tasks.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{t('暂无控制面任务')}</p> : <div className="divide-y">{tasks.slice(0, 5).map((task) => <div key={task.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm">{task.goal}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{task.id} · {task.executionIds?.length ?? 0} 次执行</p></div><span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[task.status] ?? task.status}</span></div>)}</div>}
  </Card>
}
