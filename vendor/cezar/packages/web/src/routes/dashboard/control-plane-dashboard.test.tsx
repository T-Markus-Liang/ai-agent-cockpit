import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { LocaleProvider } from '@/components/locale-provider'
import { ControlPlaneApprovals } from './control-plane-approvals'
import { ControlPlaneTasks } from './control-plane-tasks'

const ARTIFACT = 'artifact_ref_0123456789abcdef'
const DIGEST = 'sha256:0123456789abcdef0123456789abcdef'
const LONG_SUMMARY = `${'验'.repeat(160)}被截断的尾部`

const listBody = { tasks: [{ id: 'task_1', goal: '修复控制面', status: 'running', updatedAt: '2026-10-06T00:00:00Z', executionIds: ['execution_1'] }] }
const detailBody = {
  task: { id: 'task_1', goal: '修复控制面', status: 'running' },
  executions: [
    { id: 'execution_1', taskId: 'task_1', workerId: 'worker-a', status: 'succeeded', attempt: 1, artifactRef: ARTIFACT },
    { id: 'execution_2', taskId: 'task_1', workerId: 'worker-b', role: 'reviewer', status: 'reviewing', attempt: 1, parentExecutionId: 'execution_1', artifactRef: ARTIFACT },
    { id: 'execution_3', taskId: 'task_1', workerId: 'worker-c', status: 'failed', attempt: 2 },
  ],
  evidence: [
    { id: 'ev_1', executionId: 'execution_1', kind: 'test', summary: 'node --test calculator 通过', capturedAt: '2026-10-06T01:02:03.000Z', exitCode: 0, verdict: 'passed', artifactRef: ARTIFACT },
    { id: 'ev_2', executionId: 'execution_1', kind: 'command', summary: LONG_SUMMARY, capturedAt: '2026-10-06T01:05:00.000Z', exitCode: 1, verdict: 'failed' },
    { id: 'ev_3', executionId: 'execution_2', kind: 'review', summary: '独立复核通过', capturedAt: '2026-10-06T02:00:00.000Z', verdict: 'passed' },
  ],
}
const planNotReady = { action: 'task.complete', target: 'task_1', ready: false, reasons: ['所有 Execution 必须先进入终态', 'worker execution_1 缺少独立 reviewer 的 passed review Evidence'], parametersDigest: DIGEST }
const planReady = { action: 'task.complete', target: 'task_1', ready: true, reasons: [], parametersDigest: DIGEST }

