import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
  assert.match(context, /Summary:/);
  assert.match(context, /user-7/);
  assert.match(context, /assistant-7/);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.users["user-1"].turns.length <= 4, true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
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

