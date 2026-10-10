import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubmissionRegistry, computePayloadDigest } from '../src/storage/submission-registry.js';
import type { WeixinMessage } from '../src/weixin/types.js';

const ownedDirs: string[] = [];
const mk = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-registry-'));
  ownedDirs.push(dir);
  return dir;
};
after(async () => {
  await Promise.all(ownedDirs.map(async (dir) => {
    await fs.chmod(dir, 0o700).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

/** Assert a rejection carries a specific fail-closed `code`. */
const code = (expected: string) => (err: unknown): boolean => {
  assert.equal((err as { code?: string })?.code, expected);
  return true;
};

const R1 = 'a'.repeat(64);
const R2 = 'b'.repeat(64);

const message = (extra: Partial<WeixinMessage> = {}): WeixinMessage => ({
  message_id: 1,
  from_user_id: 'u1',
  to_user_id: 'bot',
  context_token: 'ctx-1',
  item_list: [{ type: 1, text_item: { text: 'hello' } }],
  ...extra,
});

test('register records the submission once with the exact fields', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir, now: () => 1234 });
  const rec = await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  assert.deepEqual(rec, { receiptId: R1, userId: 'u1', payloadDigest: 'd1', registeredAt: 1234, state: 'registered' });
  assert.equal(await reg.count(), 1);
  assert.equal(await reg.has(R1), true);
  assert.equal(await reg.has(R2), false);
  assert.equal((await reg.getRegistration(R1))?.userId, 'u1');
  assert.equal(await reg.getRegistration(R2), undefined);
  // 0600 record on disk, 0700 dir.
  assert.equal((await fs.stat(path.join(dir, `${R1}.json`))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  await reg.close();
});

test('re-registering the same receipt is idempotent and writes nothing new', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir });
  const first = await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  const again = await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  assert.equal(again, first, 'idempotent re-register returns the stored record');
  assert.equal(await reg.count(), 1);
  await reg.close();
});

test('same receipt with a different digest or owner conflicts with zero state change', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir });
  const first = await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  await assert.rejects(() => reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd2' }), code('registration-conflict'));
  await assert.rejects(() => reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd2' }), code('registration-conflict'));
  await assert.rejects(() => reg.register({ receiptId: R1, userId: 'other', payloadDigest: 'd1' }), code('registration-conflict'));
  assert.equal(await reg.count(), 1, 'a conflict must not add or drop records');
  assert.equal(await reg.getRegistration(R1), first, 'the stored record is untouched');
  await reg.close();
});

test('missing or wrongly-typed parameters are rejected without state change', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir });
  const badInput = { userId: 'u1', payloadDigest: 'd1' } as unknown as { receiptId: string; userId: string; payloadDigest: string };
  await assert.rejects(() => reg.register(undefined as unknown as { receiptId: string; userId: string; payloadDigest: string }), code('invalid-registration'));
  await assert.rejects(() => reg.register(badInput), code('invalid-registration'));
  await assert.rejects(() => reg.register({ receiptId: 'bad id', userId: 'u1', payloadDigest: 'd1' }), code('invalid-registration'));
  await assert.rejects(() => reg.register({ receiptId: R1, userId: '', payloadDigest: 'd1' }), code('invalid-registration'));
  await assert.rejects(() => reg.register({ receiptId: R1, userId: 'u1', payloadDigest: '' }), code('invalid-registration'));
  await assert.rejects(() => reg.register({ receiptId: 5 as unknown as string, userId: 'u1', payloadDigest: 'd1' }), code('invalid-registration'));
  assert.equal(await reg.count(), 0);
  await assert.rejects(() => reg.getRegistration('bad id'), code('invalid-registration'));
  await assert.rejects(() => reg.has({} as unknown as string), code('invalid-registration'));
  await reg.close();
});

