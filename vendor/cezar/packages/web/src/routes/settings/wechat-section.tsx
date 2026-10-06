import { CheckCircle2Icon, MessageCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const CONTROL_URL = import.meta.env.VITE_WECHAT_CONTROL_URL || 'http://127.0.0.1:4322'
type WeChatState = { status: 'connected' | 'disconnected' | 'pending' | 'scanned' | 'expired' | 'error'; qrUrl?: string; botId?: string; error?: string }

export function WeChatSection() {
  const [state, setState] = useState<WeChatState>({ status: 'disconnected' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${CONTROL_URL}/api/wechat/status`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState(await response.json() as WeChatState)
    } catch (error) {
      setState({ status: 'error', error: `微信控制服务不可用：${String(error)}` })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function generateQr() {
    setBusy(true)
    try {
      const response = await fetch(`${CONTROL_URL}/api/wechat/qr`, { method: 'POST' })
      const next = await response.json() as WeChatState
      setState(next)
    } catch (error) {
      setState({ status: 'error', error: String(error) })
    } finally { setBusy(false) }
  }

  const connected = state.status === 'connected'
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6" data-slot="wechat-settings">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MessageCircleIcon className="size-4" /> 微信连接</CardTitle>
          <CardDescription>通过本机微信桥接器接收任务和发送 Agent 回复。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {connected ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
              <CheckCircle2Icon className="size-4 text-emerald-500" /> 已连接{state.botId ? ` · ${state.botId}` : ''}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">点击生成二维码，用微信扫码并确认登录。</p>
              <Button type="button" onClick={() => void generateQr()} disabled={busy} className="w-fit">
                <RefreshCwIcon className="mr-2 size-4" />{busy ? '生成中…' : '生成微信二维码'}
              </Button>
              {state.qrUrl ? (
                <iframe title="微信登录二维码" src={state.qrUrl} className="h-80 w-full max-w-sm rounded-md border border-border bg-card" />
              ) : null}
              {state.status === 'scanned' ? <p className="text-sm text-warning">已扫码，请在微信中确认登录。</p> : null}
            </div>
          )}
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <p className="text-xs text-muted-foreground">二维码和登录令牌只在本机回环服务处理，不会提交到 Git 仓库。</p>
        </CardContent>
      </Card>
    </div>
  )
}
