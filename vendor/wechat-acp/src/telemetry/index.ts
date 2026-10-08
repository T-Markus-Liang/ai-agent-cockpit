/**
 * Anonymous usage telemetry via Azure Application Insights — OPT-IN ONLY.
 *
 * Privacy / safety contract (SKEY-F002 + SKEY-F003 rework):
 *   - Telemetry is DISABLED BY DEFAULT. With `WECHAT_ACP_TELEMETRY` unset we do
 *     NOT load the SDK, do NOT create an install id, do NOT touch the filesystem,
 *     and do NOT emit any event or exception.
 *   - There is NO hard-coded connection string. Enabling requires BOTH an explicit
 *     opt-in (`WECHAT_ACP_TELEMETRY=1`) AND a private connection string supplied by
 *     the operator via `WECHAT_ACP_TELEMETRY_CONNECTION_STRING`. Missing either one
 *     keeps telemetry fully silent. The connection string is read from the
 *     environment only; it is never logged, stored, or sent as an event field.
 *   - `trackException` NEVER forwards the raw Error. It emits only a bounded
 *     `category` (allow-listed area) and a bounded machine-readable `code`
 *     (derived from a fixed set of error kinds). Error `message`, `stack`, `cause`,
 *     request bodies, headers and arbitrary `properties` are never read or sent.
 *   - Every emitted value is one of: a FIXED ENUM, a bounded COUNT, a
 *     CODE-COMPUTED salted hash, or TRUSTED version metadata. Arbitrary caller
 *     strings are NEVER forwarded verbatim — the old "looks like an identifier"
 *     token passthrough is gone (SKEY-F003):
 *       * `agentPreset` is classified into a known category (`custom` if unknown);
 *       * config `configId` / `optionValue` are emitted only as salted hashes;
 *       * the `ai.session.id` tag (event AND exception) is a salted hash of the
 *         caller's session id, or the install id when absent;
 *       * `commonProperties` / `context.tags` are built only from fixed constants,
 *         the random install id, bounded version metadata and classified presets.
 *
 * Enable:
 *   WECHAT_ACP_TELEMETRY=1 \
 *   WECHAT_ACP_TELEMETRY_CONNECTION_STRING='InstrumentationKey=…;IngestionEndpoint=…;' \
 *     wechat-acp
 *
 * Disable: leave `WECHAT_ACP_TELEMETRY` unset, or set it to `0` / `false` / `off`.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Opt-in token accepted for `WECHAT_ACP_TELEMETRY`. Anything else keeps it off. */
const OPT_IN_VALUES = new Set(["1", "true", "on"]);

/** Environment key that must carry the operator's private connection string. */
export const CONNECTION_STRING_ENV = "WECHAT_ACP_TELEMETRY_CONNECTION_STRING";
export const TELEMETRY_ENV = "WECHAT_ACP_TELEMETRY";

export type EventName =
  | "app.start"
  | "app.stop"
  | "login.success"
  | "login.failure"
  | "token.reused"
  | "message.received"
  | "message.injected"
  | "command.acp_config.view"
  | "command.acp_config.set"
  | "command.acp_cancel"
  | "command.acp_new"
  | "command.acp_more"
  | "command.buffer_start"
  | "command.buffer_done"
  | "session.created"
  | "prompt.completed"
  | "reply.sent"
  | "reply.image.sent"
  | "reply.audio.sent"
  | "reply.file.sent";

type PropValue = string | number | boolean;

// ---------------------------------------------------------------------------
// Allow-lists. Everything not listed here is dropped before it reaches the SDK.
// ---------------------------------------------------------------------------

