import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GoalAI } from '../control-plane/goal-ai.mjs'
test('Kimi returns structured decisions, disables thinking and accounts for usage', async () => {
  let payload, reserved, counted
  const ai = new GoalAI({ fetcher: async (_url, init) => { payload = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: '{"instruction":"fix","reason":"failing test"}' } }], usage: { total_tokens: 123 } }) } })
  const result = await ai.call('planner', {}, { reserve: async n => { reserved = n }, reconcile: async (r, actual) => { counted = actual; assert.equal(r, reserved) } })
  assert.equal(result.identity, 'kimi/planner'); assert.equal(counted, 123)
  assert.equal(payload.thinking.type, 'disabled'); assert.equal(payload.top_p, .95)
})
test('worker falls back to loopback shim when the official version check fails, identity honest', async () => {
  const urls = []
  const ai = new GoalAI({ credentialFile: 'missing-file', fetcher: async (url) => {
    urls.push(url)
    if (url.includes('api-docs')) return new Response('<table><tr><td>MODEL</td><td>wrong</td></tr></table>')
    return Response.json({ choices: [{ message: { content: '{"files":[]}' } }], usage: { total_tokens: 20 } })
  } })
  const result = await ai.call('worker', {})
  assert.equal(result.identity, 'kimi/loopback-shim(worker-fallback)')
  assert.ok(urls.at(-1).includes('127.0.0.1:4323'), 'fallback must hit the loopback shim, never the official endpoint again')
})
test('worker falls back to loopback shim when official inference refuses (HTTP 402 quota)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-ai-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, 'synthetic.yaml'); await fs.writeFile(credentialFile, 'DEEPSEEK_API_KEY: synthetic-test-secret')
  const urls = []
  const ai = new GoalAI({ credentialFile, fetcher: async (url) => {
    urls.push(url)
    if (url.includes('api-docs')) return new Response('<table><tr><td>MODEL</td><td>deepseek-flash(1)</td></tr><tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash</td></tr></table>')
    if (url.includes('api.deepseek.com')) return new Response('quota exhausted', { status: 402 })
    return Response.json({ choices: [{ message: { content: '{"files":[]}' } }], usage: { total_tokens: 20 } })
  } })
  const result = await ai.call('worker', {})
  assert.equal(result.identity, 'kimi/loopback-shim(worker-fallback)')
  assert.ok(urls.some(u => u.includes('api.deepseek.com')), 'official endpoint must be attempted first')
  assert.ok(urls.at(-1).includes('127.0.0.1:4323'))
})
test('official worker uses only verified direct DeepSeek and never sends the key as model state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-ai-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const credentialFile = path.join(dir, 'synthetic.yaml'); await fs.writeFile(credentialFile, 'DEEPSEEK_API_KEY: synthetic-test-secret')
  const requests = []
  const ai = new GoalAI({ credentialFile, fetcher: async (url, init) => {
    requests.push({ url, init })
    if (url.includes('api-docs')) return new Response('<table><tr><td>MODEL</td><td>deepseek-flash(1)</td></tr><tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash</td></tr></table>')
    return Response.json({ choices: [{ message: { content: '{"files":[]}' } }], usage: { total_tokens: 20 } })
  } })
  const result = await ai.call('worker', {})
  assert.equal(result.identity, 'deepseek-official/deepseek-flash')
  assert.equal(requests[1].url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(requests[1].init.body.includes('synthetic-test-secret'), false)
})
test('missing usage, malformed JSON and HTTP failures fail closed with redacted errors', async () => {
  for (const response of [Response.json({ choices: [{ message: { content: '{}' } }] }), Response.json({ choices: [{ message: { content: 'bad' } }], usage: { total_tokens: 3 } }), new Response('private-key-body', { status: 503 })]) {
    const ai = new GoalAI({ fetcher: async () => response })
    await assert.rejects(ai.call('reviewer', {}), error => !error.message.includes('private-key-body'))
  }
})
