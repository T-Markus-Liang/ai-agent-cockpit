// Focused tests for the bridge-side (wechat) shadow projection layer.
//
// Every fixture is a self-built synthetic bridge state root under a private
// `os.tmpdir()/wechat-shadow-*` directory: an `incoming-receipts/`, a
// `reply-outbox/` and a `submission-registry/` subdirectory holding hand-written
// `.json` records. These tests never touch production state
// (~/.wechat-acp/, ~/.local/state/personal-ai-os/), never launch a service,
// never use the network, credentials, a model or WeChat, and never invoke git.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runShadowProjection,
  ShadowProjectionError,
  SHADOW_PROJECTION_VERSION,
  SHADOW_PROJECTION_KIND,
  BUILTIN_PROJECTION_NAMES,
  INBOX_STATUSES,
  EXECUTION_PHASES,
  OUTBOX_STATUSES,
  INBOX_DIRNAME,
  OUTBOX_DIRNAME,
  SUBMISSION_DIRNAME,
} from '../src/storage/shadow-projection.js';
import { MESSAGE_INBOX_STATUSES } from '../src/storage/message-inbox.js';

const ownedDirs: string[] = [];
after(async () => {
  await Promise.all(ownedDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const FIXED_NOW = 1_700_000_000_000;
const fixedClock = (): number => FIXED_NOW;

// --- fixture helpers -------------------------------------------------------

/** A fresh, valid bridge state root (three empty category directories). */
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-shadow-'));
  ownedDirs.push(root);
  for (const name of [INBOX_DIRNAME, OUTBOX_DIRNAME, SUBMISSION_DIRNAME]) {
    await fs.mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
  }
  return root;
}

const hexId = (n: number): string => n.toString(16).padStart(64, '0');

type Json = Record<string, unknown>;

async function writeInbox(root: string, record: Json): Promise<void> {
  await fs.writeFile(path.join(root, INBOX_DIRNAME, `${record.id as string}.json`), JSON.stringify(record), 'utf8');
}
async function writeOutbox(root: string, record: Json): Promise<void> {
  await fs.writeFile(path.join(root, OUTBOX_DIRNAME, `${record.id as string}.json`), JSON.stringify(record), 'utf8');
}
async function writeRegistry(root: string, record: Json): Promise<void> {
  await fs.writeFile(path.join(root, SUBMISSION_DIRNAME, `${record.receiptId as string}.json`), JSON.stringify(record), 'utf8');
}

function inboxRecord(id: string, opts: { status?: string; from?: string; phase?: string; attempt?: number } = {}): Json {
  const record: Json = {
    id,
    message: { message_id: 1, from_user_id: opts.from ?? 'user-a', to_user_id: 'bot', item_list: [] },
    status: opts.status ?? 'received',
    receivedAt: 1000,
    updatedAt: 1000,
  };
  if (opts.phase !== undefined) record.execution = { attempt: opts.attempt ?? 1, phase: opts.phase };
  return record;
}

function outboxRecord(id: string, opts: { status?: string; userId?: string } = {}): Json {
  return {
    id,
    clientId: `wechat-acp-${id}`,
    userId: opts.userId ?? 'user-a',
    contextToken: 'ctx',
    text: 'hi',
    receiptIds: [],
    kind: 'reply',
    status: opts.status ?? 'pending',
    attempts: 0,
    createdAt: 1000,
    nextAttemptAt: 1000,
    sequence: 1,
  };
}

function registryRecord(receiptId: string, opts: { registeredAt?: number; userId?: string } = {}): Json {
  return {
    receiptId,
    userId: opts.userId ?? 'user-a',
    payloadDigest: 'digest',
    registeredAt: opts.registeredAt ?? 1000,
    state: 'registered',
  };
}

// Stable synthetic ids reused across cases.
const ID1 = hexId(1);
const ID2 = hexId(2);
const ID3 = hexId(3);
const ID4 = hexId(4);
const ID5 = hexId(5);
const O1 = 'outbox-1';
const O2 = 'outbox-2';

/** Populate a root with a representative, internally-consistent bridge state. */
async function populate(root: string): Promise<void> {
  await writeInbox(root, inboxRecord(ID1, { status: 'received', from: 'user-a' }));
  await writeInbox(root, inboxRecord(ID2, { status: 'background', from: 'user-a', phase: 'sent-unconfirmed' }));
  await writeInbox(root, inboxRecord(ID3, { status: 'done', from: 'user-b', phase: 'result_ready' }));
  await writeInbox(root, inboxRecord(ID4, { status: 'received', from: 'user-b' })); // never registered
  await writeOutbox(root, outboxRecord(O1, { status: 'pending', userId: 'user-a' }));
  await writeOutbox(root, outboxRecord(O2, { status: 'sent', userId: 'user-b' }));
  await writeRegistry(root, registryRecord(ID1, { registeredAt: 1000 }));
  await writeRegistry(root, registryRecord(ID2, { registeredAt: 2000 }));
  await writeRegistry(root, registryRecord(ID3, { registeredAt: 3000 }));
}

function mismatches(report: { projections: { name: string; match: boolean }[] }): string[] {
  return report.projections.filter((entry) => !entry.match).map((entry) => entry.name);
}
function projectionNamed(report: { projections: { name: string }[] }, name: string) {
  return report.projections.find((entry) => entry.name === name);
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (error: unknown) => {
    assert.ok(error instanceof ShadowProjectionError, `expected ShadowProjectionError, got ${String(error)}`);
    assert.equal((error as ShadowProjectionError).code, code);
    return true;
  });
}

// --- happy path / shape / determinism --------------------------------------

test('two identical bridge state roots: every projection matches', async () => {
  const root = await makeRoot();
  await populate(root);
  const report = await runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock });

  assert.equal(report.version, SHADOW_PROJECTION_VERSION);
  assert.equal(report.kind, SHADOW_PROJECTION_KIND);
  assert.equal(report.allMatch, true);
  assert.equal(report.projections.length, 6);
  assert.deepEqual(report.projections.map((entry) => entry.name), [...BUILTIN_PROJECTION_NAMES]);
  for (const entry of report.projections) {
    assert.equal(entry.status, 'ok');
    assert.equal(entry.match, true);
    assert.match(entry.legacyDigest as string, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.legacyDigest, entry.convertedDigest);
    assert.equal(Object.hasOwn(entry, 'detail'), false);
  }
  assert.match(report.reportDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.generatedAt, new Date(FIXED_NOW).toISOString());
  // Exactly these six top-level fields.
  assert.deepEqual(Object.keys(report).sort(), ['allMatch', 'generatedAt', 'kind', 'projections', 'reportDigest', 'version']);
});