const EVENT_PROP_SCHEMA: Record<EventName, Readonly<Record<string, PropKind>>> = {
  "app.start": { agentPreset: "agentPresetEnum", daemon: "bool" },
  "app.stop": { reason: "reasonEnum", uptimeSec: "int" },
  "login.success": { forced: "bool", durationMs: "int" },
  "login.failure": { forced: "bool", durationMs: "int", errorType: "code" },
  "token.reused": {},
  "message.received": { userIdHash: "hash", kind: "kindEnum" },
  "message.injected": { userIdHash: "hash", targetKind: "targetEnum" },
  "command.acp_new": {
    userIdHash: "hash",
    hadActiveSession: "bool",
    cancelledTurn: "bool",
    cancelledPendingCreation: "bool",
    droppedQueueCount: "int",
    droppedBufferedBlockCount: "int",
  },
  "command.acp_config.view": { userIdHash: "hash", hasSession: "bool", optionCount: "int" },
  // Config values are NEVER sent verbatim — only code-computed salted hashes.
  // Keys stay `configId` / `optionValue` (caller contract); the emitted value is
  // a 16-hex salted hash, not the raw string.
  "command.acp_config.set": {
    userIdHash: "hash",
    configId: "saltedHash",
    optionType: "optionTypeEnum",
    optionValue: "saltedHash",
  },
  "command.acp_cancel": {
    userIdHash: "hash",
    drainQueue: "bool",
    cancelledTurn: "bool",
    droppedQueueCount: "int",
  },
  "command.acp_more": {
    userIdHash: "hash",
    pendingCount: "int",
    sentCount: "int",
    remainingCount: "int",
  },
  "command.buffer_start": { userIdHash: "hash" },
  "command.buffer_done": { userIdHash: "hash", blockCount: "int" },
  "session.created": {
    userIdHash: "hash",
    agentPreset: "agentPresetEnum",
    activeSessions: "int",
    sessionOutcome: "sessionOutcomeEnum",
  },
  "prompt.completed": {
    userIdHash: "hash",
    agentPreset: "agentPresetEnum",
    stopReason: "stopReasonEnum",
    success: "bool",
    durationMs: "int",
    replyChars: "int",
  },
  "reply.sent": {
    userIdHash: "hash",
    segments: "int",
    segmentsSent: "int",
    chars: "int",
    durationMs: "int",
  },
  "reply.image.sent": { userIdHash: "hash", bytes: "int", mimeType: "mimeEnum", durationMs: "int" },
  "reply.audio.sent": { userIdHash: "hash", bytes: "int", mimeType: "mimeEnum", durationMs: "int" },
  "reply.file.sent": { userIdHash: "hash", bytes: "int", mimeType: "mimeEnum", durationMs: "int" },
};

type PropKind =
  | "bool"
  | "int"
  | "hash"
  | "saltedHash"
  | "code"
  | "kindEnum"
  | "targetEnum"
  | "reasonEnum"
  | "optionTypeEnum"
  | "sessionOutcomeEnum"
  | "stopReasonEnum"
  | "agentPresetEnum"
  | "mimeEnum";

/** Allow-listed exception areas. Anything else collapses to `unclassified`. */
const EXCEPTION_CATEGORIES = new Set<string>([
  "main",
  "monitor",
  "auth",
  "message",
  "state",
  "session.reset",
  "session.created",
  "session.cleanup",
  "session.persistence",
  "agent_spawn",
  "artifact_mcp",
  "buffer",
  "prompt",
  "command",
  "enqueue",
  "reply",
  "reply.segment",
  "reply.turn_end",
  "reply.image",
  "reply.audio",
  "reply.file",
]);

const UNCLASSIFIED = "unclassified";

/**
 * Bounded machine-readable error codes. Derived only from a fixed name→code map,
 * never from `err.message` / `err.stack` / `err.cause`.
 */
const ERROR_CODE_BY_NAME = new Map<string, string>([
  ["AbortError", "E_ABORT"],
  ["TimeoutError", "E_TIMEOUT"],
  ["TypeError", "E_TYPE"],
  ["RangeError", "E_RANGE"],
  ["SyntaxError", "E_SYNTAX"],
  ["ReferenceError", "E_REFERENCE"],
  ["Error", "E_GENERIC"],
]);
const UNKNOWN_CODE = "E_UNKNOWN";
const ALLOWED_ERROR_CODES = new Set<string>([...ERROR_CODE_BY_NAME.values(), UNKNOWN_CODE]);

const ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  kindEnum: new Set(["text", "image", "voice", "file", "video", "empty"]),
  targetEnum: new Set(["last-active-user", "explicit"]),
  reasonEnum: new Set(["signal", "error", "normal"]),
  optionTypeEnum: new Set(["select", "boolean", "unknown"]),
  sessionOutcomeEnum: new Set(["new", "loaded", "unsupported", "not_found"]),
  stopReasonEnum: new Set([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
    "canceled",
    "error",
    "other",
  ]),
  // Known built-in agent presets; anything else collapses to `custom`.
  agentPresetEnum: new Set([
    "copilot",
    "claude",
    "gemini",
    "qwen",
    "codex",
    "opencode",
    "openclaw",
    "kiro",
    "hermes",
    "kimi",
    "pi",
    "raw",
  ]),
  // Known MIME types; anything else collapses to `other`.
  mimeEnum: new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/amr",
    "audio/aac",
    "video/mp4",
    "application/pdf",
    "application/json",
    "application/octet-stream",
    "application/zip",
    "text/plain",
    "text/markdown",
    "text/csv",
  ]),
};

const ENUM_FALLBACK = "other";
const AGENT_PRESET_FALLBACK = "custom";
const HASH_RE = /^[0-9a-f]{1,64}$/;
const MAX_INT = 1_000_000_000_000; // 1e12 bounds any counter/duration we emit.
/**
 * Salt used when computing hashes of caller-supplied strings (session ids, config
 * values) and when no install id is available. Prefer the install-level random id;
 * this constant is a deterministic fallback so a value never egresses verbatim.
 */
const HASH_SALT_FALLBACK = "wechat-acp-telemetry";

/** Version metadata is trusted but still length/charset bounded. */
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

/** Deterministic, salted, truncated hash — the only way caller strings are emitted. */
function hashWithSalt(salt: string, value: string): string {
  return crypto
    .createHash("sha256")
    .update(salt)
    .update("\u0000")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function coerceProp(
  kind: PropKind,
  value: PropValue,
  hash: (v: string) => string,
): string | undefined {
  switch (kind) {
    case "bool":
      return typeof value === "boolean" ? String(value) : undefined;
    case "int": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
      return String(Math.trunc(Math.min(value, MAX_INT)));
    }
    case "hash":
      return typeof value === "string" && HASH_RE.test(value) ? value : undefined;
    case "saltedHash":
      // Never forward the raw string — always a code-computed salted hash.
      return typeof value === "string" && value.length > 0 ? hash(value) : undefined;
    case "code":
      return typeof value === "string" && ALLOWED_ERROR_CODES.has(value) ? value : UNKNOWN_CODE;
    case "agentPresetEnum": {
      const allowed = ENUM_VALUES.agentPresetEnum;
      return typeof value === "string" && allowed.has(value) ? value : AGENT_PRESET_FALLBACK;
    }
    default: {
      const allowed = ENUM_VALUES[kind];
      if (!allowed) return undefined;
      return typeof value === "string" && allowed.has(value) ? value : ENUM_FALLBACK;
    }
  }
}

/** Classify a raw agent preset into a known category; unknown → `custom`. */
function classifyAgentPreset(value: unknown): string {
  return typeof value === "string" && ENUM_VALUES.agentPresetEnum.has(value)
    ? value
    : AGENT_PRESET_FALLBACK;
}

/** Bound trusted version metadata; anything unusual → `unknown`. */
function boundedVersion(value: string): string {
  return typeof value === "string" && VERSION_RE.test(value) ? value : "unknown";
}

/** Map an error's `name` to a bounded code. Never inspects message/stack/cause. */
function classifyErrorCode(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") {
      const code = ERROR_CODE_BY_NAME.get(name);
      if (code) return code;
    }
  }
  return UNKNOWN_CODE;
}

// ---------------------------------------------------------------------------
// SDK seam (injectable for offline tests; never a real network call in tests).
// ---------------------------------------------------------------------------

interface AppInsightsClient {
  trackEvent(t: {
    name: string;
    properties?: Record<string, unknown>;
    tagOverrides?: Record<string, string>;
  }): void;
  trackException(t: {
    exception: Error;
    properties?: Record<string, unknown>;
    tagOverrides?: Record<string, string>;
  }): void;
  flush(opts?: { callback?: (msg: string) => void }): void;
  context: { tags: Record<string, string>; keys: { cloudRole: string; userId: string } };
  commonProperties: Record<string, string>;
}

