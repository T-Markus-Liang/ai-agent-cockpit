import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WeChatGoalClient } from '../src/goals.js';
test('WeChat goals preserve actor identity and require exact approval digest', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-goals-')), tokenFile = path.join(dir, 'token');
  await fs.writeFile(tokenFile, 'synthetic-token'); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const client = new WeChatGoalClient({ url: 'http://127.0.0.1:4326', tokenFile });
  const digest = `sha256:${'a'.repeat(64)}`;
  const requests: Array<{ url: string; headers: Record<string, string>; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const goal = { id: 'goal_abc', status: 'draft', specDigest: digest, iterations: 0, spec: { title: '试运行', objective: 'repair', writePaths: ['app.mjs'], limits: { maxIterations: 10, maxTokens: 80000 } } };
    return Response.json(String(url).endsWith('/api/goals') ? { goals: [goal] } : { goal });
  });
  assert.match(await client.command('owner', '/目标'), /试运行/);
  assert.equal(requests[0]!.headers['X-Goal-Actor'], 'wechat-' + crypto.createHash('sha256').update('owner').digest('hex'));
  assert.match(await client.command('owner', '/目标 确认 goal_abc'), /完整确认命令/);
  assert.equal(requests.length, 1);
  await client.command('owner', `/目标 确认 goal_abc ${digest}`);
  assert.deepEqual(requests.at(-1)!.body, { digest });
  await client.command('owner', '/目标 暂停 goal_abc'); assert.match(requests.at(-1)!.url, /\/pause$/);
  await client.command('owner', '/目标 恢复 goal_abc'); assert.match(requests.at(-1)!.url, /\/resume$/);
});
test('Goal client refuses non-loopback targets', () => assert.throws(() => new WeChatGoalClient({ url: 'https://example.com', tokenFile: 'unused' })));
