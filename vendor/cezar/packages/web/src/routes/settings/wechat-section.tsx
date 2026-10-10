import { CheckCircle2Icon, MessageCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { fill, useLocale } from '@/components/locale-provider'

// AUI-03: the status READ goes through the same-origin proxy, so the browser never
// polls 127.0.0.1:4322 directly. The QR/bridge WRITE path stays on the loopback
// control service for now (step 6 of the minimal order: no new browser-reachable
// write surface until its identity/CSRF contract lands); it answers to the
// first-party origin only because the service tightened its CORS allowlist to the
// cockpit origin.
const CONTROL_URL = import.meta.env.VITE_WECHAT_CONTROL_URL || 'http://127.0.0.1:4322'
const STATUS_PROXY_URL = '/api/v1/personal-ai-os/wechat/status'
type WeChatState = { status: 'connected' | 'disconnected' | 'pending' | 'scanned' | 'expired' | 'error'; qrUrl?: string; botId?: string; error?: string }

async function readStatus(): Promise<WeChatState> {
  const response = await fetch(STATUS_PROXY_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json() as { available?: boolean; body?: WeChatState; upstreamStatus?: number }
  if (envelope.available !== true) throw new Error('wechat control unavailable')
  if (typeof envelope.upstreamStatus === 'number' && envelope.upstreamStatus >= 400) {
    throw new Error(`upstream HTTP ${envelope.upstreamStatus}`)
  }
  return envelope.body ?? { status: 'disconnected' }
}

export function WeChatSection() {
  const { t } = useLocale()
  const [state, setState] = useState<WeChatState>({ status: 'disconnected' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setState(await readStatus())
    } catch (error) {
      // One whole `fill()` template, not a translated fragment glued to the raw error: the
      // Chinese carries its own `：` and word order (see locale-provider).
      setState({ status: 'error', error: fill(t('WeChat control service is unavailable: {error}'), { error: String(error) }) })
    }
  }, [t])

  // Explicit write (AUI3-F002 split): only POST may advance the QR lifecycle or
  // start the bridge; the GET proxy read above is side-effect-free.
  const advance = useCallback(async () => {
    try {
      const response = await fetch(`${CONTROL_URL}/api/wechat/qr`, { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState(await response.json() as WeChatState)
    } catch (error) {
      setState({ status: 'error', error: String(error) })
    }
  }, [])

  const connected = state.status === 'connected'
  const flowActive = state.status === 'pending' || state.status === 'scanned'

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // While a QR flow is in flight the write endpoint advances it (pending →
    // scanned → connected); once connected the pure read keeps the card fresh.
    if (flowActive) {
      const timer = window.setInterval(() => void advance(), 2000)
      return () => window.clearInterval(timer)
    }
    if (connected) {
      const timer = window.setInterval(() => void refresh(), 2000)
      return () => window.clearInterval(timer)
    }
    return undefined
  }, [flowActive, connected, advance, refresh])

  async function generateQr() {
    setBusy(true)
    try {
      await advance()
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6" data-slot="wechat-settings">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MessageCircleIcon className="size-4" aria-hidden="true" /> {t('WeChat connection')}</CardTitle>
          <CardDescription>{t('Receive tasks and send Agent replies through the local WeChat bridge.')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {connected ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
              <CheckCircle2Icon className="size-4 text-emerald-500" aria-hidden="true" /> {t('Connected')}{state.botId ? ` · ${state.botId}` : ''}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t('Click to generate a QR code, then scan it in WeChat and confirm the login.')}</p>
              <Button type="button" onClick={() => void generateQr()} disabled={busy} className="w-fit">
                <RefreshCwIcon className="mr-2 size-4" aria-hidden="true" />{busy ? t('Generating…') : t('Generate WeChat QR code')}
              </Button>
              {state.qrUrl ? (
                <iframe title={t('WeChat login QR code')} src={state.qrUrl} className="h-80 w-full max-w-sm rounded-md border border-border bg-card" />
              ) : null}
              {state.status === 'scanned' ? <p className="text-sm text-warning">{t('Scanned; confirm the login in WeChat.')}</p> : null}
            </div>
          )}
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <p className="text-xs text-muted-foreground">{t('The QR code and login token are handled only by the local loopback service, and are never committed to the Git repository.')}</p>
        </CardContent>
      </Card>
    </div>
  )
}
