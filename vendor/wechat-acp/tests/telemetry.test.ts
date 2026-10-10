/**
 * SKEY-F002 negative tests — fully offline.
 *
 * Every scenario uses an in-memory FAKE SDK and a temp storage dir. No real
 * telemetry endpoint is contacted, no real network call is made, and no real
 * user file is touched. The synthetic credential below is constructed locally
 * (TESTONLY) and never written anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONNECTION_STRING_ENV,
  TELEMETRY_ENV,
  createTelemetry,
  type TelemetryEnv,
  type TelemetrySdk,
} from "../src/telemetry/index.js";

// A synthetic credential that would be dangerous if it ever egressed.
const TESTONLY_CRED = ["TESTONLY", "cred", "a1b2c3d4e5f60718293a"].join("-");
const CONN_STRING =
  "InstrumentationKey=TESTONLY-00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://synthetic.invalid/";

interface FakeSdk {
  sdk: TelemetrySdk;
  calls: {
    setup: number;
    connectionStrings: string[];
    start: number;
    events: Array<Record<string, unknown>>;
    exceptions: Array<Record<string, unknown>>;
    flushes: number;
  };
  client: {
    context: { tags: Record<string, string>; keys: { cloudRole: string; userId: string } };
    commonProperties: Record<string, string>;
  };
}

function makeFakeSdk(): FakeSdk {
  const calls: FakeSdk["calls"] = {
    setup: 0,
    connectionStrings: [],
    start: 0,
    events: [],
    exceptions: [],
    flushes: 0,
  };
  const client: FakeSdk["client"] = {
    context: { tags: {}, keys: { cloudRole: "ai.cloud.role", userId: "ai.user.id" } },
    commonProperties: {},
    trackEvent(t: Record<string, unknown>) {
      calls.events.push(t);
    },
    trackException(t: Record<string, unknown>) {
      calls.exceptions.push(t);
    },
    flush(opts?: { callback?: (msg: string) => void }) {
      calls.flushes += 1;
      opts?.callback?.("flushed");
    },
  } as unknown as FakeSdk["client"];
  const chain: Record<string, unknown> = {};
  for (const method of [
    "setAutoCollectRequests",
    "setAutoCollectPerformance",
    "setAutoCollectExceptions",
    "setAutoCollectDependencies",
    "setAutoCollectConsole",
    "setSendLiveMetrics",
    "setInternalLogging",
  ]) {
    chain[method] = () => chain;
  }
  chain.start = () => {
    calls.start += 1;
    return client;
  };
  const sdk = {
    setup(connectionString: string) {
      calls.setup += 1;
      calls.connectionStrings.push(connectionString);
      return chain as never;
    },
    defaultClient: client,
  } as unknown as TelemetrySdk;
  return { sdk, calls, client };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wechat-acp-telemetry-"));
}

function idFile(storageDir: string): string {
  return path.join(storageDir, "telemetry-id");
}

function enabledEnv(): TelemetryEnv {
  return { [TELEMETRY_ENV]: "1", [CONNECTION_STRING_ENV]: CONN_STRING };
}

/** Serialize everything that could leave the process. */
function egressBlob(fake: FakeSdk): string {
  return JSON.stringify({
    events: fake.calls.events,
    exceptions: fake.calls.exceptions,
    commonProperties: fake.client.commonProperties,
    tags: fake.client.context.tags,
  });
}

