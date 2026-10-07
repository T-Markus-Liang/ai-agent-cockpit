import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContinuousGoals } from './continuous-goals'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const goal = { id: 'goal_test', specDigest: 'sha256:scope', status: 'draft', iterations: 0, tokensUsed: 0, workspaceDir: '/private/work', spec: { title: '测试目标', objective: 'repair add', sourceDir: '/source', readPaths: ['app.mjs', 'check.test.mjs'], writePaths: ['app.mjs'], checks: [{ name: 'test', args: ['--test', 'check.test.mjs'] }], limits: { maxTokens: 80000, maxIterations: 10 } } }
function setup(status = 'draft', extra: Record<string, unknown> = {}) {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith('/api/bootstrap')) return Response.json({ token: 'synthetic-test' })
    if (init?.method === 'POST') return Response.json({ goal: { ...goal, status: 'ready' } })
    return Response.json({ goals: [{ ...goal, status, ...extra }] })
  }))
  render(<QueryClientProvider client={client}><ContinuousGoals /></QueryClientProvider>)
  return { client, requests }
}
it('shows scope and confirms the exact digest once', async () => {
  const { client, requests } = setup()
  await screen.findByText('测试目标')
  fireEvent.click(screen.getByRole('button', { name: '确认范围并启动' }))
  await waitFor(() => expect(requests.find(x => x.url.endsWith('/grant'))?.body).toEqual({ digest: goal.specDigest }))
  expect(screen.getByText(/不会自动覆盖原项目/)).toBeTruthy(); client.clear()
})
it('provides pause without asking for a per-iteration approval', async () => {
  const { client, requests } = setup('running')
  await screen.findByText('测试目标'); fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  await waitFor(() => expect(requests.some(x => x.url.endsWith('/pause'))).toBe(true)); client.clear()
})
it('creates a draft with immutable checks rather than running immediately', async () => {
  const { client, requests } = setup()
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
  expect(await screen.findByText(/持续目标服务暂不可用/)).toBeTruthy(); client.clear()
})
it('shows explicit recovery limits and the observed resume count', async () => {
  const { client } = setup('running', { recoveryCount: 1, spec: { ...goal.spec, recovery: { enabled: true, maxAttempts: 3 } } })
  expect(await screen.findByText(/中断自恢复：已接续 1 \/ 3 次/)).toBeTruthy(); client.clear()
})
