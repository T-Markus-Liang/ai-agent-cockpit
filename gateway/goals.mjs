#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { GoalStore, GoalError } from '../control-plane/goal-store.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { GoalRuntime } from '../control-plane/goal-runtime.mjs'
import { prepareWorkspace } from '../control-plane/goal-workspace.mjs'
import { createLiveRequestAuthority, AuthorityError } from '../control-plane/request-authority.mjs'

const ORIGINS = new Set(['http://127.0.0.1:4321', 'http://localhost:4321'])

// Role -> permitted action matrix (RR-F003). The role is taken from the
// authenticated principal (authority document), never from a request header.
// X-Goal-Actor keeps its owner-binding semantics only: a viewer that sends
// `X-Goal-Actor: local` is still read-only, because authorization on the role
// runs first and independently of the actor header.
//
//   viewer      read only
//   coordinator read + wake            (a scheduler nudge, no state transition)
//   chief       read + single-goal management (create/pause/resume/cancel/
//               revise/wake); NOT grant, NOT the global pause-all/resume-all
//   operator    everything, including grant and the global pause-all/resume-all
const ROLE_ACTIONS = Object.freeze({
  viewer: Object.freeze(['read']),
  coordinator: Object.freeze(['read', 'wake']),
  chief: Object.freeze(['read', 'create', 'pause', 'resume', 'cancel', 'revise', 'wake']),
  operator: Object.freeze(['read', 'create', 'pause', 'resume', 'cancel', 'revise', 'wake', 'grant', 'pause-all', 'resume-all']),
})

// Map a request to its authorization action. Returns undefined for routes or
// methods that are not part of the matrix, so unrecognised requests keep their
// existing NOT_FOUND / INVALID_METHOD handling rather than being denied here.
export function goalActionFor(method, pathname) {
  if (method === 'GET' && /^\/api\/goals(\/[^/]+(\/proof)?)?$/.test(pathname)) return 'read'
  if (method !== 'POST') return undefined
  if (pathname === '/api/goals/pause-all') return 'pause-all'
  if (pathname === '/api/goals/resume-all') return 'resume-all'
  if (pathname === '/api/goals') return 'create'
  const match = pathname.match(/^\/api\/goals\/[^/]+\/(grant|pause|resume|cancel|revise|wake)$/)
  return match ? match[1] : undefined
}

// Throws GoalError AUTH_FORBIDDEN (403) when the authenticated role may not
// perform the resolved action. Runs after authentication and before any
// owner/actor check or state mutation.
export function authorizeGoalRequest(principal, method, pathname) {
  const action = goalActionFor(method, pathname)
  if (action === undefined) return
  if (!ROLE_ACTIONS[principal?.role]?.includes(action)) {
    throw new GoalError('AUTH_FORBIDDEN', 'the authenticated role may not perform this goal action', 403)
  }
}

