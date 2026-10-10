/**
 * Read-only shadow projection of a converted WeChat-bridge state root against
 * its original source.
 *
 * This is the bridge-side (wechat) sibling of `control-plane/shadow-projection.mjs`
 * (D67) and `services/memory/shadow.py` (D68): the migration story the P5/P6
 * readiness map lays out -- frozen-writes consistent snapshot -> versioned
 * conversion -> **shadow** -> whitelist canary/drain -> naming batch 2 ->
 * rollback freeze points -- crosses its rehearsal step here for the *bridge's
 * own durable file stores*. The converted copy and its ORIGINAL source are run
 * through the SAME set of READ-ONLY projections and the two results are
 * compared, leaving a re-verifiable report: a dress rehearsal before any canary
 * ever runs.
 *
 * The three stores this layer reads (all created by `bridge.ts` under the
 * storage root `config.storage.dir`):
 *   * `incoming-receipts/`   -> `MessageInbox`      (message-inbox.ts)
 *   * `reply-outbox/`        -> `ReplyOutbox`       (reply-outbox.ts)
 *   * `submission-registry/` -> `SubmissionRegistry`(submission-registry.ts)
 * A "state root" is the directory that holds these three subdirectories.
 *
 * `runShadowProjection({ legacyDir, convertedDir, now? })` scans BOTH roots
 * read-only and returns a report field-by-field aligned with the Node/Python
 * versions:
 *
 *     { version:'shadow-projection-v1', kind:'wechat-bridge',
 *       projections: [ { name, status, legacyDigest, convertedDigest, match, detail? } ],
 *       allMatch, reportDigest, generatedAt }
 *
 * HARD BOUNDARIES (same spirit as `message-inbox.ts` / the Node module)
 *   * READ-ONLY over the two roots a caller points it at. It only ever calls
 *     `fs.stat`/`fs.readdir`/`fs.readFile`; it never writes, renames, chmods or
 *     unlinks, and it creates no sidecar file. The production bridge root
 *     `~/.wechat-acp/` (and every other production/launchd-owned path) is never
 *     read or written by this module -- the caller supplies the roots.
 *   * NO egress: no network, no model, no WeChat call, no environment read.
 *     The clock is injected via `now`.
 *   * OBSERVABLE SEMANTICS, NOT BYTES: a projection distils a root to a
 *     canonical, ORDER-INDEPENDENT summary -- histograms, counts, digest sets
 *     and numeric aggregates -- so a legitimate conversion (which may add
 *     optional fields, reorder files or supply empty scaffolds) still matches
 *     its source. The comparison is the sha256 of that canonical summary,
 *     using the same `stable()` convention as the Node module (keys recursively
 *     sorted, scalars as JSON text, `sha256:` prefix).
 *   * NEVER FABRICATE A MATCH: a projection is reported as matching only when
 *     the two canonical digests are equal; a projection that throws is reported
 *     `status:'failed'` with `match:false` (never silently dropped, never
 *     allowed to abort the rest of the batch).
 *   * Fail-closed: a missing root, a missing category directory, or a record
 *     file that is not valid JSON or violates its store's schema throws a
 *     `ShadowProjectionError` BEFORE any projection runs (the whole-run refusal
 *     branch of the contract). A `projections` array of functions REPLACES the
 *     built-ins (the seam the deployment batch can use for real projections).
 *
 * ENUMS: the store status/phase/kind unions are mirrored here as read-only
 * consumers (the vendor idiom -- message-inbox.ts and submission-registry.ts
 * likewise duplicate `canonicalize` rather than share it). `MESSAGE_INBOX_STATUSES`
 * IS exported by message-inbox.ts, so the test suite guards drift by comparing
 * this module's mirror against the real enum. The others are module-private in
 * their stores and are mirrored verbatim from the source of truth.
 *
 * Dependencies: node:crypto + node:fs only (no new dependency).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Report schema version understood by this module. Deliberately the same
 * string as `control-plane/shadow-projection.mjs` and `services/memory/shadow.py`
 * so a report of either kind is recognised by the same tooling; `kind` tells the
 * three apart. */
