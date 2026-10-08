import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyOutbox } from '../src/storage/reply-outbox.ts';

const ownedDirs: string[] = [];
const mk = async (): Promise<string> => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-outbox-')); ownedDirs.push(dir); return dir; };
after(async () => { await Promise.all(ownedDirs.map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const base = (extra: Record<string, unknown> = {}) => ({ userId: 'u1', contextToken: 'ctx', text: 'hi', ...extra });

test('restart keeps stable clientId and attempts', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  const rec = await a.put(base());
  assert.equal(rec.attempts, 0);
  await a.claimDue();
  await a.settle(rec.id, { sent: false });
  await a.close();
  const b = new ReplyOutbox({ dir });
  const loaded = await b.get(rec.id);
  assert.ok(loaded);
  assert.equal(loaded.clientId, rec.clientId);
  assert.match(loaded.clientId, /^wechat-acp-/);
  assert.equal(loaded.attempts, 1);
  await b.close();
});

test('failed send backoff, due gating and attempt exhaustion', async () => {
  const dir = await mk();
  let clock = 1000;
  const a = new ReplyOutbox({ dir, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, now: () => clock });
  const rec = await a.put(base());
  await a.claimDue();
  const p1 = await a.settle(rec.id, { sent: false, errorKind: 'timeout' });
  assert.equal(p1.status, 'pending');
  assert.equal(p1.errorKind, 'timeout');
  assert.equal(p1.nextAttemptAt, 1100);
  assert.deepEqual(await a.claimDue(), []);
  clock = 1099;
  assert.deepEqual(await a.claimDue(), []);
  clock = 1100;
  const [c2] = await a.claimDue();
  assert.equal(c2.attempts, 2);
  const p2 = await a.settle(rec.id, { sent: false });
  assert.equal(p2.status, 'blocked');
  assert.deepEqual(await a.claimDue({ force: true }), []);
  await a.close();
});

test('force bypasses due time', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir, baseDelayMs: 1000, maxDelayMs: 2000, now: () => 100 });
  const rec = await a.put(base());
  await a.claimDue();
  await a.settle(rec.id, { sent: false });
  assert.deepEqual(await a.claimDue(), []);
  const forced = await a.claimDue({ force: true });
  assert.deepEqual(forced.map((r) => r.id), [rec.id]);
  await a.close();
});

test('cancellation is terminal', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  const rec = await a.put(base());
  await a.claimDue();
  await a.cancelForUser('u1');
  const after = await a.settle(rec.id, { sent: false });
  assert.equal(after.status, 'cancelled');
  assert.deepEqual(await a.claimDue({ force: true }), []);
  await a.close();
});

test('dedupe suppress, conflict and pending context refresh', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  const first = await a.put(base({ dedupeKey: 'k' }));
  const again = await a.put(base({ dedupeKey: 'k' }));
  assert.equal(again.id, first.id);
  await assert.rejects(() => a.put(base({ dedupeKey: 'k', text: 'changed' })), /conflict/);
  await assert.rejects(() => a.put(base({ dedupeKey: 'k', receiptIds: ['r'] })), /conflict/);
  await assert.rejects(() => a.put(base({ dedupeKey: 'k', kind: 'notice' })), /conflict/);
  const refreshed = await a.put(base({ dedupeKey: 'k', contextToken: 'ctx2' }));
  assert.equal(refreshed.id, first.id);
  assert.equal(refreshed.contextToken, 'ctx2');
  await a.close();
});

test('same-user FIFO while other users proceed', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir, now: () => 1000 });
  const a1 = await a.put(base({ text: 'a1' }));
  const a2 = await a.put(base({ text: 'a2' }));
  const b1 = await a.put(base({ userId: 'u2', text: 'b1' }));
  const claimed = await a.claimDue();
  assert.deepEqual(claimed.map((r) => r.id), [a1.id, b1.id]);
  await a.settle(a1.id, { sent: true });
  const second = await a.claimDue();
  assert.deepEqual(second.map((r) => r.id), [a2.id]);
  await a.close();
});

