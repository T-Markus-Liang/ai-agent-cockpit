import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import http from "node:http";
import crypto from "node:crypto";

import { ConversationMemoryStore } from "../src/storage/memory.js";
import { extractionChunks, sentenceHashes } from "../src/storage/mem0.js";

test("conversation memory preserves recent turns and compacts older turns", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-memory-"));
  const file = path.join(dir, "conversation-memory.json");
  const memory = new ConversationMemoryStore({ file, enabled: true, maxTurns: 4, maxChars: 500, summaryChars: 300 });
  for (let index = 0; index < 8; index += 1) {
    await memory.append("user-1", "user", `user-${index}`);
    await memory.append("user-1", "assistant", `assistant-${index}`);
  }
  const context = await memory.context("user-1");
  assert.match(context, /Earlier excerpt \(lossy/);
  assert.match(context, /user-7/);
  assert.match(context, /assistant-7/);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.users["user-1"].turns.length <= 4, true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
});

test("full archive survives compaction and oversized messages; users stay isolated", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-memory-archive-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "memory.json");
  const memory = new ConversationMemoryStore({ file, enabled: true, maxTurns: 2, maxChars: 1000 });
  for (let i = 0; i < 12; i++) await memory.append("alice", "user", `完整历史-${i}`);
  const longText = "中文长文本".repeat(5000);
  await memory.append("alice", "user", longText);
  await memory.append("bob", "user", "Bob private");
  const context = await memory.context("alice");
  assert.equal(context.length <= 1000, true);
  assert.equal(context.includes("Bob"), false);
  const archives = await fs.readdir(memory.archiveDir);
  const turns = (await Promise.all(archives.map(async (entry) => (await fs.readFile(path.join(memory.archiveDir, entry), "utf8")).trim().split("\n").map(line => JSON.parse(line))))).flat();
  assert.equal(turns.length, 14);
  assert.equal(turns.some((turn) => turn.text === longText), true);
});

test("concurrent stores do not lose updates, including prototype-like user ids", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-memory-concurrent-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "memory.json");
  const a = new ConversationMemoryStore({ file, enabled: true, maxTurns: 32 });
  const b = new ConversationMemoryStore({ file, enabled: true, maxTurns: 32 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append("__proto__", "user", `message-${i}`)));
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.users.__proto__.turns.length, 20);
  assert.match(await b.context("__proto__"), /message-19/);
});

test("Mem0 outage preserves a durable outbox; retry recalls same user across restart/provider", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-memory-mem0-"));
  const tokenFile = path.join(dir, "token");
  await fs.writeFile(tokenFile, "test-local-token", { mode: 0o600 });
  let available = false;
  const ingested: Array<{ user_id: string; text: string }> = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer test-local-token") { res.writeHead(401); res.end(); return; }
    if (!available) { res.writeHead(503); res.end(); return; }
    let text = ""; for await (const data of req) text += data;
    const body = JSON.parse(text);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/turns") { ingested.push(body); res.end(JSON.stringify({ accepted: true })); }
    else { res.end(JSON.stringify({ results: ingested.filter((x) => x.user_id === body.user_id).map((x) => ({ memory: x.text })) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const options = { file: path.join(dir, "memory.json"), enabled: true, mem0: { url: `http://127.0.0.1:${port}`, tokenFile, timeoutMs: 100 } };
  const first = new ConversationMemoryStore(options);
  let second: ConversationMemoryStore | undefined;
  t.after(async () => { await first.close(); await second?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
  await first.append("alice", "user", "我喜欢中文回复");
  await first.flushOutbox();
  assert.equal(JSON.parse(await fs.readFile(options.file, "utf8")).outbox.length, 1);
  assert.match(await first.context("alice", "偏好"), /中文回复/);
  await first.close();
  available = true;
  second = new ConversationMemoryStore(options);
  await second.flushOutbox();
  assert.equal(JSON.parse(await fs.readFile(options.file, "utf8")).outbox.length, 0);
  assert.equal(ingested[0]!.user_id, "wechat-" + crypto.createHash("sha256").update("alice").digest("hex"));
  assert.match(await second.context("alice", "偏好"), /Mem0 retrieved user memories/);
  assert.equal((await second.context("bob", "偏好")).includes("中文回复"), false);
});

test("unknown/corrupt state never silently resets memory", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-memory-corrupt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "memory.json");
  await fs.writeFile(file, "corrupt");
  const memory = new ConversationMemoryStore({ file, enabled: true });
  await assert.rejects(memory.append("alice", "user", "hello"));
  assert.equal(await fs.readFile(file, "utf8"), "corrupt");
});

test("disabled memory neither reads nor creates a memory file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-memory-disabled-"));
  const file = path.join(dir, "conversation-memory.json");
  const memory = new ConversationMemoryStore({ file, enabled: false });
  await memory.append("user-1", "user", "secret should not persist");
  assert.equal(await memory.context("user-1"), "");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await fs.rm(dir, { recursive: true, force: true });
});

