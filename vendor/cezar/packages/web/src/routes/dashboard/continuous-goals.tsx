import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'

type Goal = { id: string; specDigest: string; status: string; iterations: number; tokensUsed: number; workspaceDir: string; reason?: string; summary?: string; phase?: string; recoveryCount?: number; nextWakeAt?: number; needsRecovery?: boolean;
  spec: { title: string; objective: string; sourceDir: string; readPaths: string[]; writePaths: string[]; checks: Array<{ name: string; args: string[] }>; limits: { maxTokens: number; maxIterations: number }; recovery?: { enabled: boolean; maxAttempts: number } };
  lastChecks?: Array<{ name: string; exitCode: number | null }>; history?: Array<{ summary: string; artifactRef?: string; review?: { verdict: string; identity?: string }; checks?: Array<{ name: string; exitCode: number | null }> }> }
const API = 'http://127.0.0.1:4326'
// Goal tokens are 32 random bytes encoded as unpadded base64url (43 characters). This is a bounded shape check only.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export class AuthError extends Error {}
export class ServiceError extends Error {}
async function request(credential: string, endpoint: string, body?: unknown, key?: string, signal?: AbortSignal) {
  if (!TOKEN_PATTERN.test(credential)) throw new AuthError('访问凭据格式无效')
  const timeout = AbortSignal.timeout(15000)
  const response = await fetch(`${API}${endpoint}`, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }).catch(() => { throw new ServiceError('持续目标服务暂不可用') })
  const result = await response.json().catch(() => ({})) as { goals?: Goal[]; goal?: Goal; paused?: boolean; message?: string }
  if (response.status === 401 || response.status === 403) throw new AuthError('目标服务认证失败：访问凭据被拒绝，请重新连接')
  if (!response.ok) throw new ServiceError(result.message ?? `HTTP ${response.status}`)
  return result
}
const LABELS: Record<string, string> = { draft: '待确认范围', ready: '等待下一轮', running: '自主执行中', paused: '已暂停', waiting: '需要你处理', cancelled: '已取消', complete: '已完成验收' }
const PHASES: Record<string, string> = { planning: '规划', planner: 'Chief 规划', worker: 'Worker 提出修改', applying: '应用受控修改', verifying: '真实验收', reviewer: '独立复核' }
// Read-only badge layer for a goal card. Each badge states only what the goal record actually
// carries — the next scheduled check (nextWakeAt), the recovery outcome (needsRecovery /
// recoveryCount) and the bounded reason. A missing field renders no badge: the card never
// invents a schedule or a state (goal-store.mjs sets nextWakeAt on grant/resume/settle/recover).
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
const clock = (ms: number): string => {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function nextCheck(goal: Goal, now: number): { label: string; tone: StatusDotTone } | null {
  const wakeAt = goal.nextWakeAt
  if (typeof wakeAt !== 'number' || !Number.isFinite(wakeAt)) return null
  // A running goal's wake already fired for this iteration, and a terminal goal never wakes
  // again — neither shows a next-check badge rather than claim a check that will not happen.
  if (goal.status === 'running' && wakeAt <= now) return null
  if (['complete', 'cancelled'].includes(goal.status)) return null
  // A paused goal only wakes on a manual resume, so an expired wake time is not "待唤醒".
  if (goal.status === 'paused') return null
  const remaining = wakeAt - now
  if (remaining <= 0) return { label: '待唤醒', tone: 'pending' }
  const minutes = Math.max(1, Math.round(remaining / 60000))
  return { label: minutes < 60 ? `约 ${minutes} 分钟后检查` : `${clock(wakeAt)} 检查`, tone: 'pending' }
}
function GoalBadges({ goal }: { goal: Goal }) {
  const next = nextCheck(goal, Date.now())
  const recovered = typeof goal.recoveryCount === 'number' && goal.recoveryCount > 0
  if (!next && !goal.needsRecovery && !recovered) return null
  return <div className="flex flex-wrap items-center gap-2">
    {next ? <Pill dot={next.tone} aria-label={`下一检查：${next.label}`}>{next.label}</Pill> : null}
    {goal.needsRecovery ? <Pill dot="danger" aria-label="恢复状态：待恢复">待恢复</Pill> : null}
    {recovered ? <Pill dot="success" aria-label={`恢复状态：已自动恢复 ${goal.recoveryCount} 次`}>已自动恢复 {goal.recoveryCount} 次</Pill> : null}
  </div>
}
export function ContinuousGoals() {
  const client = useQueryClient()
  const instance = useId()
  const scope = ['continuous-goals', instance]
  const connection = useRef({ credential: '', generation: 0, controller: new AbortController() })
  const [entry, setEntry] = useState('')
  const [connected, setConnected] = useState(false)
  const [session, setSession] = useState(0)
  const [connectError, setConnectError] = useState('')
  const currentRequest = async (endpoint: string, body?: unknown, key?: string, signal?: AbortSignal) => {
    const current = connection.current
    const result = await request(current.credential, endpoint, body, key, signal ? AbortSignal.any([current.controller.signal, signal]) : current.controller.signal)
    if (current !== connection.current) throw new ServiceError('连接已改变，旧结果已忽略')
    return result
  }
  const query = useQuery({ queryKey: [...scope, session], queryFn: ({ signal }) => currentRequest('/api/goals', undefined, undefined, signal), enabled: connected, refetchInterval: 5000, retry: false })
  useEffect(() => () => {
    connection.current.controller.abort()
    connection.current.credential = ''
    client.removeQueries({ queryKey: ['continuous-goals', instance] })
  }, [client, instance])
  const [editing, setEditing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('自动修复验证试运行')
  const [objective, setObjective] = useState('修复 add 函数，使正数、负数和零的加法测试通过；不要修改验收测试。')
  const [directory, setDirectory] = useState('/Users/markus/ai-agent-cockpit/tests/fixtures/goal-pilot')
  const [reads, setReads] = useState('calculator.mjs, calculator.test.mjs')
  const [writes, setWrites] = useState('calculator.mjs')
  const [check, setCheck] = useState('calculator.test.mjs')
  const [tokens, setTokens] = useState(80000)
  const mutate = useMutation({ mutationFn: async ({ endpoint, body, key }: { endpoint: string; body: unknown; key?: string }) => {
    const generation = connection.current.generation
    await currentRequest(endpoint, body, key)
    return generation
  }, onSuccess: generation => {
    if (generation !== connection.current.generation) return
    void client.invalidateQueries({ queryKey: scope }); setEditing(false); setEditingId(null)
  } })
  const clearConnection = () => {
    connection.current.controller.abort()
    connection.current.credential = ''
    connection.current = { credential: '', generation: connection.current.generation + 1, controller: new AbortController() }
    void client.cancelQueries({ queryKey: scope }); client.removeQueries({ queryKey: scope })
    mutate.reset(); setEditing(false); setEditingId(null); setEditError('')
  }
  const connect = () => {
    const value = entry.trim()
    if (!TOKEN_PATTERN.test(value)) { setConnectError('访问凭据无效：需要 43 位 base64url token'); return }
    clearConnection(); connection.current.credential = value
    setConnected(true); setSession(current => current + 1); setEntry(''); setConnectError('')
  }
  const disconnect = () => {
    clearConnection(); setConnected(false); setEntry(''); setConnectError('')
  }
  const create = () => mutate.mutate({ endpoint: editingId ? `/api/goals/${editingId}/revise` : '/api/goals', key: crypto.randomUUID(), body: { title, objective, sourceDir: directory,
    readPaths: reads.split(',').map(value => value.trim()), writePaths: writes.split(',').map(value => value.trim()), checks: [{ name: '固定 Node 验收', args: ['--test', check.trim()] }], limits: { maxTokens: tokens } } })
  const edit = async (goal: Goal) => {
    const generation = connection.current.generation
    if (['ready', 'running'].includes(goal.status)) await currentRequest(`/api/goals/${goal.id}/pause`, {})
    if (generation !== connection.current.generation) return
    setEditingId(goal.id); setTitle(goal.spec.title); setObjective(goal.spec.objective); setDirectory(goal.spec.sourceDir)
    setReads(goal.spec.readPaths.join(', ')); setWrites(goal.spec.writePaths.join(', ')); setCheck(goal.spec.checks[0]?.args[1] ?? ''); setTokens(goal.spec.limits.maxTokens)
    setEditing(true); void client.invalidateQueries({ queryKey: scope })
  }
  const [editError, setEditError] = useState('')
  const authFailure = query.error instanceof AuthError
  return <Card data-dashboard-module="continuous-goals" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">持续目标 · 自主验证</h2><p className="text-xs text-muted-foreground">Personal AI OS 0.2.0 · 一次确认范围，Agent 自己迭代，你抽查结果</p></div><Button size="sm" disabled={!connected} onClick={() => { setEditingId(null); setEditing(!editing) }}>新建持续目标</Button></div>
    <div className="space-y-2 border-b px-4 py-3">
      <p className="text-xs text-muted-foreground">连接凭据只在本次页面会话的内存中保存：不写入浏览器存储、URL、日志或接口返回。这是等待正式桌面/应用配对前的临时安全接口，不代表对本人身份的证明。</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">访问凭据（access token）<input className="mt-1 w-full rounded border p-2" type="password" autoComplete="off" aria-label="访问凭据" value={entry} onChange={event => setEntry(event.target.value)} /></label>
        <Button size="sm" onClick={connect}>连接</Button>
        <Button size="sm" variant="outline" disabled={!connected} onClick={disconnect}>断开连接</Button>
        <span role="status" className="text-xs text-muted-foreground">{!connected ? '未连接：连接前不会请求目标服务' : authFailure ? '认证失败' : query.isError ? '服务不可用' : query.isSuccess ? '已连接' : '正在验证连接'}</span>
      </div>
      {connectError ? <p role="alert" className="text-xs text-danger">{connectError}</p> : null}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3"><p className="text-xs text-muted-foreground">首版在独立工作副本中修复，只支持固定 Node 验收；不会自动覆盖原项目、部署或修改原生旧会话。</p><Button size="sm" variant="outline" disabled={!connected || mutate.isPending || query.isError} onClick={() => mutate.mutate({ endpoint: `/api/goals/${query.data?.paused ? 'resume-all' : 'pause-all'}`, body: {} })}>{query.data?.paused ? '恢复全部目标' : '暂停全部目标'}</Button></div>
    {editing ? <div className="grid gap-2 border-b p-4 sm:grid-cols-2">
      <label className="text-xs">目标标题<input className="mt-1 w-full rounded border p-2" aria-label="目标标题" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className="text-xs">源项目目录<input className="mt-1 w-full rounded border p-2" aria-label="源项目目录" value={directory} onChange={event => setDirectory(event.target.value)} /></label>
      <label className="text-xs sm:col-span-2">完成目标<textarea className="mt-1 w-full rounded border p-2" aria-label="完成目标" value={objective} onChange={event => setObjective(event.target.value)} /></label>
      <label className="text-xs">批准读取文件（逗号分隔）<input className="mt-1 w-full rounded border p-2" value={reads} onChange={event => setReads(event.target.value)} /></label>
      <label className="text-xs">批准修改文件（工作副本）<input className="mt-1 w-full rounded border p-2" value={writes} onChange={event => setWrites(event.target.value)} /></label>
      <label className="text-xs">不可修改的验收文件<input className="mt-1 w-full rounded border p-2" value={check} onChange={event => setCheck(event.target.value)} /></label>
      <label className="text-xs">token 上限<input className="mt-1 w-full rounded border p-2" type="number" min={1000} max={1000000} value={tokens} onChange={event => setTokens(Number(event.target.value))} /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">默认最多 10 轮、24 小时、连续 3 轮无进展停止；安全检查点支持中断后自动接续，最多 3 次，不提高原预算或权限。Kimi 规划与复核，官方 DeepSeek V4.1 Flash 提出修改。获批文件内容会发送给这些现有 provider。</p>
      <Button disabled={mutate.isPending || !connected} onClick={create}>{editingId ? '更新草稿，重新确认范围' : '创建草稿，先查看范围'}</Button>
    </div> : null}
    {mutate.isError || editError ? <p role="alert" className="p-4 text-xs text-danger">{mutate.error?.message ?? editError}</p> : null}
    {!connected ? <p className="p-4 text-xs text-muted-foreground">未连接：请在上方输入访问凭据并连接后管理持续目标。</p> : query.isError ? (authFailure
      ? <p role="alert" className="p-4 text-xs text-danger">目标服务认证失败：当前凭据被拒绝，请断开后重新连接。</p>
      : <p className="p-4 text-xs text-warning">持续目标服务暂不可用；微信聊天与 Cezar 原生任务不受影响。</p>) : !query.data?.goals?.length ? <p className="p-4 text-xs text-muted-foreground">暂无持续目标。新建后确认范围即可启动。</p> : <div className="divide-y">{query.data.goals.map(goal => <div key={goal.id} className="space-y-2 p-4">
      <div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-medium">{goal.spec.title}</span><span className="text-xs">{LABELS[goal.status] ?? goal.status}{goal.status === 'running' ? ` · ${PHASES[goal.phase ?? ''] ?? goal.phase ?? ''}` : ''}</span></div>
      <GoalBadges goal={goal} />
      <p className="text-xs text-muted-foreground">{goal.spec.objective}</p><p className="text-xs">第 {goal.iterations} / {goal.spec.limits.maxIterations} 轮 · token {goal.tokensUsed} / {goal.spec.limits.maxTokens}</p>
      <p className="text-xs text-muted-foreground">{goal.spec.recovery?.enabled ? `中断自恢复：已接续 ${goal.recoveryCount ?? 0} / ${goal.spec.recovery.maxAttempts} 次；先核对范围和检查点` : '旧目标或未开启自恢复：中断后需核对，不自动重跑'}</p>
      {goal.summary ? <p className="text-xs">{goal.summary}</p> : null}{goal.reason ? <p className="text-xs text-muted-foreground" title={goal.reason}>{truncate(goal.reason, 160)}</p> : null}
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
