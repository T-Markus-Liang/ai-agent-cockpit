import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { SystemConnections } from './system-connections'

vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { checks: [] } }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderConnections(memoryStatus: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('4324')) return Response.json({
      capabilities: [{ provider: 'kimi', status: 'ready' }, { provider: 'codex', status: 'ready' }],
      conversation: { provider: 'kimi' },
      services: { memory: { status: memoryStatus, engine: 'mem0-oss', ingestion: { pending: 2, retrying: 1 } } },
    })
    return Response.json({ status: url.includes('4322') ? 'connected' : 'ok' })
  }))
  const result = render(<QueryClientProvider client={client}><MemoryRouter><SystemConnections /></MemoryRouter></QueryClientProvider>)
  return { ...result, client }
}

it('shows the configured Kimi primary and real shared-memory queue instead of hardcoded Codex', async () => {
  const { client } = renderConnections('ready')
  await screen.findByText('本地存储 · 待提炼 2 · 重试 1')
  const kimi = screen.getByText('Kimi CLI').closest('.bg-card-2')!
  const codex = screen.getByText('Codex', { exact: true }).closest('.bg-card-2')!
  expect(within(kimi as HTMLElement).getByText(/微信主 Agent/)).toBeTruthy()
  expect(within(codex as HTMLElement).queryByText(/微信主 Agent/)).toBeNull()
  expect(screen.getByRole('link', { name: '微信已连接' }).getAttribute('href')).toBe('/settings/global/wechat')
  client.clear()
})

it('shows memory outage honestly and explains the local-context fallback', async () => {
  const { client } = renderConnections('unavailable')
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
  const memory = screen.getByText('Mem0 共享记忆').closest('.bg-card-2')!
  expect(within(memory as HTMLElement).getByText('不可用')).toBeTruthy()
  expect(within(memory as HTMLElement).getByText(/微信继续使用本地上下文/)).toBeTruthy()
  client.clear()
})
