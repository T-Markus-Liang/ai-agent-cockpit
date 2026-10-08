import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/components/locale-provider'
import { LocalAgentsSection } from './local-agents-section'

// Localized settings card: English source strings + a zh-CN table (see locale-provider). Force
// zh-CN so the wording here matches what the card renders today; the `locale=en` case below pins
// the English source strings and keeps the brand names.
beforeEach(() => { window.localStorage.setItem('cez-locale', 'zh-CN') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

function renderSection(payload: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)))
  const result = render(<LocaleProvider><QueryClientProvider client={client}><LocalAgentsSection /></QueryClientProvider></LocaleProvider>)
  return { ...result, client }
}

it('renders the local agent channels, the configured primary and the shared-memory queue', async () => {
  const { client } = renderSection({ capabilities: [{ provider: 'kimi', status: 'ready' }], conversation: { provider: 'kimi' }, services: { memory: { status: 'ready', ingestion: { pending: 3, retrying: 1 } } } })
  expect(screen.getByText('本机 Agent')).toBeTruthy()
  expect(screen.getByText('本机 Agent 通道、协议和可用状态。')).toBeTruthy()
  const kimi = screen.getByText('Kimi CLI').closest('.bg-card-2')!
  await within(kimi as HTMLElement).findByText(/微信主 Agent（配置）/)
  await screen.findByText('已连接 · 待提炼 3 · 重试 1')
  expect(screen.getByText('Mem0 共享记忆')).toBeTruthy()
  expect(screen.getByText('近期上下文、完整原文归档与跨模型长期语义记忆。')).toBeTruthy()
  client.clear()
})

it('shows the memory outage honestly and explains the local-context fallback', async () => {
  const { client } = renderSection({ services: { memory: { status: 'unavailable' } } })
  await screen.findByText('长期检索暂不可用；微信继续使用本地上下文')
  expect(screen.getByText('本地 Qdrant + SQLite；事实提炼使用已有 Kimi API，不是全离线推理。')).toBeTruthy()
  client.clear()
})

it('renders the English source strings under locale=en, keeping brand names', async () => {
  window.localStorage.setItem('cez-locale', 'en')
  const { client } = renderSection({ capabilities: [{ provider: 'kimi', status: 'ready' }], conversation: { provider: 'kimi' }, services: { memory: { status: 'ready', ingestion: { pending: 3, retrying: 1 } } } })
  expect(screen.getByText('Local agents')).toBeTruthy()
  expect(screen.getByText('Local agent channels, protocols and availability.')).toBeTruthy()
  expect(screen.getByText('Kimi CLI')).toBeTruthy()
  const kimi = screen.getByText('Kimi CLI').closest('.bg-card-2')!
  await within(kimi as HTMLElement).findByText(/WeChat primary agent \(configured\)/)
  await screen.findByText('Connected · 3 pending · 1 retrying')
  expect(screen.getByText('Shared Mem0 memory')).toBeTruthy()
  client.clear()
})

it('labels an unknown adapter as discovered rather than inventing readiness', async () => {
  const { client } = renderSection({})
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
  // GitHub Actions and Devin Cloud both ship an `unknown` default status with no live capability.
  expect(screen.getAllByText('已发现/待验证').length).toBe(2)
  client.clear()
})