export async function createGoalServer({ stateDir, goals = new GoalStore({ stateDir }), tasks, runtime, wechatStateFile = path.join(os.homedir(), '.wechat-acp/instances/cezar-codex/state.json') } = {}) {
  const root = goals.stateDir
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.chmod(root, 0o700)
  // Per-client principal authentication (0.3.0 M02 / goals wave 1.6). The
  // authority document is produced out-of-band by identity-pairing's
  // exportPrincipals() and written atomically via writeAuthorityFile(); this
  // service only consumes it. It is revalidated on every request, so token
  // rotation, revocation and expiry take effect without a restart. A missing or
  // invalid configuration fails closed (AUTH_CONFIGURATION 500) rather than
  // falling back to any shared token.
  const authFile = process.env.GOALS_AUTH_FILE ?? path.join(root, 'authority.json')
  const authority = createLiveRequestAuthority({ file: authFile, required: true })
  const ownerFile = path.join(root, 'wechat-owner')
  let owner = await fs.readFile(ownerFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (!owner) {
    const state = await fs.readFile(wechatStateFile, 'utf8').then(JSON.parse).catch(() => ({}))
    if (state.lastActiveUserId && state.users?.[state.lastActiveUserId]) {
      owner = `wechat-${crypto.createHash('sha256').update(state.lastActiveUserId).digest('hex')}`
      await fs.writeFile(ownerFile, owner, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      owner = (await fs.readFile(ownerFile, 'utf8')).trim()
    }
  }
  owner = owner.trim()
  const evidenceStore = tasks ?? new ControlPlaneStore({ stateDir: path.join(root, 'task-proof') })
  const engine = runtime ?? new GoalRuntime({ goals, tasks: evidenceStore })
  const respond = (res, status, body, origin) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      ...(ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key,X-AI-OS-Client,X-Goal-Actor', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } : {}) })
    res.end(JSON.stringify(body))
  }
  const parse = async req => {
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new GoalError('BODY_TOO_LARGE', 'goal request exceeds 100 KiB', 413); chunks.push(chunk) }
    try { return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { throw new GoalError('INVALID_JSON', 'invalid JSON', 400) }
  }
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) throw new GoalError('INVALID_HOST', 'loopback host required', 403)
      if (origin && !ORIGINS.has(origin)) throw new GoalError('UNTRUSTED_ORIGIN', 'browser origin is not allowed', 403)
      if (req.method === 'OPTIONS') return respond(res, 200, {}, origin)
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/health') {
        const items = await goals.list()
        return respond(res, 200, { status: 'ok', service: 'personal-ai-os-goals', version: '0.3.0', active: engine.active.size,
          goalCount: items.length, sandbox: 'macOS-seatbelt', mode: 'isolated-proposal-workspace', wechatOwnerBound: Boolean(owner) }, origin)
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        throw new GoalError('BOOTSTRAP_RETIRED', 'bootstrap endpoint is retired', 410)
      }
      let principal
      try { principal = authority.authenticate(req.headers) }
      catch (error) {
        if (error instanceof AuthorityError) throw new GoalError(error.code, error.status === 401 ? 'goal API authentication required' : 'goal API authority configuration is invalid', error.status)
        throw error
      }
      if (principal?.authenticated !== true) throw new GoalError('AUTH_REQUIRED', 'goal API authentication required', 401)
      // Role authorization (RR-F003): independent of, and before, the owner/actor
      // binding below. A viewer (or a viewer claiming X-Goal-Actor: local) cannot
      // reach any write action, so no state transition can occur.
      authorizeGoalRequest(principal, req.method, url.pathname)
      const actor = req.headers['x-goal-actor'] ?? 'local'
      if (actor !== 'local' && (!owner || actor !== owner)) throw new GoalError('OWNER_REQUIRED', 'only the bound WeChat owner may manage goals', 403)
      if (req.method === 'GET' && url.pathname === '/api/goals') return respond(res, 200, { goals: await goals.list(), paused: await goals.isPaused(), version: '0.3.0' }, origin)
      if (req.method === 'POST' && ['/api/goals/pause-all', '/api/goals/resume-all'].includes(url.pathname)) {
        const action = url.pathname.endsWith('pause-all') ? 'pause' : 'resume'
        const result = await goals.controlAll(action)
        if (action === 'pause') { for (const id of engine.active.keys()) engine.abort(id); await Promise.allSettled([...engine.active.values()].map(item => item.job)) }
        else void engine.tick()
        return respond(res, 200, result, origin)
      }
      if (req.method === 'POST' && url.pathname === '/api/goals') {
        const goal = await goals.create(await parse(req), { idempotencyKey: req.headers['idempotency-key'], owner: owner || 'local' })
        if (goal.status === 'draft') {
          const prepared = await fs.readFile(path.join(goal.workspaceDir, '.prepared.json'), 'utf8').then(JSON.parse).catch(() => null)
          if (prepared?.specDigest !== goal.specDigest) await prepareWorkspace(goal)
        }
        return respond(res, 201, { goal }, origin)
      }
      const match = url.pathname.match(/^\/api\/goals\/([^/]+)(?:\/(grant|pause|resume|cancel|revise|wake|proof))?$/)
      if (!match) throw new GoalError('NOT_FOUND', 'goal route not found', 404)
      const id = decodeURIComponent(match[1]), action = match[2]
      const current = await goals.get(id)
      if (actor !== 'local' && current.owner !== actor) throw new GoalError('OWNER_REQUIRED', 'goal belongs to another operator', 403)
      if (req.method === 'GET' && !action) return respond(res, 200, { goal: current }, origin)
      if (req.method === 'GET' && action === 'proof') return respond(res, 200, { proof: current.taskId ? await evidenceStore.getTask(current.taskId).catch(error => { if (error.code === 'TASK_NOT_FOUND') return null; throw error }) : null }, origin)
      if (req.method !== 'POST') throw new GoalError('INVALID_METHOD', 'POST required', 405)
      const input = await parse(req)
      let goal
      if (action === 'grant') {
        const prepared = await fs.readFile(path.join(current.workspaceDir, '.prepared.json'), 'utf8').then(JSON.parse).catch(() => null)
        if (prepared?.specDigest !== current.specDigest) throw new GoalError('WORKSPACE_NOT_PREPARED', '工作副本尚未完整准备，不能启动', 409)
        goal = await goals.grant(id, { digest: input.digest, approvedBy: actor })
      } else if (action === 'revise') {
        engine.abort(id); goal = await goals.revise(id, input); await prepareWorkspace(goal)
      } else if (['pause', 'resume', 'cancel'].includes(action)) {
        goal = await goals.control(id, action); if (action !== 'resume') { engine.abort(id); await engine.active.get(id)?.job }
      } else if (action === 'wake') { await engine.tick(); goal = await goals.get(id) }
      else throw new GoalError('INVALID_ACTION', 'unsupported goal action', 400)
      if (['grant', 'resume'].includes(action)) void engine.tick()
      return respond(res, 200, { goal }, origin)
    } catch (error) { respond(res, error.status ?? 500, { error: error.code ?? 'GOAL_ERROR', message: error instanceof GoalError ? error.message : '目标操作失败，请检查本机范围或服务状态' }, origin) }
  })
  return { server, goals, engine, authFile, start: () => engine.start(), stop: () => engine.stop() }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = await createGoalServer({ stateDir: process.env.GOAL_STATE_DIR })
  app.server.listen(Number(process.env.GOAL_PORT ?? 4326), '127.0.0.1', async () => { await app.start(); console.log('[goals] Personal AI OS 0.2.0 scheduler on loopback') })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.stop(); app.server.close(() => process.exit(0)) })
}
