#!/usr/bin/env node
import { indexLocalSessions } from '../control-plane/session-index.mjs'
import { ControlPlaneStore } from '../control-plane/store.mjs'
import { cezarCancelPlan, cezarDispatchPlan, cancelCezarExecution, dispatchCezar, reconcileCezarExecution } from '../control-plane/dispatcher.mjs'
import { listNativeAcpSessions } from '../control-plane/native-acp.mjs'
import { executeNativeSessionPrompt, nativePromptPlan } from '../control-plane/native-acp-executor.mjs'
import { createReviewerExecution } from '../control-plane/reviewer.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const store = new ControlPlaneStore()

function value(name, fallback = undefined) {
  const prefix = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? fallback : fallback
}

function listValue(name) {
  const entry = value(name)
  return entry ? entry.split(',').map((item) => item.trim()).filter(Boolean) : undefined
}

function required(name) {
  const entry = value(name)
  if (!entry) throw new Error(`缺少 --${name}=...`)
  return entry
}

function idempotency() {
  return required('idempotency')
}

function output(result) {
  if (json) return console.log(JSON.stringify(result, null, 2))
  if (Array.isArray(result)) return result.forEach((item) => console.log(JSON.stringify(item)))
  console.log(JSON.stringify(result, null, 2))
}

async function sessionsList() {
  const snapshot = await indexLocalSessions({
    providers: listValue('provider'),
    limit: value('limit') ? Number(value('limit')) : undefined,
  })
  if (value('cwd')) snapshot.sessions = snapshot.sessions.filter((session) => session.cwd === value('cwd'))
  if (json) return output(snapshot)
  console.log(`Personal AI OS session index · ${snapshot.scannedAt}`)
  console.log(`只读：${snapshot.privacy.readOnly ? '是' : '否'} · 未读取凭据：${snapshot.privacy.secretsRead ? '否' : '是'}`)
  for (const source of snapshot.sources) {
    const count = snapshot.sessions.filter((session) => session.source === source.provider).length
    console.log(`- ${source.label} (${source.provider}) · ${source.detected ? '已发现' : '未发现'} · ${count} 个可索引会话`)
    if (source.limitations.length) console.log(`  限制：${source.limitations.join('；')}`)
  }
  for (const session of snapshot.sessions.slice(0, 20)) console.log(`  ${session.source} · ${session.nativeSessionId} · ${session.title} · ${session.cwd}`)
}

