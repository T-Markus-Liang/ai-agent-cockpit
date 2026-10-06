import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createApproval, createExecution, createSessionRef, createTask, ContractError } from '../control-plane/contracts.mjs'
import { indexLocalSessions } from '../control-plane/session-index.mjs'

test('contracts keep Task, SessionRef and Execution separate', () => {
  const task = createTask({ goal: '检查本机 agent 状态', acceptanceCriteria: ['输出可追溯证据'] })
  const session = createSessionRef({ source: 'test', nativeSessionId: 'native-1', cwd: '/tmp', title: '测试会话' })
  const execution = createExecution({ taskId: task.id, workerId: 'test-worker', sessionRefId: session.id })
  assert.equal(task.type, 'Task')
  assert.equal(session.type, 'SessionRef')
  assert.equal(execution.type, 'Execution')
  assert.equal(execution.taskId, task.id)
  assert.equal(execution.sessionRefId, session.id)
})

test('contracts reject empty goals and invalid approvals', () => {
  assert.throws(() => createTask({ goal: '' }), ContractError)
  assert.throws(() => createApproval({ action: 'send', target: 'wechat', parametersDigest: 'x', decision: 'maybe' }), ContractError)
})

test('session index is read-only and returns normalized metadata', async () => {
  const snapshot = await indexLocalSessions({ home: os.homedir(), providers: ['kimi'], limit: 2 })
  assert.equal(snapshot.type, 'SessionIndexSnapshot')
  assert.equal(snapshot.privacy.readOnly, true)
  assert.equal(snapshot.privacy.secretsRead, false)
  assert.equal(snapshot.privacy.messageBodiesRead, false)
  for (const session of snapshot.sessions) {
    assert.equal(session.source, 'kimi')
    assert.equal(session.capabilities.write, 'unavailable')
    assert.ok(session.nativeSessionId)
    assert.ok(session.cwd)
  }
})

test('session index does not create control-plane state', async () => {
  const before = await fs.readdir(path.join(os.homedir(), '.local/state')).catch(() => [])
  await indexLocalSessions({ home: os.homedir(), providers: ['workbuddy'] })
  const after = await fs.readdir(path.join(os.homedir(), '.local/state')).catch(() => [])
  assert.deepEqual(after, before)
})