export const SHADOW_PROJECTION_VERSION = 'shadow-projection-v1';

/** The one state kind this module understands. */
export const SHADOW_PROJECTION_KIND = 'wechat-bridge';

/** Upper bound (characters) on each side's canonical summary in a `detail`. */
export const DETAIL_LIMIT = 2000;

/** The three category directories a bridge state root carries (bridge.ts:158-162). */
export const INBOX_DIRNAME = 'incoming-receipts';
export const OUTBOX_DIRNAME = 'reply-outbox';
export const SUBMISSION_DIRNAME = 'submission-registry';

/** Mirror of `MESSAGE_INBOX_STATUSES` (message-inbox.ts:23-35) -- the `background`
 * state is the newest member. `sent-unconfirmed` is NOT a status; it is an
 * execution checkpoint phase (see `EXECUTION_PHASES`). */
export const INBOX_STATUSES = Object.freeze([
  'received',
  'queued',
  'buffered',
  'running',
  'background',
  'done',
  'uncertain',
  'cancelled',
  'failed',
  'retry_wait',
  'reply_pending',
] as const);

/** Mirror of `ExecutionCheckpoint['phase']` (message-inbox.ts:57). */
export const EXECUTION_PHASES = Object.freeze([
  'preparing',
  'sent-unconfirmed',
  'dispatched',
  'tool_activity',
  'result_ready',
] as const);

/** Mirror of the `ReplyRecord` status union (reply-outbox.ts:22). Note the
 * terminal delivery state is `sent` (the contract text's "delivered" is the
 * same observable under its actual enum name). */
export const OUTBOX_STATUSES = Object.freeze([
  'pending',
  'sending',
  'sent',
  'blocked',
  'cancelled',
] as const);

/** Mirror of `KINDS` (reply-outbox.ts:21). */
export const OUTBOX_KINDS = Object.freeze(['reply', 'notice'] as const);

/** Mirror of `SUBMISSION_STATE` (submission-registry.ts:44). */
export const SUBMISSION_STATE = 'registered';

const INBOX_ID_PATTERN = /^[0-9a-f]{64}$/; // message-inbox.ts:106
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/; // reply-outbox.ts:24 & submission-registry.ts:65

/** A redacted shadow-projection failure. Never carries raw record content. */
export class ShadowProjectionError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ShadowProjectionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// stable serialisation / digests (mirrors control-plane/shadow-projection.mjs)
// ---------------------------------------------------------------------------
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/** A projection digest in the same `sha256:<hex>` shape the stores use. */
function digestOf(value: unknown): string {
  return `sha256:${fingerprint(value)}`;
}

function bounded(text: string): string {
  return text.length > DETAIL_LIMIT
    ? `${text.slice(0, DETAIL_LIMIT)}…(truncated ${text.length - DETAIL_LIMIT} chars)`
    : text;
}

