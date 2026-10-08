import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import { WeChatAcpBridge } from "../src/bridge.js";
import { BRIDGE_COMMANDS, defaultConfig } from "../src/config.js";
import { ReplyOutbox } from "../src/storage/reply-outbox.js";
import { MessageType, type WeixinMessage } from "../src/weixin/types.js";

const ownedDirs: string[] = [];
const ownedOutboxes: ReplyOutbox[] = [];
after(async () => {
  await Promise.all(ownedOutboxes.map((outbox) => outbox.close()));
  await Promise.all(
    ownedDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

class TestBridge extends WeChatAcpBridge {
  readonly enqueued: string[] = [];
  readonly buffered: Array<{ contextToken: string; prompt: ContentBlock[] }> = [];
  readonly sent: Array<{ contextToken: string; segment: string }> = [];
  private readonly promptGenerations = new Map<string, number>();
  bufferError: Error | undefined;
  sendBehavior: (
    contextToken: string,
    segment: string,
  ) => boolean | Promise<boolean> = () => true;

  protected override async enqueueMessage(
    _msg: WeixinMessage,
    _userId: string,
    contextToken: string,
    _isCurrent: () => boolean = () => true,
    _replyGeneration?: number,
  ): Promise<void> {
    this.enqueued.push(contextToken);
  }

  protected override async enqueueBufferedPrompt(
    _userId: string,
    contextToken: string,
    prompt: ContentBlock[],
    _replyGeneration?: number,
  ): Promise<void> {
    this.buffered.push({ contextToken, prompt });
    if (this.bufferError) throw this.bufferError;
  }

  protected override async sendTextSegment(
    _userId: string,
    contextToken: string,
    segment: string,
  ): Promise<boolean> {
    this.sent.push({ contextToken, segment });
    return this.sendBehavior(contextToken, segment);
  }

  beginPrompt(contextToken: string): void {
    this.beginAgentPrompt("user", contextToken);
    this.promptGenerations.set(
      contextToken,
      this.messageGenerationForUser("user"),
    );
  }

  queueAgentReply(contextToken: string, text: string): Promise<void> {
    return this.sendAgentReply(
      "user",
      contextToken,
      text,
      this.promptGenerations.get(contextToken),
    );
  }

  /** Seed in-memory failed text segments directly (skips the durable outbox path). */
  seedPendingText(segments: string[], contextToken = "ctx-seeded"): void {
    const registry = (this as any).pendingText;
    const generation = registry.supersede("user", contextToken);
    registry.recordFailures("user", generation, segments);
  }
}

function textMessage(text: string, contextToken: string): WeixinMessage {
  return {
    from_user_id: "user",
    context_token: contextToken,
    message_type: MessageType.USER,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function makeBridge(): TestBridge {
  const config = defaultConfig();
  config.storage.stateFile = undefined;
  config.commandAliases = {
    [BRIDGE_COMMANDS.acpMore]: ["/acp-fetch-msg", "."],
  };
  return new TestBridge(config, () => {});
}

/**
 * TestBridge with a real durable ReplyOutbox injected but no message inbox, so
 * /acp-more exercises the outbox renewal path without any recovery side effects
 * (no receipt journaling, no automatic sweep timer).
 */
async function makeOutboxBridge(
  maxAttempts = 1,
): Promise<{ bridge: TestBridge; outbox: ReplyOutbox }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-more-"));
  ownedDirs.push(dir);
  const config = defaultConfig();
  config.storage.stateFile = undefined;
  config.commandAliases = {
    [BRIDGE_COMMANDS.acpMore]: ["/acp-fetch-msg", "."],
  };
  const bridge = new TestBridge(config, () => {});
  const outbox = new ReplyOutbox({ dir, maxAttempts });
  ownedOutboxes.push(outbox);
  (bridge as any).replyOutbox = outbox;
  return { bridge, outbox };
}

/** Drive a durable record to `blocked` by exhausting its delivery attempts. */
async function seedBlocked(
  outbox: ReplyOutbox,
  text: string,
  userId = "user",
): Promise<string> {
  const record = await outbox.put({ userId, contextToken: "ctx-old", text });
  await outbox.claimDue({ userId });
  const settled = await outbox.settle(record.id, { sent: false });
  assert.equal(settled.status, "blocked", "seed record must reach blocked");
  return record.id;
}

test("acp-more is intercepted without enqueueing an ACP turn", async () => {
  const bridge = makeBridge();

  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.deepEqual(bridge.enqueued, []);
  assert.deepEqual(bridge.sent, [
    { contextToken: "context-more", segment: "目前没有待补发的消息。" },
  ]);
});

test("bare dot alias is intercepted only as the complete message", async () => {
  const bridge = makeBridge();

  await bridge.handleMessage(textMessage(".", "context-dot"));
  assert.deepEqual(bridge.enqueued, []);
  await bridge.handleMessage(textMessage(". keep this prompt", "context-prompt"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-dot", segment: "目前没有待补发的消息。" },
  ]);
  assert.deepEqual(bridge.enqueued, ["context-prompt"]);
});

test("normal delivery retains only failed segments and still attempts later segments", async () => {
  const bridge = makeBridge();
  const first = "a".repeat(4000);
  const second = "later segment";
  bridge.beginPrompt("context-agent");
  bridge.sendBehavior = (contextToken, segment) =>
    contextToken !== "context-agent" || segment !== first;

  await bridge.queueAgentReply("context-agent", `${first}\n${second}`);
  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-agent", segment: first },
    { contextToken: "context-agent", segment: second },
    { contextToken: "context-more", segment: first },
    { contextToken: "context-more", segment: "待补发文本共 1 段，本次已发出 1 段。" },
  ]);
  assert.deepEqual(bridge.enqueued, []);
});

test("queued old reply cannot restore pending output after a newer prompt", async () => {
  const bridge = makeBridge();
  let releaseBlocker!: () => void;
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    blockerStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  bridge.sendBehavior = async (contextToken) => {
    if (contextToken === "context-blocker") {
      blockerStarted();
      await blocked;
      return true;
    }
    return contextToken !== "context-old";
  };

  bridge.beginPrompt("context-old");
  const blocker = bridge.handleMessage(
    textMessage(BRIDGE_COMMANDS.acpMore, "context-blocker"),
  );
  await started;
  const oldReply = bridge.queueAgentReply("context-old", "stale output");
  bridge.beginPrompt("context-new");
  releaseBlocker();
  await blocker;
  await oldReply;
  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-fetch"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-blocker", segment: "目前没有待补发的消息。" },
    { contextToken: "context-old", segment: "stale output" },
    { contextToken: "context-fetch", segment: "目前没有待补发的消息。" },
  ]);
});

