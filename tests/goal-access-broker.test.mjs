import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GoalStore } from '../control-plane/goal-store.mjs';
import { prepareWorkspace } from '../control-plane/goal-workspace.mjs';
import { createGoalAccessBroker } from '../control-plane/goal-access-broker.mjs';

const spec = changes => ({ title: 'synthetic broker', objective: 'fix only the copied calculator', sourceDir: path.resolve('tests/fixtures/goal-pilot'),
  readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'], checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }], ...changes });
const FIX = { files: [{ path: 'calculator.mjs', content: 'export function add(a,b){return a+b}\n' }] };
const MAC = { skip: process.platform !== 'darwin' };

async function setup(t, changes = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-access-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const goals = new GoalStore({ stateDir: path.join(dir, 'goals') });
  const draft = await goals.create(spec(changes), { idempotencyKey: 'synthetic', owner: 'synthetic-owner' });
  await prepareWorkspace(draft); await goals.grant(draft.id, { digest: draft.specDigest, approvedBy: 'synthetic-human' });
  const goal = await goals.claim(draft.id, { owner: 'synthetic-runner' });
  const broker = createGoalAccessBroker({ goals, goal, leaseToken: goal.lease.token, role: 'worker' });
  return { goals, goal, broker, dir };
}

test('one confirmed Goal permits sandbox snapshot, atomic proposal and read-only checks', MAC, async t => {
  const original = await fs.readFile(path.resolve('tests/fixtures/goal-pilot/calculator.mjs'), 'utf8');
  const ctx = await setup(t);
  const before = await ctx.broker.workspaceState(); assert.equal(before.files.length, 2);
  const applied = await ctx.broker.applyProposal(FIX); assert.deepEqual(applied.applied, ['calculator.mjs']);
  const after = await ctx.broker.workspaceState(); assert.notEqual(after.artifactRef, before.artifactRef);
  const checks = await ctx.broker.runChecks(); assert.equal(checks[0].exitCode, 0, checks[0].output);
  assert.equal(await fs.readFile(ctx.goal.spec.sourceDir + '/calculator.mjs', 'utf8'), original);
  assert.equal((await ctx.goals.read()).events.filter(event => event.type === 'granted').length, 1);
  assert.equal((await fs.readdir(ctx.goal.workspaceDir)).some(name => name.endsWith('.tmp')), false);
});

test('the last authorized iteration remains usable, without admitting an extra iteration', MAC, async t => {
  const ctx = await setup(t, { limits: { maxIterations: 1 } });
  assert.equal(ctx.goal.iterations, 1);
  await ctx.broker.applyProposal(FIX); assert.equal((await ctx.broker.runChecks())[0].exitCode, 0);
  const finished = await ctx.goals.settle(ctx.goal.id, ctx.goal.lease.token, { outcome: 'retry', summary: 'synthetic', progress: true });
  assert.equal(finished.status, 'waiting'); await assert.rejects(() => ctx.goals.claim(ctx.goal.id, { owner: 'never-extra' }));
});

test('reviewer cannot write and acceptance/unknown/outside paths cannot be proposed', MAC, async t => {
  const ctx = await setup(t), before = await ctx.broker.workspaceState();
  const reviewer = createGoalAccessBroker({ goals: ctx.goals, goal: ctx.goal, leaseToken: ctx.goal.lease.token, role: 'reviewer' });
  assert.equal((await reviewer.workspaceState()).artifactRef, before.artifactRef);
  assert.throws(() => reviewer.applyProposal(FIX), error => error.code === 'READ_ONLY_ROLE');
  for (const file of ['calculator.test.mjs', '../escape', '/synthetic/outside', 'unknown.txt']) await assert.rejects(() => ctx.broker.applyProposal({ files: [{ path: file, content: 'never' }] }), error => error.code === 'WRITE_SCOPE');
  assert.equal((await ctx.broker.workspaceState()).artifactRef, before.artifactRef);
});

test('wrong lease and host binding drift deny before accessing data', MAC, async t => {
  const ctx = await setup(t);
  for (const change of [{ owner: 'other' }, { generation: 2 }, { specDigest: 'sha256:wrong' }, { workspaceDir: path.join(ctx.dir, 'other') }]) {
    const broker = createGoalAccessBroker({ goals: ctx.goals, goal: { ...ctx.goal, ...change }, leaseToken: ctx.goal.lease.token, role: 'worker' });
    await assert.rejects(() => broker.workspaceState());
  }
  const wrong = createGoalAccessBroker({ goals: ctx.goals, goal: ctx.goal, leaseToken: 'synthetic-wrong', role: 'worker' });
  await assert.rejects(() => wrong.workspaceState());
});

test('pause and revision invalidate an old broker without touching original or copied files', MAC, async t => {
  const ctx = await setup(t), before = await ctx.broker.workspaceState();
  await ctx.goals.control(ctx.goal.id, 'pause'); await assert.rejects(() => ctx.broker.applyProposal(FIX));
  await ctx.goals.revise(ctx.goal.id, spec({ objective: 'new direction' })); await assert.rejects(() => ctx.broker.workspaceState());
  assert.equal(await fs.readFile(ctx.goal.workspaceDir + '/calculator.mjs', 'utf8'), before.files.find(file => file.path === 'calculator.mjs').content);
});

test('expired grant and tampered spec content cannot become valid merely by retaining an old digest', MAC, async t => {
  const ctx = await setup(t);
  let state = await ctx.goals.read(); state.goals[ctx.goal.id].spec.writePaths.push('calculator.test.mjs');
  await fs.writeFile(ctx.goals.file, JSON.stringify(state)); await assert.rejects(() => ctx.broker.applyProposal(FIX), error => error.code === 'SCOPE_DRIFT');
  state.goals[ctx.goal.id].spec = ctx.goal.spec; state.goals[ctx.goal.id].grant.expiresAt = new Date(0).toISOString();
  await fs.writeFile(ctx.goals.file, JSON.stringify(state)); await assert.rejects(() => ctx.broker.workspaceState());
});

test('symlink escape is refused and outside data remains unchanged', MAC, async t => {
  const ctx = await setup(t); const outside = path.join(ctx.dir, 'outside.txt'); await fs.writeFile(outside, 'synthetic-private');
  await fs.unlink(ctx.goal.workspaceDir + '/calculator.mjs'); await fs.symlink(outside, ctx.goal.workspaceDir + '/calculator.mjs');
  await assert.rejects(() => ctx.broker.workspaceState()); await assert.rejects(() => ctx.broker.applyProposal(FIX));
  assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic-private');
});

test('only the original immutable check list can run, and pre-abort never launches a check', MAC, async t => {
  const ctx = await setup(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(() => ctx.broker.runChecks({ signal: controller.signal }), error => error.code === 'ABORTED');
  for (const checks of [[{ name: 'arbitrary', args: ['-e', 'process.exit(0)'] }], [{ name: 'changed-name', args: ['--test', 'calculator.test.mjs'] }], []]) await assert.rejects(() => ctx.broker.runChecks({ checks }));
});

test('ACP file callbacks bind a host session and support approved absolute paths', MAC, async t => {
  const ctx = await setup(t); const files = ctx.broker.filesystemFor('synthetic-native');
  await assert.rejects(() => files.readTextFile({ sessionId: 'wrong', path: 'calculator.mjs' }), error => error.code === 'ACP_BINDING');
  assert.ok((await files.readTextFile({ sessionId: 'synthetic-native', path: ctx.goal.workspaceDir + '/calculator.mjs' })).content.includes('a - b'));
  assert.deepEqual(await files.writeTextFile({ sessionId: 'synthetic-native', path: 'calculator.mjs', content: FIX.files[0].content }), {});
  await assert.rejects(() => files.readTextFile({ sessionId: 'synthetic-native', path: ctx.goal.spec.sourceDir + '/calculator.mjs' }), error => error.code === 'PATH_DENIED');
});

test('real verification process cannot write even worker-approved files or access outside/network', MAC, async t => {
  const ctx = await setup(t); const outside = path.join(ctx.dir, 'outside-private.txt'); await fs.writeFile(outside, 'synthetic-private');
  const before = await fs.readFile(ctx.goal.workspaceDir + '/calculator.mjs', 'utf8');
  // Trusted test harness replaces its OWN copied acceptance content to probe the
  // OS boundary; the broker/model API still cannot write this file.
  await fs.writeFile(ctx.goal.workspaceDir + '/calculator.test.mjs', `import fs from 'node:fs';import net from 'node:net';import test from 'node:test';import assert from 'node:assert/strict';
test('worker target read-only',()=>assert.throws(()=>fs.writeFileSync('calculator.mjs','never')));
test('outside read blocked',()=>assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)})));
test('outside write blocked',()=>assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'never')));
test('network blocked',async()=>{await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:4323});socket.on('connect',()=>{socket.destroy();reject(Error('unexpected network'))});socket.on('error',()=>resolve());socket.setTimeout(1000,()=>{socket.destroy();resolve()})})});`);
  const checks = await ctx.broker.runChecks(); assert.equal(checks[0].exitCode, 0, checks[0].output);
  assert.equal(await fs.readFile(ctx.goal.workspaceDir + '/calculator.mjs', 'utf8'), before);
  assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic-private');
});

test('pause during a long real check kills the owned child without locking out control', MAC, async t => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.goal.workspaceDir + '/calculator.test.mjs', "import test from 'node:test';test('synthetic delayed check',async()=>{await new Promise(resolve=>setTimeout(resolve,5000))});");
  const controller = new AbortController();
  const pending = ctx.broker.runChecks({ signal: controller.signal, timeoutMs: 10000 });
  // Attach a rejection observer before injecting the pause.
  const outcome = pending.then(() => 'unexpected-complete', () => 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now(); await ctx.goals.control(ctx.goal.id, 'pause');
  assert.ok(Date.now() - started < 1500, 'control must not wait for the long check');
  assert.equal(await outcome, 'cancelled'); assert.equal((await ctx.goals.get(ctx.goal.id)).status, 'paused');
});
