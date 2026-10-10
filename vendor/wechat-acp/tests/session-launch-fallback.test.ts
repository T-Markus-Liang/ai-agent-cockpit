/**
 * S03a candidate-chain launch gate (remediation plan §5.3): the createSession
 * candidate loop must NOT advance to another harness for auth failures,
 * unknown launch effects (session/new already sent), permission errors, aborts
 * or unstructured errors — only a proven-clean spawn-not-found / startup-exit /
 * startup-timeout may advance. Real spawnAgent subprocesses (fake `node -e`
 * ACP agents) cover the producible kinds; the SessionManagerOpts.spawnAgent
 * test seam covers the kinds a real spawn cannot produce (auth_error,
 * unstructured plain Error).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AgentStartupError, killAgent } from "../src/acp/agent-manager.js";
import { SessionManager, type SessionManagerOpts, type UserSession } from "../src/acp/session.js";

/** A minimal fake ACP agent: answers initialize and session/new. */
const GOOD_AGENT = `
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (request.method === "session/new") {
      send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "new-session", configOptions: [] } });
    }
  });
`;

/** Answers initialize, then fails session/new AFTER it was sent. */
const NEW_SESSION_FAILS = `
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (request.method === "session/new") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "session boom" } });
    }
  });
`;

/** Never answers anything (forces a startup stall until abort). */
const HANGING_AGENT = `setInterval(() => {}, 1000);`;

interface Internal {
  createSession(userId: string, contextToken: string, signal: AbortSignal): Promise<UserSession>;
  fallbackUsers: Set<string>;
}

function makeManager(logs: string[], overrides: Partial<SessionManagerOpts> = {}): SessionManager {
  return new SessionManager({
    agentCommand: process.execPath,
    agentArgs: ["-e", GOOD_AGENT],
    agentCwd: process.cwd(),
    maxConcurrentUsers: 1,
    idleTimeoutMs: 0,
    showThoughts: false,
    killAgentProcess: async () => {},
    sendTyping: async () => {},
    log: (msg) => logs.push(msg),
    onReply: async () => {},
    ...overrides,
  });
}

const spawnCount = (logs: string[]): number =>
  logs.filter((line) => line.includes("Spawning agent:")).length;

test("a. spawn-not-found (ENOENT) advances to the fallback candidate", async () => {
  const logs: string[] = [];
  const manager = makeManager(logs, {
    agentCommand: "definitely-missing-acp-agent-s03a",
    agentArgs: [],
    fallbackAgents: [{ command: process.execPath, args: ["-e", GOOD_AGENT] }],
  });
  const internal = manager as unknown as Internal;
  let session: UserSession | undefined;
  try {
    session = await internal.createSession("u-enoent", "token", new AbortController().signal);
    assert.equal(session.agentInfo.sessionId, "new-session");
    assert.equal(session.fallbackSession, true, "the session came from the fallback candidate");
    assert.ok(internal.fallbackUsers.has("u-enoent"), "the user is marked as a fallback user");
    assert.ok(
      logs.some((line) => line.includes("launch gate: advance/spawn-not-found")),
      "the gate logged the spawn-not-found advance",
    );
    assert.ok(logs.some((line) => line.includes("fallback agent")), "the fallback selection is logged");
  } finally {
    if (session) killAgent(session.agentInfo.process);
    await manager.stop();
  }
});

test("b. a failure after session/new was sent never advances (unknown launch effect)", async () => {
  const logs: string[] = [];
  const manager = makeManager(logs, {
    agentCommand: process.execPath,
    agentArgs: ["-e", NEW_SESSION_FAILS],
    fallbackAgents: [{ command: process.execPath, args: ["-e", GOOD_AGENT] }],
  });
  const internal = manager as unknown as Internal;
  try {
    const err = await internal
      .createSession("u-touched", "token", new AbortController().signal)
      .then(() => assert.fail("the launch must fail"), (caught: unknown) => caught);
    assert.ok(err instanceof AgentStartupError, `expected AgentStartupError, got ${String(err)}`);
    assert.equal(err.providerSessionTouched, true, "session/new was sent before the failure");
    assert.equal(err.phase, "new-session");
    assert.equal(spawnCount(logs), 1, "the second candidate was never spawned");
    assert.ok(
      logs.some((line) => line.includes("launch gate: stop/unknown-launch-effect")),
      "the gate stopped on the unknown launch effect",
    );
  } finally {
    await manager.stop();
  }
});