test("buffer flush uses the fresh acp-prompt-done context token", async () => {
  const bridge = makeBridge();

  await bridge.handleMessage(
    textMessage(BRIDGE_COMMANDS.promptStart, "context-start"),
  );
  await bridge.handleMessage(textMessage("buffered prompt", "context-content"));
  await bridge.handleMessage(
    textMessage(BRIDGE_COMMANDS.promptDone, "context-done"),
  );

  assert.equal(bridge.buffered.length, 1);
  assert.equal(bridge.buffered[0]!.contextToken, "context-done");
  assert.deepEqual(bridge.buffered[0]!.prompt, [
    { type: "text", text: "buffered prompt" },
  ]);
});

test("a failed buffer flush does not create an unhandled rejection", async () => {
  const bridge = makeBridge();
  await bridge.handleMessage(
    textMessage(BRIDGE_COMMANDS.promptStart, "context-start"),
  );
  await bridge.handleMessage(textMessage("buffered prompt", "context-content"));
  bridge.bufferError = new Error("session reset");

  await assert.rejects(
    bridge.handleMessage(
      textMessage(BRIDGE_COMMANDS.promptDone, "context-done"),
    ),
    /session reset/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("acp-more renews durable blocked segments and never re-executes the task", async () => {
  const { bridge, outbox } = await makeOutboxBridge();
  const id = await seedBlocked(outbox, "blocked durable segment");
  assert.equal((await outbox.get(id))?.status, "blocked");

  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  // Renewed back to pending with a reset attempt budget, due immediately.
  const renewed = await outbox.get(id);
  assert.equal(renewed?.status, "pending");
  assert.equal(renewed?.attempts, 0);
  assert.ok((renewed?.nextAttemptAt ?? Infinity) <= Date.now());
  // The handler reports the renewal but sends no durable segment itself (the
  // outbox drain does that) and never enqueues an ACP turn.
  assert.deepEqual(bridge.enqueued, []);
  assert.deepEqual(bridge.sent, [
    {
      contextToken: "context-more",
      segment: "已恢复 1 段到重试上限的待补发文本，稍后会自动重试补发。",
    },
  ]);
});

test("acp-more renews both durable blocked segments and in-memory pending text", async () => {
  const { bridge, outbox } = await makeOutboxBridge();
  const id = await seedBlocked(outbox, "durable blocked");
  bridge.seedPendingText(["in-memory pending"]);

  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.equal((await outbox.get(id))?.status, "pending");
  assert.deepEqual(bridge.sent, [
    { contextToken: "context-more", segment: "in-memory pending" },
    {
      contextToken: "context-more",
      segment:
        "已恢复 1 段到重试上限的待补发文本，稍后会自动重试补发。\n待补发文本共 1 段，本次已发出 1 段。",
    },
  ]);
  assert.deepEqual(bridge.enqueued, []);
});

test("acp-more reports the exact renewed blocked count", async () => {
  const { bridge, outbox } = await makeOutboxBridge();
  await seedBlocked(outbox, "first blocked");
  await seedBlocked(outbox, "second blocked");

  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.deepEqual(bridge.sent, [
    {
      contextToken: "context-more",
      segment: "已恢复 2 段到重试上限的待补发文本，稍后会自动重试补发。",
    },
  ]);
  assert.equal(
    (await outbox.list({ userId: "user", statuses: ["blocked"] })).length,
    0,
    "every blocked segment must be renewed",
  );
});

test("acp-more with nothing to renew replies in Chinese and touches no outbox", async () => {
  const { bridge, outbox } = await makeOutboxBridge();

  await bridge.handleMessage(textMessage(BRIDGE_COMMANDS.acpMore, "context-more"));

  assert.deepEqual(bridge.sent, [
    { contextToken: "context-more", segment: "目前没有待补发的消息。" },
  ]);
  assert.deepEqual(await outbox.list(), []);
});