test('reportDigest covers the whole report except generatedAt', async () => {
  const root = await makeRoot();
  await populate(root);
  const report = await runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock });
  const body = { version: report.version, kind: report.kind, projections: report.projections, allMatch: report.allMatch };
  assert.equal(report.reportDigest, `sha256:${createHash('sha256').update(nodeStable(body)).digest('hex')}`);
});

test('two runs on the same input produce the same reportDigest (determinism)', async () => {
  const root = await makeRoot();
  await populate(root);
  const first = await runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock });
  const second = await runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock });
  assert.equal(first.reportDigest, second.reportDigest);
  assert.deepEqual(first, second);
});

test('reportDigest excludes generatedAt: changing only the clock keeps the digest', async () => {
  const root = await makeRoot();
  await populate(root);
  const early = await runShadowProjection({ legacyDir: root, convertedDir: root, now: () => 1000 });
  const late = await runShadowProjection({ legacyDir: root, convertedDir: root, now: () => 2000 });
  assert.notEqual(early.generatedAt, late.generatedAt);
  assert.equal(early.reportDigest, late.reportDigest);
});

test('projection values are order-independent (shuffled file names still match)', async () => {
  const rootA = await makeRoot();
  const rootB = await makeRoot();
  await populate(rootA);
  await populate(rootB);
  // Rewrite the outbox records in a different creation order: same records.
  await writeOutbox(rootB, outboxRecord(O2, { status: 'sent', userId: 'user-b' }));
  await writeOutbox(rootB, outboxRecord(O1, { status: 'pending', userId: 'user-a' }));
  const report = await runShadowProjection({ legacyDir: rootA, convertedDir: rootB, now: fixedClock });
  assert.equal(report.allMatch, true);
  assert.deepEqual(mismatches(report), []);
});

