#!/usr/bin/env node
import http from 'node:http'
import { indexLocalSessions } from '../control-plane/session-index.mjs'

const PORT = Number(process.env.CONTROL_PLANE_PORT ?? 4324)
let cache = null
let cacheAt = 0

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function snapshot(query) {
  const providers = query.get('provider')?.split(',').map((value) => value.trim()).filter(Boolean)
  const limit = query.get('limit') ? Number(query.get('limit')) : undefined
  const key = JSON.stringify({ providers, limit })
  if (cache && Date.now() - cacheAt < 30_000 && cache.key === key) return cache.value
  const value = await indexLocalSessions({ providers, limit })
  cache = { key, value }
  cacheAt = Date.now()
  return value
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { status: 'ok', service: 'personal-ai-os-control-plane', readOnly: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/sessions') {
      return send(res, 200, await snapshot(url.searchParams))
    }
    if (req.method === 'GET' && url.pathname === '/api/control-plane/sources') {
      return send(res, 200, (await snapshot(url.searchParams)).sources)
    }
    return send(res, 404, { error: 'not found' })
  } catch (error) {
    return send(res, 500, { error: String(error) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[control-plane] read-only session index at http://127.0.0.1:${PORT}`)
})

