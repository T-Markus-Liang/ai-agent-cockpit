import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/components/locale-provider'
import { ContinuousGoals } from './continuous-goals'

// The card is read-only via the same-origin proxy (AUI-03): the browser never
// sees 127.0.0.1:4326, never holds a goal access token, and exposes no write
// surface. Force zh-CN so wording assertions check the Chinese render; `en` has
// its own case.
beforeEach(() => { window.localStorage.setItem('cez-locale', 'zh-CN') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

const goal = { id: 'goal_test', specDigest: 'sha256:scope', status: 'draft', iterations: 0, tokensUsed: 0, workspaceDir: '/private/work', spec: { title: '测试目标', objective: 'repair add', sourceDir: '/source', readPaths: ['app.mjs', 'check.test.mjs'], writePaths: ['app.mjs'], checks: [{ name: 'test', args: ['--test', 'check.test.mjs'] }], limits: { maxTokens: 80000, maxIterations: 10 } } }
type Recorded = { url: string; method?: string; headers?: Record<string, string> }
function setup(status = 'draft', extra: Record<string, unknown> = {}) {
  const requests: Recorded[] = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method, headers: init?.headers as Record<string, string> })
    return Response.json({ available: true, upstreamStatus: 200, body: { goals: [{ ...goal, status, ...extra }] } })
  }))
  const view = render(<LocaleProvider><QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider></LocaleProvider>)
  return { client, requests, view }
}

it('reads the goal list through the same-origin proxy without any credential', async () => {
  const { client, requests } = setup()
  expect(await screen.findByText('测试目标')).toBeTruthy()
  const reads = requests.filter((item) => item.method === undefined || item.method === 'GET')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every((item) => item.url.startsWith('/api/v1/personal-ai-os/goals'))).toBe(true)
  expect(requests.some((item) => item.url.includes('127.0.0.1:4326'))).toBe(false)
  expect(reads.every((item) => new Headers(item.headers).get('Authorization') === null)).toBe(true)
  client.clear()
})

it('exposes no token input and no write actions from the browser', async () => {
  const { client } = setup()
  expect(await screen.findByText('测试目标')).toBeTruthy()
  expect(screen.queryByLabelText('访问凭据')).toBeNull()
  expect(screen.queryByRole('button', { name: '连接' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新建持续目标' })).toBeNull()
  expect(screen.queryByRole('button', { name: '暂停' })).toBeNull()
  expect(screen.queryByRole('button', { name: '确认范围并启动' })).toBeNull()
  client.clear()
})

it('renders the read-only notice in Chinese', async () => {
  const { client } = setup()
  expect(await screen.findByText(/只读视图：浏览器不再持有 goal 访问 token/)).toBeTruthy()
  client.clear()
})

it('reports an unavailable goals service honestly through the envelope', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ available: false, reason: 'authority-unavailable' })))
  render(<LocaleProvider><QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider></LocaleProvider>)
  expect(await screen.findByText(/持续目标服务暂不可用/)).toBeTruthy()
  client.clear()
})

it('reports an upstream error through the envelope without fabricating goals', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ available: true, upstreamStatus: 500, body: {} })))
  render(<LocaleProvider><QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider></LocaleProvider>)
  expect(await screen.findByText(/持续目标服务暂不可用/)).toBeTruthy()
  expect(screen.queryByText('测试目标')).toBeNull()
  client.clear()
})

it('renders the empty state without promising creation from the browser', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ available: true, upstreamStatus: 200, body: { goals: [] } })))
  render(<LocaleProvider><QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider></LocaleProvider>)
  expect(await screen.findByText('暂无持续目标。')).toBeTruthy()
  client.clear()
})

it('shows explicit recovery limits and the observed resume count', async () => {
  const { client } = setup('running', { recoveryCount: 1, spec: { ...goal.spec, recovery: { enabled: true, maxAttempts: 3 } } })
  expect(await screen.findByText(/中断自恢复：已接续 1 \/ 3 次/)).toBeTruthy()
  client.clear()
})

it('shows a relative next-check badge for a wake due within the hour', async () => {
  const { client } = setup('ready', { nextWakeAt: Date.now() + 5 * 60000 })
  expect(await screen.findByText('约 5 分钟后检查')).toBeTruthy()
  expect(screen.getByLabelText('下一检查：约 5 分钟后检查')).toBeTruthy()
  client.clear()
})

