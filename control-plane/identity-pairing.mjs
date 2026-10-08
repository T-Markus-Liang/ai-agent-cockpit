// Formal identity pairing and credential lifecycle for the Personal AI OS
// control plane (0.3.0 M02 / I03d, first slice).
//
// This module is a pure, in-memory authority: it owns code-based client
// pairing, token minting, rotation, revocation and expiry, and it can export a
// configuration document that `control-plane/request-authority.mjs` accepts
// verbatim. It performs no I/O, wires nothing into the runtime, and never logs.
//
// Secret hygiene: plaintext pairing codes and plaintext tokens are returned to
// the caller exactly once and are never retained internally or stored in
// serialized state. Only sha256 digests are kept. Every Error.message carries a
// machine-readable code (and, for denials, a fixed reason label) and never a
// token or code value.
import crypto from 'node:crypto';

// Role set mirrors control-plane/request-authority.mjs:9. request-authority
// does not export its ROLES set, so it is defined locally here and must be kept
// in lock-step with it (the exportPrincipals() contract depends on this).
export const ROLES = Object.freeze(new Set(['operator', 'coordinator', 'chief', 'viewer']));

// Pairing codes are short-lived (five minutes); principal tokens live 30 days.
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CODE_BYTES = 24; // 24 random bytes -> 32 char base64url pairing code
const TOKEN_BYTES = 32; // 32 random bytes -> 43 char base64url bearer token
const PRINCIPAL_ID_BYTES = 8; // 8 random bytes -> 16 hex chars after `p_`

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9:_-]{1,200}$/;

const sha256hex = value => crypto.createHash('sha256').update(value).digest('hex');

export class PairingError extends Error {
  constructor(code, reason) {
    super(reason === undefined ? code : `${code}: ${reason}`);
    this.name = 'PairingError';
    this.code = code;
    this.reason = reason;
  }
}

