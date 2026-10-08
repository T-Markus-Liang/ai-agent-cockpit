import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContinuousGoals } from './continuous-goals'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const TEST_CREDENTIAL = 'A'.repeat(43)
const goal = { id: 'goal_test', specDigest: 'sha256:scope', status: 'draft', iterations: 0, tokensUsed: 0, workspaceDir: '/private/work', spec: { title: '测试目标', objective: 'repair add', sourceDir: '/source', readPaths: ['app.mjs', 'check.test.mjs'], writePaths: ['app.mjs'], checks: [{ name: 'test', args: ['--test', 'check.test.mjs'] }], limits: { maxTokens: 80000, maxIterations: 10 } } }
type Recorded = { url: string; method?: string; headers?: Record<string, string>; body?: Record<string, unknown> }
function setup(status = 'draft', extra: Record<string, unknown> = {}) {
  const requests: Recorded[] = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (String(url).includes('/api/bootstrap')) return Response.json({ token: 'leaked-bootstrap-token' })
    if (init?.method === 'POST') return Response.json({ goal: { ...goal, status: 'ready' } })
    return Response.json({ goals: [{ ...goal, status, ...extra }] })
  }))
  const view = render(<QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider>)
  return { client, requests, view }
}
function connect() {
  fireEvent.change(screen.getByLabelText('访问凭据'), { target: { value: TEST_CREDENTIAL } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
}
it('does not touch the network before a credential is connected', async () => {
  const { client, requests } = setup()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(requests.length).toBe(0)
  expect(screen.getByRole('status').textContent).toContain('未连接'); client.clear()
})
it('never calls the retired bootstrap endpoint', async () => {
  const { client, requests } = setup()
  connect()
  await screen.findByText('测试目标')
  expect(requests.some(item => item.url.includes('/api/bootstrap'))).toBe(false); client.clear()
})
it('sends the credential only in the Authorization header, never URL or body', async () => {
  const { client, requests } = setup()
  connect()
  await screen.findByText('测试目标')
  const first = requests[0]
  expect(first).toBeDefined()
  if (!first) throw new Error('synthetic request was not made')
  expect(new Headers(first.headers).get('Authorization')).toBe(`Bearer ${TEST_CREDENTIAL}`)
  expect(first.url.includes(TEST_CREDENTIAL)).toBe(false)
  expect(JSON.stringify(first.body ?? {})).not.toContain(TEST_CREDENTIAL); client.clear()
})
it('clears cached goals and stops access after disconnect', async () => {
  const { client, requests } = setup()
  connect()
  await screen.findByText('测试目标')
  fireEvent.click(screen.getByRole('button', { name: '断开连接' }))
  expect(screen.queryByText('测试目标')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('未连接')
  const before = requests.length
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(requests.length).toBe(before); client.clear()
})
it('shows scope and confirms the exact digest once', async () => {
  const { client, requests } = setup()
  connect()
  await screen.findByText('测试目标')
  fireEvent.click(screen.getByRole('button', { name: '确认范围并启动' }))
  await waitFor(() => expect(requests.find(x => x.url.endsWith('/grant'))?.body).toEqual({ digest: goal.specDigest }))
  expect(screen.getByText(/不会自动覆盖原项目/)).toBeTruthy(); client.clear()
})
it('provides pause without asking for a per-iteration approval', async () => {
  const { client, requests } = setup('running')
  connect()
  await screen.findByText('测试目标'); fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  await waitFor(() => expect(requests.some(x => x.url.endsWith('/pause'))).toBe(true)); client.clear()
})
it('creates a draft with immutable checks rather than running immediately', async () => {
  const { client, requests } = setup()
  connect()
  await screen.findByText('测试目标')
  fireEvent.click(screen.getByRole('button', { name: '新建持续目标' }))
  fireEvent.click(screen.getByRole('button', { name: '创建草稿，先查看范围' }))
  await waitFor(() => expect(requests.some(x => x.url.endsWith('/api/goals') && x.body?.checks)).toBe(true))
  const body = requests.find(x => x.body?.checks)?.body
  expect(body?.writePaths).toEqual(['calculator.mjs']); client.clear()
})
it('reports unavailable goal service without pretending it is running', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })))
  render(<QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider>)
  connect()
  expect(await screen.findByText(/持续目标服务暂不可用/)).toBeTruthy(); client.clear()
})
it('shows authentication failure distinctly from service unavailability', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })))
  render(<QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider>)
  connect()
  expect(await screen.findByText(/目标服务认证失败/)).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('认证失败')
  expect(screen.queryByText('已连接')).toBeNull()
  expect(screen.queryByText(/持续目标服务暂不可用/)).toBeNull(); client.clear()
})
it('shows explicit recovery limits and the observed resume count', async () => {
  const { client } = setup('running', { recoveryCount: 1, spec: { ...goal.spec, recovery: { enabled: true, maxAttempts: 3 } } })
  connect()
  expect(await screen.findByText(/中断自恢复：已接续 1 \/ 3 次/)).toBeTruthy(); client.clear()
})

