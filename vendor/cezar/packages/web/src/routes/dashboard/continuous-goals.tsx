import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { fill, useLocale } from '@/components/locale-provider'
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
  if (!TOKEN_PATTERN.test(credential)) throw new AuthError('Invalid credential format')
  const timeout = AbortSignal.timeout(15000)
  const response = await fetch(`${API}${endpoint}`, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }).catch(() => { throw new ServiceError('The continuous goals service is temporarily unavailable') })
  const result = await response.json().catch(() => ({})) as { goals?: Goal[]; goal?: Goal; paused?: boolean; message?: string }
  if (response.status === 401 || response.status === 403) throw new AuthError('Goal service authentication failed: the credential was rejected, reconnect with a new token')
  if (!response.ok) throw new ServiceError(result.message ?? `HTTP ${response.status}`)
  return result
}
// Status/phrase labels are ENGLISH source strings translated at render (see locale-provider `t`),
// so a locale switch re-renders the card instead of leaving one language baked into the module.
const LABELS: Record<string, string> = { draft: 'Scope pending', ready: 'Waiting to run', running: 'Executing autonomously', paused: 'Paused', waiting: 'Needs you', cancelled: 'Cancelled', complete: 'Accepted' }
const PHASES: Record<string, string> = { planning: 'Planning', planner: 'Chief planning', worker: 'Worker proposes changes', applying: 'Applying controlled changes', verifying: 'Real acceptance', reviewer: 'Independent review' }
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
function nextCheck(goal: Goal, now: number, t: (text: string) => string): { label: string; tone: StatusDotTone } | null {
  const wakeAt = goal.nextWakeAt
  if (typeof wakeAt !== 'number' || !Number.isFinite(wakeAt)) return null
  // A running goal's wake already fired for this iteration, and a terminal goal never wakes
  // again — neither shows a next-check badge rather than claim a check that will not happen.
  if (goal.status === 'running' && wakeAt <= now) return null
  if (['complete', 'cancelled'].includes(goal.status)) return null
  // A paused goal only wakes on a manual resume, so an expired wake time is not "待唤醒".
  if (goal.status === 'paused') return null
  const remaining = wakeAt - now
  if (remaining <= 0) return { label: t('Waiting for wake'), tone: 'pending' }
  const minutes = Math.max(1, Math.round(remaining / 60000))
  return { label: minutes < 60 ? fill(t('Check in ~{minutes} min'), { minutes }) : fill(t('Check at {time}'), { time: clock(wakeAt) }), tone: 'pending' }
}
function GoalBadges({ goal }: { goal: Goal }) {
  const { t } = useLocale()
  const next = nextCheck(goal, Date.now(), t)
  const recovered = typeof goal.recoveryCount === 'number' && goal.recoveryCount > 0
  if (!next && !goal.needsRecovery && !recovered) return null
  return <div className="flex flex-wrap items-center gap-2">
    {next ? <Pill dot={next.tone} aria-label={fill(t('Next check: {label}'), { label: next.label })}>{next.label}</Pill> : null}
    {goal.needsRecovery ? <Pill dot="danger" aria-label={t('Recovery status: pending')}>{t('Recovery pending')}</Pill> : null}
    {recovered ? <Pill dot="success" aria-label={fill(t('Recovery status: auto-recovered {count} times'), { count: goal.recoveryCount ?? 0 })}>{fill(t('Auto-recovered {count} times'), { count: goal.recoveryCount ?? 0 })}</Pill> : null}
  </div>
}
export function ContinuousGoals() {
  const { t } = useLocale()
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
    if (current !== connection.current) throw new ServiceError('Connection changed — the previous result was ignored')
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
  const [title, setTitle] = useState(t('Automated fix verification dry run'))
  const [objective, setObjective] = useState(t('Fix the add function so the addition tests for positive numbers, negatives and zero pass; do not modify the acceptance tests.'))
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
    if (!TOKEN_PATTERN.test(value)) { setConnectError('Invalid credential: a 43-character base64url token is required'); return }
    clearConnection(); connection.current.credential = value
    setConnected(true); setSession(current => current + 1); setEntry(''); setConnectError('')
  }
  const disconnect = () => {
    clearConnection(); setConnected(false); setEntry(''); setConnectError('')
  }
  const create = () => mutate.mutate({ endpoint: editingId ? `/api/goals/${editingId}/revise` : '/api/goals', key: crypto.randomUUID(), body: { title, objective, sourceDir: directory,
    readPaths: reads.split(',').map(value => value.trim()), writePaths: writes.split(',').map(value => value.trim()), checks: [{ name: t('Fixed Node acceptance'), args: ['--test', check.trim()] }], limits: { maxTokens: tokens } } })
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
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">{t('Continuous goals · autonomous verification')}</h2><p className="text-xs text-muted-foreground">{t('Personal AI OS 0.2.0 · confirm the scope once, the agent iterates on its own, you spot-check the results')}</p></div><Button size="sm" disabled={!connected} onClick={() => { setEditingId(null); setEditing(!editing) }}>{t('New continuous goal')}</Button></div>
    <div className="space-y-2 border-b px-4 py-3">
      <p className="text-xs text-muted-foreground">{t('The connection credential is kept only in this page session memory: never written to browser storage, the URL, logs or API responses. This is a temporary secure interface until formal desktop/app pairing exists, and it is not proof of your identity.')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">{t('Access credential (access token)')}<input className="mt-1 w-full rounded border p-2" type="password" autoComplete="off" aria-label={t('Access credential')} value={entry} onChange={event => setEntry(event.target.value)} /></label>
        <Button size="sm" onClick={connect}>{t('Connect')}</Button>
        <Button size="sm" variant="outline" disabled={!connected} onClick={disconnect}>{t('Disconnect')}</Button>
        <span role="status" className="text-xs text-muted-foreground">{!connected ? t('Not connected: the goal service is not requested until you connect') : authFailure ? t('Authentication failed') : query.isError ? t('Service unavailable') : query.isSuccess ? t('Connected') : t('Verifying connection')}</span>
      </div>
      {connectError ? <p role="alert" className="text-xs text-danger">{t(connectError)}</p> : null}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3"><p className="text-xs text-muted-foreground">{t('The first version fixes inside an isolated working copy and supports only fixed Node acceptance; it never overwrites the original project, deploys, or modifies native old sessions.')}</p><Button size="sm" variant="outline" disabled={!connected || mutate.isPending || query.isError} onClick={() => mutate.mutate({ endpoint: `/api/goals/${query.data?.paused ? 'resume-all' : 'pause-all'}`, body: {} })}>{query.data?.paused ? t('Resume all goals') : t('Pause all goals')}</Button></div>
    {editing ? <div className="grid gap-2 border-b p-4 sm:grid-cols-2">
      <label className="text-xs">{t('Goal title')}<input className="mt-1 w-full rounded border p-2" aria-label={t('Goal title')} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className="text-xs">{t('Source project directory')}<input className="mt-1 w-full rounded border p-2" aria-label={t('Source project directory')} value={directory} onChange={event => setDirectory(event.target.value)} /></label>
      <label className="text-xs sm:col-span-2">{t('Goal objective')}<textarea className="mt-1 w-full rounded border p-2" aria-label={t('Goal objective')} value={objective} onChange={event => setObjective(event.target.value)} /></label>
      <label className="text-xs">{t('Approved read files (comma-separated)')}<input className="mt-1 w-full rounded border p-2" value={reads} onChange={event => setReads(event.target.value)} /></label>
      <label className="text-xs">{t('Approved write files (working copy)')}<input className="mt-1 w-full rounded border p-2" value={writes} onChange={event => setWrites(event.target.value)} /></label>
      <label className="text-xs">{t('Immutable acceptance file')}<input className="mt-1 w-full rounded border p-2" value={check} onChange={event => setCheck(event.target.value)} /></label>
      <label className="text-xs">{t('Token limit')}<input className="mt-1 w-full rounded border p-2" type="number" min={1000} max={1000000} value={tokens} onChange={event => setTokens(Number(event.target.value))} /></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">{t('At most 10 rounds, 24 hours, stop after 3 rounds with no progress by default; safety checkpoints resume automatically after an interruption, at most 3 times, without raising the original budget or permissions. Kimi plans and reviews, the official DeepSeek V4.1 Flash proposes changes. Approved file contents are sent to these existing providers.')}</p>
      <Button disabled={mutate.isPending || !connected} onClick={create}>{editingId ? t('Update draft and re-confirm scope') : t('Create draft and review scope first')}</Button>
    </div> : null}
    {mutate.isError || editError ? <p role="alert" className="p-4 text-xs text-danger">{t(mutate.error?.message ?? editError)}</p> : null}
    {!connected ? <p className="p-4 text-xs text-muted-foreground">{t('Not connected: enter an access credential above and connect before managing continuous goals.')}</p> : query.isError ? (authFailure
      ? <p role="alert" className="p-4 text-xs text-danger">{t('Goal service authentication failed: the current credential was rejected, disconnect and reconnect.')}</p>
      : <p className="p-4 text-xs text-warning">{t('The continuous goals service is temporarily unavailable; WeChat chat and Cezar native tasks are unaffected.')}</p>) : !query.data?.goals?.length ? <p className="p-4 text-xs text-muted-foreground">{t('No continuous goals yet. Create one and confirm its scope to start.')}</p> : <div className="divide-y">{query.data.goals.map(goal => <div key={goal.id} className="space-y-2 p-4">
      <div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-medium">{goal.spec.title}</span><span className="text-xs">{t(LABELS[goal.status] ?? goal.status)}{goal.status === 'running' ? ` · ${t(PHASES[goal.phase ?? ''] ?? goal.phase ?? '')}` : ''}</span></div>
      <GoalBadges goal={goal} />
      <p className="text-xs text-muted-foreground">{goal.spec.objective}</p><p className="text-xs">{fill(t('Round {iteration} / {maxRounds} · tokens {used} / {max}'), { iteration: goal.iterations, maxRounds: goal.spec.limits.maxIterations, used: goal.tokensUsed, max: goal.spec.limits.maxTokens })}</p>
      <p className="text-xs text-muted-foreground">{goal.spec.recovery?.enabled ? fill(t('Interruption self-recovery: resumed {count} / {max} times; verify the scope and checkpoints first'), { count: goal.recoveryCount ?? 0, max: goal.spec.recovery.maxAttempts }) : t('Old goal or self-recovery off: an interruption needs review, it does not rerun on its own')}</p>
      {goal.summary ? <p className="text-xs">{goal.summary}</p> : null}{goal.reason ? <p className="text-xs text-muted-foreground" title={goal.reason}>{truncate(goal.reason, 160)}</p> : null}
      <div className="flex flex-wrap gap-2">{goal.status === 'draft' ? <Button size="sm" disabled={mutate.isPending} onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/grant`, body: { digest: goal.specDigest } })}>{t('Confirm scope and start')}</Button> : null}
        {['ready', 'running'].includes(goal.status) ? <Button size="sm" variant="outline" onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/pause`, body: {} })}>{t('Pause')}</Button> : null}
        {['paused', 'waiting'].includes(goal.status) ? <Button size="sm" variant="outline" onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/resume`, body: {} })}>{t('Resume')}</Button> : null}
        {!['complete', 'cancelled'].includes(goal.status) ? <><Button size="sm" variant="outline" onClick={() => { setEditError(''); void edit(goal).catch(error => setEditError(String(error.message))) }}>{t('Change direction')}</Button><Button size="sm" variant="outline" onClick={() => mutate.mutate({ endpoint: `/api/goals/${goal.id}/cancel`, body: {} })}>{t('Cancel')}</Button></> : null}
      </div>
      <details className="text-xs"><summary className="cursor-pointer">{t('Spot-check scope and acceptance record')}</summary><p className="mt-2">{t('Read: ')}{goal.spec.readPaths.join(', ')}<br />{t('Write: ')}{goal.spec.writePaths.join(', ')}<br />{t('Fixed checks: ')}{goal.spec.checks.map(item => item.args.join(' ')).join('; ')}<br />{t('Result copy: ')}{goal.workspaceDir}</p>
        {(goal.lastChecks ?? []).map((item, index) => <p key={index}>{fill(t('{name}: exit code {code}'), { name: item.name, code: item.exitCode ?? t('did not finish normally') })}</p>)}
        {(goal.history ?? []).slice(-3).map((item, index) => <p key={index} className="mt-2">{item.summary} · {item.review?.identity ?? t('Not yet reviewed')} · {item.artifactRef?.slice(0, 24)}</p>)}<code className="mt-2 block break-all">{goal.id}</code></details>
    </div>)}</div>}
  </Card>
}