function reason(error: unknown): string {
  const thrown = error as { message?: unknown } | null | undefined;
  const message = thrown && typeof thrown.message === 'string' && thrown.message ? thrown.message : String(error);
  return message.slice(0, 300);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function corrupt(store: string, source: string, why?: string): never {
  throw new ShadowProjectionError('corrupt-record', `${store}: corrupt record ${source}${why ? ` (${why})` : ''}`);
}

// ---------------------------------------------------------------------------
// read-only record loading (the only file IO this module performs)
// ---------------------------------------------------------------------------
/** The observable projection of one inbox receipt (message-inbox.ts). */
export interface InboxView {
  id: string;
  status: string;
  phase: string | undefined;
  fromUserId: unknown;
}

/** The observable projection of one outbox record (reply-outbox.ts). */
export interface OutboxView {
  id: string;
  status: string;
  userId: string;
}

/** The observable projection of one submission registration. */
export interface RegistryView {
  receiptId: string;
  registeredAt: number;
}

/** A fully-loaded, validated side (root) -- the read surface projections see. */
export interface ShadowSideState {
  inbox: InboxView[];
  outbox: OutboxView[];
  registry: RegistryView[];
}

/** Parse + schema-validate one stored record; any violation is fail-closed. */
function parseInboxRecord(raw: string, source: string, stem: string): InboxView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    corrupt('inbox', source);
  }
  if (!isPlainObject(parsed)) corrupt('inbox', source);
  const p = parsed as Record<string, unknown>;
  if (!isString(p.id) || !INBOX_ID_PATTERN.test(p.id) || p.id !== stem) corrupt('inbox', source, 'id');
  if (!isPlainObject(p.message)) corrupt('inbox', source, 'message');
  if (!isString(p.status) || !(INBOX_STATUSES as readonly string[]).includes(p.status)) corrupt('inbox', source, 'status');
  if (typeof p.receivedAt !== 'number' || !Number.isFinite(p.receivedAt)) corrupt('inbox', source, 'receivedAt');
  let phase: string | undefined;
  if (p.execution !== undefined) {
    const execution = p.execution;
    if (!isPlainObject(execution)) corrupt('inbox', source, 'execution');
    const attempt = execution.attempt;
    const execPhase = execution.phase;
    if (!Number.isSafeInteger(attempt) || (attempt as number) < 0) corrupt('inbox', source, 'execution.attempt');
    if (!isString(execPhase) || !(EXECUTION_PHASES as readonly string[]).includes(execPhase)) corrupt('inbox', source, 'execution.phase');
    phase = execPhase;
  }
  const message = p.message as Record<string, unknown>;
  const from = message.from_user_id;
  const fromUserId = from === undefined || from === null ? from : typeof from === 'string' ? from : String(from);
  return { id: p.id, status: p.status, phase, fromUserId };
}

function parseOutboxRecord(raw: string, source: string, stem: string): OutboxView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    corrupt('outbox', source);
  }
  if (!isPlainObject(parsed)) corrupt('outbox', source);
  const p = parsed as Record<string, unknown>;
  if (!isString(p.id) || !SAFE_ID_PATTERN.test(p.id) || p.id !== stem) corrupt('outbox', source, 'id');
  if (!isString(p.clientId) || !p.clientId.startsWith('wechat-acp-')) corrupt('outbox', source, 'clientId');
  if (!isNonEmptyString(p.userId)) corrupt('outbox', source, 'userId');
  if (!isNonEmptyString(p.contextToken)) corrupt('outbox', source, 'contextToken');
  if (!isNonEmptyString(p.text)) corrupt('outbox', source, 'text');
  if (!Array.isArray(p.receiptIds) || !p.receiptIds.every(isNonEmptyString)) corrupt('outbox', source, 'receiptIds');
  if (!isString(p.kind) || !(OUTBOX_KINDS as readonly string[]).includes(p.kind)) corrupt('outbox', source, 'kind');
  if (!isString(p.status) || !(OUTBOX_STATUSES as readonly string[]).includes(p.status)) corrupt('outbox', source, 'status');
  if (!Number.isInteger(p.attempts) || (p.attempts as number) < 0) corrupt('outbox', source, 'attempts');
  if (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)) corrupt('outbox', source, 'createdAt');
  if (typeof p.nextAttemptAt !== 'number' || !Number.isFinite(p.nextAttemptAt)) corrupt('outbox', source, 'nextAttemptAt');
  if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 1) corrupt('outbox', source, 'sequence');
  if (p.errorKind !== undefined && !isString(p.errorKind)) corrupt('outbox', source, 'errorKind');
  return { id: p.id, status: p.status, userId: p.userId };
}

