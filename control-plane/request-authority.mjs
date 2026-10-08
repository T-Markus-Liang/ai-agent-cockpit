// Strict request authority for the new runtime path. An unconfigured 0.2.2
// gateway remains explicitly legacy-loopback, not authenticated or safe for
// new tool execution. No token is minted, logged or returned by this module.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Parsed authority documents are tiny; anything larger is refused rather than
// read. Kept in lock-step with loadRequestAuthority's streaming limit.
const MAX_AUTHORITY_BYTES = 16384;

const ROLES = new Set(['operator', 'coordinator', 'chief', 'viewer']);
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9:_-]{1,200}$/;

export class AuthorityError extends Error {
  constructor(code, status = 403) {
    super(code === 'AUTH_REQUIRED' ? 'request authentication required' : 'request authority rejected');
    this.name = 'AuthorityError'; this.code = code; this.status = status;
  }
}

// `clock` is injectable for deterministic expiry tests. A principal may carry
// two optional lifecycle fields (M02 ID-E001):
//   - expiresAt: finite, non-negative epoch ms. `clock() >= expiresAt` means the
//     principal no longer matches (AUTH_REQUIRED 401).
//   - revoked:   when present it must be exactly `true`; a revoked entry never
//     matches and is retained as revocation evidence rather than deleted.
// Unknown keys, duplicate ids/digests and any other malformed field still fail
// closed with AUTH_CONFIGURATION 500.
export function createRequestAuthority(input, { clock = Date.now } = {}) {
  if (!input || input.version !== 1 || !Array.isArray(input.principals) || input.principals.length < 1 || input.principals.length > 16) {
    throw new AuthorityError('AUTH_CONFIGURATION', 500);
  }
  const ids = new Set(), digests = new Set();
  const principals = input.principals.map(value => {
    if (!value || Object.keys(value).some(key => !['id', 'role', 'tokenDigest', 'expiresAt', 'revoked'].includes(key)) ||
        typeof value.id !== 'string' || typeof value.role !== 'string' || typeof value.tokenDigest !== 'string' ||
        !ID.test(value.id) || !ROLES.has(value.role) || !HEX.test(value.tokenDigest) || ids.has(value.id) || digests.has(value.tokenDigest) ||
        (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt < 0)) ||
        (value.revoked !== undefined && value.revoked !== true)) {
      throw new AuthorityError('AUTH_CONFIGURATION', 500);
    }
    ids.add(value.id); digests.add(value.tokenDigest);
    return {
      public: Object.freeze({ id: value.id, role: value.role, authenticated: true }),
      digest: Buffer.from(value.tokenDigest, 'hex'),
      expiresAt: value.expiresAt,
      revoked: value.revoked === true,
    };
  });
  return Object.freeze({ mode: 'strict', authenticate(headers) {
    const header = headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new AuthorityError('AUTH_REQUIRED', 401);
    const digest = crypto.createHash('sha256').update(header.slice(7)).digest();
    const now = clock();
    let found;
    for (const principal of principals) {
      if (principal.revoked || (principal.expiresAt !== undefined && now >= principal.expiresAt)) continue;
      if (crypto.timingSafeEqual(digest, principal.digest)) found = principal.public;
    }
    if (!found) throw new AuthorityError('AUTH_REQUIRED', 401);
    return found;
  } });
}

export async function loadRequestAuthority({ file, required = false } = {}) {
  if (file === undefined || file === '') {
    if (required) throw new AuthorityError('AUTH_CONFIGURATION', 500);
    return Object.freeze({ mode: 'legacy-loopback', authenticate: () => undefined });
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new AuthorityError('AUTH_CONFIGURATION', 500);
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_AUTHORITY_BYTES || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new AuthorityError('AUTH_CONFIGURATION', 500);
    return createRequestAuthority(JSON.parse(await handle.readFile('utf8')));
  } catch {
    throw new AuthorityError('AUTH_CONFIGURATION', 500);
  } finally { await handle?.close(); }
}