interface AppInsightsSetup {
  setAutoCollectRequests(b: boolean): AppInsightsSetup;
  setAutoCollectPerformance(b: boolean): AppInsightsSetup;
  setAutoCollectExceptions(b: boolean): AppInsightsSetup;
  setAutoCollectDependencies(b: boolean): AppInsightsSetup;
  setAutoCollectConsole(b: boolean): AppInsightsSetup;
  setSendLiveMetrics(b: boolean): AppInsightsSetup;
  setInternalLogging(a: boolean, b: boolean): AppInsightsSetup;
  start(): unknown;
}

export interface TelemetrySdk {
  setup(connectionString: string): AppInsightsSetup;
  defaultClient: AppInsightsClient;
}

export type TelemetrySdkLoader = () => TelemetrySdk;

function defaultSdkLoader(): TelemetrySdk {
  // Lazy require keeps disabled installs free of any SDK load cost.
  return require("applicationinsights") as unknown as TelemetrySdk;
}

export interface InitTelemetryOptions {
  version: string;
  storageDir: string;
  agentPreset?: string;
  daemon?: boolean;
  /** Test seam: override the SDK loader. Production never passes this. */
  sdkLoader?: TelemetrySdkLoader;
}

export interface TelemetryEnv {
  [key: string]: string | undefined;
}

export interface TelemetryDeps {
  getEnv?: () => TelemetryEnv;
  sdkLoader?: TelemetrySdkLoader;
}

export interface Telemetry {
  init(opts: InitTelemetryOptions): void;
  trackEvent(name: EventName, props?: Record<string, PropValue>, sessionId?: string): void;
  trackException(err: unknown, area: string, sessionId?: string): void;
  hashUserId(userId: string): string;
  shutdown(): Promise<void>;
}