type Stub = { dStatus?: number; planStatus?: number; plan?: typeof planNotReady; executions?: typeof detailBody.executions }
function stubFetch({ dStatus = 200, planStatus = 200, plan = planNotReady, executions = detailBody.executions }: Stub = {}) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); requests.push(url)
    if (url.includes('/api/v1/personal-ai-os/control-plane/tasks/') && url.includes('/completion-plan')) return new Response(JSON.stringify({ available: true, upstreamStatus: planStatus, body: planStatus < 400 ? plan : {} }), { status: 200 })
    if (/\/api\/v1\/personal-ai-os\/control-plane\/tasks\/[^/?]+$/.test(url)) return new Response(JSON.stringify({ available: true, upstreamStatus: dStatus, body: dStatus < 400 ? { ...detailBody, executions } : {} }), { status: 200 })
    if (url.includes('/api/v1/personal-ai-os/control-plane/tasks')) return new Response(JSON.stringify({ available: true, upstreamStatus: 200, body: listBody }), { status: 200 })
    if (url.includes('/api/v1/personal-ai-os/control-plane/approvals')) return new Response(JSON.stringify({ available: true, upstreamStatus: 200, body: { approvals: [{ id: 'approval_1', action: 'cezar.dispatch', target: 'execution_1', parametersDigest: 'sha256:test', decision: 'pending', createdAt: '2026-10-06T00:00:00Z' }] } }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  return { requests }
}

function renderWithQuery(ui: React.ReactElement) {
  const client = createQueryClient()
  return render(<LocaleProvider><QueryClientProvider client={client}>{ui}</QueryClientProvider></LocaleProvider>)
}

function selectTask() {
  fireEvent.click(screen.getByRole('button', { name: /展开任务 task_1/ }))
}

// These modules are localized (English source strings + a zh-CN table). Force zh-CN so the
// existing assertions keep checking the Chinese they were written against; the `locale=en`
// cases below cover the English source.
beforeEach(() => { window.localStorage.setItem('cez-locale', 'zh-CN') })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Personal AI OS dashboard modules', () => {
  beforeEach(() => { stubFetch() })

  it('renders the unavailable state when the same-origin proxy degrades', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url)
      if (url.includes('/api/v1/personal-ai-os/control-plane/tasks')) {
        return new Response(JSON.stringify({ available: false, reason: 'authority-unavailable' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    renderWithQuery(<ControlPlaneTasks />)
    expect(await screen.findByText('控制面暂不可用；不会影响 Cezar 原生任务')).toBeTruthy()
    expect(requests.some((url) => url.startsWith('/api/v1/personal-ai-os/'))).toBe(true)
    expect(requests.some((url) => url.includes('127.0.0.1:4324'))).toBe(false)
  })

  it('renders the unavailable state when the upstream tasks read errors through the proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/personal-ai-os/control-plane/tasks')) {
        return new Response(JSON.stringify({ available: true, upstreamStatus: 500, body: {} }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    renderWithQuery(<ControlPlaneTasks />)
    expect(await screen.findByText('控制面暂不可用；不会影响 Cezar 原生任务')).toBeTruthy()
  })

  it('renders live control-plane task state', async () => {
    renderWithQuery(<ControlPlaneTasks />)
    expect(await screen.findByText('修复控制面')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.getByText(/1 次执行/)).toBeTruthy()
  })

  it('renders pending approvals read-only through the same-origin proxy', async () => {
    const { requests } = stubFetch()
    renderWithQuery(<ControlPlaneApprovals />)
    expect(await screen.findByText('cezar.dispatch · execution_1')).toBeTruthy()
    expect(screen.getByText('只读：审批请通过微信或 operator 控制台完成，浏览器不执行决策。')).toBeTruthy()
    expect(requests.some((url) => url.startsWith('/api/v1/personal-ai-os/control-plane/approvals?decision=pending&limit=20'))).toBe(true)
    expect(requests.some((url) => url.includes('127.0.0.1:4324'))).toBe(false)
  })

  it('does not fetch the detail until a task is selected', async () => {
    const { requests } = stubFetch()
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    expect(requests.some((url) => url.includes('/completion-plan'))).toBe(false)
    expect(requests.some((url) => /\/tasks\/[^/?]+$/.test(url))).toBe(false)
  })

  it('lists executions with the eight-state Chinese labels, attempts and the review child marker', async () => {
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    expect(await screen.findByText('worker-a')).toBeTruthy()
    expect(screen.getByLabelText('执行状态：已成功')).toBeTruthy()
    expect(screen.getByLabelText('执行状态：复核中')).toBeTruthy()
    expect(screen.getByLabelText('执行状态：失败')).toBeTruthy()
    expect(screen.getByText('第 2 次')).toBeTruthy()
    expect(screen.getByText(/复核子执行 · 父执行 execution_1/)).toBeTruthy()
    expect(screen.getAllByText(/副本 artifact_ref_0123456789a…/).length).toBe(2)
    expect(screen.queryByText(ARTIFACT, { exact: false })).toBeNull()
    expect(screen.getByRole('region', { name: 'Execution 列表' })).toBeTruthy()
  })

  it('expands an execution to reveal its evidence with kind, exit code, verdict and a bounded summary', async () => {
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    await screen.findByText('worker-a')
    fireEvent.click(screen.getByRole('button', { name: '展开执行 execution_1 的证据' }))
    expect(screen.getByText('测试')).toBeTruthy()
    expect(screen.getByText('命令')).toBeTruthy()
    expect(screen.getByText('退出码 0')).toBeTruthy()
    expect(screen.getByText('退出码 1')).toBeTruthy()
    expect(screen.getAllByText('通过').length).toBeGreaterThan(0)
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0)
    expect(screen.getByText('node --test calculator 通过')).toBeTruthy()
    expect(screen.getByText(`${'验'.repeat(160)}…`)).toBeTruthy()
    expect(screen.queryByText(LONG_SUMMARY, { exact: false })).toBeNull()
  })

  it('shows the review child its own evidence when expanded', async () => {
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    await screen.findByText('worker-b')
    fireEvent.click(screen.getByRole('button', { name: '展开执行 execution_2 的证据' }))
    expect(screen.getByText('复核')).toBeTruthy()
    expect(screen.getByText('独立复核通过')).toBeTruthy()
  })

  it('reports an honest empty state when the task has no executions or evidence', async () => {
    stubFetch({ executions: [] })
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    expect(await screen.findByText('该任务暂无 Execution。')).toBeTruthy()
  })

  it('reports an execution with no evidence honestly when expanded', async () => {
    stubFetch({ executions: [{ id: 'execution_3', taskId: 'task_1', workerId: 'worker-c', status: 'failed', attempt: 2 }] })
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    await screen.findByText('worker-c')
    fireEvent.click(screen.getByRole('button', { name: '展开执行 execution_3 的证据' }))
    expect(screen.getByText('该执行暂无证据。')).toBeTruthy()
  })

  it('lists every unmet completion reason and truncates the parameters digest', async () => {
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    expect(await screen.findByText('所有 Execution 必须先进入终态')).toBeTruthy()
    expect(screen.getByText('worker execution_1 缺少独立 reviewer 的 passed review Evidence')).toBeTruthy()
    expect(screen.getByRole('region', { name: '完成验收条件' })).toBeTruthy()
    expect(screen.getByText(/参数摘要 sha256:0123456789abcdef012345678…/)).toBeTruthy()
    expect(screen.queryByText(DIGEST, { exact: false })).toBeNull()
  })

  it('states the fixed acceptance condition when ready without any completion call-to-action', async () => {
    stubFetch({ plan: planReady })
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    expect(await screen.findByText(/满足固定验收条件/)).toBeTruthy()
    expect(screen.queryByText('所有 Execution 必须先进入终态')).toBeNull()
    expect(screen.queryByRole('button', { name: /完成/ })).toBeNull()
  })

  it('shows an unreachable notice with a retry and never fabricates executions when the detail fails', async () => {
    stubFetch({ dStatus: 500, planStatus: 500 })
    renderWithQuery(<ControlPlaneTasks />)
    await screen.findByText('修复控制面')
    selectTask()
    expect(await screen.findByText(/控制面暂不可达，无法读取该任务的执行详情/)).toBeTruthy()
    expect(await screen.findByText(/完成条件暂不可达/)).toBeTruthy()
    expect(screen.queryByText('worker-a')).toBeNull()
    expect(screen.getAllByRole('button', { name: /重试/ }).length).toBe(2)
  })

  // AUI3-F003: the browser no longer carries an approval decision path. The card is
  // read-only; buttons named 拒绝/批准 must not exist at all.
  it('exposes no approval decision buttons — the card is browser read-only', async () => {
    renderWithQuery(<ControlPlaneApprovals />)
    expect(await screen.findByText('cezar.dispatch · execution_1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '拒绝 cezar.dispatch · execution_1' })).toBeNull()
    expect(screen.queryByRole('button', { name: '批准 cezar.dispatch · execution_1' })).toBeNull()
  })

  // i18n en: every module renders the English source strings verbatim.
  it('renders English source strings under locale=en', async () => {
    window.localStorage.setItem('cez-locale', 'en')
    renderWithQuery(<ControlPlaneTasks />)
    expect(await screen.findByText('修复控制面')).toBeTruthy()
    expect(screen.getByText('Control-plane tasks')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show execution details for task task_1' }))
    expect(await screen.findByText('worker-a')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show evidence for execution execution_1' })).toBeTruthy()
  })

  it('shows the approvals card read-only under locale=en', async () => {
    window.localStorage.setItem('cez-locale', 'en')
    renderWithQuery(<ControlPlaneApprovals />)
    expect(await screen.findByText('cezar.dispatch · execution_1')).toBeTruthy()
    expect(screen.getByText('Read-only: decisions are made through WeChat or the operator console, not from the browser.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reject cezar.dispatch · execution_1' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve cezar.dispatch · execution_1' })).toBeNull()
  })
})
