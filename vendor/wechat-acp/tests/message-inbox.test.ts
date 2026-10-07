import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const { MessageInbox } = await import('../src/storage/message-inbox.js');

const HEX_FILE = /^[0-9a-f]{64}\.(json|lock)$/;

async function makeDir() {
  return mkdtemp(join(tmpdir(), 'message-inbox-'));
}

async function withInbox(fn) {
  const dir = await makeDir();
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function msg(overrides = {}) {
  return {
    message_id: 1001,
    from_user_id: 'user-a',
    to_user_id: 'bot-b',
    context_token: 'token-1',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...overrides,
  };
}

test('put persists a new receipt with expected shape and status', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { isNew, record } = await inbox.put(msg());
    assert.equal(isNew, true);
    assert.equal(record.status, 'received');
    assert.equal(record.message.message_id, 1001);
    assert.equal(typeof record.receivedAt, 'number');
    assert.match(record.id, /^[0-9a-f]{64}$/);
    await inbox.close();
  });
});

test('directory is 0700 and receipts are 0600', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { record } = await inbox.put(msg());
    const dirStat = await fs.stat(dir);
    const fileStat = await fs.stat(join(dir, record.id + '.json'));
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
    await inbox.close();
  });
});

test('receipts survive restart on a fresh instance', async () => {
  await withInbox(async (dir) => {
    const first = new MessageInbox({ dir });
    const { record } = await first.put(msg());
    await first.close();

    const second = new MessageInbox({ dir });
    const list = await second.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, record.id);
    assert.equal(list[0].status, 'received');
    assert.deepEqual(list[0].message.item_list, [{ type: 1, text_item: { text: 'hello' } }]);
    await second.close();
  });
});

test('replaying an identical server id is suppressed, not duplicated', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const first = await inbox.put(msg());
    const second = await inbox.put(msg());
    assert.equal(second.isNew, false);
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.receivedAt, first.record.receivedAt);
    const list = await inbox.list();
    assert.equal(list.length, 1);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    await inbox.close();
  });
});

test('two instances share the inbox and suppress duplicates', async () => {
  await withInbox(async (dir) => {
    const a = new MessageInbox({ dir });
    const b = new MessageInbox({ dir });
    const first = await a.put(msg());
    const second = await b.put(msg());
    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(second.record.id, first.record.id);
    assert.equal((await b.list()).length, 1);
    await a.close();
    await b.close();
  });
});
test('same-pid concurrent instances never reclaim a live lock or duplicate a receipt', async () => {
  await withInbox(async dir => {
    const a = new MessageInbox({ dir }), b = new MessageInbox({ dir });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).put(msg())));
    assert.equal(results.filter(row => row.isNew).length, 1);
    await a.close(); await b.close();
  });
});
test('zero/unreliable server id does not merge distinct voice messages', async () => {
  await withInbox(async dir => {
    const inbox = new MessageInbox({ dir });
    const a = await inbox.put(msg({ message_id: 0 }));
    const b = await inbox.put(msg({ message_id: 0, item_list: [{ type: 3, voice_item: { text: 'other voice' } }] }));
    assert.notEqual(a.record.id, b.record.id); await inbox.close();
  });
});

test('changed payload under the same server id fails closed', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    await inbox.put(msg());
    await assert.rejects(
      () => inbox.put(msg({ item_list: [{ type: 1, text_item: { text: 'DIFFERENT' } }] })),
      /conflicting payload/,
    );
    const list = await inbox.list();
    assert.equal(list[0].message.item_list[0].text_item.text, 'hello');
    await inbox.close();
  });
});

test('refreshed context_token is persisted for a pending receipt', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    await inbox.put(msg({ context_token: 'token-1' }));
    const refreshed = await inbox.put(msg({ context_token: 'token-2' }));
    assert.equal(refreshed.isNew, false);
    assert.equal(refreshed.record.message.context_token, 'token-2');
    await inbox.close();

    const reopened = new MessageInbox({ dir });
    const list = await reopened.list();
    assert.equal(list[0].message.context_token, 'token-2');
    await reopened.close();
  });
});

test('context_token refresh on terminal work is suppressed without resurrection', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { record } = await inbox.put(msg({ context_token: 'token-1' }));
    await inbox.setStatus(record.id, 'done');
    const duplicate = await inbox.put(msg({ context_token: 'token-2' }));
    assert.equal(duplicate.isNew, false); assert.equal(duplicate.record.status, 'done');
    await inbox.close();
  });
});

test('corruption throws instead of resetting or deleting the receipt', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { record } = await inbox.put(msg());
    const path = join(dir, record.id + '.json');
    await fs.writeFile(path, '{ this is not json', 'utf8');

    await assert.rejects(() => inbox.list(), /corrupt receipt/);
    await assert.rejects(() => inbox.recover(), /corrupt receipt/);
    await assert.rejects(() => inbox.setStatus(record.id, 'running'), /corrupt receipt/);
    assert.ok(await fs.readFile(path, 'utf8'));
    await inbox.close();
  });
});

test('filenames are opaque hex digests regardless of payload contents', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    await inbox.put(msg({ from_user_id: '../../etc/passwd', to_user_id: 'a b/c' }));
    const entries = await fs.readdir(dir);
    assert.ok(entries.length >= 1);
    for (const entry of entries) {
      assert.match(entry, HEX_FILE, `unexpected filename ${entry}`);
      assert.ok(!entry.includes('passwd'));
      assert.ok(!entry.includes('..'));
    }
    await inbox.close();
  });
});