const userKeyOf = (userId: string) => "wechat-" + crypto.createHash("sha256").update(userId).digest("hex");

interface ArchivedEvent { id: string; userId: string; role: string; text: string; at: string }
interface TombstoneRow { event_id: string; source_hash: string; quote_hashes: string[] }

async function readArchiveEvents(memory: ConversationMemoryStore, userId: string): Promise<ArchivedEvent[]> {
  try {
    const raw = await fs.readFile(path.join(memory.archiveDir, `${userKeyOf(userId)}.jsonl`), "utf8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ArchivedEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function tombstoneRows(events: ArchivedEvent[]): TombstoneRow[] {
  const rows: TombstoneRow[] = [];
  for (const event of events) for (const chunk of extractionChunks(event.id, event.text)) rows.push({ event_id: chunk.eventId, source_hash: chunk.sourceHash, quote_hashes: sentenceHashes(chunk.text) });
  return rows;
}

function forgetResponse(body: Record<string, unknown>, rows: TombstoneRow[], epoch = 1): Response {
  const requested = body.event_ids as string[];
  const wanted = new Set(requested);
  return Response.json({
    accepted: true, status: "forgotten", scope: "server-source",
    user_id: body.user_id, memory_epoch: epoch, forgotten_event_ids: requested,
    tombstones: rows.filter((row) => wanted.has(row.event_id)), local_archive_handled: false,
  });
}

async function makeMem0Store(t: TestContext, handler: (body: Record<string, unknown>, url: string) => Response | Promise<Response>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-privacy-"));
  const tokenFile = path.join(dir, "token");
  await fs.writeFile(tokenFile, "synthetic-test-token", { mode: 0o600 });
  const file = path.join(dir, "memory.json");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: { body?: unknown } | undefined) => {
    calls.push(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    return handler(body, String(url));
  });
  const memory = new ConversationMemoryStore({ file, enabled: true, mem0: { url: "http://127.0.0.1:4325", tokenFile, timeoutMs: 100 } });
  t.after(async () => { await memory.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { memory, file, tokenFile, calls };
}

test("local forget validates owner archive targets before any remote work and persists the barrier before the fetch", async (t) => {
  let forgetCalls = 0;
  let releaseForget!: () => void;
  let forgetStarted!: () => void;
  const started = new Promise<void>((resolve) => { forgetStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseForget = resolve; });
  const { memory, file } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) return Response.json({ accepted: true }, { status: 202 });
    if (url.endsWith("/v1/forget")) { forgetCalls += 1; forgetStarted(); await gate; return Response.json({}, { status: 503 }); }
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "alice private");
  await memory.flushOutbox();
  await memory.append("bob", "user", "bob private");
  await memory.flushOutbox();
  const alice = await readArchiveEvents(memory, "alice");
  const bob = await readArchiveEvents(memory, "bob");

  await assert.rejects(memory.forget("alice", [bob[0]!.id], "req-cross"), /archive/);
  await assert.rejects(memory.forget("alice", ["does-not-exist"], "req-ghost"), /archive/);
  assert.equal(forgetCalls, 0, "no remote forget before target validation");

  const running = memory.forget("alice", [alice[0]!.id], "req-1");
  await started;
  const mid = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(mid.privacy[userKeyOf("alice")].pending, "durable barrier exists before the fetch resolves");
  releaseForget();
  const outcome = await running;
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.epoch, 0);
  assert.equal(forgetCalls, 1);
});

