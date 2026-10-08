// Strict request authority for the new runtime path. An unconfigured 0.2.2
// gateway remains explicitly legacy-loopback, not authenticated or safe for
// new tool execution. No token is minted, logged or returned by this module.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const ROLES = new Set(['operator', 'coordinator', 'chief', 'viewer']);
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9:_-]{1,200}$/;

export class AuthorityError extends Error {
  constructor(code, status = 403) {
    super(code === 'AUTH_REQUIRED' ? 'request authentication required' : 'request authority rejected');
    this.name = 'AuthorityError'; this.code = code; this.status = status;
  }
}

export function createRequestAuthority(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.principals) || input.principals.length < 1 || input.principals.length > 16) {
    throw new AuthorityError('AUTH_CONFIGURATION', 500);
  }
  const ids = new Set(), digests = new Set();
  const principals = input.principals.map(value => {
    if (!value || Object.keys(value).some(key => !['id', 'role', 'tokenDigest'].includes(key)) ||
        typeof value.id !== 'string' || typeof value.role !== 'string' || typeof value.tokenDigest !== 'string' ||
        !ID.test(value.id) || !ROLES.has(value.role) || !HEX.test(value.tokenDigest) || ids.has(value.id) || digests.has(value.tokenDigest)) {
      throw new AuthorityError('AUTH_CONFIGURATION', 500);
    }
    ids.add(value.id); digests.add(value.tokenDigest);
    return { public: Object.freeze({ id: value.id, role: value.role, authenticated: true }), digest: Buffer.from(value.tokenDigest, 'hex') };
  });
  return Object.freeze({ mode: 'strict', authenticate(headers) {
    const header = headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new AuthorityError('AUTH_REQUIRED', 401);
    const digest = crypto.createHash('sha256').update(header.slice(7)).digest();
    let found;
    for (const principal of principals) if (crypto.timingSafeEqual(digest, principal.digest)) found = principal.public;
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
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new AuthorityError('AUTH_CONFIGURATION', 500);
    return createRequestAuthority(JSON.parse(await handle.readFile('utf8')));
  } catch {
    throw new AuthorityError('AUTH_CONFIGURATION', 500);
  } finally { await handle?.close(); }
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
