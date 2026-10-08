import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ControlPlaneStore } from '../control-plane/store.mjs';

test('aged live holder is never stolen; a killed holder releases SQLite coordination and is reclaimed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-control-lock-'));
  let child;
  try {
    const script = `import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';
const dir=process.argv[1];const db=new DatabaseSync(path.join(dir,'control-plane-mutex.sqlite'));db.exec('BEGIN IMMEDIATE');
const file=path.join(dir,'control-plane.lock');fs.writeFileSync(file,JSON.stringify({pid:process.pid,token:'synthetic-live-owner',acquiredAt:new Date().toISOString()}),{mode:0o600});
fs.utimesSync(file,new Date(0),new Date(0));process.stdout.write('READY');setInterval(()=>{},1000);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(Error('synthetic holder exited before readiness'))); });
    const original = await fs.readFile(path.join(dir, 'control-plane.lock'), 'utf8');
    const contender = new ControlPlaneStore({ stateDir: dir, lockTimeoutMs: 150 });
    await assert.rejects(() => contender.createTask({ goal: 'must wait' }, { idempotencyKey: 'wait' }), error => error.code === 'LOCK_TIMEOUT');
    assert.equal(await fs.readFile(path.join(dir, 'control-plane.lock'), 'utf8'), original);
    assert.equal(await contender.exists(), false);
    child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve));
    const reclaimed = await contender.createTask({ goal: 'after confirmed death' }, { idempotencyKey: 'reclaimed' });
    assert.equal(reclaimed.task.goal, 'after confirmed death');
    assert.equal((await contender.snapshot()).taskCount, 1);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent store instances persist every row and remove only their own lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-control-concurrent-'));
  try {
    const stores = [new ControlPlaneStore({ stateDir: dir }), new ControlPlaneStore({ stateDir: dir })];
    await Promise.all(Array.from({ length: 8 }, (_, index) => stores[index % 2].createTask({ goal: `synthetic-${index}` }, { idempotencyKey: `task-${index}` })));
    assert.equal((await stores[0].listTasks()).length, 8);
    await assert.rejects(() => fs.stat(path.join(dir, 'control-plane.lock')), error => error.code === 'ENOENT');
    assert.equal((await fs.stat(path.join(dir, 'control-plane.json'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(dir, 'control-plane-mutex.sqlite'))).mode & 0o777, 0o600);
    assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.candidate') || name.endsWith('.tmp')), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