it('rejects malformed credentials without any request or storage writes', async () => {
  const { client, requests } = setup()
  const local = vi.spyOn(Storage.prototype, 'setItem')
  fireEvent.change(screen.getByLabelText('访问凭据'), { target: { value: 'invalid' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  expect(screen.getByRole('alert').textContent).toContain('访问凭据无效')
  expect(requests.length).toBe(0); expect(local).not.toHaveBeenCalled()
  local.mockRestore(); client.clear()
})

it('unmount cancels requests and clears all instance query data before another mount', async () => {
  const { client, requests, view } = setup()
  connect(); await screen.findByText('测试目标')
  expect(client.getQueryCache().findAll({ queryKey: ['continuous-goals'] }).length).toBe(1)
  view.unmount()
  expect(client.getQueryCache().findAll({ queryKey: ['continuous-goals'] }).length).toBe(0)
  const count = requests.length
  render(<QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider>)
  expect(screen.queryByText('测试目标')).toBeNull()
  await new Promise(resolve => setTimeout(resolve, 20)); expect(requests.length).toBe(count)
  client.clear()
})

it('changing credentials uses a new header and never shows the previous connection data', async () => {
  const { client, requests } = setup()
  connect(); await screen.findByText('测试目标')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers as Record<string, string> })
    return Response.json({ goals: [] })
  }))
  const next = 'B'.repeat(43)
  fireEvent.change(screen.getByLabelText('访问凭据'), { target: { value: next } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  expect(screen.queryByText('测试目标')).toBeNull()
  await screen.findByText(/暂无持续目标/)
  expect(new Headers(requests.at(-1)?.headers).get('Authorization')).toBe(`Bearer ${next}`)
  client.clear()
})

it('shows a relative next-check badge for a wake due within the hour', async () => {
  const { client } = setup('ready', { nextWakeAt: Date.now() + 5 * 60000 })
  connect()
  await screen.findByText('测试目标')
  expect(screen.getByText('约 5 分钟后检查')).toBeTruthy()
  expect(screen.getByLabelText('下一检查：约 5 分钟后检查')).toBeTruthy()
  client.clear()
})

it('shows a clock-style next-check badge for a wake more than an hour away', async () => {
  const { client } = setup('ready', { nextWakeAt: Date.now() + 2 * 3600000 })
  connect()
  await screen.findByText('测试目标')
  expect(screen.getByText(/^\d{2}:\d{2} 检查$/)).toBeTruthy()
  expect(screen.getByLabelText(/^下一检查：\d{2}:\d{2} 检查$/)).toBeTruthy()
  client.clear()
})

it('labels an overdue wake as 待唤醒 for a goal that is not running', async () => {
  const { client } = setup('ready', { nextWakeAt: Date.now() - 60000 })
  connect()
  await screen.findByText('测试目标')
  expect(screen.getByText('待唤醒')).toBeTruthy()
  expect(screen.getByLabelText('下一检查：待唤醒')).toBeTruthy()
  client.clear()
})

it('omits the next-check badge for a running goal whose wake has already fired', async () => {
  const { client } = setup('running', { nextWakeAt: Date.now() - 60000 })
  connect()
  await screen.findByText('测试目标')
  expect(screen.queryByText('待唤醒')).toBeNull()
  expect(screen.queryByLabelText(/^下一检查/)).toBeNull()
  client.clear()
})

it('omits the next-check badge for a paused goal even when the wake time expired', async () => {
  const { client } = setup('paused', { nextWakeAt: Date.now() - 60000 })
  connect()
  await screen.findByText('测试目标')
  expect(screen.queryByText('待唤醒')).toBeNull()
  expect(screen.queryByLabelText(/^下一检查/)).toBeNull()
  client.clear()
})

it('omits the next-check badge when nextWakeAt is missing rather than inventing a schedule', async () => {
  const { client } = setup('ready')
  connect()
  await screen.findByText('测试目标')
  expect(screen.queryByLabelText(/^下一检查/)).toBeNull()
  expect(screen.queryByText('待唤醒')).toBeNull()
  client.clear()
})

it('shows a prominent 待恢复 badge when the goal needs recovery', async () => {
  const { client } = setup('waiting', { needsRecovery: true })
  connect()
  await screen.findByText('测试目标')
  expect(screen.getByText('待恢复')).toBeTruthy()
  expect(screen.getByLabelText('恢复状态：待恢复')).toBeTruthy()
  client.clear()
})

it('shows an automatic-recovery count badge and bounds the displayed reason', async () => {
  const longReason = 'r'.repeat(300)
  const { client } = setup('waiting', { recoveryCount: 2, needsRecovery: true, reason: longReason })
  connect()
  await screen.findByText('测试目标')
  expect(screen.getByText('已自动恢复 2 次')).toBeTruthy()
  expect(screen.getByLabelText('恢复状态：已自动恢复 2 次')).toBeTruthy()
  const shown = screen.getByText(`${'r'.repeat(160)}…`)
  expect(shown.getAttribute('title')).toBe(longReason)
  expect(screen.queryByText(longReason)).toBeNull()
  client.clear()
})

it('shows a short reason unchanged, without truncation', async () => {
  const { client } = setup('waiting', { reason: 'token 预算已耗尽' })
  connect()
  await screen.findByText('测试目标')
  expect(screen.getByText('token 预算已耗尽')).toBeTruthy()
  client.clear()
})

