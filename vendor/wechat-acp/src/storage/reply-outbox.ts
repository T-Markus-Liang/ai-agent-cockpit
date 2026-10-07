import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ReplyRecord = {
  id: string;
  clientId: string;
  userId: string;
  contextToken: string;
  text: string;
  receiptIds: string[];
  kind: 'reply' | 'notice';
  status: 'pending' | 'sending' | 'sent' | 'blocked' | 'cancelled';
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  sequence: number;
  errorKind?: string;
};

const KINDS = ['reply', 'notice'] as const;
const STATUSES = ['pending', 'sending', 'sent', 'blocked', 'cancelled'] as const;
const TERMINAL = ['sent', 'blocked', 'cancelled'] as const;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sanitizeErrorKind(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

function parseRecord(raw: string, source: string): ReplyRecord {
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    throw new Error(`reply outbox: corrupt record ${source}`);
  }
  const bad = (why: string): never => {
    throw new Error(`reply outbox: corrupt ${why} ${source}`);
  };
  if (typeof p !== 'object' || p === null || Array.isArray(p)) bad('record');
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) bad('id');
  if (typeof p.clientId !== 'string' || !p.clientId.startsWith('wechat-acp-')) bad('clientId');
  for (const field of ['userId', 'contextToken', 'text'] as const) {
    if (typeof p[field] !== 'string' || p[field].length === 0) bad(field);
  }
  if (!Array.isArray(p.receiptIds) || !p.receiptIds.every((v: unknown) => typeof v === 'string' && v.length > 0)) bad('receiptIds');
  if (!(KINDS as readonly string[]).includes(p.kind)) bad('kind');
  if (!(STATUSES as readonly string[]).includes(p.status)) bad('status');
  if (!Number.isInteger(p.attempts) || p.attempts < 0) bad('attempts');
  if (!Number.isFinite(p.createdAt) || !Number.isFinite(p.nextAttemptAt)) bad('timestamps');
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1) bad('sequence');
  if (p.errorKind !== undefined && typeof p.errorKind !== 'string') bad('errorKind');
  return {
    id: p.id,
    clientId: p.clientId,
    userId: p.userId,
    contextToken: p.contextToken,
    text: p.text,
    receiptIds: [...p.receiptIds] as string[],
    kind: p.kind as ReplyRecord['kind'],
    status: p.status as ReplyRecord['status'],
    attempts: p.attempts as number,
    createdAt: p.createdAt as number,
    nextAttemptAt: p.nextAttemptAt as number,
    sequence: p.sequence as number,
    ...(p.errorKind !== undefined ? { errorKind: p.errorKind as string } : {}),
  };
}