function parseRegistryRecord(raw: string, source: string, stem: string): RegistryView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    corrupt('submission-registry', source);
  }
  if (!isPlainObject(parsed)) corrupt('submission-registry', source);
  const p = parsed as Record<string, unknown>;
  if (!isString(p.receiptId) || !SAFE_ID_PATTERN.test(p.receiptId) || p.receiptId !== stem) corrupt('submission-registry', source, 'receiptId');
  if (!isNonEmptyString(p.userId)) corrupt('submission-registry', source, 'userId');
  if (!isNonEmptyString(p.payloadDigest)) corrupt('submission-registry', source, 'payloadDigest');
  if (typeof p.registeredAt !== 'number' || !Number.isFinite(p.registeredAt)) corrupt('submission-registry', source, 'registeredAt');
  if (p.state !== SUBMISSION_STATE) corrupt('submission-registry', source, 'state');
  return { receiptId: p.receiptId, registeredAt: p.registeredAt };
}

type RecordParser<T> = (raw: string, source: string, stem: string) => T;

/**
 * Read every `<stem>.json` record of one category directory read-only. Only
 * `.json` entries are considered, so `.lock`, `.tmp-*` and `*.tmp` scratch
 * files (message-inbox.ts `_listIds`, reply-outbox.ts `loadAll`) are naturally
 * ignored. A missing directory refuses the whole run (fail-closed); a record
 * that cannot be read, parsed or validated likewise refuses it.
 */
async function loadCategory<T>(root: string, dirname: string, side: string, parser: RecordParser<T>): Promise<T[]> {
  const categoryDir = path.join(root, dirname);
  let stat;
  try {
    stat = await fs.stat(categoryDir);
  } catch {
    throw new ShadowProjectionError('missing-collection', `${side} ${dirname} directory not found`);
  }
  if (!stat.isDirectory()) {
    throw new ShadowProjectionError('missing-collection', `${side} ${dirname} is not a directory`);
  }
  let names: string[];
  try {
    names = await fs.readdir(categoryDir);
  } catch {
    throw new ShadowProjectionError('missing-collection', `${side} ${dirname} directory is not readable`);
  }
  const records: T[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const full = path.join(categoryDir, name);
    const stem = name.slice(0, -'.json'.length);
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ShadowProjectionError('corrupt-record', `${dirname}: unreadable record ${name}`);
    }
    records.push(parser(raw, `${dirname}/${name}`, stem));
  }
  return records;
}

/** Load and validate one whole side (root) before any projection runs. */
async function loadSide(dir: unknown, side: string): Promise<ShadowSideState> {
  if (!isNonEmptyString(dir)) {
    throw new ShadowProjectionError('invalid-path', `${side} directory is required`);
  }
  let rootStat;
  try {
    rootStat = await fs.stat(dir);
  } catch {
    throw new ShadowProjectionError('missing-root', `${side} directory not found`);
  }
  if (!rootStat.isDirectory()) {
    throw new ShadowProjectionError('missing-root', `${side} state root is not a directory`);
  }
  const inbox = await loadCategory(dir, INBOX_DIRNAME, side, parseInboxRecord);
  const outbox = await loadCategory(dir, OUTBOX_DIRNAME, side, parseOutboxRecord);
  const registry = await loadCategory(dir, SUBMISSION_DIRNAME, side, parseRegistryRecord);
  return { inbox, outbox, registry };
}

// ---------------------------------------------------------------------------
// projection helpers
// ---------------------------------------------------------------------------
function label(value: unknown): string {
  return value === undefined || value === null ? '(absent)' : String(value);
}

