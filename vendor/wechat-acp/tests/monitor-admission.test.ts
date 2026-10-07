import test from 'node:test';
import assert from 'node:assert/strict';
import { admitUpdateBatch } from '../src/weixin/monitor.js';
test('update cursor commits only after every message is durably admitted', async () => {
  const events: string[] = [];
  await admitUpdateBatch({ msgs: [{ message_id: 1 }, { message_id: 2 }], get_updates_buf: 'next' }, async msg => {
    await new Promise(resolve => setTimeout(resolve, 1)); events.push(`saved-${msg.message_id}`);
  }, cursor => events.push(`cursor-${cursor}`));
  assert.deepEqual(events, ['saved-1', 'saved-2', 'cursor-next']);
});
test('a failed admission never advances the cursor; duplicate replay can recover the batch', async () => {
  let cursorWrites = 0;
  await assert.rejects(admitUpdateBatch({ msgs: [{ message_id: 1 }], get_updates_buf: 'next' }, async () => { throw new Error('disk failure'); }, () => { cursorWrites++; }));
  assert.equal(cursorWrites, 0);
});
test('message admission is independent of agent completion', async () => {
  let admitted = 0, committed = false;
  const agent = new Promise(() => {});
  await admitUpdateBatch({ msgs: [{ message_id: 1 }], get_updates_buf: 'next' }, () => { admitted++; void agent; }, () => { committed = true; });
  assert.equal(admitted, 1); assert.equal(committed, true);
});
