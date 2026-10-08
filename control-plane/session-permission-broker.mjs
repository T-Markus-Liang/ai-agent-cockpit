// Session-level ACP permission bridge for the Personal AI OS control plane
// (0.3.0 M02 / I03d, second slice).
//
// The D07 module (control-plane/acp-permission-broker.mjs) is a per-execution
// bridge: it verifies exactly one frozen host binding and one approval. This
// module adds the session-scoped adjudication a real SessionManager needs — a
// registry keyed by a generated `s_...` id, one-shot semantics per
// `toolCallId`, and a hard fail-closed ordering so a missing / closed / replayed
// session or a malformed option set is denied *before* any approval is resolved
// or consumed. Verification itself is delegated, unchanged, to the D07 broker.
//
// This is a pure, in-memory authority: it performs no I/O of its own, never
// writes the store, never logs, and is not wired into the vendor SessionManager
// (that wiring is a later slice).
//
// Secret hygiene: decision entries retain only the request's parameters digest,
// never the rawInput payload. Every Error.message carries a machine-readable
// code only (and a fixed reason label); it never echoes a binding value, a
// session id, a tool call id or a request payload.
import crypto from 'node:crypto';
import { acpPermissionPlan, createAcpPermissionBroker } from './acp-permission-broker.mjs';

const STATE_VERSION = 1;
const SESSION_ID_BYTES = 16; // 16 random bytes -> 32 hex chars after `s_`
const SESSION_ID = /^s_[a-f0-9]{32}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