test("c. auth_error never advances to another candidate (test seam)", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const manager = makeManager(logs, {
    fallbackAgents: [{ command: "fallback-binary", args: [] }],
    spawnAgent: async (params) => {
      calls.push(params.command);
      throw new AgentStartupError("provider rejected credentials", "auth_error", "initialize", false);
    },
  });
  const internal = manager as unknown as Internal;
  try {
    await assert.rejects(
      internal.createSession("u-auth", "token", new AbortController().signal),
      (err: unknown) => err instanceof AgentStartupError && err.kind === "auth_error",
    );
    assert.deepEqual(calls, [process.execPath], "no second candidate was attempted");
    assert.ok(logs.some((line) => line.includes("launch gate: stop/auth-failure")));
  } finally {
    await manager.stop();
  }
});

test("d. spawn-permission (EACCES) never advances to another candidate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s03a-noexec-"));
  const blocked = path.join(dir, "not-executable.sh");
  fs.writeFileSync(blocked, "echo never\n", { mode: 0o644 });
  const logs: string[] = [];
  const manager = makeManager(logs, {
    agentCommand: blocked,
    agentArgs: [],
    fallbackAgents: [{ command: process.execPath, args: ["-e", GOOD_AGENT] }],
  });
  const internal = manager as unknown as Internal;
  try {
    const err = await internal
      .createSession("u-eacces", "token", new AbortController().signal)
      .then(() => assert.fail("the launch must fail"), (caught: unknown) => caught);
    assert.ok(err instanceof AgentStartupError, `expected AgentStartupError, got ${String(err)}`);
    assert.equal(err.kind, "spawn-permission");
    assert.equal(err.providerSessionTouched, false);
    assert.equal(spawnCount(logs), 1, "the fallback candidate was never spawned");
    assert.ok(logs.some((line) => line.includes("launch gate: stop/permission-denied")));
  } finally {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("e. an abort stops the chain instead of advancing to the next candidate", async () => {
  const logs: string[] = [];
  const manager = makeManager(logs, {
    agentCommand: process.execPath,
    agentArgs: ["-e", HANGING_AGENT],
    fallbackAgents: [{ command: process.execPath, args: ["-e", GOOD_AGENT] }],
  });
  const internal = manager as unknown as Internal;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  try {
    const err = await internal
      .createSession("u-abort", "token", controller.signal)
      .then(() => assert.fail("the launch must fail"), (caught: unknown) => caught);
    assert.ok(err instanceof AgentStartupError, `expected AgentStartupError, got ${String(err)}`);
    assert.equal(err.kind, "aborted");
    const failures = logs.filter((line) => line.includes("failed:"));
    assert.equal(failures.length, 1, "only the first candidate failed; no advance after abort");
    assert.ok(failures[0]!.includes("launch gate: stop/launch-aborted"));
  } finally {
    await manager.stop();
  }
});

test("f. an unstructured plain Error stops the chain (fail closed, test seam)", async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const manager = makeManager(logs, {
    fallbackAgents: [{ command: "fallback-binary", args: [] }],
    spawnAgent: async (params) => {
      calls.push(params.command);
      throw new Error("totally unstructured boom");
    },
  });
  const internal = manager as unknown as Internal;
  try {
    await assert.rejects(
      internal.createSession("u-plain", "token", new AbortController().signal),
      /unstructured boom/,
    );
    assert.deepEqual(calls, [process.execPath], "no second candidate was attempted");
    assert.ok(logs.some((line) => line.includes("launch gate: stop/unknown-launch-effect")));
  } finally {
    await manager.stop();
  }
});

test("g. startup-exit (process dies during startup) advances to the fallback", async () => {
  const logs: string[] = [];
  const manager = makeManager(logs, {
    agentCommand: process.execPath,
    agentArgs: ["-e", "process.exit(1)"],
    fallbackAgents: [{ command: process.execPath, args: ["-e", GOOD_AGENT] }],
  });
  const internal = manager as unknown as Internal;
  let session: UserSession | undefined;
  try {
    session = await internal.createSession("u-exit", "token", new AbortController().signal);
    assert.equal(session.agentInfo.sessionId, "new-session");
    assert.equal(session.fallbackSession, true);
    assert.ok(logs.some((line) => line.includes("launch gate: advance/startup-exit-clean")));
  } finally {
    if (session) killAgent(session.agentInfo.process);
    await manager.stop();
  }
});