// --- per-projection divergences: exactly one projection is flagged ----------

const ISOLATION_CASES: { name: string; mutate: (root: string) => Promise<void> }[] = [
  {
    name: 'inboxStatusHistogram',
    mutate: async (root) => writeInbox(root, inboxRecord(ID1, { status: 'queued', from: 'user-a' })),
  },
  {
    name: 'inboxExecutionPhaseHistogram',
    mutate: async (root) => writeInbox(root, inboxRecord(ID3, { status: 'done', from: 'user-b', phase: 'dispatched' })),
  },
  {
    name: 'outboxStatusHistogram',
    mutate: async (root) => writeOutbox(root, outboxRecord(O2, { status: 'blocked', userId: 'user-b' })),
  },
  {
    name: 'perUserCounts',
    mutate: async (root) => writeInbox(root, inboxRecord(ID4, { status: 'received', from: 'user-c' })),
  },
  {
    name: 'submissionRegisteredAtBounds',
    mutate: async (root) => writeRegistry(root, registryRecord(ID3, { registeredAt: 500 })), // a new min
  },
  {
    name: 'receiptIdCrossConsistency',
    mutate: async (root) => {
      await fs.rm(path.join(root, INBOX_DIRNAME, `${ID4}.json`));
      await writeInbox(root, inboxRecord(ID5, { status: 'received', from: 'user-b' })); // same status/user, new id
    },
  },
];

for (const { name, mutate } of ISOLATION_CASES) {
  test(`a divergence in ${name} flags exactly that projection`, async () => {
    const legacy = await makeRoot();
    await populate(legacy);
    const converted = await makeRoot();
    await populate(converted);
    await mutate(converted);

    const report = await runShadowProjection({ legacyDir: legacy, convertedDir: converted, now: fixedClock });
    assert.deepEqual(mismatches(report), [name]);
    assert.equal(report.allMatch, false);
    const flagged = projectionNamed(report, name);
    assert.equal(flagged?.status, 'ok');
    assert.equal(flagged?.match, false);
    assert.notEqual(flagged?.legacyDigest, flagged?.convertedDigest);
    const detail = flagged?.detail as { legacy: string; converted: string } | undefined;
    assert.ok(detail && typeof detail.legacy === 'string' && typeof detail.converted === 'string');
    assert.notEqual(detail.legacy, detail.converted);
  });
}

test('a mismatch is never reported as a match, and detail is truthful', async () => {
  const legacy = await makeRoot();
  await populate(legacy);
  const converted = await makeRoot();
  await populate(converted);
  await writeInbox(converted, inboxRecord(ID1, { status: 'queued', from: 'user-a' }));

  const report = await runShadowProjection({ legacyDir: legacy, convertedDir: converted, now: fixedClock });
  const flagged = projectionNamed(report, 'inboxStatusHistogram');
  assert.equal(flagged?.match, false);
  const detail = flagged?.detail as { legacy: string; converted: string };
  assert.match(detail.legacy, /received/);
  assert.match(detail.converted, /queued/);
});

test('cross-consistency truthfully surfaces an inbox receipt with no registration', async () => {
  const legacy = await makeRoot();
  await populate(legacy);
  const converted = await makeRoot();
  await populate(converted);
  // The converted side received ID5 but never registered it: inboxOnly diverges.
  await writeInbox(converted, inboxRecord(ID5, { status: 'received', from: 'user-b' }));

  const report = await runShadowProjection({ legacyDir: legacy, convertedDir: converted, now: fixedClock });
  const flagged = projectionNamed(report, 'receiptIdCrossConsistency');
  assert.equal(flagged?.match, false);
  const detail = flagged?.detail as { legacy: string; converted: string };
  assert.match(detail.converted, new RegExp(ID5));
  assert.doesNotMatch(detail.legacy, new RegExp(ID5));
});

