import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import http from "node:http";
import crypto from "node:crypto";

import { ConversationMemoryStore } from "../src/storage/memory.js";

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
  const turns = (await Promise.all(archives.map(async (entry) => (await fs.readFile(path.join(memory.archiveDir, entry), "utf8")).trim().split("\n").map(JSON.parse)))).flat();
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
