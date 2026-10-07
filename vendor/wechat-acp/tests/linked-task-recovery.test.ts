import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WeChatAcpBridge } from '../src/bridge.js';
import { defaultConfig } from '../src/config.js';

for (const scenario of ['verified', 'missing-proof', 'wrong-source', 'cancelled'] as const) test(`linked task recovery ${scenario} respects authoritative proof and cancellation`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-task-'));
  const config = defaultConfig(); config.storage.dir = dir; config.storage.stateFile = undefined; config.memory = { enabled: false }; config.recovery = { enabled: true };
  const bridge = new WeChatAcpBridge(config, () => {}), internal = bridge as any;
  const { record } = await internal.messageInbox.put({ message_type: 1, message_id: 1, from_user_id: 'synthetic', to_user_id: 'bot', context_token: 'synthetic', item_list: [{ type: 1, text_item: { text: 'synthetic task' } }] });
  await internal.messageInbox.setStatus(record.id, scenario === 'cancelled' ? 'cancelled' : 'uncertain');
  const sourceRequestId = scenario === 'wrong-source' ? 'f'.repeat(64) : record.id;
  const task = { id: 'task_fixture', sourceRequestId, status: 'completed', goal: 'controlled synthetic task', ...(scenario === 'missing-proof' ? {} : { completionProof: { at: new Date().toISOString(), parametersDigest: `sha256:${'a'.repeat(64)}` } }) };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url?.includes('/tasks/task_') ? { task, evidence: [{ kind: 'test', exitCode: 0 }, { kind: 'review', verdict: 'passed' }] } : { tasks: [task] })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  config.controlPlaneUrl = `http://127.0.0.1:${port}`;
  t.after(async () => { await bridge.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
  const accepted = await internal.reconcileLinkedTask(record.id);
  const latest = (await internal.messageInbox.list())[0];
  if (scenario === 'verified') { assert.equal(accepted, true); assert.equal(latest.status, 'reply_pending'); assert.equal(latest.execution.sourceTaskId, task.id); }
  else if (scenario === 'cancelled') assert.equal(latest.status, 'cancelled');
  else { assert.equal(accepted, false); assert.equal(latest.status, 'uncertain'); }
});
