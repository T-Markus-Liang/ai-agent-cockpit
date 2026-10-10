import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Mem0Client, sentenceHashes } from "../src/storage/mem0.js";
import crypto from "node:crypto";

test("source sentence hashes match server grammar and preserve decimals", () => {
  const source = "My name is Rowan. My project budget is 1234.50 CNY.\n我不喝咖啡，喜欢喝茶。";
  const expected = ["My name is Rowan.", "My project budget is 1234.50 CNY.", "我不喝咖啡，喜欢喝茶。"];
  assert.deepEqual(sentenceHashes(source), expected.map(value => crypto.createHash("sha256").update(value).digest("hex")));
});
import { ConversationMemoryStore } from "../src/storage/memory.js";

test("Mem0 client accepts only loopback HTTP endpoints", () => {
  for (const url of ["https://127.0.0.1:4325", "http://example.com:4325", "file:///tmp/mem0"]) {
    assert.throws(() => new Mem0Client({ url, tokenFile: "unused" }), /loopback HTTP/);
  }
  for (const url of ["http://127.0.0.1:4325", "http://localhost:4325", "http://[::1]:4325"]) {
    assert.doesNotThrow(() => new Mem0Client({ url, tokenFile: "unused" }));
  }
});

test("Mem0 extraction input redacts common tokens and splits long originals with stable ids", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem0-client-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "token");
  await fs.writeFile(tokenFile, "synthetic-test-token", { mode: 0o600 });
  const uploads: Array<{ event_id: string; text: string }> = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    uploads.push(JSON.parse(String(init?.body)));
    return Response.json({ accepted: true }, { status: 202 });
  });
  const client = new Mem0Client({ url: "http://127.0.0.1:4325", tokenFile });
  const text = "Bearer synthetic-private-token sk-synthetic012345678901 apikey_synthetic012345678901 " + "中文".repeat(100_001);
  const turn = { id: "oversized", userId: "alice", role: "user" as const, text, at: "2026-10-06" };
  await client.ingest(turn);
  const first = uploads.splice(0);
  assert.equal(first.length, 3);
  assert.ok(first.every(row => row.text.length <= 100_000));
  assert.ok(first.every(row => !row.text.includes("synthetic-private-token") && !row.text.includes("synthetic012345678901")));
  await client.ingest(turn);
  assert.deepEqual(uploads, first);
  assert.equal(turn.text, text);
});

test("permanently rejected outbox events are retained privately and do not poison later turns", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem0-rejected-"));
  const tokenFile = path.join(dir, "token");
  await fs.writeFile(tokenFile, "synthetic-test-token", { mode: 0o600 });
  const memory = new ConversationMemoryStore({ file: path.join(dir, "memory.json"), enabled: true, mem0: { url: "http://127.0.0.1:4325", tokenFile } });
  t.after(async () => { await memory.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const accepted: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (payload.text === "rejected original") return Response.json({}, { status: 422 });
    accepted.push(payload.text);
    return Response.json({ accepted: true }, { status: 202 });
  });
  await memory.append("alice", "user", "rejected original");
  await memory.flushOutbox();
  await memory.append("alice", "user", "later valid turn");
  await memory.flushOutbox();
  const state = JSON.parse(await fs.readFile(path.join(dir, "memory.json"), "utf8"));
  assert.equal(state.outbox.length, 0);
  assert.equal(state.rejectedOutbox.length, 1);
  assert.equal(state.rejectedOutbox[0].event.text, "rejected original");
  assert.equal(state.rejectedOutbox[0].status, 422);
  assert.deepEqual(accepted, ["later valid turn"]);
});

test("close drains an in-flight upload and forbids starting new writes/uploads", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem0-close-"));
  const tokenFile = path.join(dir, "token");
  await fs.writeFile(tokenFile, "synthetic-test-token", { mode: 0o600 });
  const memory = new ConversationMemoryStore({ file: path.join(dir, "memory.json"), enabled: true, mem0: { url: "http://127.0.0.1:4325", tokenFile } });
  t.after(async () => { await memory.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++; started(); await gate;
    return Response.json({ accepted: true }, { status: 202 });
  });
  await memory.append("alice", "user", "before close");
  await requestStarted;
  let finished = false;
  const stopping = memory.close().then(() => { finished = true; });
  await assert.rejects(memory.append("alice", "user", "after close"), /closed/);
  assert.equal(finished, false);
  release(); await stopping;
  await memory.flushOutbox();
  assert.equal(requests, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "memory.json"), "utf8")).outbox.length, 0);
});