// `now` and `random` are injectable so callers/tests can run deterministically.
// `random(n)` must return `n` random bytes (crypto.randomBytes by default).
export function createPairingAuthority({ now = Date.now, random = crypto.randomBytes } = {}) {
  if (typeof now !== 'function' || typeof random !== 'function') throw new PairingError('invalid-state');

  // Pairing codes are keyed by sha256(code); plaintext codes are never stored.
  const codes = new Map(); // digestHex -> { role, clientLabel?, expiresAt, consumed }
  const principals = new Map(); // id -> { id, role, clientLabel?, tokenDigest, createdAt, expiresAt, revoked }

  const isActive = principal => !principal.revoked && principal.expiresAt > now();

  const mintToken = () => random(TOKEN_BYTES).toString('base64url');

  return {
    // Start a pairing ceremony. Returns the plaintext code once; only its digest
    // is retained. Unknown roles fail closed with `invalid-role`.
    beginPairing({ role, clientLabel } = {}) {
      if (typeof role !== 'string' || !ROLES.has(role)) throw new PairingError('invalid-role');
      const pairingCode = random(CODE_BYTES).toString('base64url');
      const expiresAt = now() + PAIRING_CODE_TTL_MS;
      codes.set(sha256hex(pairingCode), {
        role,
        ...(typeof clientLabel === 'string' ? { clientLabel } : {}),
        expiresAt,
        consumed: false,
      });
      return { pairingCode, expiresAt };
    },

    // Consume a pairing code exactly once and mint the first principal token.
    // Unknown, expired and already-consumed codes are all denied; the plaintext
    // code is never echoed in the error.
    completePairing(pairingCode) {
      const record = typeof pairingCode === 'string' ? codes.get(sha256hex(pairingCode)) : undefined;
      if (!record) throw new PairingError('pairing-denied', 'unknown');
      if (record.consumed) throw new PairingError('pairing-denied', 'consumed');
      if (record.expiresAt <= now()) throw new PairingError('pairing-denied', 'expired');
      record.consumed = true; // single use; digest retained to block replay
      const principalId = `p_${random(PRINCIPAL_ID_BYTES).toString('hex')}`;
      const token = mintToken();
      const createdAt = now();
      principals.set(principalId, {
        id: principalId,
        role: record.role,
        ...(record.clientLabel === undefined ? {} : { clientLabel: record.clientLabel }),
        tokenDigest: sha256hex(token),
        createdAt,
        expiresAt: createdAt + PRINCIPAL_TTL_MS,
        revoked: false,
      });
      return { principalId, token };
    },

    // Resolve a bearer token to its active principal. Unknown, expired, revoked
    // and malformed tokens all return `undefined` (never throw, timing-safe).
    authenticate(token) {
      if (typeof token !== 'string' || token.length === 0) return undefined;
      const digest = Buffer.from(sha256hex(token), 'hex');
      let found;
      for (const principal of principals.values()) {
        if (!isActive(principal)) continue;
        if (crypto.timingSafeEqual(digest, Buffer.from(principal.tokenDigest, 'hex'))) {
          found = Object.freeze({
            id: principal.id,
            role: principal.role,
            ...(principal.clientLabel === undefined ? {} : { clientLabel: principal.clientLabel }),
          });
        }
      }
      return found;
    },

    // Atomically replace a principal's credential. The old token stops working
    // immediately; the new token is returned once. Revoked/unknown -> denied.
    rotate(principalId) {
      const principal = principals.get(principalId);
      if (!principal || principal.revoked) throw new PairingError('unknown-principal');
      const token = mintToken();
      principal.tokenDigest = sha256hex(token);
      return { token };
    },

    // Revoke in place (record retained for audit; nothing is deleted).
    revoke(principalId) {
      const principal = principals.get(principalId);
      if (!principal || principal.revoked) throw new PairingError('unknown-principal');
      principal.revoked = true;
      return { principalId, revoked: true };
    },

    // Snapshot for persistence: principals (including revoked records, for
    // audit) and consumed pairing-code digests. Never any plaintext secret.
    toJSON() {
      return {
        version: 1,
        consumedCodes: [...codes.entries()].filter(([, record]) => record.consumed).map(([digest]) => digest),
        principals: [...principals.values()].map(principal => ({ ...principal })),
      };
    },

    // Rehydrate from a toJSON() snapshot after revalidating its structure.
    // Malformed state fails closed with `invalid-state`.
    fromJSON(data) {
      if (!isPlainObject(data) || data.version !== 1 ||
          Object.keys(data).some(key => !['version', 'consumedCodes', 'principals'].includes(key)) ||
          !Array.isArray(data.consumedCodes) || !Array.isArray(data.principals)) {
        throw new PairingError('invalid-state');
      }
      const nextCodes = new Map();
      for (const digest of data.consumedCodes) {
        if (typeof digest !== 'string' || !HEX.test(digest) || nextCodes.has(digest)) throw new PairingError('invalid-state');
        nextCodes.set(digest, { consumed: true });
      }
      const nextPrincipals = new Map();
      const digests = new Set();
      for (const principal of data.principals) {
        if (!isPlainObject(principal) ||
            Object.keys(principal).some(key => !['id', 'role', 'clientLabel', 'tokenDigest', 'createdAt', 'expiresAt', 'revoked'].includes(key)) ||
            typeof principal.id !== 'string' || !ID.test(principal.id) || nextPrincipals.has(principal.id) ||
            typeof principal.role !== 'string' || !ROLES.has(principal.role) ||
            typeof principal.tokenDigest !== 'string' || !HEX.test(principal.tokenDigest) || digests.has(principal.tokenDigest) ||
            !Number.isFinite(principal.createdAt) || !Number.isFinite(principal.expiresAt) ||
            typeof principal.revoked !== 'boolean' ||
            (principal.clientLabel !== undefined && typeof principal.clientLabel !== 'string')) {
          throw new PairingError('invalid-state');
        }
        digests.add(principal.tokenDigest);
        nextPrincipals.set(principal.id, {
          id: principal.id,
          role: principal.role,
          ...(principal.clientLabel === undefined ? {} : { clientLabel: principal.clientLabel }),
          tokenDigest: principal.tokenDigest,
          createdAt: principal.createdAt,
          expiresAt: principal.expiresAt,
          revoked: principal.revoked,
        });
      }
      codes.clear();
      principals.clear();
      for (const [digest, record] of nextCodes) codes.set(digest, record);
      for (const [id, principal] of nextPrincipals) principals.set(id, principal);
      return this;
    },

    // Configuration document consumed verbatim by
    // control-plane/request-authority.mjs (loadRequestAuthority). Active
    // principals only; shape is exactly { version: 1, principals: [...] }.
    exportPrincipals() {
      return {
        version: 1,
        principals: [...principals.values()].filter(isActive).map(principal => ({
          id: principal.id,
          role: principal.role,
          tokenDigest: principal.tokenDigest,
        })),
      };
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