test("failed forget keeps a durable pending barrier across restart and suppresses re-uploads of the same source", async (t) => {
  const ingested: string[] = [];
  const { memory, file, tokenFile } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) { ingested.push(String(body.text)); return Response.json({ accepted: true }, { status: 202 }); }
    if (url.endsWith("/v1/forget")) return Response.json({}, { status: 503 });
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "forgotten alpha");
  await memory.flushOutbox();
  const events = await readArchiveEvents(memory, "alice");
  const outcome = await memory.forget("alice", [events[0]!.id], "req-fail");
  assert.equal(outcome.status, "pending");
  assert.equal((await memory.context("alice", "alpha")).includes("forgotten alpha"), false);

  await memory.close();
  const restarted = new ConversationMemoryStore({ file, enabled: true, mem0: { url: "http://127.0.0.1:4325", tokenFile, timeoutMs: 100 } });
  t.after(() => restarted.close());
  assert.equal((await restarted.privacyState("alice")).pending, true);
  assert.equal((await restarted.context("alice", "alpha")).includes("forgotten alpha"), false);
  await restarted.append("alice", "user", "forgotten alpha");
  await restarted.flushOutbox();
  assert.equal(ingested.filter((text) => text === "forgotten alpha").length, 1, "same-source re-upload stays suppressed");
  assert.equal((await restarted.context("alice")).includes("forgotten alpha"), false);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).outbox.length, 0);
});

test("confirmed forget drops old summary and pre-boundary/uncaptured assistant context but keeps the raw archive", async (t) => {
  let rows: TombstoneRow[] = [];
  const { memory, file } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) return Response.json({ accepted: true }, { status: 202 });
    if (url.endsWith("/v1/forget")) return forgetResponse(body, rows);
    return Response.json({ results: [] });
  });
  const store = memory;
  for (let index = 0; index < 6; index += 1) await store.append("alice", "user", `old-${index}`);
  await store.append("alice", "user", "alpha secret fact");
  await store.flushOutbox();
  const before = await readArchiveEvents(store, "alice");
  const target = before.find((event) => event.text === "alpha secret fact")!;
  rows = tombstoneRows(before);
  const outcome = await store.forget("alice", [target.id], "req-ok");
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.epoch, 1);

  await store.append("alice", "assistant", "derived from old session", 0);
  await store.append("alice", "user", "post boundary fresh");
  await store.append("alice", "assistant", "current fresh reply", 1);
  const context = await store.context("alice");
  assert.equal(context.includes("alpha secret fact"), false);
  assert.equal(context.includes("Earlier excerpt"), false);
  assert.equal(context.includes("derived from old session"), false);
  assert.equal(context.includes("post boundary fresh"), true);
  assert.equal(context.includes("current fresh reply"), true);

  const after = await readArchiveEvents(store, "alice");
  assert.equal(after.length, before.length + 3, "raw archive is never erased");
  assert.equal(after.some((event) => event.text === "alpha secret fact"), true);
  const privacy = await store.privacyState("alice");
  assert.equal(privacy.epoch, 1);
  assert.equal(privacy.pending, false);
  assert.equal(privacy.activeSessionResetRequired, true);
});