// Mirrors control-plane/acp-permission-broker.mjs:9 (TOOL_KINDS is not
// exported), kept in lock-step so an unknown tool kind is denied here with a
// precise reason instead of surfacing as a generic unverifiable request.
const TOOL_KINDS = Object.freeze(new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch']));

// Canonical binding keys are exactly those the D07 broker validates
// (acp-permission-broker.mjs:8 — ownerId/source/accountId/profileId/...). The
// design contract abbreviates three of them as owner/account/profile, so those
// aliases are accepted and normalized to the canonical names before delegation.
const BINDING_FIELDS = Object.freeze(['ownerId', 'source', 'accountId', 'profileId', 'nativeSessionId', 'cwd', 'taskId', 'executionId']);
const BINDING_ALIASES = Object.freeze({ owner: 'ownerId', account: 'accountId', profile: 'profileId' });
const ALIAS_OF = Object.freeze(Object.fromEntries(Object.entries(BINDING_ALIASES).map(([alias, field]) => [field, alias])));

const OUTCOMES = Object.freeze(new Set(['allow_once', 'unknown-session', 'session-closed', 'replay', 'unsupported-options', 'unknown-tool-kind', 'no-approval']));

export class SessionPermissionError extends Error {
  constructor(code, reason) {
    super(reason === undefined ? code : `${code}: ${reason}`);
    this.name = 'SessionPermissionError';
    this.code = code;
    this.reason = reason;
  }
}

// `now` and `random` are injectable so callers/tests can run deterministically.
// `random(n)` must return `n` random bytes (crypto.randomBytes by default).
export function createSessionPermissionBroker({ store, findApprovalId, now = Date.now, random = crypto.randomBytes } = {}) {
  if (typeof now !== 'function' || typeof random !== 'function' ||
      !store || typeof store.consumeApproval !== 'function' || typeof findApprovalId !== 'function') {
    throw new SessionPermissionError('invalid-state');
  }

  const sessions = new Map(); // sessionId -> { sessionId, binding, closed, closedAt }
  const decisionLog = []; // frozen entries, oldest first
  const adjudicated = new Set(); // `${sessionId}\0${toolCallId}` that were ever decided

  const at = () => new Date(now()).toISOString();

  // Append a decision entry (digest-level only) and remember the pair so a
  // repeat of the same toolCallId is a replay, never a fresh adjudication.
  function logDecision(sessionId, toolCallId, toolKind, parametersDigest, outcome) {
    const entry = Object.freeze({
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      toolCallId: typeof toolCallId === 'string' && toolCallId ? toolCallId : null,
      toolKind: typeof toolKind === 'string' && toolKind ? toolKind : null,
      parametersDigest: typeof parametersDigest === 'string' ? parametersDigest : null,
      outcome,
      at: at(),
    });
    decisionLog.push(entry);
    if (entry.sessionId !== null && entry.toolCallId !== null) adjudicated.add(`${entry.sessionId}\u0000${entry.toolCallId}`);
    return entry;
  }

  function denied(sessionId, toolCallId, toolKind, parametersDigest, reason) {
    logDecision(sessionId, toolCallId, toolKind, parametersDigest, reason);
    return { outcome: 'denied', reason };
  }

  return {
    // Register a session against a frozen copy of its host binding. Returns the
    // generated session id; the binding is never echoed back.
    registerSession(binding) {
      const normalized = normalizeBinding(binding, 'invalid-binding');
      const sessionId = `s_${random(SESSION_ID_BYTES).toString('hex')}`;
      sessions.set(sessionId, { sessionId, binding: normalized, closed: false, closedAt: null });
      return { sessionId };
    },

    // Mark a session closed (record retained for audit). Unknown -> throws.
    closeSession(sessionId) {
      const record = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!record) throw new SessionPermissionError('unknown-session');
      if (!record.closed) {
        record.closed = true;
        record.closedAt = at();
      }
      return { sessionId, closed: true };
    },

    // Adjudicate one permission request. Always resolves (never throws) with
    // either `{ outcome: 'allow_once' }` or `{ outcome: 'denied', reason }`.
    async handlePermissionRequest(request = {}) {
      const sessionId = request?.sessionId;
      const toolCallId = request?.toolCallId;
      const toolKind = request?.tool?.kind;
      const options = request?.options;

      // 1. Session state. Unknown or closed sessions never reach approval logic.
      const record = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!record) return denied(sessionId, toolCallId, toolKind, null, 'unknown-session');
      if (record.closed) return denied(sessionId, toolCallId, toolKind, null, 'session-closed');

      // 2. One-shot: an already-decided toolCallId is never re-adjudicated, so a
      //    replayed allow neither re-releases nor re-consumes an approval.
      const replayKey = typeof toolCallId === 'string' && toolCallId ? `${sessionId}\u0000${toolCallId}` : null;
      if (replayKey !== null && adjudicated.has(replayKey)) return denied(sessionId, toolCallId, toolKind, null, 'replay');

      // 3. Options must be exactly one allow_once option. Nothing else is
      //    selected and no first option is ever defaulted to.
      if (!Array.isArray(options) || options.length !== 1 || options[0]?.kind !== 'allow_once') {
        return denied(sessionId, toolCallId, toolKind, null, 'unsupported-options');
      }

      // 4. Unknown tool kinds are rejected before any approval is inspected.
      if (typeof toolKind !== 'string' || !TOOL_KINDS.has(toolKind)) {
        return denied(sessionId, toolCallId, toolKind, null, 'unknown-tool-kind');
      }

      // 5. Delegate verification to the D07 broker with the registered binding.
      //    The model-supplied approvalId is never trusted (host findApprovalId
      //    resolves it), and any failure/undefined denies rather than allows.
      const params = {
        sessionId: record.binding.nativeSessionId,
        toolCall: { toolCallId, kind: toolKind, rawInput: request.rawInput },
        options,
      };
      let parametersDigest = null;
      try { parametersDigest = acpPermissionPlan(record.binding, params).parametersDigest; } catch { parametersDigest = null; }

      let optionId;
      try { optionId = await createAcpPermissionBroker({ store, binding: record.binding, findApprovalId }).authorizePermission(params); } catch { optionId = undefined; }

      if (typeof optionId === 'string' && optionId.length > 0) {
        logDecision(sessionId, toolCallId, toolKind, parametersDigest, 'allow_once');
        return { outcome: 'allow_once' };
      }
      return denied(sessionId, toolCallId, toolKind, parametersDigest, 'no-approval');
    },

    // Decision log, optionally filtered by session. Returns frozen copies.
    decisions(sessionId) {
      const entries = sessionId === undefined ? decisionLog : decisionLog.filter(entry => entry.sessionId === sessionId);
      return Object.freeze(entries.map(entry => Object.freeze({ ...entry })));
    },

    // Snapshot for persistence: closed sessions (retained for audit) and the
    // digest-level decision log. Never any rawInput payload or secret.
    toJSON() {
      return {
        version: STATE_VERSION,
        sessions: [...sessions.values()].map(record => ({
          sessionId: record.sessionId,
          binding: { ...record.binding },
          closed: record.closed,
          closedAt: record.closedAt,
        })),
        decisions: decisionLog.map(entry => ({ ...entry })),
      };
    },

    // Rehydrate from a toJSON() snapshot after revalidating it in full.
    // Malformed state fails closed with `invalid-state`.
    fromJSON(data) {
      if (!isPlainObject(data) || data.version !== STATE_VERSION ||
          Object.keys(data).some(key => !['version', 'sessions', 'decisions'].includes(key)) ||
          !Array.isArray(data.sessions) || !Array.isArray(data.decisions)) {
        throw new SessionPermissionError('invalid-state');
      }

      const nextSessions = new Map();
      for (const record of data.sessions) {
        if (!isPlainObject(record) ||
            Object.keys(record).some(key => !['sessionId', 'binding', 'closed', 'closedAt'].includes(key)) ||
            typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId) || nextSessions.has(record.sessionId) ||
            typeof record.closed !== 'boolean' ||
            !(record.closedAt === null || isIso(record.closedAt))) {
          throw new SessionPermissionError('invalid-state');
        }
        nextSessions.set(record.sessionId, {
          sessionId: record.sessionId,
          binding: normalizeBinding(record.binding, 'invalid-state'),
          closed: record.closed,
          closedAt: record.closedAt,
        });
      }

      const nextLog = [];
      for (const entry of data.decisions) {
        if (!isPlainObject(entry) ||
            Object.keys(entry).some(key => !['sessionId', 'toolCallId', 'toolKind', 'parametersDigest', 'outcome', 'at'].includes(key)) ||
            !(entry.sessionId === null || (typeof entry.sessionId === 'string' && entry.sessionId.trim() !== '')) ||
            !(entry.toolCallId === null || (typeof entry.toolCallId === 'string' && entry.toolCallId !== '')) ||
            !(entry.toolKind === null || (typeof entry.toolKind === 'string' && entry.toolKind !== '')) ||
            !(entry.parametersDigest === null || (typeof entry.parametersDigest === 'string' && DIGEST.test(entry.parametersDigest))) ||
            typeof entry.outcome !== 'string' || !OUTCOMES.has(entry.outcome) ||
            !isIso(entry.at)) {
          throw new SessionPermissionError('invalid-state');
        }
        nextLog.push(Object.freeze({
          sessionId: entry.sessionId,
          toolCallId: entry.toolCallId,
          toolKind: entry.toolKind,
          parametersDigest: entry.parametersDigest,
          outcome: entry.outcome,
          at: entry.at,
        }));
      }

      sessions.clear();
      for (const [id, record] of nextSessions) sessions.set(id, record);
      decisionLog.length = 0;
      adjudicated.clear();
      for (const entry of nextLog) {
        decisionLog.push(entry);
        if (entry.sessionId !== null && entry.toolCallId !== null) adjudicated.add(`${entry.sessionId}\u0000${entry.toolCallId}`);
      }
      return this;
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// Validate a host binding against the 8 canonical D07 fields, accepting the
// shorthand aliases and normalizing to the canonical names. Any missing field,
// non-string/empty value, unknown key or conflicting alias fails closed with
// `code`.
function normalizeBinding(input, code) {
  if (!isPlainObject(input)) throw new SessionPermissionError(code);
  const allowed = new Set(BINDING_FIELDS);
  for (const alias of Object.keys(BINDING_ALIASES)) allowed.add(alias);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new SessionPermissionError(code);

  const binding = {};
  for (const field of BINDING_FIELDS) {
    const alias = ALIAS_OF[field];
    const hasCanonical = Object.hasOwn(input, field);
    const hasAlias = alias !== undefined && Object.hasOwn(input, alias);
    if (hasCanonical && hasAlias && input[field] !== input[alias]) throw new SessionPermissionError(code);
    const value = hasCanonical ? input[field] : hasAlias ? input[alias] : undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new SessionPermissionError(code);
    binding[field] = value;
  }
  return Object.freeze(binding);
}
