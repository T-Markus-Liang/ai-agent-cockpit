#!/usr/bin/env node
import { spawn } from 'node:child_process'

async function get(url) {
  try {
    const response = await fetch(url)
    const text = await response.text()
    return { ok: response.ok, status: response.status, body: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

function runEval() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['evals/control-plane-regression.mjs'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => {
      try { resolve({ ok: code === 0, report: JSON.parse(stdout) }) } catch { resolve({ ok: false, error: stderr || stdout }) }
    })
  })
}

const [cezar, wechat, controlPlane, capabilities] = await Promise.all([
  get('http://127.0.0.1:4321/api/v1/health'),
  get('http://127.0.0.1:4322/api/wechat/status'),
  get('http://127.0.0.1:4324/health'),
  get('http://127.0.0.1:4324/api/control-plane/capabilities'),
])
const evaluation = await runEval()
const report = {
  type: 'PersonalAiOsDoctorReport',
  ok: cezar.ok && wechat.ok && controlPlane.ok && capabilities.ok && evaluation.ok,
  services: { cezar, wechat, controlPlane },
  capabilities: capabilities.body?.capabilities?.map((item) => ({ agentId: item.agentId, provider: item.provider, status: item.status })) ?? [],
  evaluation: evaluation.report ?? evaluation,
  checkedAt: new Date().toISOString(),
}
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1