/** An order-independent histogram of `values` (keys normalised to strings). */
function histogram(values: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = label(value);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// built-in projections (read-only, over a validated ShadowSideState)
// ---------------------------------------------------------------------------
function projectInboxStatusHistogram(state: ShadowSideState): Record<string, number> {
  return histogram(state.inbox.map((record) => record.status));
}

function projectInboxExecutionPhaseHistogram(state: ShadowSideState): Record<string, number> {
  return histogram(state.inbox.map((record) => record.phase));
}

function projectOutboxStatusHistogram(state: ShadowSideState): Record<string, number> {
  return histogram(state.outbox.map((record) => record.status));
}

/** Per-user received (inbox) / outbound (outbox) counts. */
function projectPerUserCounts(state: ShadowSideState): Record<string, { received: number; outbound: number }> {
  const counts: Record<string, { received: number; outbound: number }> = {};
  const touch = (key: string) => {
    counts[key] = counts[key] ?? { received: 0, outbound: 0 };
    return counts[key];
  };
  for (const record of state.inbox) touch(label(record.fromUserId)).received += 1;
  for (const record of state.outbox) touch(label(record.userId)).outbound += 1;
  return counts;
}

/**
 * `registeredAt` bounds over the submission registry. Because every stored
 * registration is validated to carry a finite `registeredAt`, `count` is exactly
 * the registry size -- so this one projection also carries the registry count
 * (no separate count projection, which lets every projection be isolated).
 */
function projectSubmissionRegisteredAtBounds(state: ShadowSideState): { count: number; min: number | null; max: number | null } {
  const values = state.registry.map((record) => record.registeredAt).filter((value) => Number.isFinite(value));
  if (values.length === 0) return { count: 0, min: null, max: null };
  return { count: values.length, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Cross-consistency between the inbox receipts and the submission registry:
 * the ids present on one side only (`inboxOnly` = a received receipt that was
 * never registered; `registryOnly` = a registration with no matching inbox
 * receipt). Both empty <=> the two id sets are equal.
 */
function projectReceiptIdCrossConsistency(state: ShadowSideState): { inboxOnly: string[]; registryOnly: string[] } {
  const inboxIds = new Set(state.inbox.map((record) => record.id));
  const registryIds = new Set(state.registry.map((record) => record.receiptId));
  const inboxOnly = [...inboxIds].filter((id) => !registryIds.has(id)).sort();
  const registryOnly = [...registryIds].filter((id) => !inboxIds.has(id)).sort();
  return { inboxOnly, registryOnly };
}

interface ProjectionSpec {
  name: string;
  value: (state: ShadowSideState, ctx: { now: number }) => unknown;
}

// The built-in projection set. The seam a caller may override is
// `runShadowProjection({ ..., projections: [...] })`.
const BUILTIN: readonly ProjectionSpec[] = Object.freeze([
  { name: 'inboxStatusHistogram', value: projectInboxStatusHistogram },
  { name: 'inboxExecutionPhaseHistogram', value: projectInboxExecutionPhaseHistogram },
  { name: 'outboxStatusHistogram', value: projectOutboxStatusHistogram },
  { name: 'perUserCounts', value: projectPerUserCounts },
  { name: 'submissionRegisteredAtBounds', value: projectSubmissionRegisteredAtBounds },
  { name: 'receiptIdCrossConsistency', value: projectReceiptIdCrossConsistency },
]);

/** Names of the built-in projections, in report order. */
export const BUILTIN_PROJECTION_NAMES: readonly string[] = Object.freeze(BUILTIN.map((spec) => spec.name));

// ---------------------------------------------------------------------------
// input normalisation / projection resolution
// ---------------------------------------------------------------------------
function makeClock(now: unknown): () => number {
  if (now !== undefined && typeof now !== 'function') {
    throw new ShadowProjectionError('invalid-config', 'now must be a function when provided');
  }
  return (now as (() => number) | undefined) ?? Date.now;
}

function resolveProjections(projections: unknown): ProjectionSpec[] {
  if (projections === undefined) return [...BUILTIN];
  if (!Array.isArray(projections) || projections.length === 0) {
    throw new ShadowProjectionError('invalid-config', 'projections must be a non-empty array of functions');
  }
  return projections.map((fn, index) => {
    if (typeof fn !== 'function') {
      throw new ShadowProjectionError('invalid-config', `projections[${index}] must be a function`);
    }
    const named = fn as { displayName?: unknown; name?: unknown };
    const displayName = typeof named.displayName === 'string' && named.displayName ? named.displayName : undefined;
    const fnName = typeof named.name === 'string' && named.name ? named.name : undefined;
    const name = displayName ?? fnName ?? `projection-${index}`;
    return { name, value: fn as ProjectionSpec['value'] };
  });
}

/** Run one projection on both sides and compare their canonical digests. */
function runOne(spec: ProjectionSpec, legacy: ShadowSideState, converted: ShadowSideState, ctx: { now: number }): ShadowProjectionEntry {
  const evaluated: { side: string; value: unknown }[] = [];
  for (const [side, state] of [['legacy', legacy], ['converted', converted]] as const) {
    try {
      evaluated.push({ side, value: spec.value(state, ctx) });
    } catch (error) {
      return {
        name: spec.name,
        status: 'failed',
        legacyDigest: null,
        convertedDigest: null,
        match: false,
        detail: { side, error: reason(error) },
      };
    }
  }
  const [legacySide, convertedSide] = evaluated;
  const legacyDigest = digestOf(legacySide.value);
  const convertedDigest = digestOf(convertedSide.value);
  const match = legacyDigest === convertedDigest;
  const projection: ShadowProjectionEntry = { name: spec.name, status: 'ok', legacyDigest, convertedDigest, match };
  if (!match) {
    projection.detail = {
      legacy: bounded(stable(legacySide.value)),
      converted: bounded(stable(convertedSide.value)),
    };
  }
  return projection;
}

export interface ShadowProjectionEntry {
  name: string;
  status: 'ok' | 'failed';
  legacyDigest: string | null;
  convertedDigest: string | null;
  match: boolean;
  detail?: Record<string, unknown>;
}

export interface ShadowProjectionReport {
  version: string;
  kind: string;
  projections: ShadowProjectionEntry[];
  allMatch: boolean;
  reportDigest: string;
  generatedAt: string;
}

/**
 * Run the shadow projection of a converted bridge state root against its
 * original source. Both roots are scanned read-only; the two sides' built-in
 * (or injected) projections are compared and a re-verifiable report returned.
 *
 * @param options.legacyDir    path to the ORIGINAL bridge state root (read-only).
 * @param options.convertedDir path to the converted bridge state root (read-only).
 * @param options.now          injected clock returning epoch-milliseconds
 *                             (defaults to `Date.now`). Fix it for a byte-stable
 *                             `reportDigest`.
 * @param options.projections  optional projection functions that REPLACE the
 *                             built-in set; each is `(state, ctx) => value` over
 *                             a `ShadowSideState` with `ctx = { now }`.
 * @returns `{version, kind, projections, allMatch, reportDigest, generatedAt}`.
 * @throws ShadowProjectionError fail-closed on a missing root, a missing
 *         category directory, a corrupt/mis-schema'd record, or an invalid
 *         `now`/`projections` argument -- all BEFORE any projection runs.
 */
export async function runShadowProjection(options: {
  legacyDir?: unknown;
  convertedDir?: unknown;
  now?: unknown;
  projections?: unknown;
} = {}): Promise<ShadowProjectionReport> {
  const { legacyDir, convertedDir, now, projections } = options;
  const clock = makeClock(now);
  const createdAt = clock();
  const specs = resolveProjections(projections);
  // Fail-closed BEFORE any projection: both sides must load and validate.
  const legacy = await loadSide(legacyDir, 'legacy');
  const converted = await loadSide(convertedDir, 'converted');
  const ctx = { now: createdAt };

  const results = specs.map((spec) => runOne(spec, legacy, converted, ctx));
  const allMatch = results.length > 0 && results.every((entry) => entry.status === 'ok' && entry.match === true);

  const body = { version: SHADOW_PROJECTION_VERSION, kind: SHADOW_PROJECTION_KIND, projections: results, allMatch };
  const reportDigest = digestOf(body);
  return { ...body, reportDigest, generatedAt: new Date(createdAt).toISOString() };
}
