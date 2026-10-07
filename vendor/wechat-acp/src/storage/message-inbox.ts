/**
 * Lightweight durable inbox for WeChat iLink messages.
 *
 * Design goals:
 *  - Durable: uuid temp file + fsync + atomic rename, 0700 dir, 0600 receipts.
 *  - Idempotent: stable sha256 identity from sender+recipient+server id, with a
 *    whole-payload digest fallback. Repeated delivery of the same server id is
 *    suppressed and never dispatched twice.
 *  - Fail closed: a same-id payload conflict throws rather than silently
 *    overwriting; only a refreshed context_token may be persisted while a
 *    receipt is still pending (received/queued).
 *  - Recoverable: running/buffered work is marked uncertain on recovery and is
 *    never auto-replayed.
 *  - Serialized: in-process queue plus a per-record cross-process file lock
 *    with stale/dead-pid handling.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { WeixinMessage } from '../weixin/types.js';

export const MESSAGE_INBOX_STATUSES = [
  'received',
  'queued',
  'buffered',
  'running',
  'done',
  'uncertain',
  'cancelled',
  'failed',
  'retry_wait',
  'reply_pending',
] as const;

export type MessageInboxStatus = (typeof MESSAGE_INBOX_STATUSES)[number];

export interface MessageInboxRecord {
  id: string;
  message: WeixinMessage;
  status: MessageInboxStatus;
  receivedAt: number;
  errorKind?: string;
  execution?: ExecutionCheckpoint;
}

export interface ExecutionCheckpoint {
  attempt: number;
  phase: 'preparing' | 'dispatched' | 'tool_activity' | 'result_ready';
  sessionId?: string;
  usedTools?: boolean;
  resultText?: string;
  stopReason?: string;
  retryAt?: number;
  noticeQueued?: boolean;
  retryCount?: number;
  sourceTaskId?: string;
  processId?: number;
  groupIds?: string[];
  resultArchived?: boolean;
}

interface StoredRecord extends MessageInboxRecord {
  updatedAt: number;
}

export interface PutResult {
  isNew: boolean;
  record: MessageInboxRecord;
}

export interface RecoverResult {
  pending: MessageInboxRecord[];
  uncertainCount: number;
}

export interface SetStatusOptions {
  errorKind?: string;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'uncertain', 'cancelled', 'failed']);

/** Monotonic ordering. Uncertain is terminal for automatic transitions. */
const STATUS_RANK: Record<MessageInboxStatus, number> = {
  received: 0,
  queued: 1,
  buffered: 2,
  running: 3,
  uncertain: 3,
  done: 4,
  cancelled: 4,
  failed: 4,
  retry_wait: 1,
  reply_pending: 3,
};

const ID_PATTERN = /^[0-9a-f]{64}$/;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 5;

/** Lock files currently held by this process (guards same-pid instance races). */
const HELD_LOCKS = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && (err as NodeJS.ErrnoException).code === 'EPERM');
  }
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((entry) => canonicalize(entry)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + canonicalize(entry));
  }
  return '{' + parts.join(',') + '}';
}

function withoutContextToken(message: WeixinMessage): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...message };
  delete copy.context_token;
  return copy;
}