export function createTelemetry(deps: TelemetryDeps = {}): Telemetry {
  const getEnv = deps.getEnv ?? (() => process.env as TelemetryEnv);
  const sdkLoader = deps.sdkLoader ?? defaultSdkLoader;

  let client: AppInsightsClient | null = null;
  let installId = "";
  let initialized = false;
  let disabled = false;
  let closed = false;

  function readOptIn(): boolean {
    const v = (getEnv()[TELEMETRY_ENV] ?? "").trim().toLowerCase();
    return OPT_IN_VALUES.has(v);
  }

  function readConnectionString(): string {
    return (getEnv()[CONNECTION_STRING_ENV] ?? "").trim();
  }

  /** Instance hash: salted with the install-level random id (or a fixed fallback). */
  function saltedHash(value: string): string {
    return hashWithSalt(installId || HASH_SALT_FALLBACK, value);
  }

  function loadOrCreateInstallId(storageDir: string): string {
    const idFile = path.join(storageDir, "telemetry-id");
    try {
      if (fs.existsSync(idFile)) {
        const existing = fs.readFileSync(idFile, "utf-8").trim();
        if (existing) return existing;
      }
      const id = crypto.randomUUID();
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(idFile, id, "utf-8");
      return id;
    } catch {
      // Storage not writable — fall back to an ephemeral per-process id.
      return crypto.randomUUID();
    }
  }

  function init(opts: InitTelemetryOptions): void {
    if (closed) return; // terminal: closed instances never re-arm.
    if (initialized) return; // idempotent: ignore repeated init calls.
    initialized = true;

    // Default-off: require BOTH explicit opt-in AND a private connection string.
    const optIn = readOptIn();
    const connectionString = readConnectionString();
    if (!optIn || !connectionString) {
      disabled = true;
      client = null;
      return; // no SDK load, no install id, no filesystem write.
    }

    try {
      installId = loadOrCreateInstallId(opts.storageDir);

      const loader = opts.sdkLoader ?? sdkLoader;
      const appInsights = loader();
      const conn = connectionString; // read from env only; never logged or stored.
      const version = boundedVersion(opts.version);

      appInsights
        .setup(conn)
        .setAutoCollectRequests(false)
        .setAutoCollectPerformance(false)
        .setAutoCollectExceptions(false)
        .setAutoCollectDependencies(false)
        .setAutoCollectConsole(false)
        .setSendLiveMetrics(false)
        .setInternalLogging(false, false)
        .start();

      const c = appInsights.defaultClient as unknown as AppInsightsClient;
      // Every envelope tag is either a fixed constant, the random install id, or
      // bounded version metadata — never raw caller text.
      c.context.tags[c.context.keys.cloudRole] = "wechat-acp";
      c.context.tags[c.context.keys.userId] = installId;
      c.context.tags["ai.application.ver"] = version;
      c.commonProperties = {
        version,
        node: process.version,
        os: process.platform,
        arch: process.arch,
        installId,
        // Raw preset is classified into a known category; unknown → `custom`.
        ...(opts.agentPreset ? { agentPreset: classifyAgentPreset(opts.agentPreset) } : {}),
        ...(opts.daemon !== undefined ? { daemon: String(opts.daemon) } : {}),
      };
      client = c;
      disabled = false;
    } catch {
      // Telemetry must never break the app: fail silent and stay off.
      client = null;
      disabled = true;
    }
  }

  /**
   * The session tag is a code-computed salted hash of whatever the caller passes,
   * or the install id when absent. The raw caller string is never forwarded — this
   * single helper is used by BOTH trackEvent and trackException.
   */
  function buildTagOverrides(sessionId?: string): Record<string, string> {
    const token =
      typeof sessionId === "string" && sessionId.length > 0
        ? saltedHash(sessionId)
        : installId || "anonymous";
    return { "ai.session.id": token };
  }

  function trackEvent(
    name: EventName,
    props?: Record<string, PropValue>,
    sessionId?: string,
  ): void {
    if (disabled || closed || !client) return;
    const schema = EVENT_PROP_SCHEMA[name];
    if (!schema) return; // unknown event name → dropped entirely.
    try {
      const properties: Record<string, string> = {};
      if (props) {
        for (const [key, kind] of Object.entries(schema)) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
          const coerced = coerceProp(kind, props[key], saltedHash);
          if (coerced !== undefined) properties[key] = coerced;
        }
      }
      client.trackEvent({ name, properties, tagOverrides: buildTagOverrides(sessionId) });
    } catch {
      // ignore
    }
  }

  function trackException(err: unknown, area: string, sessionId?: string): void {
    if (disabled || closed || !client) return;
    try {
      const category = EXCEPTION_CATEGORIES.has(area) ? area : UNCLASSIFIED;
      const code = classifyErrorCode(err);
      // Construct a sanitized error carrying ONLY the bounded category/code. The
      // original err (message/stack/cause) is never forwarded.
      const safeError = new Error(`${category}:${code}`);
      safeError.name = code;
      safeError.stack = undefined;
      client.trackException({
        exception: safeError,
        properties: { category, code },
        tagOverrides: buildTagOverrides(sessionId),
      });
    } catch {
      // ignore
    }
  }

  function hashUserId(userId: string): string {
    if (!userId) return "";
    const salt = installId || "wechat-acp";
    return crypto.createHash("sha256").update(salt).update(userId).digest("hex").slice(0, 16);
  }

  async function shutdown(): Promise<void> {
    if (closed) return;
    const active = !disabled && client;
    const c = client;
    closed = true;
    client = null;
    if (!active || !c) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        c.flush({ callback: () => done() });
      } catch {
        done();
        return;
      }
      setTimeout(done, 2_000).unref();
    });
  }

  return { init, trackEvent, trackException, hashUserId, shutdown };
}

// ---------------------------------------------------------------------------
// Default singleton used by the rest of the app.
// ---------------------------------------------------------------------------

const singleton = createTelemetry();

/** Initialize telemetry once at startup. No-op unless opted in with a connection string. */
export function initTelemetry(opts: InitTelemetryOptions): void {
  singleton.init(opts);
}

export function trackEvent(
  name: EventName,
  props?: Record<string, PropValue>,
  sessionId?: string,
): void {
  singleton.trackEvent(name, props, sessionId);
}

export function trackException(err: unknown, area: string, sessionId?: string): void {
  singleton.trackException(err, area, sessionId);
}

/**
 * Hash a WeChat user id with the install salt so it's stable per-install but
 * cannot be linked across installs and cannot be reversed to the raw id. Works
 * even when telemetry is disabled (no install id file is created).
 */
export function hashUserId(userId: string): string {
  return singleton.hashUserId(userId);
}

/** Flush pending telemetry, with at most ~2s wait. */
export async function shutdownTelemetry(): Promise<void> {
  await singleton.shutdown();
}
