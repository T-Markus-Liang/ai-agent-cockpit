/**
 * Durable runtime Submission registry for inbound WeChat receipts.
 *
 * Purpose (docs/handoffs/p3-readiness-r1.md:30): the bridge already has a
 * stable *receipt* identity (`MessageInbox` id = sourceRequestId) but no durable
 * *runtime Submission* identity. This module records, exactly once per inbound
 * receipt, a persistent registration that a later Wave can bind to an execution
 * route. This slice only registers the submission; it carries no dispatch link
 * yet (no speculative fields).
 *
 * Design goals (mirroring the storage idiom of reply-outbox.ts / message-inbox.ts):
 *  - Durable: uuid temp file + fsync + atomic rename, 0700 dir, 0600 records.
 *  - Idempotent: re-registering the same receiptId with the same payload digest
 *    (and owner) returns the existing record and writes nothing.
 *  - Fail closed: the same receiptId with a *different* digest (or owner) throws
 *    "registration-conflict" and changes no state; invalid/missing parameters
 *    throw "invalid-registration"; a corrupt stored record poisons the registry
 *    instead of being silently dropped.
 *  - Poisoned store: any failed durable write — or a corrupt record discovered
 *    while loading — puts the registry into a poisoned state where every API
 *    refuses with "store-poisoned" until an explicit recover() reloads and
 *    re-validates from disk (or the instance is rebuilt). Never a fake success.
 *  - Recoverable: recover() re-reads the durable truth and clears the poison;
 *    close() refuses every later API with "store-closed".
 *  - Serialized: an in-process promise queue serializes all mutations.
 *
 * Semantics are aligned with the durable route-binding store
 * (runtime/route-binding-store.mjs, "r2" slice) — persistence, source/format
 * validation on load, poison fail-closed on write failure, idempotent/conflict
 * behaviour and close() refusal — WITHOUT importing that module. The route
 * binding store is a root-side `node:sqlite` module; this package (engines:
 * Node >= 20, file-only storage, tsc strict, no cross-package imports) reuses
 * its *semantic contract* rather than its implementation, preserving the
 * package boundary. The actual execution-time runtime binding stays the root
 * route-binding store's job (a later Wave).
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WeixinMessage } from '../weixin/types.js';

/** The only submission state in this slice. Dispatch links arrive later. */
export const SUBMISSION_STATE = 'registered' as const;

export interface SubmissionRegistration {
  receiptId: string;
  userId: string;
  payloadDigest: string;
  registeredAt: number;
  state: 'registered';
}

/** Fail-closed denial. `code` identifies the reason for audit and tests. */
export class SubmissionRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? `submission registry rejected: ${code}`);
    this.name = 'SubmissionRegistryError';
    this.code = code;
  }
}

/** Safe on-disk file stem: covers 64-hex inbox ids and readable test ids. */
const RECEIPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Deterministic JSON with recursively sorted object keys (mirrors message-inbox). */
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

/** The canonical payload form: the message body without its delivery context_token. */
function withoutContextToken(message: WeixinMessage): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...message };
  delete copy.context_token;
  return copy;
}

/**
 * Content fingerprint of an inbound message payload: sha256 over the canonical
 * (sorted-key) message body with the volatile delivery context_token removed.
 * The bridge passes this as the submission's payloadDigest. The inbox record
 * exposes no separate payload digest — its `id` is the sha256 *identity* digest
 * (sender + recipient + server id, with a whole-payload fallback) and is the
 * receipt id itself — so the digest is computed from the normalized body, which
 * keeps payloadDigest independent of the receipt id and the conflict guard
 * meaningful.
 */
export function computePayloadDigest(message: WeixinMessage): string {
  return createHash('sha256').update(canonicalize(withoutContextToken(message)), 'utf8').digest('hex');
}

/** Parse and validate a stored record; any shape violation is fail-closed. */
function parseRegistration(raw: string, source: string): SubmissionRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt record ${source}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt record ${source}`);
  }
  const p = parsed as Record<string, unknown>;
  const receiptId = p.receiptId;
  const userId = p.userId;
  const payloadDigest = p.payloadDigest;
  const registeredAt = p.registeredAt;
  if (typeof receiptId !== 'string' || !RECEIPT_ID_RE.test(receiptId)) {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt receiptId ${source}`);
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt userId ${source}`);
  }
  if (typeof payloadDigest !== 'string' || payloadDigest.length === 0) {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt payloadDigest ${source}`);
  }
  if (typeof registeredAt !== 'number' || !Number.isFinite(registeredAt)) {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt registeredAt ${source}`);
  }
  if (p.state !== SUBMISSION_STATE) {
    throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt state ${source}`);
  }
  return Object.freeze({
    receiptId,
    userId,
    payloadDigest,
    registeredAt,
    state: SUBMISSION_STATE,
  });
}

export class SubmissionRegistry {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private poisonReason: string | null = null;
  private readonly records = new Map<string, SubmissionRegistration>();

