import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryLease } from '../src/storage/recovery-lease.js';

test('single consumer lease excludes another owner and path aliases, then releases cleanly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-lease-'));
  const dir = path.join(root, 'instance'); await fs.mkdir(dir); const alias = path.join(root, 'alias'); await fs.symlink(dir, alias);
  const a = new RecoveryLease(dir), b = new RecoveryLease(alias);
  t.after(async () => { await a.close(); await b.close(); await fs.rm(root, { recursive: true, force: true }); });
  await a.acquire(); await assert.rejects(b.acquire(), /EADDRINUSE/); assert.equal(a.port, b.port);
  await a.close(); await b.acquire(); await b.close();
});