test("a reused request id with changed targets is rejected before effects in pending and confirmed cases", async (t) => {
  let mode: "fail" | "ok" = "fail";
  let rows: TombstoneRow[] = [];
  let forgetCalls = 0;
  const { memory, file } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) return Response.json({ accepted: true }, { status: 202 });
    if (url.endsWith("/v1/forget")) { forgetCalls += 1; return mode === "fail" ? Response.json({}, { status: 503 }) : forgetResponse(body, rows); }
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "first target");
  await memory.append("alice", "user", "second target");
  await memory.flushOutbox();
  const events = await readArchiveEvents(memory, "alice");
  const first = events.find((event) => event.text === "first target")!;
  const second = events.find((event) => event.text === "second target")!;
  rows = tombstoneRows(events);

  assert.equal((await memory.forget("alice", [first.id], "req-p")).status, "pending");
  await assert.rejects(memory.forget("alice", [second.id], "req-p"), /different targets/);
  assert.equal(forgetCalls, 1, "changed targets rejected before a second remote call");

  await memory.forget("alice", [first.id], "req-p");
  assert.equal(forgetCalls, 2, "same id and same set re-attempts the pending barrier");

  mode = "ok";
  assert.equal((await memory.forget("alice", [first.id], "req-p")).status, "confirmed");
  assert.equal(forgetCalls, 3);
  await assert.rejects(memory.forget("alice", [second.id], "req-p"), /different targets/);
  assert.equal(forgetCalls, 3, "confirmed changed target rejected before remote");
  const stable = await memory.forget("alice", [first.id], "req-p");
  assert.equal(stable.status, "confirmed");
  assert.equal(stable.epoch, 1);
  assert.equal(forgetCalls, 3, "same id and same set is stable with no new remote call");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.privacy[userKeyOf("alice")].epoch, 1);
});

test("a new archive id with the same forgotten source never enters context or uploads", async (t) => {
  const ingested: string[] = [];
  let rows: TombstoneRow[] = [];
  const { memory } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) { ingested.push(String(body.text)); return Response.json({ accepted: true }, { status: 202 }); }
    if (url.endsWith("/v1/forget")) return forgetResponse(body, rows);
    return Response.json({ results: [] });
  });
  const secret = "Bearer synthetic-secret-token-12345678 private preference";
  await memory.append("alice", "user", secret);
  await memory.flushOutbox();
  const events = await readArchiveEvents(memory, "alice");
  rows = tombstoneRows(events);
  assert.equal((await memory.forget("alice", [events[0]!.id], "req-src")).status, "confirmed");
  const uploadsAfterForget = ingested.length;

  await memory.append("alice", "user", secret);
  await memory.flushOutbox();
  assert.equal(ingested.length, uploadsAfterForget, "same redacted source is not re-uploaded under a new id");
  const context = await memory.context("alice");
  assert.equal(context.includes("private preference"), false);
  assert.equal(context.includes("synthetic-secret-token"), false);
  assert.equal((await readArchiveEvents(memory, "alice")).length, 2, "both raw originals stay readable");
});

test("context re-reads the boundary after recall and drops stale pre-forget context", async (t) => {
  let rows: TombstoneRow[] = [];
  let releaseRecall!: () => void;
  let recallStarted!: () => void;
  const recallBegun = new Promise<void>((resolve) => { recallStarted = resolve; });
  const recallGate = new Promise<void>((resolve) => { releaseRecall = resolve; });
  const { memory } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) return Response.json({ accepted: true }, { status: 202 });
    if (url.endsWith("/v1/forget")) return forgetResponse(body, rows);
    if (url.endsWith("/v1/search")) { recallStarted(); await recallGate; return Response.json({ results: [{ memory: "recalled secret fact" }] }); }
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "secret fact");
  await memory.flushOutbox();
  const events = await readArchiveEvents(memory, "alice");
  rows = tombstoneRows(events);

  const running = memory.context("alice", "secret");
  await recallBegun;
  assert.equal((await memory.forget("alice", [events[0]!.id], "req-race")).status, "confirmed");
  releaseRecall();
  const context = await running;
  assert.equal(context.includes("secret fact"), false, "stale local context dropped");
  assert.equal(context.includes("recalled secret fact"), false, "recall result that predates the boundary dropped");
});