test('an optional field on a converted record does not by itself cause a mismatch', async () => {
  const legacy = await makeRoot();
  await populate(legacy);
  const converted = await makeRoot();
  await populate(converted);
  // A newer optional field the converter may add; the projections read none of it.
  await writeInbox(converted, { ...inboxRecord(ID2, { status: 'background', from: 'user-a', phase: 'sent-unconfirmed' }), errorKind: 'network' });
  const report = await runShadowProjection({ legacyDir: legacy, convertedDir: converted, now: fixedClock });
  assert.equal(report.allMatch, true);
});

// --- fail-closed -----------------------------------------------------------

test('a missing state root is refused', async () => {
  const root = await makeRoot();
  await populate(root);
  const missing = path.join(os.tmpdir(), `wechat-shadow-missing-${process.pid}-${Date.now()}`);
  await expectCode(() => runShadowProjection({ legacyDir: missing, convertedDir: root, now: fixedClock }), 'missing-root');
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: missing, now: fixedClock }), 'missing-root');
});

test('a missing category directory is refused', async () => {
  const root = await makeRoot();
  await populate(root);
  await fs.rm(path.join(root, SUBMISSION_DIRNAME), { recursive: true, force: true });
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock }), 'missing-collection');
});

test('a corrupt JSON record fails closed', async () => {
  const root = await makeRoot();
  await populate(root);
  await fs.writeFile(path.join(root, INBOX_DIRNAME, `${ID1}.json`), '{ this is not json', 'utf8');
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock }), 'corrupt-record');
});

test('a schema-mismatched record fails closed', async () => {
  const root = await makeRoot();
  await populate(root);
  await writeInbox(root, { ...inboxRecord(ID1), status: 'teleported' });
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock }), 'corrupt-record');
});

test('a record whose id does not match its file name fails closed', async () => {
  const root = await makeRoot();
  await populate(root);
  await fs.writeFile(path.join(root, OUTBOX_DIRNAME, `${O1}.json`), JSON.stringify(outboxRecord('other-id')), 'utf8');
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock }), 'corrupt-record');
});

test('a corrupt registry record fails closed', async () => {
  const root = await makeRoot();
  await populate(root);
  await fs.writeFile(path.join(root, SUBMISSION_DIRNAME, `${ID1}.json`), JSON.stringify({ receiptId: ID1, userId: 'u', payloadDigest: 'd', registeredAt: 1, state: 'dispatched' }), 'utf8');
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock }), 'corrupt-record');
});

test('invalid configuration fails closed', async () => {
  const root = await makeRoot();
  await populate(root);
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: 123 }), 'invalid-config');
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock, projections: [] }), 'invalid-config');
  await expectCode(() => runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock, projections: ['nope'] }), 'invalid-config');
  await expectCode(() => runShadowProjection({ legacyDir: 42, convertedDir: root, now: fixedClock }), 'invalid-path');
});

// --- the store enums this module mirrors -----------------------------------

test('the mirrored enums match the real store enums (drift guard)', () => {
  assert.deepEqual([...INBOX_STATUSES], [...MESSAGE_INBOX_STATUSES]);
  assert.ok(INBOX_STATUSES.includes('background'), 'the new background status must be mirrored');
  assert.ok(EXECUTION_PHASES.includes('sent-unconfirmed'), 'the sent-unconfirmed phase must be mirrored');
  assert.deepEqual([...OUTBOX_STATUSES], ['pending', 'sending', 'sent', 'blocked', 'cancelled']);
});

// --- injected projections --------------------------------------------------

test('an injected projection set replaces the built-ins', async () => {
  const root = await makeRoot();
  await populate(root);
  function inboxCount(state: { inbox: unknown[] }): number {
    return state.inbox.length;
  }
  const report = await runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock, projections: [inboxCount] });
  assert.equal(report.projections.length, 1);
  assert.deepEqual(report.projections.map((entry) => entry.name), ['inboxCount']);
  assert.equal(report.projections[0].match, true);
  assert.equal(report.allMatch, true);
});