test('a failed durable write poisons the registry; recover() clears it from disk', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir });
  await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });

  // Force every durable write to fail, then observe fail-closed.
  await fs.chmod(dir, 0o500);
  await assert.rejects(() => reg.register({ receiptId: R2, userId: 'u2', payloadDigest: 'd2' }));
  await assert.rejects(() => reg.count(), code('store-poisoned'));
  await assert.rejects(() => reg.has(R1), code('store-poisoned'));
  await assert.rejects(() => reg.getRegistration(R1), code('store-poisoned'));
  await assert.rejects(() => reg.register({ receiptId: R2, userId: 'u2', payloadDigest: 'd2' }), code('store-poisoned'));
  await fs.chmod(dir, 0o700);

  // recover() re-reads the durable truth and clears the poison.
  await reg.recover();
  // Only the record that was actually persisted survives; the failed one never did.
  assert.equal(await reg.count(), 1);
  assert.equal(await reg.has(R2), false);
  const restored = await reg.register({ receiptId: R2, userId: 'u2', payloadDigest: 'd2' });
  assert.equal(restored.receiptId, R2);
  assert.equal(await reg.count(), 2);
  await reg.close();
});

test('recover fails closed while the durable store cannot be read', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir });
  await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  await fs.chmod(dir, 0o000);
  try {
    await assert.rejects(() => reg.recover(), code('store-poisoned'));
  } finally {
    await fs.chmod(dir, 0o700);
  }
  await reg.recover();
  assert.equal(await reg.count(), 1);
  await reg.close();
});

test('a corrupt stored record poisons the registry instead of silently dropping it', async () => {
  const dir = await mk();
  await fs.writeFile(path.join(dir, 'notjson.json'), 'not json');
  const reg = new SubmissionRegistry({ dir });
  await assert.rejects(() => reg.count(), code('store-poisoned'));
  await assert.rejects(() => reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' }), code('store-poisoned'));

  // Fixing the durable store and recovering clears the poison.
  await fs.rm(path.join(dir, 'notjson.json'));
  await reg.recover();
  assert.equal(await reg.count(), 0);
  await reg.close();
});

test('a schema-mismatched record poisons on load', async () => {
  const dir = await mk();
  await fs.writeFile(path.join(dir, `${R1}.json`), JSON.stringify({ receiptId: R1, userId: 'u1', payloadDigest: 'd1', registeredAt: 1, state: 'dispatched' }));
  const reg = new SubmissionRegistry({ dir });
  await assert.rejects(() => reg.count(), code('store-poisoned'));
  await reg.close();

  const dir2 = await mk();
  // receiptId does not match the file name -> corrupt identity.
  await fs.writeFile(path.join(dir2, `${R1}.json`), JSON.stringify({ receiptId: R2, userId: 'u1', payloadDigest: 'd1', registeredAt: 1, state: 'registered' }));
  const reg2 = new SubmissionRegistry({ dir: dir2 });
  await assert.rejects(() => reg2.count(), code('store-poisoned'));
  await reg2.close();
});

test('registrations survive a restart (new instance, same dir)', async () => {
  const dir = await mk();
  const a = new SubmissionRegistry({ dir });
  await a.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  await a.close();

  const b = new SubmissionRegistry({ dir });
  assert.equal(await b.has(R1), true);
  assert.equal((await b.getRegistration(R1))?.payloadDigest, 'd1');
  assert.equal(await b.count(), 1);
  await b.close();
});

test('close drains then refuses every API', async () => {
  const dir = await mk();
  const reg = new SubmissionRegistry({ dir });
  await reg.register({ receiptId: R1, userId: 'u1', payloadDigest: 'd1' });
  await reg.close();
  await assert.rejects(() => reg.register({ receiptId: R2, userId: 'u2', payloadDigest: 'd2' }), code('store-closed'));
  await assert.rejects(() => reg.count(), code('store-closed'));
  await assert.rejects(() => reg.has(R1), code('store-closed'));
  await assert.rejects(() => reg.getRegistration(R1), code('store-closed'));
  await assert.rejects(() => reg.recover(), code('store-closed'));
});

test('computePayloadDigest is deterministic and ignores the delivery token', () => {
  const base = message();
  assert.equal(computePayloadDigest(base), computePayloadDigest(base));
  assert.equal(computePayloadDigest(base), computePayloadDigest(message({ context_token: 'ctx-other' })), 'context_token must not affect the digest');
  assert.notEqual(computePayloadDigest(base), computePayloadDigest(message({ item_list: [{ type: 1, text_item: { text: 'changed' } }] })));
  assert.match(computePayloadDigest(base), /^[0-9a-f]{64}$/);
});