async function main() {
  const command = args[0] ?? 'sessions'
  const subcommand = args[1] ?? 'list'
  if (command === 'sessions' && subcommand === 'list') return sessionsList()
  if (command === 'sessions' && subcommand === 'native-list') {
    return output(await listNativeAcpSessions({ source: value('provider', 'codex'), cwd: value('cwd', process.cwd()) }))
  }
  if (command === 'sessions' && subcommand === 'native-load-probe') {
    return output(await listNativeAcpSessions({ source: value('provider', 'codex'), cwd: value('cwd', process.cwd()), loadSessionId: required('session') }))
  }
  if (command === 'task' && subcommand === 'create') {
    return output(await store.createTask({
      id: value('id'),
      goal: required('goal'),
      chief: value('chief'),
      constraints: listValue('constraints'),
      acceptanceCriteria: listValue('acceptance'),
    }, { idempotencyKey: idempotency() }))
  }
  if (command === 'task' && subcommand === 'list') {
    return output(await store.listTasks({ status: value('status'), limit: value('limit') }))
  }
  if (command === 'task' && subcommand === 'show') return output(await store.getTask(required('id')))
  if (command === 'task' && subcommand === 'completion-plan') return output(await store.completionPlan(required('id')))
  if (command === 'task' && subcommand === 'complete') return output(await store.completeTask(required('id'), { approvalId: required('approval') }, { idempotencyKey: idempotency() }))
  if (command === 'audit' && subcommand === 'list') return output(await store.listEvents({ entityId: value('entity'), limit: value('limit') }))
  if (command === 'execution' && subcommand === 'create') {
    return output(await store.createExecution(required('task'), {
      id: value('id'),
      workerId: required('worker'),
      sessionRefId: value('session'),
      parentExecutionId: value('parent'),
      attempt: value('attempt') ? Number(value('attempt')) : undefined,
    }, { idempotencyKey: idempotency() }))
  }
  if (command === 'execution' && subcommand === 'status') {
    return output(await store.updateExecutionStatus(required('id'), { status: required('status'), outcome: value('outcome') }, { idempotencyKey: idempotency() }))
  }
  if (command === 'review' && subcommand === 'create') {
    return output(await createReviewerExecution({ store, taskId: required('task'), sourceExecutionId: required('source-execution'), reviewerId: required('reviewer'), sessionRefId: value('session'), idempotencyKey: idempotency() }))
  }
  if (command === 'native' && subcommand === 'plan') {
    return output(nativePromptPlan({ taskId: required('task'), executionId: required('execution'), source: required('provider'), nativeSessionId: required('session'), cwd: required('cwd'), prompt: required('prompt') }))
  }
  if (command === 'native' && subcommand === 'prompt') {
    return output(await executeNativeSessionPrompt({ store, taskId: required('task'), executionId: required('execution'), approvalId: required('approval'), source: required('provider'), nativeSessionId: required('session'), cwd: required('cwd'), prompt: required('prompt'), accountId: value('account'), profileId: value('profile'), idempotencyKey: idempotency() }))
  }
  if (command === 'evidence' && subcommand === 'add') {
    return output(await store.addEvidence(required('execution'), {
      kind: value('kind', 'message'),
      summary: required('summary'),
      source: required('source'),
      uri: value('uri'),
      exitCode: value('exit-code') === undefined ? undefined : Number(value('exit-code')),
    }, { idempotencyKey: idempotency() }))
  }
  if (command === 'approval' && subcommand === 'create') {
    return output(await store.createApproval({
      id: value('id'),
      action: required('action'),
      target: required('target'),
      parametersDigest: required('digest'),
      expiresAt: value('expires'),
    }, { idempotencyKey: idempotency() }))
  }
  if (command === 'approval' && subcommand === 'decide') {
    return output(await store.decideApproval(required('id'), { decision: required('decision'), approvedBy: value('approved-by') }, { idempotencyKey: idempotency() }))
  }
  if (command === 'cezar' && subcommand === 'plan') {
    return output(cezarDispatchPlan({ taskId: required('task'), executionId: required('execution'), runner: value('runner'), workflow: value('workflow'), worktree: value('worktree') !== 'false' }))
  }
  if (command === 'cezar' && subcommand === 'dispatch') {
    return output(await dispatchCezar({ store, taskId: required('task'), executionId: required('execution'), approvalId: required('approval'), runner: value('runner'), workflow: value('workflow'), worktree: value('worktree') !== 'false', idempotencyKey: idempotency() }))
  }
  if (command === 'cezar' && subcommand === 'reconcile') {
    return output(await reconcileCezarExecution({ store, executionId: required('execution'), idempotencyKey: idempotency() }))
  }
  if (command === 'cezar' && subcommand === 'cancel-plan') return output(cezarCancelPlan({ executionId: required('execution') }))
  if (command === 'cezar' && subcommand === 'cancel') {
    return output(await cancelCezarExecution({ store, executionId: required('execution'), approvalId: required('approval'), idempotencyKey: idempotency() }))
  }
  if (command === 'session' && subcommand === 'lock') {
    return output(await store.acquireSessionLock(required('id'), { owner: required('owner'), ttlMs: value('ttl') ? Number(value('ttl')) : undefined }, { idempotencyKey: idempotency() }))
  }
  if (command === 'session' && subcommand === 'unlock') {
    return output(await store.releaseSessionLock(required('id'), { owner: value('owner'), token: value('token') }, { idempotencyKey: idempotency() }))
  }
  throw new Error('用法：sessions list/native-list/native-load-probe | task create/list/show/completion-plan/complete | execution create/status | review create | native plan/prompt | evidence add | approval create/decide | cezar plan/dispatch/reconcile | session lock/unlock')
}

try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