test('concurrent claims never duplicate', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  const r1 = await a.put(base({ text: '1' }));
  await a.put(base({ text: '2' }));
  const [x, y] = await Promise.all([a.claimDue(), a.claimDue()]);
  const ids = [...x, ...y].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === r1.id).length, 1);
  await a.close();
});

test('recover interrupted sending', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  const rec = await a.put(base());
  await a.claimDue();
  await a.close();
  const b = new ReplyOutbox({ dir });
  await b.recover();
  const back = await b.get(rec.id);
  assert.ok(back);
  assert.equal(back.status, 'pending');
  assert.equal(back.attempts, 1);
  assert.equal(back.clientId, rec.clientId);
  assert.ok(back.nextAttemptAt <= Date.now());
  await b.close();
});

test('refreshContext updates pending only', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  const pending = await a.put(base({ userId: 'u1' }));
  await a.refreshContext('u1', 'ctx-new');
  assert.equal((await a.get(pending.id))?.contextToken, 'ctx-new');
  const sent = await a.put(base({ userId: 'u2', contextToken: 'orig' }));
  await a.claimDue({ userId: 'u2' });
  await a.settle(sent.id, { sent: true });
  await a.refreshContext('u2', 'nope');
  assert.equal((await a.get(sent.id))?.contextToken, 'orig');
  await a.close();
});

test('corrupt records and invalid ids fail closed', async () => {
  const dir = await mk();
  const a = new ReplyOutbox({ dir });
  await assert.rejects(() => a.get('bad id'), /invalid id/);
  await fs.writeFile(path.join(dir, 'notjson.json'), 'not json');
  await assert.rejects(() => a.list(), /corrupt/);
  await a.close();

  const dir2 = await mk();
  const b = new ReplyOutbox({ dir: dir2 });
  const good = await b.put(base());
  const raw = JSON.parse(await fs.readFile(path.join(dir2, `${good.id}.json`), 'utf8'));
  await fs.writeFile(path.join(dir2, 'aaaa.json'), JSON.stringify({ ...raw, id: 'bbbb' }));
  await assert.rejects(() => b.list(), /corrupt identity/);
  await b.close();
});

test('0700/0600 permissions and close drains then rejects', async () => {
  const dir = await mk();
  await fs.chmod(dir, 0o755);
  const a = new ReplyOutbox({ dir });
  const inflight = a.put(base());
  await a.close();
  const rec = await inflight;
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, `${rec.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await a.get(rec.id))?.text, 'hi');
  await assert.rejects(() => a.put(base()), /closed/);
});
test('explicit delivery retry renews blocked attempts, reports the count, and never resurrects cancelled records', async () => {
  const dir = await mk(), outbox = new ReplyOutbox({ dir, maxAttempts: 1 });
  const a = await outbox.put(base()); await outbox.claimDue(); await outbox.settle(a.id, { sent: false });
  const b = await outbox.put(base({ text: 'second' })); await outbox.claimDue(); await outbox.settle(b.id, { sent: false });
  // Count reflects only the records actually renewed back to `pending`.
  assert.equal(await outbox.retryBlockedForUser('someone-else'), 0);
  assert.equal(await outbox.retryBlockedForUser('u1'), 2);
  const renewed = await outbox.list({ userId: 'u1', statuses: ['pending'] });
  assert.equal(renewed.length, 2);
  assert.ok(renewed.every((row) => row.attempts === 0));
  const [again] = await outbox.claimDue();
  assert.equal(again.clientId, a.clientId); assert.equal(again.attempts, 1);
  await outbox.cancelForUser('u1');
  assert.equal(await outbox.retryBlockedForUser('u1'), 0, 'cancelled records are never renewed or counted');
  assert.deepEqual(await outbox.claimDue({ force: true }), []);
  await outbox.close();
});