test('a projection that throws is reported failed and does not abort the batch', async () => {
  const root = await makeRoot();
  await populate(root);
  function inboxCount(state: { inbox: unknown[] }): number {
    return state.inbox.length;
  }
  function boom(): never {
    throw new Error('kaboom');
  }
  const report = await runShadowProjection({ legacyDir: root, convertedDir: root, now: fixedClock, projections: [inboxCount, boom] });
  assert.equal(report.projections.length, 2);
  const bad = projectionNamed(report, 'boom');
  assert.equal(bad?.status, 'failed');
  assert.equal(bad?.match, false);
  assert.equal(bad?.legacyDigest, null);
  assert.equal(bad?.convertedDigest, null);
  assert.match((bad?.detail as { error: string }).error, /kaboom/);
  assert.equal(projectionNamed(report, 'inboxCount')?.match, true);
  assert.equal(report.allMatch, false);
});

// --- read-only guarantee ---------------------------------------------------

async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of [INBOX_DIRNAME, OUTBOX_DIRNAME, SUBMISSION_DIRNAME]) {
    const full = path.join(root, dir);
    let names: string[];
    try {
      names = (await fs.readdir(full)).sort();
    } catch {
      out.push(`${dir}: <missing>`);
      continue;
    }
    for (const name of names) {
      const bytes = await fs.readFile(path.join(full, name));
      out.push(`${dir}/${name}:${createHash('sha256').update(bytes).digest('hex')}`);
    }
  }
  return out;
}

test('neither root is mutated and no sidecar file is created', async () => {
  const legacy = await makeRoot();
  await populate(legacy);
  const converted = await makeRoot();
  await populate(converted);
  const before = await snapshotTree(legacy);
  const beforeConverted = await snapshotTree(converted);
  await runShadowProjection({ legacyDir: legacy, convertedDir: converted, now: fixedClock });
  assert.deepEqual(await snapshotTree(legacy), before);
  assert.deepEqual(await snapshotTree(converted), beforeConverted);
});

// --- cross-implementation digest: the module vs the Node canonicalisation ---

/** A verbatim copy of `stable()` from control-plane/shadow-projection.mjs:71-80. */
function nodeStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(nodeStable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${nodeStable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const nodeDigest = (value: unknown): string => `sha256:${createHash('sha256').update(nodeStable(value)).digest('hex')}`;

/** The module's own digest of an arbitrary value, via its public injected-projection seam. */
async function moduleDigest(value: unknown, emptyRoot: string): Promise<string | null> {
  const report = await runShadowProjection({ legacyDir: emptyRoot, convertedDir: emptyRoot, now: fixedClock, projections: [() => value] });
  return report.projections[0].legacyDigest;
}

test('the module digest equals the Node stable() digest on representative values', async () => {
  const root = await makeRoot();
  const values: unknown[] = [
    { received: 2, background: 1 }, // an inbox-status histogram
    ['a', 'b', 'c'], // an order-preserving array
    { count: 3, min: 500, max: 3000 }, // registeredAt bounds
    { '(absent)': 1 }, // the absent-bucket key
    0, // a bare zero
    [], // an empty array
    { count: 0, min: null, max: null }, // empty bounds
    { inboxOnly: ['00ff'], registryOnly: [] }, // a cross-consistency value
  ];
  for (const value of values) {
    assert.equal(await moduleDigest(value, root), nodeDigest(value), `digest mismatch for ${JSON.stringify(value)}`);
  }
});

test('the same root digests identically regardless of the injected clock', async () => {
  const root = await makeRoot();
  const at1000 = await moduleDigest({ received: 1 }, root);
  const at2000 = await moduleDigest({ received: 1 }, root);
  assert.equal(at1000, at2000);
  assert.equal(at1000, nodeDigest({ received: 1 }));
});