test("a privacy boundary stays owner-scoped and never pollutes prototypes", async (t) => {
  let rows: TombstoneRow[] = [];
  const { memory, file } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) return Response.json({ accepted: true }, { status: 202 });
    if (url.endsWith("/v1/forget")) return forgetResponse(body, rows);
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "shared phrase");
  await memory.append("bob", "user", "shared phrase");
  await memory.append("__proto__", "user", "proto phrase");
  await memory.flushOutbox();
  rows = tombstoneRows(await readArchiveEvents(memory, "alice"));
  assert.equal((await memory.forget("alice", [(await readArchiveEvents(memory, "alice"))[0]!.id], "req-alice")).status, "confirmed");

  assert.equal((await memory.context("alice")).includes("shared phrase"), false);
  assert.equal((await memory.context("bob")).includes("shared phrase"), true, "unrelated user is unaffected");

  const protoEvents = await readArchiveEvents(memory, "__proto__");
  rows = tombstoneRows(protoEvents);
  assert.equal((await memory.forget("__proto__", [protoEvents[0]!.id], "req-proto")).status, "confirmed");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(state.privacy, userKeyOf("__proto__")), true);
  assert.equal(Object.prototype.hasOwnProperty.call(state.users, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(state.privacy), Object.prototype);
  assert.equal((await memory.context("__proto__")).includes("proto phrase"), false);
});

test("stale controls never reduce the local epoch and forwarded tombstone hashes suppress uploads", async (t) => {
  let controlEpoch = 0;
  let rows: TombstoneRow[] = [];
  const hidden = "control hidden fact";
  const hiddenHash = extractionChunks("probe", hidden)[0]!.sourceHash;
  const ingested: string[] = [];
  const { memory } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) { ingested.push(String(body.text)); return Response.json({ accepted: true }, { status: 202 }); }
    if (url.endsWith("/v1/forget")) return forgetResponse(body, rows);
    if (url.endsWith("/v1/controls")) return Response.json({ user_id: body.user_id, memory_epoch: controlEpoch, forgotten_event_ids: ["e-x"], tombstones: [{ event_id: "e-x", source_hash: hiddenHash, quote_hashes: sentenceHashes(hidden) }], local_archive_handled: false });
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "epoch seed");
  await memory.flushOutbox();
  const events = await readArchiveEvents(memory, "alice");
  rows = tombstoneRows(events);
  assert.equal((await memory.forget("alice", [events[0]!.id], "req-e")).status, "confirmed");
  assert.equal((await memory.privacyState("alice")).epoch, 1);

  assert.equal(await memory.syncPrivacy("alice"), 1, "stale controls cannot reduce the epoch");
  controlEpoch = 3;
  assert.equal(await memory.syncPrivacy("alice"), 3);
  controlEpoch = 1;
  assert.equal(await memory.syncPrivacy("alice"), 3, "later stale controls still cannot reduce the epoch");

  const uploadsBefore = ingested.length;
  await memory.append("alice", "user", hidden);
  await memory.flushOutbox();
  assert.equal(ingested.length, uploadsBefore, "server tombstone source hash suppresses the matching upload");
  assert.equal((await memory.context("alice")).includes(hidden), false);
});

test("first controls sync creates a durable local boundary for an externally forgotten source", async (t) => {
  let rows: TombstoneRow[] = [];
  const { memory, file } = await makeMem0Store(t, async (body, url) => {
    if (url.endsWith("/v1/turns")) return Response.json({ accepted: true }, { status: 202 });
    if (url.endsWith("/v1/controls")) return Response.json({ user_id: body.user_id, memory_epoch: 1,
      forgotten_event_ids: rows.map(row => row.event_id), tombstones: rows, local_archive_handled: false });
    return Response.json({ results: [] });
  });
  await memory.append("alice", "user", "old preference");
  await memory.flushOutbox();
  rows = tombstoneRows(await readArchiveEvents(memory, "alice"));
  assert.equal(await memory.syncPrivacy("alice"), 1);
  assert.equal((await memory.context("alice")).includes("old preference"), false);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.privacy[userKeyOf("alice")].epoch, 1);
});

test("corrupt privacy boundary never falls back to pre-boundary history", async (t) => {
  const { memory, file } = await makeMem0Store(t, () => Response.json({ accepted: true }, { status: 202 }));
  await memory.append("alice", "user", "must not resurrect");
  await memory.flushOutbox();
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  state.privacy = { [userKeyOf("alice")]: { epoch: 1, boundarySeq: null } };
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(memory.context("alice"), /invalid privacy state/);
});
