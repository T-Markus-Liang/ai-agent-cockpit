import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/components/locale-provider'
import { WeChatSection } from './wechat-section'

// Localized settings card: English source strings + a zh-CN table (see locale-provider). Force
// zh-CN so the wording here matches what the card renders today; `locale=en` has its own case.
beforeEach(() => { window.localStorage.setItem('cez-locale', 'zh-CN') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

type Stub = { body?: unknown; postBody?: unknown; fail?: boolean }
function stubWechat({ body, postBody, fail = false }: Stub) {
  const requests: Array<{ url: string; method: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? 'GET' })
    if (fail) throw new Error('boom')
    if ((init?.method ?? 'GET') === 'POST') return Response.json(postBody ?? body)
    return Response.json({ available: true, upstreamStatus: 200, body })
  }))
  return { requests }
}

function renderSection(stub: Stub) {
  const { requests } = stubWechat(stub)
  render(<LocaleProvider><WeChatSection /></LocaleProvider>)
  return { requests }
}

it('renders the WeChat connection card in Chinese under locale=zh-CN', async () => {
  renderSection({ body: { status: 'disconnected' } })
  expect(await screen.findByText('点击生成二维码，用微信扫码并确认登录。')).toBeTruthy()
  expect(screen.getByText('微信连接')).toBeTruthy()
  expect(screen.getByText('通过本机微信桥接器接收任务和发送 Agent 回复。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '生成微信二维码' })).toBeTruthy()
  expect(screen.getByText('二维码和登录令牌只在本机回环服务处理，不会提交到 Git 仓库。')).toBeTruthy()
})

it('reads status through the same-origin proxy and never GETs the loopback control port', async () => {
  const { requests } = renderSection({ body: { status: 'disconnected' } })
  await screen.findByText('点击生成二维码，用微信扫码并确认登录。')
  const reads = requests.filter((item) => item.method === 'GET')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every((item) => item.url.startsWith('/api/v1/personal-ai-os/wechat/status'))).toBe(true)
  expect(reads.some((item) => item.url.includes('127.0.0.1:4322'))).toBe(false)
})

it('shows the connected bot id in Chinese', async () => {
  renderSection({ body: { status: 'connected', botId: 'bot_abc' } })
  expect(await screen.findByText('已连接 · bot_abc')).toBeTruthy()
})

it('shows the scanned prompt in Chinese', async () => {
  renderSection({ body: { status: 'scanned' } })
  expect(await screen.findByText('已扫码，请在微信中确认登录。')).toBeTruthy()
})

it('localizes the login QR iframe title', async () => {
  renderSection({ body: { status: 'pending', qrUrl: 'http://127.0.0.1:4322/qr.png' } })
  expect(await screen.findByTitle('微信登录二维码')).toBeTruthy()
})

it('starts the QR flow through the explicit POST write on the control service', async () => {
  const { requests } = renderSection({ postBody: { status: 'pending', qrUrl: 'http://127.0.0.1:4322/qr.png' }, body: { status: 'disconnected' } })
  await screen.findByText('点击生成二维码，用微信扫码并确认登录。')
  fireEvent.click(screen.getByRole('button', { name: '生成微信二维码' }))
  expect(await screen.findByTitle('微信登录二维码')).toBeTruthy()
  const writes = requests.filter((item) => item.method === 'POST')
  expect(writes).toEqual([{ url: 'http://127.0.0.1:4322/api/wechat/qr', method: 'POST' }])
})

it('reports an unreachable control service in Chinese', async () => {
  renderSection({ body: undefined, fail: true })
  expect(await screen.findByText(/微信控制服务不可用：/)).toBeTruthy()
})

it('renders the English source strings under locale=en', async () => {
  window.localStorage.setItem('cez-locale', 'en')
  renderSection({ body: { status: 'pending', qrUrl: 'http://127.0.0.1:4322/qr.png' } })
  expect(await screen.findByText('Click to generate a QR code, then scan it in WeChat and confirm the login.')).toBeTruthy()
  expect(screen.getByText('WeChat connection')).toBeTruthy()
  expect(screen.getByText('Receive tasks and send Agent replies through the local WeChat bridge.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Generate WeChat QR code' })).toBeTruthy()
  expect(screen.getByTitle('WeChat login QR code')).toBeTruthy()
  expect(screen.getByText('The QR code and login token are handled only by the local loopback service, and are never committed to the Git repository.')).toBeTruthy()
})