export class ReplyOutbox {
  private readonly dir: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: { dir: string; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; now?: () => number }) {
    if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
      throw new Error('reply outbox: dir required');
    }
    this.dir = options.dir;
    this.maxAttempts = options.maxAttempts ?? 96;
    this.baseDelayMs = options.baseDelayMs ?? 15_000;
    this.maxDelayMs = options.maxDelayMs ?? 900_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10000 || !Number.isFinite(this.baseDelayMs) || this.baseDelayMs < 1 || !Number.isFinite(this.maxDelayMs) || this.maxDelayMs < this.baseDelayMs) throw new Error('reply outbox: invalid retry policy');
    this.ready = fs
      .mkdir(this.dir, { recursive: true, mode: 0o700 })
      .then(() => fs.chmod(this.dir, 0o700));
    void this.ready.catch(() => {});
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('reply outbox: closed'));
    const task = this.tail.then(async () => {
      await this.ready;
      return fn();
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async settleTail(): Promise<void> {
    await this.ready;
    await this.tail;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async load(id: string): Promise<ReplyRecord | undefined> {
    if (!ID_RE.test(id)) throw new Error('reply outbox: invalid id');
    let raw: string;
    try {
      raw = await fs.readFile(this.file(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const record = parseRecord(raw, this.file(id));
    if (record.id !== id) throw new Error('reply outbox: corrupt identity');
    return record;
  }

  private async loadAll(): Promise<ReplyRecord[]> {
    const records: ReplyRecord[] = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        const record = parseRecord(await fs.readFile(file, 'utf8'), file);
        if (name !== `${record.id}.json`) throw new Error('reply outbox: corrupt identity');
        records.push(record);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
    return records;
  }

  private async persist(record: ReplyRecord): Promise<void> {
    const tmp = path.join(this.dir, `${record.id}.${randomUUID()}.tmp`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.file(record.id));
    try {
      const dirHandle = await fs.open(this.dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      /* best-effort directory fsync */
    }
  }

  private backoff(attempts: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(0, attempts - 1), this.maxDelayMs);
  }

  async put(input: { userId: string; contextToken: string; text: string; receiptIds?: string[]; kind?: 'reply' | 'notice'; dedupeKey?: string }): Promise<ReplyRecord> {
    return this.run(async () => {
      const ask = (value: unknown, field: string): string => {
        if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`reply outbox: invalid ${field}`);
        return value;
      };
      const userId = ask(input?.userId, 'userId');
      const contextToken = ask(input?.contextToken, 'contextToken');
      const text = ask(input?.text, 'text');
      const kind = input.kind ?? 'reply';
      if (!(KINDS as readonly string[]).includes(kind)) throw new Error('reply outbox: invalid kind');
      const receiptIds = input.receiptIds ?? [];
      if (!Array.isArray(receiptIds) || receiptIds.some((v) => ask(v, 'receiptId') !== v)) throw new Error('reply outbox: invalid receiptIds');
      const dedupeKey = input.dedupeKey;
      if (dedupeKey !== undefined) ask(dedupeKey, 'dedupeKey');

      let id: string;
      if (dedupeKey !== undefined) {
        id = createHash('sha256').update(JSON.stringify([userId, dedupeKey]), 'utf8').digest('hex');
        const existing = await this.load(id);
        if (existing) {
          if (existing.text !== text || existing.kind !== kind || !sameIds(existing.receiptIds, receiptIds)) {
            throw new Error('reply outbox: dedupe key conflict');
          }
          if (existing.status === 'pending' && existing.contextToken !== contextToken) {
            const refreshed: ReplyRecord = { ...existing, contextToken };
            await this.persist(refreshed);
            return refreshed;
          }
          return existing;
        }
      } else {
        id = randomUUID();
      }

      const at = this.now();
      const record: ReplyRecord = {
        id,
        clientId: `wechat-acp-${randomUUID()}`,
        userId,
        contextToken,
        text,
        receiptIds: [...receiptIds],
        kind: kind as ReplyRecord['kind'],
        status: 'pending',
        attempts: 0,
        createdAt: at,
        nextAttemptAt: at,
        sequence: (await this.loadAll()).reduce((max, record) => Math.max(max, record.sequence), 0) + 1,
      };
      await this.persist(record);
      return record;
    });
  }

  async get(id: string): Promise<ReplyRecord | undefined> {
    await this.settleTail();
    return this.load(id);
  }

  async list(query: { userId?: string; statuses?: string[] } = {}): Promise<ReplyRecord[]> {
    if (query.statuses !== undefined && !query.statuses.every((s) => (STATUSES as readonly string[]).includes(s))) {
      throw new Error('reply outbox: invalid statuses');
    }
    await this.settleTail();
    const order = (a: ReplyRecord, b: ReplyRecord) => a.sequence - b.sequence;
    return (await this.loadAll())
      .filter((r) => query.userId === undefined || r.userId === query.userId)
      .filter((r) => query.statuses === undefined || query.statuses.includes(r.status))
      .sort(order);
  }

  async claimDue(options: { userId?: string; limit?: number; force?: boolean } = {}): Promise<ReplyRecord[]> {
    return this.run(async () => {
      const force = options.force ?? false;
      const limit = options.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('reply outbox: invalid limit');
      const at = this.now();
      const order = (a: ReplyRecord, b: ReplyRecord) => a.sequence - b.sequence;
      const byUser = new Map<string, ReplyRecord[]>();
      for (const record of await this.loadAll()) {
        if (record.status !== 'pending' && record.status !== 'sending') continue;
        if (options.userId !== undefined && record.userId !== options.userId) continue;
        const group = byUser.get(record.userId);
        if (group) group.push(record);
        else byUser.set(record.userId, [record]);
      }
      const candidates: ReplyRecord[] = [];
      for (const group of byUser.values()) {
        group.sort(order);
        const head = group[0];
        if (head.status !== 'pending' || head.attempts >= this.maxAttempts) continue;
        if (!force && head.nextAttemptAt > at) continue;
        candidates.push(head);
      }
      candidates.sort(order);
      const claimed: ReplyRecord[] = [];
      for (const record of candidates) {
        if (claimed.length >= limit) break;
        const next: ReplyRecord = { ...record, status: 'sending', attempts: record.attempts + 1 };
        await this.persist(next);
        claimed.push(next);
      }
      return claimed;
    });
  }

  async settle(id: string, input: { sent: boolean; errorKind?: string }): Promise<ReplyRecord> {
    return this.run(async () => {
      const record = await this.load(id);
      if (!record) throw new Error('reply outbox: record not found');
      if ((TERMINAL as readonly string[]).includes(record.status)) return record;
      if (record.status !== 'sending') throw new Error('reply outbox: record not sending');
      const at = this.now();
      if (input.sent) {
        const { errorKind: _drop, ...rest } = record;
        const done: ReplyRecord = { ...rest, status: 'sent', nextAttemptAt: at };
        await this.persist(done);
        return done;
      }
      const errorKind = sanitizeErrorKind(input.errorKind);
      const next: ReplyRecord = record.attempts >= this.maxAttempts
        ? { ...record, status: 'blocked', nextAttemptAt: at }
        : { ...record, status: 'pending', nextAttemptAt: at + this.backoff(record.attempts) };
      if (errorKind === undefined) delete next.errorKind;
      else next.errorKind = errorKind;
      await this.persist(next);
      return next;
    });
  }

  async recover(): Promise<void> {
    return this.run(async () => {
      const at = this.now();
      for (const record of await this.loadAll()) {
        if (record.status !== 'sending') continue;
        await this.persist({ ...record, status: record.attempts >= this.maxAttempts ? 'blocked' : 'pending', nextAttemptAt: Math.min(record.nextAttemptAt, at) });
      }
    });
  }

  async refreshContext(userId: string, contextToken: string): Promise<void> {
    return this.run(async () => {
      if (!userId || !contextToken) throw new Error('reply outbox: invalid context refresh');
      for (const record of await this.loadAll()) {
        if (record.userId !== userId) continue;
        if (record.status !== 'pending' && record.status !== 'sending') continue;
        if (record.contextToken === contextToken) continue;
        await this.persist({ ...record, contextToken });
      }
    });
  }

  async cancelForUser(userId: string): Promise<void> {
    return this.run(async () => {
      if (!userId) throw new Error('reply outbox: invalid userId');
      for (const record of await this.loadAll()) {
        if (record.userId !== userId) continue;
        if (record.status !== 'pending' && record.status !== 'sending') continue;
        await this.persist({ ...record, status: 'cancelled' });
      }
    });
  }

  /** Explicit user /acp-more renews only delivery attempts, never task execution. */
  async retryBlockedForUser(userId: string): Promise<void> {
    return this.run(async () => {
      for (const record of await this.loadAll()) if (record.userId === userId && record.status === 'blocked') await this.persist({ ...record, status: 'pending', attempts: 0, nextAttemptAt: this.now() });
    });
  }

  async cancelForReceipts(ids: string[]): Promise<void> {
    return this.run(async () => {
      for (const record of await this.loadAll()) if (record.receiptIds.some(id => ids.includes(id)) && ['pending', 'sending'].includes(record.status)) await this.persist({ ...record, status: 'cancelled' });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.ready, this.tail]);
  }
}