  constructor(options: { dir: string; now?: () => number }) {
    if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
      throw new Error('submission registry: dir required');
    }
    const dir = options.dir;
    this.dir = dir;
    this.now = options.now ?? Date.now;
    // Load the durable truth eagerly; a corrupt record poisons the registry
    // rather than throwing out of the constructor (the bridge constructs this
    // synchronously and the first register() must fail closed, not crash boot).
    this.ready = (async () => {
      try {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.chmod(dir, 0o700);
        const loaded = await this.readAll();
        this.records.clear();
        for (const record of loaded) this.records.set(record.receiptId, record);
      } catch (error) {
        this.poisonReason = error instanceof Error ? error.message : String(error);
      }
    })();
    void this.ready.catch(() => {});
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new SubmissionRegistryError('store-closed', 'the submission registry is closed'));
    }
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

  /**
   * Fail-closed usability gate shared by every API. Once closed or poisoned
   * (a durable write failed, or a corrupt record was found on load), every
   * read/write/idempotent retry is refused with an honest reason.
   */
  private assertUsable(): void {
    if (this.closed) throw new SubmissionRegistryError('store-closed', 'the submission registry is closed');
    if (this.poisonReason !== null) {
      throw new SubmissionRegistryError('store-poisoned', `the submission registry is poisoned: ${this.poisonReason}`);
    }
  }

  private file(receiptId: string): string {
    return path.join(this.dir, `${receiptId}.json`);
  }

  private async readAll(): Promise<SubmissionRegistration[]> {
    const out: SubmissionRegistration[] = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const source = path.join(this.dir, name);
      let raw: string;
      try {
        raw = await fs.readFile(source, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const record = parseRegistration(raw, source);
      if (name !== `${record.receiptId}.json`) {
        throw new SubmissionRegistryError('invalid-registration', `submission registry: corrupt identity ${source}`);
      }
      out.push(record);
    }
    return out;
  }

  /** Atomic write: uuid temp + fsync + rename, 0600, best-effort dir fsync. */
  private async persist(record: SubmissionRegistration): Promise<void> {
    const tmp = path.join(this.dir, `${record.receiptId}.${randomUUID()}.tmp`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, this.file(record.receiptId));
    } catch (error) {
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore cleanup failure */
      }
      throw error;
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

  /**
   * Enter the poisoned state after a failed write path. The durable truth is
   * re-read (best effort); if even that fails the in-memory map is emptied so
   * no unpersisted record can survive as authoritative. Either way every API
   * now rejects until an explicit recover().
   */
  private async poisonAfterWriteFailure(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const reloaded = await this.readAll();
      this.records.clear();
      for (const record of reloaded) this.records.set(record.receiptId, record);
      this.poisonReason = reason;
    } catch (reloadError) {
      this.records.clear();
      this.poisonReason = `${reason}; reload also failed: ${reloadError instanceof Error ? reloadError.message : String(reloadError)}`;
    }
  }

  /**
   * Register an inbound receipt exactly once.
   *  - same receiptId + same digest + same owner -> idempotent, returns the
   *    existing record and writes nothing;
   *  - same receiptId + different digest (or owner) -> "registration-conflict",
   *    zero state change;
   *  - missing / wrongly-typed fields -> "invalid-registration".
   */
  register(input: { receiptId: string; userId: string; payloadDigest: string }): Promise<SubmissionRegistration> {
    return this.run(async () => {
      this.assertUsable();
      const receiptId = input?.receiptId;
      const userId = input?.userId;
      const payloadDigest = input?.payloadDigest;
      if (typeof receiptId !== 'string' || !RECEIPT_ID_RE.test(receiptId)) {
        throw new SubmissionRegistryError('invalid-registration', 'submission registry: invalid receiptId');
      }
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new SubmissionRegistryError('invalid-registration', 'submission registry: invalid userId');
      }
      if (typeof payloadDigest !== 'string' || payloadDigest.length === 0) {
        throw new SubmissionRegistryError('invalid-registration', 'submission registry: invalid payloadDigest');
      }
      const existing = this.records.get(receiptId);
      if (existing !== undefined) {
        if (existing.payloadDigest === payloadDigest && existing.userId === userId) return existing;
        throw new SubmissionRegistryError('registration-conflict', `submission registry: receipt ${receiptId} already registered with a different payload digest or owner`);
      }
      const record: SubmissionRegistration = Object.freeze({
        receiptId,
        userId,
        payloadDigest,
        registeredAt: this.now(),
        state: SUBMISSION_STATE,
      });
      try {
        await this.persist(record);
      } catch (error) {
        await this.poisonAfterWriteFailure(error);
        throw error;
      }
      this.records.set(receiptId, record);
      return record;
    });
  }

  getRegistration(receiptId: string): Promise<SubmissionRegistration | undefined> {
    return this.run(async () => {
      this.assertUsable();
      if (typeof receiptId !== 'string' || !RECEIPT_ID_RE.test(receiptId)) {
        throw new SubmissionRegistryError('invalid-registration', 'submission registry: invalid receiptId');
      }
      return this.records.get(receiptId);
    });
  }

  has(receiptId: string): Promise<boolean> {
    return this.run(async () => {
      this.assertUsable();
      if (typeof receiptId !== 'string' || !RECEIPT_ID_RE.test(receiptId)) {
        throw new SubmissionRegistryError('invalid-registration', 'submission registry: invalid receiptId');
      }
      return this.records.has(receiptId);
    });
  }

  count(): Promise<number> {
    return this.run(async () => {
      this.assertUsable();
      return this.records.size;
    });
  }

  /**
   * Explicit controlled recovery: reload and re-validate the durable truth,
   * clearing the poison. If the reload fails the registry stays poisoned.
   */
  recover(): Promise<void> {
    return this.run(async () => {
      if (this.closed) throw new SubmissionRegistryError('store-closed', 'the submission registry is closed');
      let reloaded: SubmissionRegistration[];
      try {
        reloaded = await this.readAll();
      } catch (error) {
        this.poisonReason = error instanceof Error ? error.message : String(error);
        throw new SubmissionRegistryError('store-poisoned', `submission registry: recovery failed: ${this.poisonReason}`);
      }
      this.records.clear();
      for (const record of reloaded) this.records.set(record.receiptId, record);
      this.poisonReason = null;
    });
  }

  /** Drain in-flight work and refuse every later API. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.ready, this.tail]);
  }
}
