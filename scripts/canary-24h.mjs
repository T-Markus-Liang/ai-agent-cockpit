#!/usr/bin/env node
// 24h canary logger for the 0.3.0 local-test deployment (S06 precursor).
// Appends one JSON line per tick to logs/canary-24h.jsonl: wall clock, elapsed
// hours, per-service health. Suspend is detected at analysis time from tick
// gaps plus `pmset -g log` — sleep periods are never claimed as execution.
// The owner diary of physical events (lid, battery, network) lives in
// logs/canary-24h-diary.md. Started 2026-10-10 ~08:35 local.
import fs from 'node:fs'

const OUT = new URL('../logs/canary-24h.jsonl', import.meta.url).pathname
const START = Date.now()
const TICK_MS = 5 * 60 * 1000

async function health(port, path = '/health') {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
    return r.status
  } catch { return 'down' }
}

async function tick() {
  const line = {
    at: new Date().toISOString(),
    elapsedHours: Number(((Date.now() - START) / 3600000).toFixed(2)),
    goals: await health(4326),
    memory: await health(4325),
    controlPlane: await health(4324),
    wechatControl: (await health(4322, '/api/wechat/status')) === 200 ? 200 : 'down', // 无 /health 路由，探业务只读端点
    cezar: await health(4321, '/api/v1/health'),
  }
  fs.appendFileSync(OUT, JSON.stringify(line) + '\n')
}

await tick()
setInterval(tick, TICK_MS)
console.log('[canary] first tick appended; logging every', TICK_MS / 60000, 'min to', OUT)
