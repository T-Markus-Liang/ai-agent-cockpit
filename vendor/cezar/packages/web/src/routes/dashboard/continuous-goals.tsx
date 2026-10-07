import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

type Goal = { id: string; specDigest: string; status: string; iterations: number; tokensUsed: number; workspaceDir: string; reason?: string; summary?: string; phase?: string; recoveryCount?: number;
  spec: { title: string; objective: string; sourceDir: string; readPaths: string[]; writePaths: string[]; checks: Array<{ name: string; args: string[] }>; limits: { maxTokens: number; maxIterations: number }; recovery?: { enabled: boolean; maxAttempts: number } };
  lastChecks?: Array<{ name: string; exitCode: number | null }>; history?: Array<{ summary: string; artifactRef?: string; review?: { verdict: string; identity?: string }; checks?: Array<{ name: string; exitCode: number | null }> }> }
const API = 'http://127.0.0.1:4326'
async function request(endpoint: string, body?: unknown, key?: string) {
  const bootstrap = await fetch(`${API}/api/bootstrap`, { headers: { 'X-AI-OS-Client': 'cockpit' }, signal: AbortSignal.timeout(3000) })
  if (!bootstrap.ok) throw new Error('持续目标服务未连接')
  const { token } = await bootstrap.json() as { token: string }
  const response = await fetch(`${API}${endpoint}`, { signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const result = await response.json() as { goals?: Goal[]; goal?: Goal; paused?: boolean; message?: string }
  if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`)
  return result
}
const LABELS: Record<string, string> = { draft: '待确认范围', ready: '等待下一轮', running: '自主执行中', paused: '已暂停', waiting: '需要你处理', cancelled: '已取消', complete: '已完成验收' }
const PHASES: Record<string, string> = { planning: '规划', planner: 'Chief 规划', worker: 'Worker 提出修改', applying: '应用受控修改', verifying: '真实验收', reviewer: '独立复核' }
export function ContinuousGoals() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['continuous-goals'], queryFn: () => request('/api/goals'), refetchInterval: 5000, retry: false })
  const [editing, setEditing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('自动修复验证试运行')
  const [objective, setObjective] = useState('修复 add 函数，使正数、负数和零的加法测试通过；不要修改验收测试。')
  const [directory, setDirectory] = useState('/Users/markus/ai-agent-cockpit/tests/fixtures/goal-pilot')
  const [reads, setReads] = useState('calculator.mjs, calculator.test.mjs')
  const [writes, setWrites] = useState('calculator.mjs')
  const [check, setCheck] = useState('calculator.test.mjs')
  const [tokens, setTokens] = useState(80000)
  const mutate = useMutation({ mutationFn: ({ endpoint, body, key }: { endpoint: string; body: unknown; key?: string }) => request(endpoint, body, key),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['continuous-goals'] }); setEditing(false); setEditingId(null) } })
  const create = () => mutate.mutate({ endpoint: editingId ? `/api/goals/${editingId}/revise` : '/api/goals', key: crypto.randomUUID(), body: { title, objective, sourceDir: directory,
    readPaths: reads.split(',').map(value => value.trim()), writePaths: writes.split(',').map(value => value.trim()), checks: [{ name: '固定 Node 验收', args: ['--test', check.trim()] }], limits: { maxTokens: tokens } } })
  const edit = async (goal: Goal) => {
    if (['ready', 'running'].includes(goal.status)) await request(`/api/goals/${goal.id}/pause`, {})
    setEditingId(goal.id); setTitle(goal.spec.title); setObjective(goal.spec.objective); setDirectory(goal.spec.sourceDir)
    setReads(goal.spec.readPaths.join(', ')); setWrites(goal.spec.writePaths.join(', ')); setCheck(goal.spec.checks[0]?.args[1] ?? ''); setTokens(goal.spec.limits.maxTokens)
    setEditing(true); void client.invalidateQueries({ queryKey: ['continuous-goals'] })
  }
  const [editError, setEditError] = useState('')
  return <Card data-dashboard-module="continuous-goals" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">持续目标 · 自主验证</h2><p className="text-xs text-muted-foreground">Personal AI OS 0.2.0 · 一次确认范围，Agent 自己迭代，你抽查结果</p></div><Button size="sm" onClick={() => { setEditingId(null); setEditing(!editing) }}>新建持续目标</Button></div>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3"><p className="text-xs text-muted-foreground">首版在独立工作副本中修复，只支持固定 Node 验收；不会自动覆盖原项目、部署或修改原生旧会话。</p><Button size="sm" variant="outline" disabled={mutate.isPending || query.isError} onClick={() => mutate.mutate({ endpoint: `/api/goals/${query.data?.paused ? 'resume-all' : 'pause-all'}`, body: {} })}>{query.data?.paused ? '恢复全部目标' : '暂停全部目标'}</Button></div>
    {editing ? <div className="grid gap-2 border-b p-4 sm:grid-cols-2">
      <label className="text-xs">目标标题<input className="mt-1 w-full rounded border p-2" aria-label="目标标题" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className="text-xs">源项目目录<input className="mt-1 w-full rounded border p-2" aria-label="源项目目录" value={directory} onChange={event => setDirectory(event.target.value)} /></label>
      <label className="text-xs sm:col-span-2">完成目标<textarea className="mt-1 w-full rounded border p-2" aria-label="完成目标" value={objective} onChange={event => setObjective(event.target.value)} /></label>
      <label className="text-xs">批准读取文件（逗号分隔）<input className="mt-1 w-full rounded border p-2" value={reads} onChange={event => setReads(event.target.value)} /></label>
      <label className="text-xs">批准修改文件（工作副本）<input className="mt-1 w-full rounded border p-2" value={writes} onChange={event => setWrites(event.target.value)} /></label>
      <label className="text-xs">不可修改的验收文件<input className="mt-1 w-full rounded border p-2" value={check} onChange={event => setCheck(event.target.value)} /></label>
      <label className="text-xs">token 上限<input className="mt-1 w-full rounded border p-2" type="number" min={1000} max={1000000} value={tokens} onChange={event => setTokens(Number(event.target.value))} /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">默认最多 10 轮、24 小时、连续 3 轮无进展停止；安全检查点支持中断后自动接续，最多 3 次，不提高原预算或权限。Kimi 规划与复核，官方 DeepSeek V4.1 Flash 提出修改。获批文件内容会发送给这些现有 provider。</p>
      <Button disabled={mutate.isPending} onClick={create}>{editingId ? '更新草稿，重新确认范围' : '创建草稿，先查看范围'}</Button>
    </div> : null}
    {mutate.isError || editError ? <p role="alert" className="p-4 text-xs text-danger">{mutate.error?.message ?? editError}</p> : null}
    {query.isError ? <p className="p-4 text-xs text-warning">持续目标服务暂不可用；微信聊天与 Cezar 原生任务不受影响。</p> : !query.data?.goals?.length ? <p className="p-4 text-xs text-muted-foreground">暂无持续目标。新建后确认范围即可启动。</p> : <div className="divide-y">{query.data.goals.map(goal => <div key={goal.id} className="space-y-2 p-4">
      <div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-medium">{goal.spec.title}</span><span className="text-xs">{LABELS[goal.status] ?? goal.status}{goal.status === 'running' ? ` · ${PHASES[goal.phase ?? ''] ?? goal.phase ?? ''}` : ''}</span></div>
      <p className="text-xs text-muted-foreground">{goal.spec.objective}</p><p className="text-xs">第 {goal.iterations} / {goal.spec.limits.maxIterations} 轮 · token {goal.tokensUsed} / {goal.spec.limits.maxTokens}</p>
      <p className="text-xs text-muted-foreground">{goal.spec.recovery?.enabled ? `中断自恢复：已接续 ${goal.recoveryCount ?? 0} / ${goal.spec.recovery.maxAttempts} 次；先核对范围和检查点` : '旧目标或未开启自恢复：中断后需核对，不自动重跑'}</p>
      {goal.summary ? <p className="text-xs">{goal.summary}</p> : null}{goal.reason ? <p className="text-xs text-warning">{goal.reason}</p> : null}
      <div className="flex flex-wrap gap-2">{goal.status === 'draft' ? <Button size="sm" disabled={mutate.isPending} onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/grant`, body: { digest: goal.specDigest } })}>确认范围并启动</Button> : null}
        {['ready', 'running'].includes(goal.status) ? <Button size="sm" variant="outline" onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/pause`, body: {} })}>暂停</Button> : null}
        {['paused', 'waiting'].includes(goal.status) ? <Button size="sm" variant="outline" onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/resume`, body: {} })}>恢复</Button> : null}
        {!['complete', 'cancelled'].includes(goal.status) ? <><Button size="sm" variant="outline" onClick={() => { setEditError(''); void edit(goal).catch(error => setEditError(String(error.message))) }}>改方向</Button><Button size="sm" variant="outline" onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/cancel`, body: {} })}>取消</Button></> : null}
      </div>
      <details className="text-xs"><summary className="cursor-pointer">抽查范围与验收记录</summary><p className="mt-2">读取：{goal.spec.readPaths.join(', ')}<br />修改：{goal.spec.writePaths.join(', ')}<br />固定检查：{goal.spec.checks.map(item => item.args.join(' ')).join('; ')}<br />结果副本：{goal.workspaceDir}</p>
        {(goal.lastChecks ?? []).map((item, index) => <p key={index}>{item.name}：退出码 {item.exitCode ?? '未正常结束'}</p>)}
        {(goal.history ?? []).slice(-3).map((item, index) => <p key={index} className="mt-2">{item.summary} · {item.review?.identity ?? '尚未复核'} · {item.artifactRef?.slice(0, 24)}</p>)}<code className="mt-2 block break-all">{goal.id}</code></details>
    </div>)}</div>}
  </Card>
}
