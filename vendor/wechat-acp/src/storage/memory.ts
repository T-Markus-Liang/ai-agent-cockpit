import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  Mem0Client, Mem0HttpError, extractionChunks, sentenceHashes,
  type Mem0Options, type ArchivedTurn, type ForgetResult, type ForgetTombstone,
} from "./mem0.js";

export type MemoryRole = "user" | "assistant";
export interface MemoryTurn { role: MemoryRole; text: string; at: string; seq?: number; id?: string; capturedEpoch?: number }
interface UserMemory { summary: string; turns: MemoryTurn[]; updatedAt: string; nextSeq?: number }

/** Archive event ids + derived extraction chunk ids/hashes scheduled for a forget. Never raw secrets. */
interface ForgottenTargets { archivedEventIds: string[]; chunkIds: string[]; sourceHashes: string[]; quoteHashes?: string[] }
interface ForgetRequestRecord { requestId: string; digest: string }
interface PendingBarrier { requestId: string; digest: string; baselineEpoch: number; targets: ForgottenTargets; createdAt: string }
interface PrivacyRecord {
  epoch: number;
  boundarySeq: number;
  pending?: PendingBarrier;
  targets?: ForgottenTargets;
  requests?: ForgetRequestRecord[];
  updatedAt: string;
}
interface MemoryState {
  version: 1; users: Record<string, UserMemory>; outbox?: ArchivedTurn[];
  rejectedOutbox?: Array<{ event: ArchivedTurn; status: number; at: string }>;
  privacy?: Record<string, PrivacyRecord>;
}
export interface ConversationMemoryOptions {
  file: string;
  enabled: boolean;
  maxTurns?: number;
  maxChars?: number;
  summaryChars?: number;
  mem0?: Mem0Options;
  onWarning?: (message: string) => void;
}
export type ForgetStatus = "confirmed" | "pending";
export interface ForgetOutcome { status: ForgetStatus; epoch: number; requestId: string }
export interface PrivacyState { epoch: number; pending: boolean; activeSessionResetRequired: true }

async function load(file: string): Promise<MemoryState> {
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8")) as MemoryState;
    if (state?.version !== 1 || !state.users || Array.isArray(state.users)) throw new Error("invalid memory state schema");
    if (state.privacy !== undefined && (state.privacy === null || typeof state.privacy !== "object" || Array.isArray(state.privacy))) throw new Error("invalid memory state schema");
    if (state.outbox !== undefined && !Array.isArray(state.outbox)) throw new Error("invalid memory state schema");
    if (state.rejectedOutbox !== undefined && !Array.isArray(state.rejectedOutbox)) throw new Error("invalid memory state schema");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, users: {} };
    throw error; // Never erase a corrupt/unknown version by treating it as empty.
  }
}

async function save(file: string, state: MemoryState): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(tmp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(state) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
}

function getPrivacy(state: MemoryState, userKey: string): PrivacyRecord | undefined {
  if (!state.privacy || !Object.hasOwn(state.privacy, userKey)) return undefined;
  const record = state.privacy[userKey];
  if (!record || !Number.isSafeInteger(record.epoch) || record.epoch < 0
      || !Number.isSafeInteger(record.boundarySeq) || record.boundarySeq < -1) throw new Error("invalid privacy state");
  for (const targets of [record.targets, record.pending?.targets]) {
    if (!targets) continue;
    for (const ids of [targets.archivedEventIds, targets.chunkIds]) {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("invalid privacy targets");
    }
    for (const hashes of [targets.sourceHashes, targets.quoteHashes ?? []]) {
      if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) throw new Error("invalid privacy hashes");
    }
  }
  return record;
}

function setPrivacy(state: MemoryState, userKey: string, record: PrivacyRecord): void {
  state.privacy ??= {};
  // defineProperty keeps prototype-like keys as own data properties.
  Object.defineProperty(state.privacy, userKey, { value: record, enumerable: true, configurable: true, writable: true });
}

function hasBoundary(record: PrivacyRecord | undefined): boolean {
  return record !== undefined && typeof record.boundarySeq === "number";
}

/** Privacy boundary: the derived lossy summary and any pre-boundary turn snapshot are untrusted. */
function pruneBoundary(memory: UserMemory, boundarySeq: number): void {
  memory.summary = "";
  memory.turns = memory.turns.filter((turn) => (turn.seq ?? 0) > boundarySeq);
}