function normalizeToken(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Stable identity: sender + recipient + server id, digest fallback. */
function computeId(message: WeixinMessage): string {
  const sender = message.from_user_id ?? '';
  const recipient = message.to_user_id ?? '';
  let basis: string;
  if (Number.isSafeInteger(message.message_id) && (message.message_id ?? 0) > 0) {
    basis = 'server\u0000' + sender + '\u0000' + recipient + '\u0000' + String(message.message_id);
  } else if (message.client_id !== undefined && message.client_id !== null && message.client_id !== '') {
    basis = 'client\u0000' + sender + '\u0000' + recipient + '\u0000' + String(message.client_id);
  } else {
    basis = 'digest\u0000' + canonicalize(withoutContextToken(message));
  }
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

export class MessageInbox {
  dir: string;
  _closed: boolean;
  _tail: Promise<void>;
  _readyPromise: Promise<void> | null;

  constructor(options: { dir: string }) {
    if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
      throw new Error('MessageInbox: { dir } is required');
    }
    this.dir = options.dir;
    this._closed = false;
    this._tail = Promise.resolve();
    this._readyPromise = null;
  }

  async _ready(): Promise<void> {
    if (this._readyPromise === null) {
      this._readyPromise = (async () => {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        await fs.chmod(this.dir, 0o700);
      })();
    }
    return this._readyPromise;
  }

  _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this._closed) {
      return Promise.reject(new Error('MessageInbox: closed'));
    }
    const run = this._tail.then(fn, fn);
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  _recordPath(id: string): string {
    return join(this.dir, id + '.json');
  }

  _lockPath(id: string): string {
    return join(this.dir, id + '.lock');
  }

  _validateRecord(parsed: unknown, id: string): asserts parsed is StoredRecord {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`MessageInbox: corrupt receipt ${id}`);
    }
    const record = parsed as Record<string, unknown>;
    if (record.id !== id) {
      throw new Error(`MessageInbox: corrupt receipt ${id} (id mismatch)`);
    }
    if (!record.message || typeof record.message !== 'object') {
      throw new Error(`MessageInbox: corrupt receipt ${id} (message)`);
    }
    if (typeof record.status !== 'string' || !(MESSAGE_INBOX_STATUSES as readonly string[]).includes(record.status)) {
      throw new Error(`MessageInbox: corrupt receipt ${id} (status)`);
    }
    if (typeof record.receivedAt !== 'number' || !Number.isFinite(record.receivedAt)) {
      throw new Error(`MessageInbox: corrupt receipt ${id} (receivedAt)`);
    }
    if (record.execution !== undefined) {
      const execution = record.execution as ExecutionCheckpoint;
      if (!execution || !Number.isSafeInteger(execution.attempt) || execution.attempt < 0 || !['preparing', 'dispatched', 'tool_activity', 'result_ready'].includes(execution.phase) || (execution.retryCount !== undefined && (!Number.isSafeInteger(execution.retryCount) || execution.retryCount < 0))) throw new Error('MessageInbox: corrupt execution checkpoint');
      if ((execution.processId !== undefined && (!Number.isSafeInteger(execution.processId) || execution.processId < 1)) || (execution.usedTools !== undefined && typeof execution.usedTools !== 'boolean') || (execution.retryAt !== undefined && (!Number.isFinite(execution.retryAt) || execution.retryAt < 0)) || (execution.resultText !== undefined && typeof execution.resultText !== 'string') || (execution.groupIds !== undefined && (!Array.isArray(execution.groupIds) || execution.groupIds.length > 50 || !execution.groupIds.includes(id) || execution.groupIds.some(groupId => !ID_PATTERN.test(groupId))))) throw new Error('MessageInbox: corrupt execution evidence');
    }
  }

  async _readRecord(id: string): Promise<StoredRecord | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this._recordPath(id), 'utf8');
    } catch (err) {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`MessageInbox: corrupt receipt ${id}`);
    }
    this._validateRecord(parsed, id);
    return parsed;
  }

  async _writeRecord(record: StoredRecord): Promise<void> {
    this._validateRecord(record, record.id);
    await this._ready();
    const finalPath = this._recordPath(record.id);
    const tmpPath = join(this.dir, '.tmp-' + randomUUID());
    const data = JSON.stringify(record);
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmpPath, finalPath);
    } catch (err) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }
    try {
      const dirHandle = await fs.open(this.dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      /* directory fsync is best effort on some platforms */
    }
  }

  async _acquireLock(id: string): Promise<string> {
    await this._ready();
    const lockPath = this._lockPath(id);
    const candidate = join(this.dir, '.lock-candidate-' + randomUUID());
    const handle = await fs.open(candidate, 'wx', 0o600);
    try { await handle.writeFile(String(process.pid)); await handle.sync(); }
    finally { await handle.close(); }
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    try {
      for (;;) {
        try { await fs.link(candidate, lockPath); HELD_LOCKS.add(lockPath); return lockPath; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const raw = await fs.readFile(lockPath, 'utf8').catch(() => '');
        const owner = Number(raw.trim());
        if (Number.isSafeInteger(owner) && owner > 0 && !isPidAlive(owner)) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) throw new Error('MessageInbox: lock timeout');
        await sleep(LOCK_POLL_MS);
      }
    } finally { await fs.unlink(candidate).catch(() => {}); }
  }

  async _releaseLock(lockPath: string): Promise<void> {
    HELD_LOCKS.delete(lockPath);
    try {
      await fs.unlink(lockPath);
    } catch {
      /* already gone */
    }
  }

  _toPublic(record: StoredRecord): MessageInboxRecord {
    const out: MessageInboxRecord = {
      id: record.id,
      message: record.message,
      status: record.status,
      receivedAt: record.receivedAt,
    };
    if (record.errorKind !== undefined) {
      out.errorKind = record.errorKind;
    }
    if (record.execution) out.execution = structuredClone(record.execution);
    return out;
  }

  async _listIds(): Promise<string[]> {
    const entries = await fs.readdir(this.dir);
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (ID_PATTERN.test(id)) ids.push(id);
    }
    return ids;
  }

  /** Insert an inbound message. Returns whether it was newly recorded. */
  put(message: WeixinMessage): Promise<PutResult> {
    return this._enqueue(async () => {
      await this._ready();
      if (!message || typeof message !== 'object') {
        throw new Error('MessageInbox: put requires a message object');
      }
      const id = computeId(message);
      const lockPath = await this._acquireLock(id);
      try {
        const existing = await this._readRecord(id);
        if (existing === null) {
          const now = Date.now();
          const record: StoredRecord = {
            id,
            message,
            status: 'received',
            receivedAt: now,
            updatedAt: now,
          };
          await this._writeRecord(record);
          return { isNew: true, record: this._toPublic(record) };
        }

        const sameBase =
          canonicalize(withoutContextToken(existing.message)) ===
          canonicalize(withoutContextToken(message));
        if (!sameBase) {
          throw new Error(`MessageInbox: conflicting payload for id ${id}`);
        }

        const incomingToken = normalizeToken(message.context_token);
        const existingToken = normalizeToken(existing.message.context_token);
        if (incomingToken === existingToken) {
          return { isNew: false, record: this._toPublic(existing) };
        }

        const pending = ['received', 'queued', 'retry_wait', 'reply_pending'].includes(existing.status);
        if (incomingToken !== null && pending) {
          existing.message = { ...existing.message, context_token: incomingToken };
          existing.updatedAt = Date.now();
          await this._writeRecord(existing);
          return { isNew: false, record: this._toPublic(existing) };
        }

        // A delivery token refresh cannot make terminal work runnable again.
        // Suppress this duplicate without blocking the entire polling batch.
        return { isNew: false, record: this._toPublic(existing) };
      } finally {
        await this._releaseLock(lockPath);
      }
    });
  }

  /** Advance a receipt's status monotonically; terminal states cannot change. */
  setStatus(id: string, status: MessageInboxStatus, options?: SetStatusOptions): Promise<MessageInboxRecord> {
    return this._enqueue(async () => {
      await this._ready();
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new Error('MessageInbox: invalid receipt id');
      }
      if (!(MESSAGE_INBOX_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`MessageInbox: unknown status ${String(status)}`);
      }
      const lockPath = await this._acquireLock(id);
      try {
        const record = await this._readRecord(id);
        if (record === null) {
          throw new Error(`MessageInbox: unknown receipt ${id}`);
        }
        const current = record.status;
        if (TERMINAL_STATUSES.has(current)) {
          if (status === current) {
            return this._toPublic(record);
          }
          throw new Error(`MessageInbox: cannot resurrect terminal status ${current}`);
        }
        if (STATUS_RANK[status] < STATUS_RANK[current]) {
          throw new Error(`MessageInbox: non-monotonic transition ${current} -> ${status}`);
        }
        record.status = status;
        record.updatedAt = Date.now();
        if (options && options.errorKind !== undefined) {
          record.errorKind = options.errorKind;
        }
        await this._writeRecord(record);
        return this._toPublic(record);
      } finally {
        await this._releaseLock(lockPath);
      }
    });
  }

  /** Journal transitions precede dispatch. Terminal requests cannot be replayed. */
  checkpoint(id: string, patch: Partial<ExecutionCheckpoint>, beginAttempt = false): Promise<MessageInboxRecord> {
    return this._enqueue(async () => {
      await this._ready();
      if (!ID_PATTERN.test(id)) throw new Error('MessageInbox: invalid receipt id');
      const lock = await this._acquireLock(id);
      try {
        const record = await this._readRecord(id);
        if (!record) throw new Error('MessageInbox: unknown receipt');
        if (beginAttempt && TERMINAL_STATUSES.has(record.status)) throw new Error('MessageInbox: cannot restart terminal receipt');
        const old = record.execution;
        record.execution = beginAttempt
          ? { ...patch, attempt: (old?.attempt ?? 0) + 1, phase: 'preparing', retryCount: old?.retryCount ?? 0 }
          : { attempt: old?.attempt ?? 1, phase: old?.phase ?? 'preparing', ...old, ...patch };
        if (beginAttempt) record.status = 'running';
        record.updatedAt = Date.now();
        await this._writeRecord(record);
        return this._toPublic(record);
      } finally { await this._releaseLock(lock); }
    });
  }

  /** Only a checkpoint proving no ACP dispatch permits automatic admission retry. */
  scheduleRetry(id: string, { maxAttempts, delayMs, errorKind }: { maxAttempts: number; delayMs: number; errorKind: string }): Promise<boolean> {
    return this._enqueue(async () => {
      await this._ready();
      if (!ID_PATTERN.test(id)) throw new Error('MessageInbox: invalid receipt id');
      const lock = await this._acquireLock(id);
      try {
        const record = await this._readRecord(id);
        if (!record) throw new Error('MessageInbox: unknown receipt');
        if (TERMINAL_STATUSES.has(record.status) || record.status === 'buffered' || record.execution?.phase === 'result_ready') return false;
        const safe = !record.execution || record.execution.phase === 'preparing';
        if (!safe || record.execution?.usedTools) return false;
        const attempt = record.execution?.attempt ?? 0, retryCount = (record.execution?.retryCount ?? 0) + 1;
        if (retryCount >= maxAttempts) { record.status = 'failed'; }
        else {
          record.status = 'retry_wait';
          record.execution = { attempt, retryCount, phase: 'preparing', retryAt: Date.now() + delayMs };
        }
        record.errorKind = errorKind; record.updatedAt = Date.now();
        await this._writeRecord(record);
        return record.status === 'retry_wait';
      } finally { await this._releaseLock(lock); }
    });
  }

  async cancelForUser(userId: string, exceptId?: string): Promise<void> {
    return this._enqueue(async () => {
      await this._ready();
      for (const id of await this._listIds()) {
        if (id === exceptId) continue;
        const lock = await this._acquireLock(id);
        try {
          const record = await this._readRecord(id);
          if (!record || record.message.from_user_id !== userId || ['done', 'cancelled'].includes(record.status)) continue;
          record.status = 'cancelled'; record.updatedAt = Date.now(); await this._writeRecord(record);
        } finally { await this._releaseLock(lock); }
      }
    });
  }

  /** Reconciliation only accepts a matching, completed control-plane result.
   * It changes delivery state, never dispatches or authorizes an execution. */
  acceptTaskResult(id: string, proof: { sourceRequestId: string; taskId: string; completed: boolean; text: string }): Promise<void> {
    return this._enqueue(async () => {
      await this._ready();
      if (!ID_PATTERN.test(id) || !ID_PATTERN.test(proof.sourceRequestId) || !proof.completed || !/^task_[A-Za-z0-9-]+$/.test(proof.taskId) || !proof.text.trim()) throw new Error('MessageInbox: invalid result reconciliation');
      const lock = await this._acquireLock(id);
      try {
        const record = await this._readRecord(id); if (!record) throw new Error('MessageInbox: unknown receipt');
        const primary = record.execution?.groupIds?.[0] ?? id;
        const root = await this._readRecord(primary);
        if (proof.sourceRequestId !== primary || !root || root.message.from_user_id !== record.message.from_user_id) throw new Error('MessageInbox: mismatched result ownership');
        if (['cancelled', 'done'].includes(record.status)) return;
        record.execution = { ...record.execution, attempt: record.execution?.attempt ?? 0, phase: 'result_ready', resultText: proof.text, stopReason: 'verified_task', sourceTaskId: proof.taskId };
        record.status = 'reply_pending'; record.updatedAt = Date.now(); await this._writeRecord(record);
      } finally { await this._releaseLock(lock); }
    });
  }

  /** List receipts sorted by arrival, optionally filtered by status. */
  async list(options?: { statuses?: readonly MessageInboxStatus[] }): Promise<MessageInboxRecord[]> {
    await this._tail;
    await this._ready();
    const ids = await this._listIds();
    const filter = options && options.statuses ? new Set<string>(options.statuses) : null;
    const records: StoredRecord[] = [];
    for (const id of ids) {
      const record = await this._readRecord(id);
      if (record === null) continue;
      if (filter && !filter.has(record.status)) continue;
      records.push(record);
    }
    records.sort((a, b) => {
      if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return records.map((record) => this._toPublic(record));
  }

  /**
   * Recover after a restart. running/buffered work becomes uncertain and is
   * never auto-replayed. Returns pending (received/queued) and the total number
   * of uncertain receipts.
   */
  recover(): Promise<RecoverResult> {
    return this._enqueue(async () => {
      await this._ready();
      const ids = await this._listIds();
      const pending: StoredRecord[] = [];
      let uncertainCount = 0;
      for (const id of ids) {
        const lockPath = await this._acquireLock(id);
        try {
          const record = await this._readRecord(id);
          if (record === null) continue;
          if (record.status === 'running' || record.status === 'buffered') {
            record.status = record.execution?.phase === 'result_ready' ? 'reply_pending'
              : record.execution?.phase === 'preparing' && !record.execution.usedTools ? 'queued' : 'uncertain';
            record.updatedAt = Date.now();
            await this._writeRecord(record);
          }
          if (record.status === 'received' || record.status === 'queued' || (record.status === 'retry_wait' && (record.execution?.retryAt ?? 0) <= Date.now())) {
            pending.push(record);
          }
          if (record.status === 'uncertain') {
            uncertainCount += 1;
          }
        } finally {
          await this._releaseLock(lockPath);
        }
      }
      pending.sort((a, b) => {
        if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return { pending: pending.map((record) => this._toPublic(record)), uncertainCount };
    });
  }

  /** Wait for in-flight mutations to drain and refuse further mutation. */
  async close(): Promise<void> {
    this._closed = true;
    await this._tail;
  }
}