it('shows a clock-style next-check badge for a wake more than an hour away', async () => {
  const { client } = setup('ready', { nextWakeAt: Date.now() + 2 * 3600000 })
  expect(await screen.findByText(/^\d{2}:\d{2} 检查$/)).toBeTruthy()
  expect(screen.getByLabelText(/^下一检查：\d{2}:\d{2} 检查$/)).toBeTruthy()
  client.clear()
})

it('labels an overdue wake as 待唤醒 for a goal that is not running', async () => {
  const { client } = setup('ready', { nextWakeAt: Date.now() - 60000 })
  expect(await screen.findByText('待唤醒')).toBeTruthy()
  expect(screen.getByLabelText('下一检查：待唤醒')).toBeTruthy()
  client.clear()
})

it('omits the next-check badge for a running goal whose wake has already fired', async () => {
  const { client } = setup('running', { nextWakeAt: Date.now() - 60000 })
  expect(await screen.findByText('测试目标')).toBeTruthy()
  expect(screen.queryByText('待唤醒')).toBeNull()
  expect(screen.queryByLabelText(/^下一检查/)).toBeNull()
  client.clear()
})

it('omits the next-check badge for a paused goal even when the wake time expired', async () => {
  const { client } = setup('paused', { nextWakeAt: Date.now() - 60000 })
  expect(await screen.findByText('测试目标')).toBeTruthy()
  expect(screen.queryByText('待唤醒')).toBeNull()
  expect(screen.queryByLabelText(/^下一检查/)).toBeNull()
  client.clear()
})

it('omits the next-check badge when nextWakeAt is missing rather than inventing a schedule', async () => {
  const { client } = setup('ready')
  expect(await screen.findByText('测试目标')).toBeTruthy()
  expect(screen.queryByLabelText(/^下一检查/)).toBeNull()
  expect(screen.queryByText('待唤醒')).toBeNull()
  client.clear()
})

it('shows a prominent 待恢复 badge when the goal needs recovery', async () => {
  const { client } = setup('waiting', { needsRecovery: true })
  expect(await screen.findByText('待恢复')).toBeTruthy()
  expect(screen.getByLabelText('恢复状态：待恢复')).toBeTruthy()
  client.clear()
})

it('shows an automatic-recovery count badge and bounds the displayed reason', async () => {
  const longReason = 'r'.repeat(300)
  const { client } = setup('waiting', { recoveryCount: 2, needsRecovery: true, reason: longReason })
  expect(await screen.findByText('已自动恢复 2 次')).toBeTruthy()
  expect(screen.getByLabelText('恢复状态：已自动恢复 2 次')).toBeTruthy()
  const shown = screen.getByText(`${'r'.repeat(160)}…`)
  expect(shown.getAttribute('title')).toBe(longReason)
  expect(screen.queryByText(longReason)).toBeNull()
  client.clear()
})

it('shows a short reason unchanged, without truncation', async () => {
  const { client } = setup('waiting', { reason: 'token 预算已耗尽' })
  expect(await screen.findByText('token 预算已耗尽')).toBeTruthy()
  client.clear()
})

it('keeps the scope and acceptance record expandable for spot-checking', async () => {
  const { client } = setup()
  expect(await screen.findByText('测试目标')).toBeTruthy()
  fireEvent.click(screen.getByText('抽查范围与验收记录'))
  expect(screen.getByText(/app\.mjs, check\.test\.mjs/)).toBeTruthy()
  client.clear()
})

// i18n: the card's source strings are English, mapped to the SAME Chinese under zh-CN. The two
// cases below pin both halves — an `en` render is the English source verbatim, a `zh-CN` render
// is the wording the card has always shown.
it('renders the English source strings under locale=en', async () => {
  window.localStorage.setItem('cez-locale', 'en')
  const { client } = setup()
  expect(await screen.findByText('Continuous goals · autonomous verification')).toBeTruthy()
  expect(screen.getByText(/Read-only view: the browser no longer holds a goal access token/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  expect(screen.queryByLabelText('Access credential')).toBeNull()
  client.clear()
})

it('renders the same Chinese wording under locale=zh-CN', async () => {
  const { client } = setup()
  expect(await screen.findByText('持续目标 · 自主验证')).toBeTruthy()
  expect(screen.getByText(/只读视图：浏览器不再持有 goal 访问 token/)).toBeTruthy()
  client.clear()
})

it('exposes aria-labels on the recovery badges', async () => {
  const { client } = setup('waiting', { needsRecovery: true, recoveryCount: 1 })
  expect(await screen.findByText('待恢复')).toBeTruthy()
  expect(screen.getByLabelText('恢复状态：待恢复')).toBeTruthy()
  expect(screen.getByLabelText('恢复状态：已自动恢复 1 次')).toBeTruthy()
  client.clear()
})