test("default config: zero SDK init, zero egress, no install-id file", async () => {
  const fake = makeFakeSdk();
  let loaderCalls = 0;
  const dir = tmpDir();
  try {
    const t = createTelemetry({
      getEnv: () => ({}),
      sdkLoader: () => {
        loaderCalls += 1;
        return fake.sdk;
      },
    });
    t.init({ version: "1.2.3", storageDir: dir });
    t.trackEvent("app.start", { agentPreset: "copilot", daemon: true });
    t.trackException(new Error(`boom ${TESTONLY_CRED}`), "auth");
    await t.shutdown();

    assert.equal(loaderCalls, 0, "SDK loader must not run by default");
    assert.equal(fake.calls.setup, 0);
    assert.equal(fake.calls.start, 0);
    assert.equal(fake.calls.events.length, 0);
    assert.equal(fake.calls.exceptions.length, 0);
    assert.equal(fake.calls.flushes, 0);
    assert.equal(fs.existsSync(idFile(dir)), false, "no telemetry-id file may be written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit WECHAT_ACP_TELEMETRY=0 disables even with a connection string", async () => {
  const fake = makeFakeSdk();
  let loaderCalls = 0;
  const dir = tmpDir();
  try {
    const t = createTelemetry({
      getEnv: () => ({ ...enabledEnv(), [TELEMETRY_ENV]: "0" }),
      sdkLoader: () => {
        loaderCalls += 1;
        return fake.sdk;
      },
    });
    t.init({ version: "1.2.3", storageDir: dir });
    t.trackEvent("login.success", { forced: false, durationMs: 10 });
    t.trackException("nope", "auth");
    await t.shutdown();

    assert.equal(loaderCalls, 0);
    assert.equal(fake.calls.events.length, 0);
    assert.equal(fake.calls.exceptions.length, 0);
    assert.equal(fs.existsSync(idFile(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in without a connection string stays fully silent", async () => {
  for (const env of [
    { [TELEMETRY_ENV]: "1" },
    { [TELEMETRY_ENV]: "1", [CONNECTION_STRING_ENV]: "" },
    { [TELEMETRY_ENV]: "1", [CONNECTION_STRING_ENV]: "   " },
  ] as TelemetryEnv[]) {
    const fake = makeFakeSdk();
    let loaderCalls = 0;
    const dir = tmpDir();
    try {
      const t = createTelemetry({
        getEnv: () => env,
        sdkLoader: () => {
          loaderCalls += 1;
          return fake.sdk;
        },
      });
      t.init({ version: "1.2.3", storageDir: dir });
      t.trackEvent("app.start", { agentPreset: "copilot" });
      t.trackException(new Error("x"), "auth");
      await t.shutdown();

      assert.equal(loaderCalls, 0, `loader must not run for ${JSON.stringify(env)}`);
      assert.equal(fake.calls.events.length, 0);
      assert.equal(fake.calls.exceptions.length, 0);
      assert.equal(fs.existsSync(idFile(dir)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("SDK initialization failure degrades silently and never throws", async () => {
  const dir = tmpDir();
  try {
    const t = createTelemetry({
      getEnv: enabledEnv,
      sdkLoader: () => {
        throw new Error("synthetic SDK load failure");
      },
    });
    assert.doesNotThrow(() => t.init({ version: "1.2.3", storageDir: dir }));
    // Calls after a failed init must be inert and must not throw.
    assert.doesNotThrow(() => t.trackEvent("app.start", { agentPreset: "copilot" }));
    assert.doesNotThrow(() => t.trackException(new Error("x"), "auth"));
    await assert.doesNotReject(() => t.shutdown());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler throwing during setup also degrades silently", async () => {
  const dir = tmpDir();
  try {
    const t = createTelemetry({
      getEnv: enabledEnv,
      sdkLoader: () =>
        ({
          setup() {
            throw new Error("synthetic setup failure");
          },
          defaultClient: {},
        }) as unknown as TelemetrySdk,
    });
    assert.doesNotThrow(() => t.init({ version: "1.2.3", storageDir: dir }));
    assert.doesNotThrow(() => t.trackException(new Error("x"), "auth"));
    await t.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled: egress carries only allow-listed fields, never the credential", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
    t.init({ version: "9.9.9", storageDir: dir });

    const nakedError = new Error(`leak ${TESTONLY_CRED} message`);
    nakedError.stack = `Error: leak ${TESTONLY_CRED}\n  at secret.ts:1:1`;
    const nested = new Error("outer only");
    (nested as { cause?: unknown }).cause = new Error(`inner ${TESTONLY_CRED}`);

    t.trackException(nakedError, "auth");
    t.trackException(`string error ${TESTONLY_CRED}`, "message");
    t.trackException(nested, "reply.image");
    t.trackException(new Error("other"), "totally-unknown-area");

    assert.equal(fake.calls.exceptions.length, 4);

    const expected = [
      { category: "auth", code: "E_GENERIC" },
      { category: "message", code: "E_UNKNOWN" },
      { category: "reply.image", code: "E_GENERIC" },
      { category: "unclassified", code: "E_GENERIC" },
    ];
    fake.calls.exceptions.forEach((payload, i) => {
      assert.deepEqual(payload.properties, expected[i], `payload #${i} must carry only category/code`);
      const exception = payload.exception as Error;
      assert.ok(exception instanceof Error);
      assert.notEqual(exception, nakedError, "raw Error object must not be forwarded");
      assert.equal(exception.stack, undefined, "no stack may be forwarded");
      assert.doesNotMatch(exception.message, /TESTONLY/, "no credential may reach the message");
      assert.equal(exception.message, `${expected[i].category}:${expected[i].code}`);
    });

    // The synthetic credential must appear nowhere in the egress payload.
    assert.doesNotMatch(egressBlob(fake), /TESTONLY/, "credential must never egress");
    assert.doesNotMatch(egressBlob(fake), /leak|inner|secret\.ts/, "no error text may egress");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled: trackEvent keeps only allow-listed keys with bounded values", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
    t.init({ version: "9.9.9", storageDir: dir });

    // Extra/unknown keys are dropped.
    t.trackEvent("message.received", {
      userIdHash: "deadbeefdeadbeef",
      kind: "text",
      bogus: "value",
      secretProp: 42,
    } as never);
    // Invalid enum/hash values fall back to a bounded value or are dropped.
    t.trackEvent("message.received", { userIdHash: "NOT-HEX", kind: "not-a-kind" });
    // Free-text stops collapse to `other`; unknown preset -> `custom`; numbers are
    // bounded integers; negatives drop.
    t.trackEvent("prompt.completed", {
      stopReason: `secret ${TESTONLY_CRED}`,
      agentPreset: "a b c",
      success: true,
      durationMs: 12.9,
      replyChars: -5,
    });
    // A known preset is preserved as its category.
    t.trackEvent("app.start", { agentPreset: "copilot", daemon: true });
    // Unknown event names are dropped entirely.
    t.trackEvent("evil.event" as never, { x: 1 } as never);
    // Raw session id (not a bounded token) must not be forwarded as a tag.
    t.trackEvent("message.received", { userIdHash: "deadbeefdeadbeef", kind: "text" }, "user@example.com");

    const events = fake.calls.events;
    assert.equal(events.length, 5, "unknown event name must be dropped");

    assert.deepEqual(Object.keys(events[0].properties as object).sort(), ["kind", "userIdHash"]);
    assert.deepEqual(events[0].properties, { userIdHash: "deadbeefdeadbeef", kind: "text" });

    assert.deepEqual(events[1].properties, { kind: "other" }, "invalid hash drops, invalid enum -> other");

    assert.deepEqual(events[2].properties, {
      stopReason: "other",
      agentPreset: "custom",
      success: "true",
      durationMs: "12",
    });

    assert.deepEqual(events[3].properties, { agentPreset: "copilot", daemon: "true" });

    const tag = (events[4].tagOverrides as Record<string, string>)["ai.session.id"];
    assert.notEqual(tag, "user@example.com", "raw session id must not be forwarded");
    assert.match(tag, /^[0-9a-f]{16}$/, "session tag must be a salted hash");

    for (const event of events) {
      for (const value of Object.values(event.properties as Record<string, unknown>)) {
        assert.equal(typeof value, "string");
      }
    }
    assert.doesNotMatch(egressBlob(fake), /TESTONLY/, "credential must never egress via events");
    assert.doesNotMatch(egressBlob(fake), /a b c/, "free text must never egress");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled: command.acp_more forwards the bounded renewedBlockedCount allow-list", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
    t.init({ version: "9.9.9", storageDir: dir });

    // The event carries the renewal count alongside the pending-text counters;
    // unknown keys are still dropped.
    t.trackEvent("command.acp_more", {
      userIdHash: "deadbeefdeadbeef",
      pendingCount: 2,
      sentCount: 1,
      remainingCount: 1,
      renewedBlockedCount: 3,
      secretProp: 42,
    } as never);

    const events = fake.calls.events;
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].properties, {
      userIdHash: "deadbeefdeadbeef",
      pendingCount: "2",
      sentCount: "1",
      remainingCount: "1",
      renewedBlockedCount: "3",
    });

    // renewedBlockedCount is bounded like every other counter: negatives drop.
    t.trackEvent("command.acp_more", {
      userIdHash: "deadbeefdeadbeef",
      renewedBlockedCount: -1,
    } as never);
    assert.deepEqual(events[1].properties, { userIdHash: "deadbeefdeadbeef" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enabled: connection string is never sent as an event field", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
    t.init({ version: "9.9.9", storageDir: dir });
    t.trackEvent("app.start", { agentPreset: "copilot", daemon: false });
    t.trackException(new Error("x"), "auth");

    assert.equal(fake.calls.connectionStrings[0], CONN_STRING, "SDK receives the env connection string");
    assert.doesNotMatch(egressBlob(fake), /InstrumentationKey|IngestionEndpoint/, "connection string must not egress");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated init is idempotent", async () => {
  const fake = makeFakeSdk();
  let loaderCalls = 0;
  const dir = tmpDir();
  try {
    const t = createTelemetry({
      getEnv: enabledEnv,
      sdkLoader: () => {
        loaderCalls += 1;
        return fake.sdk;
      },
    });
    t.init({ version: "1.0.0", storageDir: dir });
    t.init({ version: "2.0.0", storageDir: dir });
    t.init({ version: "3.0.0", storageDir: dir });

    assert.equal(loaderCalls, 1, "SDK must load once");
    assert.equal(fake.calls.setup, 1, "setup must run once");
    assert.equal(fake.client.commonProperties.version, "1.0.0", "first init wins");

    t.trackEvent("app.start", { agentPreset: "copilot" });
    assert.equal(fake.calls.events.length, 1);
    await t.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("after shutdown every call is a no-op", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
    t.init({ version: "1.0.0", storageDir: dir });
    t.trackEvent("app.start", { agentPreset: "copilot" });
    assert.equal(fake.calls.events.length, 1);

    await t.shutdown();
    assert.equal(fake.calls.flushes, 1);

    t.trackEvent("app.stop", { reason: "signal", uptimeSec: 1 });
    t.trackException(new Error("x"), "auth");
    t.init({ version: "2.0.0", storageDir: dir });
    await t.shutdown();

    assert.equal(fake.calls.events.length, 1, "no events after shutdown");
    assert.equal(fake.calls.exceptions.length, 0, "no exceptions after shutdown");
    assert.equal(fake.calls.flushes, 1, "shutdown is idempotent");
    assert.equal(fake.calls.setup, 1, "init after shutdown must not re-arm");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hashUserId works without telemetry and creates no install-id file", async () => {
  const dir = tmpDir();
  try {
    const t = createTelemetry({ getEnv: () => ({}), sdkLoader: () => makeFakeSdk().sdk });
    const a = t.hashUserId("user-1");
    const b = t.hashUserId("user-1");
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b, "hashing is stable");
    assert.notEqual(a, t.hashUserId("user-2"));
    assert.equal(t.hashUserId(""), "");
    assert.equal(fs.existsSync(idFile(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SKEY-F003 regression: the exact audit probe path. A synthetic value that is a
// "valid-looking identifier" (sk- + repeated TESTONLY, 35 chars) is passed through
// optionValue / configId / session tag / agentPreset and must NOT egress verbatim.
// ---------------------------------------------------------------------------

test("SKEY-F003: audit canary (sk-identifier shape) never egresses via config/tag/preset", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const canary = "sk-" + "TESTONLY".repeat(4); // the audit's 35-char synthetic value
    assert.equal(canary.length, 35);
    const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
    t.init({ version: "synthetic", storageDir: dir, agentPreset: canary });

    t.trackEvent(
      "command.acp_config.set",
      { configId: canary, optionType: "select", optionValue: canary },
      canary,
    );
    t.trackException(new Error(canary), "prompt", canary);

    const event = fake.calls.events[0];
    const exception = fake.calls.exceptions[0];

    // No raw canary anywhere in what leaves the process.
    assert.doesNotMatch(egressBlob(fake), /sk-TESTONLY/, "audit canary must never egress");

    // The four r1 leak paths, asserted fixed.
    assert.notEqual((event.properties as Record<string, string>).optionValue, canary);
    assert.notEqual((event.tagOverrides as Record<string, string>)["ai.session.id"], canary);
    assert.notEqual((exception.tagOverrides as Record<string, string>)["ai.session.id"], canary);
    assert.notEqual(fake.client.commonProperties.agentPreset, canary);

    // Config values egress only as salted hashes; preset collapses to a category.
    const props = event.properties as Record<string, string>;
    assert.match(props.optionValue, /^[0-9a-f]{16}$/);
    assert.match(props.configId, /^[0-9a-f]{16}$/);
    assert.equal(props.optionType, "select");
    assert.equal(fake.client.commonProperties.agentPreset, "custom");
    assert.match((event.tagOverrides as Record<string, string>)["ai.session.id"], /^[0-9a-f]{16}$/);
    assert.match((exception.tagOverrides as Record<string, string>)["ai.session.id"], /^[0-9a-f]{16}$/);
    // Event and exception share the same session-tag computation.
    assert.equal(
      (event.tagOverrides as Record<string, string>)["ai.session.id"],
      (exception.tagOverrides as Record<string, string>)["ai.session.id"],
    );
    // The raw exception text is gone (message/stack scrubbed).
    assert.doesNotMatch((exception.exception as Error).message, /sk-TESTONLY/);
    assert.equal((exception.exception as Error).stack, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("full egress surface carries no raw credential, path, URL or free text", async () => {
  const fake = makeFakeSdk();
  const dir = tmpDir();
  try {
    const credential = TESTONLY_CRED;
    const secretPath = "/Users/someone/private/secret-project/keys.txt";
    const secretUrl = "https://internal.example.invalid/private?token=abc";
    const freeText = "please summarize my private diary about finances";
    const presets = [credential, secretPath, secretUrl, freeText];

    for (const preset of presets) {
      fake.calls.events.length = 0;
      fake.calls.exceptions.length = 0;
      const t = createTelemetry({ getEnv: enabledEnv, sdkLoader: () => fake.sdk });
      // Inject raw text into every acceptable field position.
      t.init({ version: credential, storageDir: dir, agentPreset: preset, daemon: true });
      t.trackEvent(
        "command.acp_config.set",
        { configId: secretPath, optionType: "select", optionValue: secretUrl } as never,
        secretPath,
      );
      t.trackEvent("prompt.completed", {
        stopReason: freeText,
        agentPreset: preset,
        success: true,
        durationMs: 1,
        replyChars: 1,
      });
      t.trackException(new Error(credential + secretPath + secretUrl), "command", credential);

      const blob = egressBlob(fake);
      for (const raw of [credential, secretPath, secretUrl, freeText]) {
        assert.ok(!blob.includes(raw), `raw value must not egress: ${raw.slice(0, 12)}…`);
      }
      // Version metadata is bounded (untrusted-looking version → "unknown").
      assert.equal(fake.client.commonProperties.version, "unknown");
      assert.ok(["custom", "copilot"].includes(fake.client.commonProperties.agentPreset));
    }

    // context.tags and commonProperties only ever contain bounded metadata.
    assert.equal(fake.client.context.tags["ai.application.ver"], "unknown");
    for (const tag of Object.values(fake.client.context.tags)) {
      assert.ok(typeof tag === "string" && tag.length <= 64);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