// M02 ID-E001: a *live* authority that revalidates the on-disk configuration on
// every `authenticate` call, so token rotation / revocation / expiry take effect
// without restarting the process. Same synchronous shape as createRequestAuthority
// ({ mode, authenticate(headers) }), plus a read-only `generation` reload counter
// for observation. No token, digest or file content is ever logged or returned.
//
// Change detection and TOCTOU: the file is opened with O_NOFOLLOW and the change
// key (`ino:mtimeMs:size`) is taken from fstat on that same fd, so there is no
// stat->read path-swap window. When the key is unchanged the cached parsed
// authority is served without re-parsing; when it changes the fd's identity,
// type, size, mode, uid and JSON/schema are revalidated in full on the same fd.
//
// Fail-closed: any reload failure (file gone, permissions drift, symlink, bad
// JSON, bad schema) throws AuthorityError('AUTH_CONFIGURATION', 500) and the old
// cache is *never* used as a fallback. A writer rotating this file MUST do so
// atomically (write a tmp file, then rename over the target); an in-place
// truncate+write can be observed mid-flight and is rejected, not half-parsed.
export function createLiveRequestAuthority({ file, required = false, clock = Date.now } = {}) {
  if (file === undefined || file === '') {
    if (required) throw new AuthorityError('AUTH_CONFIGURATION', 500);
    return Object.freeze({ mode: 'legacy-loopback', generation: 0, authenticate: () => undefined });
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new AuthorityError('AUTH_CONFIGURATION', 500);
  let cache = null; // { key, authority }
  let generation = 0;
  return Object.freeze({
    mode: 'strict',
    get generation() { return generation; },
    authenticate(headers) {
      let fd;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        const key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
        if (cache !== null && cache.key === key) return cache.authority.authenticate(headers);
        if (!stat.isFile() || stat.size > MAX_AUTHORITY_BYTES || (stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new AuthorityError('AUTH_CONFIGURATION', 500);
        const authority = createRequestAuthority(JSON.parse(readFileSync(fd, 'utf8')), { clock });
        cache = { key, authority };
        generation += 1;
        return authority.authenticate(headers);
      } catch (error) {
        if (error instanceof AuthorityError) throw error;
        throw new AuthorityError('AUTH_CONFIGURATION', 500);
      } finally { if (fd !== undefined) closeSync(fd); }
    },
  });
}

// M02 goals-per-client-token wave (completes the D40 handoff gap "file
// production side not wired"): produce the authority document that
// createLiveRequestAuthority / loadRequestAuthority consume. The snapshot is
// validated with createRequestAuthority first, so an invalid document is never
// written. The write is atomic — a mode-0600 tmp file in the target directory,
// then rename over the target — so a concurrent reader never observes a
// half-written file (matching the live reload contract above). Used to feed
// per-client principals exported by identity-pairing's exportPrincipals().
export async function writeAuthorityFile(file, snapshot) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new AuthorityError('AUTH_CONFIGURATION', 500);
  createRequestAuthority(snapshot); // structural validation; throws AUTH_CONFIGURATION before any write
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > MAX_AUTHORITY_BYTES) throw new AuthorityError('AUTH_CONFIGURATION', 500);
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(serialized);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error instanceof AuthorityError ? error : new AuthorityError('AUTH_CONFIGURATION', 500);
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error instanceof AuthorityError ? error : new AuthorityError('AUTH_CONFIGURATION', 500);
  }
}

export function authorizeHttpRequest(principal, method, pathname) {
  if (principal?.authenticated !== true || !ROLES.has(principal.role) || typeof principal.id !== 'string' || !ID.test(principal.id)) throw new AuthorityError('AUTH_REQUIRED', 401);
  if (method === 'GET') {
    // session/list can spawn a CLI; it is not an ordinary read-only HTTP view.
    if (pathname === '/api/control-plane/native-sessions' && principal.role === 'viewer') throw new AuthorityError('AUTH_FORBIDDEN');
    return;
  }
  if (pathname === '/mcp' && method === 'POST') return; // MCP enforces per-tool roles separately.
  if (principal.role === 'operator') return;
  if (principal.role === 'coordinator' && method === 'POST' &&
      (/^\/api\/control-plane\/executions\/[^/]+\/(status|evidence)$/.test(pathname) || pathname === '/api/control-plane/events')) return;
  if (principal.role === 'chief' && method === 'POST' &&
      (['/api/control-plane/route-plan', '/api/control-plane/tasks', '/api/control-plane/approvals', '/api/control-plane/events'].includes(pathname) ||
       /^\/api\/control-plane\/tasks\/[^/]+\/(executions|reviews|complete)$/.test(pathname) ||
       /^\/api\/control-plane\/sessions\/[^/]+\/(lock|unlock)$/.test(pathname) ||
       /^\/api\/control-plane\/executions\/[^/]+\/(native\/(plan|prompt)|cezar\/(plan|dispatch|cancel-plan|cancel))$/.test(pathname))) return;
  throw new AuthorityError('AUTH_FORBIDDEN');
}

export function trustedApprovalDecision(input, principal) {
  if (principal?.authenticated !== true || principal.role !== 'operator' || typeof principal.id !== 'string' || !ID.test(principal.id)) throw new AuthorityError('AUTH_FORBIDDEN');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['decision', 'approvedBy'].includes(key))) throw new AuthorityError('UNEXPECTED_ARGUMENT', 400);
  if (input.approvedBy !== undefined && input.approvedBy !== principal.id) throw new AuthorityError('APPROVER_MISMATCH');
  return { ...input, approvedBy: principal.id };
}

export function nativeRemoteInput(input, { approval = false } = {}) {
  const keys = new Set(['taskId', 'source', 'nativeSessionId', 'cwd', 'prompt', ...(approval ? ['approvalId'] : [])]);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.has(key))) {
    throw new AuthorityError('UNEXPECTED_ARGUMENT', 400);
  }
  return input;
}