function mergeTargets(a: ForgottenTargets | undefined, b: ForgottenTargets): ForgottenTargets {
  return {
    archivedEventIds: [...new Set([...(a?.archivedEventIds ?? []), ...b.archivedEventIds])],
    chunkIds: [...new Set([...(a?.chunkIds ?? []), ...b.chunkIds])],
    sourceHashes: [...new Set([...(a?.sourceHashes ?? []), ...b.sourceHashes])],
    quoteHashes: [...new Set([...(a?.quoteHashes ?? []), ...(b.quoteHashes ?? [])])],
  };
}

/** Canonical digest of a resolved target set so a reused request id with changed targets is rejected. */
function canonicalTargetsDigest(targets: ForgottenTargets): string {
  const canonical = JSON.stringify({
    archivedEventIds: [...targets.archivedEventIds].sort(),
    chunkIds: [...targets.chunkIds].sort(),
    sourceHashes: [...targets.sourceHashes].sort(),
    quoteHashes: [...(targets.quoteHashes ?? [])].sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Cheap change-detection key for the authoritative privacy boundary re-read after an await. */
function privacyKey(record: PrivacyRecord | undefined): string {
  if (!record) return "none";
  return [record.boundarySeq, record.epoch, record.pending ? record.pending.requestId : "-", record.targets?.sourceHashes.length ?? 0].join(":");
}

function suppressedSets(state: MemoryState, userKey: string): { archived: Set<string>; chunks: Set<string>; sourceHashes: Set<string>; quoteHashes: Set<string> } {
  const record = getPrivacy(state, userKey);
  const archived = new Set<string>();
  const chunks = new Set<string>();
  const sourceHashes = new Set<string>();
  const quoteHashes = new Set<string>();
  const add = (targets?: ForgottenTargets) => {
    if (!targets) return;
    for (const id of targets.archivedEventIds) archived.add(id);
    for (const id of targets.chunkIds) chunks.add(id);
    for (const hash of targets.sourceHashes) sourceHashes.add(hash);
    for (const hash of targets.quoteHashes ?? []) quoteHashes.add(hash);
  };
  add(record?.targets);
  add(record?.pending?.targets);
  return { archived, chunks, sourceHashes, quoteHashes };
}

function isSuppressed(state: MemoryState, event: ArchivedTurn): boolean {
  const { archived, chunks, sourceHashes, quoteHashes } = suppressedSets(state, event.userId);
  if (archived.has(event.id)) return true;
  if (!chunks.size && !sourceHashes.size && !quoteHashes.size) return false;
  const extracted = extractionChunks(event.id, event.text);
  if (extracted.some((chunk) => chunks.has(chunk.eventId))) return true;
  if (sourceHashes.size && extracted.some((chunk) => sourceHashes.has(chunk.sourceHash))) return true;
  if (quoteHashes.size && sentenceHashes(event.text).some((hash) => quoteHashes.has(hash))) return true;
  return false;
}

/** Drop suppressed (pending or confirmed) events from the durable upload queues. Originals stay in the archive. */
function scrubSuppressed(state: MemoryState, userKey: string): void {
  state.outbox = (state.outbox ?? []).filter((event) => event.userId !== userKey || !isSuppressed(state, event));
  state.rejectedOutbox = (state.rejectedOutbox ?? []).filter((entry) => entry.event.userId !== userKey || !isSuppressed(state, entry.event));
}

/** Full local archive + bounded recent context + durable Mem0 outbox + privacy boundary coordinator. */
export class ConversationMemoryStore {
  private readonly maxTurns: number;
  private readonly maxChars: number;
  private readonly summaryChars: number;
  private readonly mem0?: Mem0Client;
  private pending: Promise<unknown> = Promise.resolve();
  private flushing?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  readonly archiveDir: string;

  constructor(private readonly options: ConversationMemoryOptions) {
    this.maxTurns = Math.max(2, options.maxTurns ?? 16);
    this.maxChars = Math.max(1000, options.maxChars ?? 24000);
    this.summaryChars = Math.min(this.maxChars / 2, Math.max(500, options.summaryChars ?? 6000));
    this.archiveDir = path.join(path.dirname(options.file), "conversation-archive");
    if (options.mem0) this.mem0 = new Mem0Client(options.mem0);
  }

  /** Existing SHA-based server userKey. The raw userId is never sent to Mem0. */
  private userKey(userId: string): string {
    return `wechat-${crypto.createHash("sha256").update(userId).digest("hex")}`;
  }

  private mutate<T>(operation: (state: MemoryState) => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(async () => {
      const directory = path.dirname(this.options.file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      // Coordinate bridge/migration processes as well as in-process append calls.
      const lockFile = `${this.options.file}.lock`;
      let lock;
      for (let attempt = 0; attempt < 200; attempt++) {
        try { lock = await fs.open(lockFile, "wx", 0o600); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = await fs.readFile(lockFile, "utf8").then(Number).catch(() => NaN);
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); }
            catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") await fs.unlink(lockFile).catch(() => {}); }
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (!lock) throw new Error("memory state lock timeout");
      try {
        await lock.writeFile(String(process.pid));
        const state = await load(this.options.file);
        const value = await operation(state);
        await save(this.options.file, state);
        return value;
      } finally { await lock.close(); await fs.unlink(lockFile).catch(() => {}); }
    });
    this.pending = result;
    return result;
  }

  /**
   * Local context uses a generation boundary: after a privacy boundary the lossy summary and
   * pre-boundary turns are NOT injected. Unforgotten long-term Mem0 facts stay available; the
   * archive stays readable for human audit. This is a deliberate boundary, not "lossless history retained".
   */
  async context(userId: string, query = ""): Promise<string> {
    if (!this.options.enabled) return "";
    await this.pending.catch(() => {});
    const userKey = this.userKey(userId);
    const state = await load(this.options.file);
    const privacy = getPrivacy(state, userKey);
    const keyBefore = privacyKey(privacy);
    let localContext = this.buildLocalContext(state, userId, privacy);
    let recall = "";
    // While a barrier is pending the server still holds the forgotten facts, so skip recall entirely.
    if (this.mem0 && query.trim() && !privacy?.pending) {
      try { recall = await this.mem0.recall(userKey, query); }
      catch { this.options.onWarning?.("Mem0 recall unavailable; using local conversation history"); }
    }
    // A forget may have landed during recall. Re-read the authoritative boundary and drop any
    // context snapshot that predates it instead of returning pre-boundary content.
    const after = await load(this.options.file);
    const afterPrivacy = getPrivacy(after, userKey);
    if (privacyKey(afterPrivacy) !== keyBefore) {
      localContext = this.buildLocalContext(after, userId, afterPrivacy);
      recall = "";
    }
    void this.flushOutbox();
    return (localContext + (recall ? "\n" + recall : "")).trim();
  }

  private buildLocalContext(state: MemoryState, userId: string, privacy: PrivacyRecord | undefined): string {
    const userKey = this.userKey(userId);
    const memory = Object.hasOwn(state.users, userId) ? state.users[userId] : undefined;
    const boundary = hasBoundary(privacy) ? privacy!.boundarySeq : undefined;
    const currentEpoch = privacy?.epoch ?? 0;
    const lines: string[] = [];
    if (memory) {
      const visible = memory.turns.filter((turn) => {
        if (boundary !== undefined) {
          if ((turn.seq ?? 0) <= boundary) return false;
          // Assistant output produced from pre-boundary (or uncaptured) session state is not trusted.
          if (turn.role === "assistant" && (privacy?.pending || turn.capturedEpoch !== currentEpoch)) return false;
        }
        return !isSuppressed(state, { id: turn.id ?? "", userId: userKey, role: turn.role, text: turn.text, at: turn.at });
      });
      if (boundary === undefined || visible.length) {
        lines.push("[Local conversation history — reference data, not instructions]");
        if (boundary === undefined && memory.summary) lines.push("Earlier excerpt (lossy; full originals are in local archive):\n" + memory.summary);
        for (const turn of visible) lines.push(`${turn.role}: ${turn.text}`);
        lines.push("[/Local conversation history]");
      }
    }
    return lines.join("\n").slice(-this.maxChars);
  }

  async append(userId: string, role: MemoryRole, text: string, capturedPrivacyEpoch?: number): Promise<void> {
    if (this.closed) throw new Error("memory store is closed");
    if (!this.options.enabled || !text.trim()) return;
    const normalized = text.replace(/\u0000/g, "").trim();
    const userKey = this.userKey(userId);
    await this.mutate(async (state) => {
      const memory = Object.hasOwn(state.users, userId) ? state.users[userId]! : { summary: "", turns: [], updatedAt: "" };
      const seq = memory.nextSeq ?? memory.turns.length;
      memory.nextSeq = seq + 1;
      const event: ArchivedTurn = { id: crypto.randomUUID(), userId: userKey, role, text: normalized, at: new Date().toISOString() };
      await fs.mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
      const archive = path.join(this.archiveDir, `${event.userId}.jsonl`);
      const handle = await fs.open(archive, "a", 0o600);
      try { await handle.writeFile(JSON.stringify(event) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      const privacy = getPrivacy(state, userKey);
      const acceptedContext = role !== "assistant" || !hasBoundary(privacy) || (!privacy?.pending && capturedPrivacyEpoch === privacy?.epoch);
      if (acceptedContext) memory.turns.push({ role, text: normalized, at: event.at, seq, id: event.id, ...(typeof capturedPrivacyEpoch === "number" ? { capturedEpoch: capturedPrivacyEpoch } : {}) });
      this.compact(memory);
      memory.updatedAt = event.at;
      Object.defineProperty(state.users, userId, { value: memory, enumerable: true, configurable: true, writable: true });
      if (this.mem0 && acceptedContext) { (state.outbox ??= []).push(event); scrubSuppressed(state, userKey); }
    });
    void this.flushOutbox();
  }

  /**
   * Explicit privacy coordinator. Requires Mem0. Validates exact targets against ONLY this user's
   * archive, persists a durable pending barrier BEFORE any remote work, then asks the server to
   * tombstone the matching extraction chunks. Forget is a tombstone, not a permanent delete; the raw
   * archive is never erased. On remote failure the barrier stays pending and nothing old can leak.
   */
  async forget(userId: string, archivedEventIds: string[], requestId: string): Promise<ForgetOutcome> {
    if (this.closed) throw new Error("memory store is closed");
    if (!this.options.enabled) throw new Error("memory is disabled");
    if (!this.mem0) throw new Error("forget requires Mem0 to be enabled");
    if (typeof userId !== "string" || !userId) throw new Error("forget requires a valid user id");
    if (typeof requestId !== "string" || !requestId) throw new Error("forget requires a valid request id");
    if (!Array.isArray(archivedEventIds) || archivedEventIds.length === 0) throw new Error("forget requires archived event ids");
    const userKey = this.userKey(userId);

    const prepared = await this.mutate(async (state) => {
      const existing = getPrivacy(state, userKey);
      // Resolve exact targets against ONLY this user's archive before any effect/barrier/network.
      const archive = await this.loadArchive(userKey);
      const byId = new Map(archive.map((turn) => [turn.id, turn]));
      const seen = new Set<string>();
      const targets: ForgottenTargets = { archivedEventIds: [], chunkIds: [], sourceHashes: [], quoteHashes: [] };
      const expectedQuotes = new Map<string, Set<string>>();
      for (const archivedId of archivedEventIds) {
        if (typeof archivedId !== "string" || !archivedId) throw new Error("invalid archived event id");
        if (seen.has(archivedId)) throw new Error("duplicate archived event id");
        seen.add(archivedId);
        const entry = byId.get(archivedId);
        if (!entry) throw new Error("forget target is not in this user's archive");
        if (entry.userId !== userKey) throw new Error("forget target owner mismatch");
        targets.archivedEventIds.push(archivedId);
        for (const chunk of extractionChunks(entry.id, entry.text)) {
          targets.chunkIds.push(chunk.eventId);
          targets.sourceHashes.push(chunk.sourceHash);
          expectedQuotes.set(chunk.eventId, new Set(sentenceHashes(chunk.text)));
        }
        for (const hash of sentenceHashes(entry.text)) targets.quoteHashes!.push(hash);
      }
      // Idempotency is keyed by a canonical digest of the resolved target set, so the same request id
      // with changed targets is rejected before any effect; the same id/set stays stable.
      const digest = canonicalTargetsDigest(targets);
      if (existing?.pending) {
        if (existing.pending.requestId !== requestId) throw new Error("another forget is already pending for this user");
        if (existing.pending.digest !== digest) throw new Error("forget request id reused with different targets");
        return { skipRemote: false as const, epoch: existing.epoch, pending: existing.pending, expectedQuotes };
      }
      const prior = existing?.requests?.find((entry) => entry.requestId === requestId);
      if (prior) {
        if (prior.digest !== digest) throw new Error("forget request id reused with different targets");
        return { skipRemote: true as const, epoch: existing!.epoch, pending: undefined, expectedQuotes };
      }
      const memory = Object.hasOwn(state.users, userId) ? state.users[userId] : undefined;
      const baselineEpoch = existing?.epoch ?? 0;
      const lastSeq = (memory?.nextSeq ?? memory?.turns.length ?? 0) - 1;
      const boundarySeq = existing ? Math.max(existing.boundarySeq, lastSeq) : lastSeq;
      const pending: PendingBarrier = { requestId, digest, baselineEpoch, targets, createdAt: new Date().toISOString() };
      const record: PrivacyRecord = {
        epoch: baselineEpoch,
        boundarySeq,
        pending,
        ...(existing?.targets ? { targets: existing.targets } : {}),
        ...(existing?.requests ? { requests: existing.requests } : {}),
        updatedAt: new Date().toISOString(),
      };
      setPrivacy(state, userKey, record);
      if (memory) pruneBoundary(memory, boundarySeq);
      scrubSuppressed(state, userKey);
      return { skipRemote: false as const, epoch: baselineEpoch, pending, expectedQuotes };
    });

    if (prepared.skipRemote) return { status: "confirmed", epoch: prepared.epoch, requestId };
    const pending = prepared.pending!;
    const expectedHashes = new Map<string, string>(pending.targets.chunkIds.map((id, index) => [id, pending.targets.sourceHashes[index]!]));
    let result: ForgetResult;
    try {
      result = await this.mem0.forget(userKey, pending.targets.chunkIds, requestId, expectedHashes, prepared.expectedQuotes);
    } catch {
      this.options.onWarning?.("Mem0 forget could not be confirmed; local privacy barrier remains pending");
      return { status: "pending", epoch: prepared.epoch, requestId };
    }
    if (result.memoryEpoch < prepared.epoch) {
      this.options.onWarning?.("Mem0 forget returned a stale epoch; local privacy barrier remains pending");
      return { status: "pending", epoch: prepared.epoch, requestId };
    }
    const confirmed = await this.mutate(async (state) => {
      const existing = getPrivacy(state, userKey);
      if (!existing?.pending || existing.pending.requestId !== requestId) {
        return Math.max(existing?.epoch ?? 0, result.memoryEpoch);
      }
      const merged = mergeTargets(existing.targets, existing.pending.targets);
      for (const tombstone of result.tombstones) {
        merged.sourceHashes = [...new Set([...merged.sourceHashes, tombstone.sourceHash])];
        merged.quoteHashes = [...new Set([...(merged.quoteHashes ?? []), ...tombstone.quoteHashes])];
      }
      const requests = existing.requests ?? [];
      const record: PrivacyRecord = {
        epoch: Math.max(existing.epoch, result.memoryEpoch),
        boundarySeq: existing.boundarySeq,
        targets: merged,
        requests: requests.some((entry) => entry.requestId === requestId) ? requests : [...requests, { requestId, digest: existing.pending.digest }],
        updatedAt: new Date().toISOString(),
      };
      setPrivacy(state, userKey, record);
      scrubSuppressed(state, userKey);
      return record.epoch;
    });
    return { status: "confirmed", epoch: confirmed, requestId };
  }

  /** Epoch/pending view for a future bridge/runtime. Active ACP session reset is still required. */
  async privacyState(userId: string): Promise<PrivacyState> {
    await this.pending.catch(() => {});
    const state = await load(this.options.file);
    const record = getPrivacy(state, this.userKey(userId));
    return { epoch: record?.epoch ?? 0, pending: Boolean(record?.pending), activeSessionResetRequired: true };
  }

  /**
   * Optional explicit server controls reconciliation. Never called per-context. Stale server epochs
   * cannot reduce the local epoch; unknown/malformed responses throw rather than fail open.
   */
  async syncPrivacy(userId: string): Promise<number> {
    if (!this.mem0) throw new Error("privacy sync requires Mem0 to be enabled");
    const userKey = this.userKey(userId);
    const controls = await this.mem0.controls(userKey);
    return await this.mutate(async (state) => {
      const existing = getPrivacy(state, userKey);
      if (!existing && controls.memoryEpoch === 0) return 0;
      if (existing && controls.memoryEpoch < existing.epoch) return existing.epoch; // stale controls cannot reduce epoch
      const serverTargets: ForgottenTargets = {
        archivedEventIds: [],
        chunkIds: controls.forgottenEventIds,
        sourceHashes: controls.tombstones.map((tombstone) => tombstone.sourceHash),
        quoteHashes: controls.tombstones.flatMap((tombstone) => tombstone.quoteHashes),
      };
      const targets = mergeTargets(existing?.targets, serverTargets);
      const memory = Object.hasOwn(state.users, userId) ? state.users[userId] : undefined;
      const newest = (memory?.nextSeq ?? memory?.turns.length ?? 0) - 1;
      const changed = !existing || controls.memoryEpoch > existing.epoch;
      const boundarySeq = changed ? Math.max(existing?.boundarySeq ?? -1, newest) : existing.boundarySeq;
      const record: PrivacyRecord = { ...existing, boundarySeq, epoch: Math.max(existing?.epoch ?? 0, controls.memoryEpoch), targets, updatedAt: new Date().toISOString() };
      if (memory && changed) pruneBoundary(memory, boundarySeq);
      setPrivacy(state, userKey, record);
      scrubSuppressed(state, userKey);
      return record.epoch;
    });
  }

  private async loadArchive(userKey: string): Promise<ArchivedTurn[]> {
    // userKey is a SHA-256 hex digest, so this path cannot be injected.
    let raw: string;
    try { raw = await fs.readFile(path.join(this.archiveDir, `${userKey}.jsonl`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const turns: ArchivedTurn[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as ArchivedTurn;
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.text !== "string" || typeof parsed.userId !== "string") throw new Error("invalid archive entry");
      if (parsed.userId !== userKey) throw new Error("archive entry owner mismatch");
      turns.push(parsed);
    }
    return turns;
  }

  private compact(memory: UserMemory): void {
    let first = memory.turns.length;
    let chars = 0;
    while (first > 0 && memory.turns.length - first < this.maxTurns) {
      const turn = memory.turns[first - 1]!;
      if (chars + turn.text.length > this.maxChars - this.summaryChars && first < memory.turns.length) break;
      chars += Math.min(turn.text.length, this.maxChars - this.summaryChars);
      first--;
    }
    const archived = memory.turns.slice(0, first);
    if (archived.length) memory.summary = [memory.summary, ...archived.map((turn) => `${turn.role}: ${turn.text}`)].filter(Boolean).join("\n").slice(-this.summaryChars);
    memory.turns = memory.turns.slice(first).map((turn) => ({ ...turn, text: turn.text.slice(-(this.maxChars - this.summaryChars)) }));
  }

  async flushOutbox(): Promise<void> {
    if (this.closed || !this.options.enabled || !this.mem0) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      await this.pending.catch(() => {});
      const state = await load(this.options.file);
      const batch = (state.outbox ?? []).slice(0, 32);
      const accepted = new Set<string>();
      const rejected: Array<{ event: ArchivedTurn; status: number; at: string }> = [];
      const suppressed = new Set<string>();
      for (const event of batch) {
        // Recheck the boundary immediately before each upload so a raced forget cannot leak.
        const current = await load(this.options.file);
        if (isSuppressed(current, event)) { suppressed.add(event.id); continue; }
        try { await this.mem0!.ingest(event); accepted.add(event.id); }
        catch (error) {
          if (error instanceof Mem0HttpError && error.permanent) {
            rejected.push({ event, status: error.status, at: new Date().toISOString() });
            this.options.onWarning?.("Mem0 rejected a turn; quarantined on disk without blocking later turns");
            continue;
          }
          this.options.onWarning?.("Mem0 ingestion unavailable; pending turns remain on disk");
          break;
        }
      }
      if (accepted.size || rejected.length || suppressed.size) await this.mutate(async (current) => {
        const outstanding = new Set((current.outbox ?? []).map((event) => event.id));
        const newRejected = rejected.filter((entry) => outstanding.has(entry.event.id));
        const settled = new Set([...accepted, ...rejected.map((entry) => entry.event.id), ...suppressed]);
        current.outbox = (current.outbox ?? []).filter((event) => !settled.has(event.id) && !isSuppressed(current, event));
        if (newRejected.length) (current.rejectedOutbox ??= []).push(...newRejected);
        current.rejectedOutbox = (current.rejectedOutbox ?? []).filter((entry) => !isSuppressed(current, entry.event));
      });
      const remaining = (await load(this.options.file)).outbox?.length ?? 0;
      if (remaining && !this.retryTimer && !this.closed) {
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flushOutbox(); }, 5000);
        this.retryTimer.unref();
      }
    })().catch(() => { this.options.onWarning?.("Mem0 outbox retry deferred; local archive preserved"); }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.flushing;
    await this.pending.catch(() => {});
  }
}