test('identity falls back to a whole-payload digest when no server id exists', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const bare = { from_user_id: 'u', to_user_id: 'b', item_list: [{ type: 1, text_item: { text: 'x' } }] };
    const a = await inbox.put(bare);
    const b = await inbox.put(bare);
    const c = await inbox.put({ ...bare, item_list: [{ type: 1, text_item: { text: 'y' } }] });
    assert.equal(a.isNew, true);
    assert.equal(b.isNew, false);
    assert.equal(c.isNew, true);
    assert.notEqual(a.record.id, c.record.id);
    await inbox.close();
  });
});

test('client_id provides identity when message_id is absent', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const a = await inbox.put({ client_id: 'c-1', from_user_id: 'u', to_user_id: 'b' });
    const b = await inbox.put({ client_id: 'c-1', from_user_id: 'u', to_user_id: 'b' });
    assert.equal(a.isNew, true);
    assert.equal(b.isNew, false);
    await inbox.close();
  });
});

test('status transitions are monotonic and terminal states cannot be resurrected', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { record } = await inbox.put(msg());
    await inbox.setStatus(record.id, 'running');
    await assert.rejects(() => inbox.setStatus(record.id, 'queued'), /non-monotonic/);
    await inbox.setStatus(record.id, 'done');
    await assert.rejects(() => inbox.setStatus(record.id, 'running'), /terminal/);
    await assert.rejects(() => inbox.setStatus(record.id, 'failed'), /terminal/);
    await inbox.close();
  });
});

test('failed status records an errorKind', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { record } = await inbox.put(msg());
    await inbox.setStatus(record.id, 'running');
    const failed = await inbox.setStatus(record.id, 'failed', { errorKind: 'network' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorKind, 'network');
    await inbox.close();
  });
});

test('setStatus validates the receipt exists', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    await assert.rejects(
      () => inbox.setStatus('0'.repeat(64), 'running'),
      /unknown receipt/,
    );
    await assert.rejects(() => inbox.setStatus('../evil', 'running'), /invalid receipt id/);
    await inbox.close();
  });
});

test('recover marks running/buffered uncertain, returns pending, never replays', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const received = await inbox.put(msg({ message_id: 1 }));
    const queued = await inbox.put(msg({ message_id: 2 }));
    const buffered = await inbox.put(msg({ message_id: 3 }));
    const running = await inbox.put(msg({ message_id: 4 }));
    await inbox.setStatus(queued.record.id, 'queued');
    await inbox.setStatus(buffered.record.id, 'buffered');
    await inbox.setStatus(running.record.id, 'running');
    await inbox.close();

    const recovered = new MessageInbox({ dir });
    const result = await recovered.recover();
    const pendingIds = result.pending.map((r) => r.id).sort();
    assert.deepEqual(pendingIds, [received.record.id, queued.record.id].sort());
    assert.equal(result.uncertainCount, 2);

    const statuses = new Map((await recovered.list()).map((r) => [r.id, r.status]));
    assert.equal(statuses.get(buffered.record.id), 'uncertain');
    assert.equal(statuses.get(running.record.id), 'uncertain');

    const again = await recovered.recover();
    assert.equal(again.uncertainCount, 2);
    assert.equal(again.pending.length, 2);
    await recovered.close();
  });
});

test('list filters by status and sorts by arrival', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const first = await inbox.put(msg({ message_id: 1 }));
    await inbox.put(msg({ message_id: 2 }));
    await inbox.setStatus(first.record.id, 'done');

    const done = await inbox.list({ statuses: ['done'] });
    assert.equal(done.length, 1);
    assert.equal(done[0].id, first.record.id);

    const all = await inbox.list();
    assert.equal(all.length, 2);
    assert.ok(all[0].receivedAt <= all[1].receivedAt);
    await inbox.close();
  });
});

test('stale lock from a dead pid is reclaimed', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const { record } = await inbox.put(msg());
    await fs.writeFile(join(dir, record.id + '.lock'), '999999', 'utf8');
    const replay = await inbox.put(msg());
    assert.equal(replay.isNew, false);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.lock'));
    assert.equal(leftovers.length, 0);
    await inbox.close();
  });
});

test('close drains in-flight mutations and refuses new ones', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const inFlight = inbox.put(msg({ message_id: 1 }));
    await inbox.close();
    const result = await inFlight;
    assert.equal(result.isNew, true);
    await assert.rejects(() => inbox.put(msg({ message_id: 2 })), /closed/);
  });
});

test('concurrent puts within one instance serialize to a single receipt', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    const results = await Promise.all([
      inbox.put(msg()),
      inbox.put(msg()),
      inbox.put(msg()),
    ]);
    assert.equal(results.filter((r) => r.isNew).length, 1);
    assert.equal((await inbox.list()).length, 1);
    await inbox.close();
  });
});

test('raw temp files are not left behind after writes', async () => {
  await withInbox(async (dir) => {
    const inbox = new MessageInbox({ dir });
    await inbox.put(msg());
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      assert.ok(!basename(entry).startsWith('.tmp-'), `temp file leaked: ${entry}`);
    }
    await inbox.close();
  });
});
