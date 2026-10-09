import { useQuery } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { fill, useLocale } from '@/components/locale-provider'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'

type Goal = { id: string; specDigest: string; status: string; iterations: number; tokensUsed: number; workspaceDir: string; reason?: string; summary?: string; phase?: string; recoveryCount?: number; nextWakeAt?: number; needsRecovery?: boolean;
  spec: { title: string; objective: string; sourceDir: string; readPaths: string[]; writePaths: string[]; checks: Array<{ name: string; args: string[] }>; limits: { maxTokens: number; maxIterations: number }; recovery?: { enabled: boolean; maxAttempts: number } };
  lastChecks?: Array<{ name: string; exitCode: number | null }>; history?: Array<{ summary: string; artifactRef?: string; review?: { verdict: string; identity?: string }; checks?: Array<{ name: string; exitCode: number | null }> }> }
type GoalsResponse = { goals?: Goal[]; paused?: boolean }

async function readGoals(): Promise<GoalsResponse> {
  // Same-origin read proxy (AUI-03): the server holds the goals viewer token and
  // the browser never sees 127.0.0.1:4326. The access-token input this card used
  // to take is retired — no goal credential ever enters page memory (AUI3-F005),
  // and the browser no longer sends X-Goal-Actor at all (AUI3-F004). The view is
  // read-only: goal management happens through the operator console.
  const response = await fetch('/api/v1/personal-ai-os/goals', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json() as { available?: boolean; body?: GoalsResponse; upstreamStatus?: number }
  if (envelope.available !== true) throw new Error('goals unavailable')
  if (typeof envelope.upstreamStatus === 'number' && envelope.upstreamStatus >= 400) {
    throw new Error(`upstream HTTP ${envelope.upstreamStatus}`)
  }
  return envelope.body ?? {}
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
  const query = useQuery({ queryKey: ['personal-ai-os-goals'], queryFn: readGoals, refetchInterval: 5000, retry: false })
  const goals = query.data?.goals ?? []
  return <Card data-dashboard-module="continuous-goals" className="gap-0 overflow-hidden py-0">
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3"><div><h2 className="text-sm font-semibold">{t('Continuous goals · autonomous verification')}</h2><p className="text-xs text-muted-foreground">{t('Personal AI OS 0.2.0 · confirm the scope once, the agent iterates on its own, you spot-check the results')}</p></div></div>
    <div className="border-b px-4 py-3"><p className="text-xs text-muted-foreground">{t('Read-only view: the browser no longer holds a goal access token. Managing goals (create / confirm scope / pause / resume / cancel) is done through the operator console.')}</p></div>
    <div className="px-4 pt-3"><p className="text-xs text-muted-foreground">{t('The first version fixes inside an isolated working copy and supports only fixed Node acceptance; it never overwrites the original project, deploys, or modifies native old sessions.')}</p></div>
    {query.isPending ? <p className="p-4 text-xs text-muted-foreground">{t('Reading goals…')}</p> : query.isError ? <p className="p-4 text-xs text-warning">{t('The continuous goals service is temporarily unavailable; WeChat chat and Cezar native tasks are unaffected.')}</p> : goals.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{t('No continuous goals yet.')}</p> : <div className="divide-y">{goals.map((goal) => <div key={goal.id} className="space-y-2 p-4">
      <div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-medium">{goal.spec.title}</span><span className="text-xs">{t(LABELS[goal.status] ?? goal.status)}{goal.status === 'running' ? ` · ${t(PHASES[goal.phase ?? ''] ?? goal.phase ?? '')}` : ''}</span></div>
      <GoalBadges goal={goal} />
      <p className="text-xs text-muted-foreground">{goal.spec.objective}</p><p className="text-xs">{fill(t('Round {iteration} / {maxRounds} · tokens {used} / {max}'), { iteration: goal.iterations, maxRounds: goal.spec.limits.maxIterations, used: goal.tokensUsed, max: goal.spec.limits.maxTokens })}</p>
      <p className="text-xs text-muted-foreground">{goal.spec.recovery?.enabled ? fill(t('Interruption self-recovery: resumed {count} / {max} times; verify the scope and checkpoints first'), { count: goal.recoveryCount ?? 0, max: goal.spec.recovery.maxAttempts }) : t('Old goal or self-recovery off: an interruption needs review, it does not rerun on its own')}</p>
      {goal.summary ? <p className="text-xs">{goal.summary}</p> : null}{goal.reason ? <p className="text-xs text-muted-foreground" title={goal.reason}>{truncate(goal.reason, 160)}</p> : null}
      <details className="text-xs"><summary className="cursor-pointer">{t('Spot-check scope and acceptance record')}</summary><p className="mt-2">{t('Read: ')}{goal.spec.readPaths.join(', ')}<br />{t('Write: ')}{goal.spec.writePaths.join(', ')}<br />{t('Fixed checks: ')}{goal.spec.checks.map((item) => item.args.join(' ')).join('; ')}<br />{t('Result copy: ')}{goal.workspaceDir}</p>
        {(goal.lastChecks ?? []).map((item, index) => <p key={index}>{fill(t('{name}: exit code {code}'), { name: item.name, code: item.exitCode ?? t('did not finish normally') })}</p>)}
        {(goal.history ?? []).slice(-3).map((item, index) => <p key={index} className="mt-2">{item.summary} · {item.review?.identity ?? t('Not yet reviewed')} · {item.artifactRef?.slice(0, 24)}</p>)}<code className="mt-2 block break-all">{goal.id}</code></details>
    </div>)}</div>}
  </Card>
}
