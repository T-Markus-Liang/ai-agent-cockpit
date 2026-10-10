// Personal AI OS 0.3.0 S02 — candidate deployment package generator.
//
// This module turns the 0.3.0 restart preparation into a *verifiable candidate
// deployment package*: a migrated wechat-acp configuration, per-client
// authority documents for the goals and memory services, a public client
// mapping, and an isolated live preflight of the goals authentication matrix.
//
// SCOPE / HARD BOUNDARIES
//   * This module ONLY produces a candidate package under a caller-supplied
//     `candidateDir`. It NEVER writes any live/production path
//     (~/.local/state/personal-ai-os/, ~/.wechat-acp/, launchd plists, the
//     repo's own config/). Every filesystem path it touches is handed in
//     explicitly by the caller. Tests drive it exclusively with fs.mkdtempSync
//     trees.
//   * The clock (`now`) and the random source (`random`) are injectable so
//     callers/tests can run deterministically. Reports carry sha256 digests
//     and fixed records only — never a wall-clock timestamp.
//   * Public artifacts (mapping.json, reports, CLI output) NEVER contain a
//     plaintext token. Plaintext tokens are written exactly once, each to its
//     own mode-0600 file under `<candidateDir>/tokens/`. Only sha256 digests
//     appear in the mapping and in authority documents.
//   * It makes no network calls of its own. verifyGoalsAuthorityCandidate()
//     starts the real goals service in-process on 127.0.0.1 with an ephemeral
//     port (listen(0)) and probes it over loopback — that is an isolated
//     preflight, not an external call.
//
// ROTATION / REVOCATION RELATIONSHIP (how the artifacts are operated on)
//   Each per-service authority.json is produced by identity-pairing's
//   exportPrincipals() and consumed by a live authority that revalidates the
//   file on EVERY request (control-plane/request-authority.mjs
//   createLiveRequestAuthority; services/memory LiveAuthority). Therefore:
//     - revoke a client  = revoke(principalId) on that service's pairing
//                          authority, exportPrincipals(), writeAuthorityFile()
//                          over the same path — the old token dies without a
//                          service restart;
//     - rotate a client  = rotate(principalId), same export+write cycle;
//     - expiry           = expiresAt is enforced per request by the consumer.
//   Any writer MUST rotate the file atomically (tmp + rename), which
//   writeAuthorityFile already guarantees.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPairingAuthority, ROLES, PRINCIPAL_TTL_MS } from './identity-pairing.mjs';
import { writeAuthorityFile } from './request-authority.mjs';
import { createGoalServer } from '../gateway/goals.mjs';
import { ControlPlaneStore } from './store.mjs';

const TOKEN_BYTES = 32; // mirrors identity-pairing token minting (32 random bytes -> base64url)
const SAFE_NAME = /^[A-Za-z0-9:_-]{1,200}$/; // matches request-authority's principal-id grammar
const SERVICES = new Set(['goals', 'memory']);

// ---------------------------------------------------------------------------
// Error type: every failure carries a machine-readable `code`, never a secret.
// ---------------------------------------------------------------------------
export class DeployCandidateError extends Error {
  constructor(code, reason) {
    super(reason === undefined ? code : `${code}: ${reason}`);
    this.name = 'DeployCandidateError';
    this.code = code;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const sha256hex = value => crypto.createHash('sha256').update(value).digest('hex');

// Atomic synchronous write: mode-0600 tmp file in the target directory,
// fsync, rename over the target (atomic replace, so a candidate directory is
// re-runnable), then fsync the containing directory so the rename is durable.
function atomicWriteFileSync(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  const dirFd = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Deterministic serialization: object keys sorted recursively, array order
// preserved. Two runs over semantically identical input are byte-identical.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeysDeep(value[key])]));
  }
  return value;
}
const canonicalJson = value => JSON.stringify(sortKeysDeep(value), null, 2) + '\n';

// ---------------------------------------------------------------------------
// 1a. wechat-acp configuration migration
// ---------------------------------------------------------------------------
//
// Background: the legacy `session.promptTimeoutMs` key is dead in the new
// vendor code (vendor/wechat-acp/src/config.ts only honours
// `session.foregroundWaitMs`, default 120000 — notification timing only — and
// `session.grantDeadlineMs`, default 1800000 — the hard per-turn ceiling). An
// unmigrated config would silently fall to the 30-minute default while the old
// behaviour was 5 minutes, so the migration is explicit, never silent.
//
// Known keys (forward compatibility): unknown top-level or session keys are
// NOT rejected — they are preserved verbatim and listed in report.warnings.
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'controlPlaneUrl', 'controlPlaneAudit', 'inbound', 'recovery', 'goals', 'memory',
  'commandAliases', 'agent', 'agents', 'fallbackAgents', 'session',
]);
const KNOWN_SESSION_KEYS = new Set([
  'resume', 'idleTimeoutMs', 'maxConcurrentUsers', 'startupTimeoutMs', 'turnEndMessage',
  'foregroundWaitMs', 'grantDeadlineMs', 'promptTimeoutMs',
]);
// Known millisecond fields. When present, each must be a positive integer
// <= Number.MAX_SAFE_INTEGER, otherwise the whole migration is refused with
// `config-invalid-time` and nothing is written.
const SESSION_TIME_KEYS = ['promptTimeoutMs', 'foregroundWaitMs', 'grantDeadlineMs', 'startupTimeoutMs', 'idleTimeoutMs'];

function validateTimeField(value, where) {
  if (!Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new DeployCandidateError('config-invalid-time', `${where} must be a positive integer <= Number.MAX_SAFE_INTEGER`);
  }
}

export function migrateWechatAcpConfig({ sourcePath, targetPath, dryRun = false } = {}) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new DeployCandidateError('config-invalid', 'sourcePath must be an absolute path');
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) throw new DeployCandidateError('config-invalid', 'targetPath must be an absolute path');

  let sourceBytes;
  try { sourceBytes = fs.readFileSync(sourcePath); }
  catch { throw new DeployCandidateError('config-invalid', `source is not readable: ${path.basename(sourcePath)}`); }
  let config;
  try { config = JSON.parse(sourceBytes.toString('utf8')); }
  catch { throw new DeployCandidateError('config-invalid', 'source is not valid JSON'); }
  if (!isPlainObject(config)) throw new DeployCandidateError('config-invalid', 'top-level configuration must be a JSON object');

  // Validate known time fields BEFORE any migration decision; any violation
  // aborts the run with zero writes.
  const session = isPlainObject(config.session) ? config.session : undefined;
  if (session) {
    for (const key of SESSION_TIME_KEYS) {
      if (Object.hasOwn(session, key)) validateTimeField(session[key], `session.${key}`);
    }
  }
  if (isPlainObject(config.recovery)) {
    for (const key of Object.keys(config.recovery)) {
      if (key.endsWith('Ms')) validateTimeField(config.recovery[key], `recovery.${key}`);
    }
  }

  // Forward compatibility: unknown keys are preserved and reported, never
  // rejected.
  const warnings = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown top-level key "${key}" preserved (forward compatibility)`);
  }
  if (session) {
    for (const key of Object.keys(session)) {
      if (!KNOWN_SESSION_KEYS.has(key)) warnings.push(`unknown session key "${key}" preserved (forward compatibility)`);
    }
  }

  // Migration of session.promptTimeoutMs -> session.grantDeadlineMs.
  const deprecations = [];
  let migrated = false;
  if (session) {
    const hasLegacy = Object.hasOwn(session, 'promptTimeoutMs');
    const hasModern = Object.hasOwn(session, 'grantDeadlineMs');
    if (hasLegacy && !hasModern) {
      // Carry the old value over as the hard per-turn ceiling; the legacy key
      // has no foreground-wait semantics, so foregroundWaitMs stays at the new
      // default (120000) and is intentionally not set here.
      session.grantDeadlineMs = session.promptTimeoutMs;
      delete session.promptTimeoutMs;
      deprecations.push(`session.promptTimeoutMs migrated to session.grantDeadlineMs=${session.grantDeadlineMs}`);
      migrated = true;
    } else if (hasLegacy && hasModern && session.promptTimeoutMs === session.grantDeadlineMs) {
      delete session.promptTimeoutMs;
      deprecations.push(`session.promptTimeoutMs removed (identical to session.grantDeadlineMs=${session.grantDeadlineMs})`);
      migrated = true;
    } else if (hasLegacy && hasModern) {
      // Conflicting explicit values: refuse. Never silently adopt any default.
      throw new DeployCandidateError('config-conflict',
        `session.promptTimeoutMs (${session.promptTimeoutMs}) conflicts with session.grantDeadlineMs (${session.grantDeadlineMs}); pick one value`);
    }
  }

  const candidate = canonicalJson(config);
  const report = {
    sourceSha256: sha256hex(sourceBytes),
    candidateSha256: sha256hex(candidate),
    deprecations,
    warnings,
    migrated,
  };
  const bytes = Buffer.byteLength(candidate);
  if (dryRun) return { bytes, report };

  atomicWriteFileSync(targetPath, candidate, 0o600);
  const rollbackPath = `${targetPath}.rollback`;
  atomicWriteFileSync(rollbackPath, sourceBytes, 0o600);
  return { bytes, report, rollbackPath };
}

// ---------------------------------------------------------------------------
// 1b. per-client authority candidates
// ---------------------------------------------------------------------------
//
// The default client set is the real action surface of the 0.3.0 restart:
//   wechat-bridge-goals  goals   operator  (bridge calls list/get/grant/pause/
//                                          resume/cancel/pause-all/resume-all;
//                                          grant and pause-all are operator-only)
//   wechat-bridge-memory memory  chief     (bridge ingests turns + reads)
//   ui-proxy-goals       goals   viewer    (Execution panel: read-only status)
//   ui-proxy-memory      memory  viewer    (read-only status)
// Callers may override the list; the CLI uses the default.
export const DEFAULT_CLIENTS = Object.freeze([
  Object.freeze({ name: 'wechat-bridge-goals', service: 'goals', role: 'operator' }),
  Object.freeze({ name: 'wechat-bridge-memory', service: 'memory', role: 'chief' }),
  Object.freeze({ name: 'ui-proxy-goals', service: 'goals', role: 'viewer' }),
  Object.freeze({ name: 'ui-proxy-memory', service: 'memory', role: 'viewer' }),
]);

export async function generateAuthorityCandidates({ candidateDir, clients = DEFAULT_CLIENTS, now = Date.now, random = crypto.randomBytes, expiresInMs } = {}) {
  if (typeof candidateDir !== 'string' || !path.isAbsolute(candidateDir)) throw new DeployCandidateError('invalid-client', 'candidateDir must be an absolute path');
  if (!Array.isArray(clients) || clients.length === 0) throw new DeployCandidateError('invalid-client', 'clients must be a non-empty array');
  const ttl = expiresInMs ?? PRINCIPAL_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > Number.MAX_SAFE_INTEGER) throw new DeployCandidateError('invalid-client', 'expiresInMs must be a positive integer');
  if (typeof now !== 'function' || typeof random !== 'function') throw new DeployCandidateError('invalid-client', 'now and random must be functions');

  // Validate EVERYTHING before the first write: a bad client definition is an
  // `invalid-client` refusal with zero writes.
  const seen = new Set();
  for (const client of clients) {
    if (!isPlainObject(client) || typeof client.name !== 'string' || !SAFE_NAME.test(client.name) || seen.has(client.name) ||
        !SERVICES.has(client.service) || !ROLES.has(client.role)) {
      throw new DeployCandidateError('invalid-client', `invalid client definition: ${isPlainObject(client) && typeof client.name === 'string' ? client.name : '<unnamed>'}`);
    }
    seen.add(client.name);
  }

  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new DeployCandidateError('invalid-client', 'now() must return a finite epoch ms');
  const expiresAt = nowMs + ttl;

  // Group clients per service; each service gets its own pairing authority so
  // revocation/rotation of one service's clients never touches the other's.
  const byService = new Map();
  for (const client of clients) {
    if (!byService.has(client.service)) byService.set(client.service, []);
    byService.get(client.service).push(client);
  }

  const tokens = new Map(); // client name -> plaintext token (written once, never mapped)
  const authorityFiles = [];
  for (const [service, serviceClients] of byService) {
    const authority = createPairingAuthority({ now: () => nowMs, random });
    // Mint one principal per client with the client name as the principal id
    // and the batch TTL. completePairing() cannot express a caller-chosen id
    // or TTL, so the principals are injected through the validated
    // fromJSON()/exportPrincipals() round-trip — the export is still the exact
    // document contract request-authority consumes.
    const principals = serviceClients.map(client => {
      const token = random(TOKEN_BYTES).toString('base64url');
      tokens.set(client.name, token);
      return {
        id: client.name,
        role: client.role,
        clientLabel: client.name,
        tokenDigest: sha256hex(token),
        createdAt: nowMs,
        expiresAt,
        revoked: false,
      };
    });
    authority.fromJSON({ version: 1, consumedCodes: [], principals });
    const snapshot = authority.exportPrincipals();
    const authorityFile = path.join(candidateDir, service, 'authority.json');
    fs.mkdirSync(path.dirname(authorityFile), { recursive: true, mode: 0o700 });
    await writeAuthorityFile(authorityFile, snapshot); // validates, then atomic tmp+rename (mode 0600)
    authorityFiles.push(authorityFile);
  }

  // Plaintext tokens: one mode-0600 file per client, content is the token
  // string plus a trailing newline. This is the ONLY place plaintext lives.
  const tokenFiles = [];
  fs.mkdirSync(path.join(candidateDir, 'tokens'), { recursive: true, mode: 0o700 });
  for (const client of clients) {
    const tokenFile = path.join(candidateDir, 'tokens', `${client.name}.token`);
    atomicWriteFileSync(tokenFile, `${tokens.get(client.name)}\n`, 0o600);
    tokenFiles.push(tokenFile);
  }

  // Public mapping: names, roles, digests and expiry — never a plaintext token.
  const mapping = clients.map(client => ({
    name: client.name,
    service: client.service,
    principalId: client.name,
    role: client.role,
    expiresAt,
    tokenDigest: sha256hex(tokens.get(client.name)),
  }));
  atomicWriteFileSync(path.join(candidateDir, 'mapping.json'), canonicalJson({ version: 1, clients: mapping }), 0o600);

  return { mapping, tokenFiles, authorityFiles };
}

// ---------------------------------------------------------------------------
// 1c. service authority path resolution (pure)
// ---------------------------------------------------------------------------
//
// Where will each service actually look for its authority document?
//   goals : process.env.GOALS_AUTH_FILE ?? <stateDir>/authority.json, with the
//           launchd default stateDir ~/.local/state/personal-ai-os/goals
//           (gateway/goals.mjs:63-68).
//   memory: process.env.MEMORY_AUTH_FILE ?? <stateDir>/authority.json, with the
//           default stateDir ~/.local/state/personal-ai-os/mem0
//           (services/memory/service.py:921-923). NOTE: MEMORY_AUTH_FILE exists
//           in the running code — an earlier brief claimed memory had no
//           override; the code is the source of truth.
// Neither current launchd plist (launchd/com.markus.personal-ai-os.goals.plist,
// ...memory.plist) sets an authority override, but the resolver must honour
// one if present. Precedence: explicit env > plist EnvironmentVariables >
// built-in default. plistTexts is injected as raw text ({ goalsPlist?,
// memoryPlist? }) so the resolver stays a pure function and tests need no
// fixture files; extraction is a simple <key>NAME</key><string>…</string>
// match (plist XML), sufficient for EnvironmentVariables entries.
function extractPlistEnv(plistText, key) {
  if (typeof plistText !== 'string') return undefined;
  const match = plistText.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match ? match[1] : undefined;
}

export function resolveServiceAuthorityPaths({ env = {}, homeDir, plistTexts } = {}) {
  if (typeof homeDir !== 'string' || homeDir.length === 0) throw new DeployCandidateError('invalid-input', 'homeDir is required');
  const resolve = (envKey, defaultPath, plistText) => {
    if (typeof env[envKey] === 'string' && env[envKey].length > 0) return { path: env[envKey], source: 'env' };
    const fromPlist = extractPlistEnv(plistText, envKey);
    if (fromPlist !== undefined && fromPlist.length > 0) return { path: fromPlist, source: 'plist' };
    return { path: defaultPath, source: 'default' };
  };
  return {
    goals: resolve('GOALS_AUTH_FILE', path.join(homeDir, '.local/state/personal-ai-os/goals/authority.json'), plistTexts?.goalsPlist),
    memory: resolve('MEMORY_AUTH_FILE', path.join(homeDir, '.local/state/personal-ai-os/mem0/authority.json'), plistTexts?.memoryPlist),
  };
}

// ---------------------------------------------------------------------------
// 1d. isolated goals preflight: real service, real HTTP, synthetic state
// ---------------------------------------------------------------------------
//
// Starts the REAL goals service in-process (createGoalServer) on 127.0.0.1
// with an ephemeral port, pointed at the CANDIDATE goals authority via
// GOALS_AUTH_FILE (saved and restored around the run) and a caller-supplied
// synthetic stateDir — no production state is read or written. The business
// authentication matrix is then exercised over loopback HTTP:
//   1. no Authorization            -> 401
//   2. forged token                -> 401
//   3. viewer GET 200; viewer POST -> 403 with zero state mutation
//   4. operator POST 201, then readable via GET
//   5. expired principal           -> 401 (tampered authority, then restored)
//   6. revoke+rotate               -> old token 401, replacement token 200,
//                                     WITHOUT a service restart
//   7. missing authority file      -> 500 fail-closed (a second server
//                                     instance pointed at a nonexistent file)
// Every check is recorded as { check, expected, actual, pass }; the function
// never throws for a failed check — it returns { pass, results } so a report
// is always complete. The candidate authority file is restored byte-for-byte
// after the tamper checks (restoration is itself a recorded check).
export async function verifyGoalsAuthorityCandidate({ candidateDir, stateDir, mapping } = {}) {
  if (typeof candidateDir !== 'string' || !path.isAbsolute(candidateDir)) throw new DeployCandidateError('invalid-input', 'candidateDir must be an absolute path');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new DeployCandidateError('invalid-input', 'stateDir must be an absolute path');
  const resolvedMapping = mapping ?? JSON.parse(fs.readFileSync(path.join(candidateDir, 'mapping.json'), 'utf8'));
  const mappingClients = Array.isArray(resolvedMapping) ? resolvedMapping : (resolvedMapping.clients ?? []);
  const goalsClients = mappingClients.filter(client => client.service === 'goals');
  const viewer = goalsClients.find(client => client.role === 'viewer');
  const operator = goalsClients.find(client => client.role === 'operator');
  if (!viewer || !operator) throw new DeployCandidateError('invalid-input', 'mapping must contain goals viewer and operator clients');
  const readToken = name => fs.readFileSync(path.join(candidateDir, 'tokens', `${name}.token`), 'utf8').trim();
  const viewerToken = readToken(viewer.name);
  const operatorToken = readToken(operator.name);

  const goalsAuthorityFile = path.join(candidateDir, 'goals', 'authority.json');
  const originalAuthorityBytes = fs.readFileSync(goalsAuthorityFile, 'utf8');

  // A tiny synthetic goal fixture so the operator create path (including
  // workspace preparation) runs entirely inside stateDir.
  const fixtureDir = path.join(stateDir, 'goal-fixture');
  fs.mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fixtureDir, 'calculator.mjs'), 'export const add = (a, b) => a + b\n', { mode: 0o600 });
  fs.writeFileSync(path.join(fixtureDir, 'calculator.test.mjs'),
    "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './calculator.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\n", { mode: 0o600 });
  const goalBody = {
    title: 'Deploy candidate preflight', objective: 'verify the operator create path end to end',
    sourceDir: fixtureDir,
    readPaths: ['calculator.mjs', 'calculator.test.mjs'], writePaths: ['calculator.mjs'],
    checks: [{ name: 'add', args: ['--test', 'calculator.test.mjs'] }],
  };

  const results = [];
  const record = (check, expected, actual) => { results.push({ check, expected, actual, pass: expected === actual }); };
  const stubEngine = () => ({ active: new Map(), start: async () => {}, stop: async () => {}, tick: async () => {}, abort: () => {} });
  const listen = app => new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const close = async app => { if (!app) return; app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  const request = async (root, endpoint, { token, method = 'GET', body, headers: extraHeaders } = {}) => {
    const headers = { ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(root + endpoint, {
      method, headers, signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { /* status is what matters */ }
    return { status: response.status, body: parsed };
  };

  const hadEnv = Object.hasOwn(process.env, 'GOALS_AUTH_FILE');
  const previousEnv = process.env.GOALS_AUTH_FILE;
  let appA;
  let appB;
  try {
    process.env.GOALS_AUTH_FILE = goalsAuthorityFile;
    appA = await createGoalServer({
      stateDir: path.join(stateDir, 'goals-a'),
      tasks: new ControlPlaneStore({ stateDir: path.join(stateDir, 'tasks-a') }),
      runtime: stubEngine(),
      wechatStateFile: path.join(stateDir, 'wechat.json'),
    });
    await listen(appA);
    const rootA = `http://127.0.0.1:${appA.server.address().port}`;

    // 1. unauthenticated
    record('unauthenticated-request-denied', 401, (await request(rootA, '/api/goals')).status);
    // 2. forged token
    record('forged-token-denied', 401, (await request(rootA, '/api/goals', { token: crypto.randomBytes(32).toString('base64url') })).status);
    // 3. viewer: read allowed, write denied with zero mutation
    record('viewer-read-allowed', 200, (await request(rootA, '/api/goals', { token: viewerToken })).status);
    record('viewer-write-denied', 403, (await request(rootA, '/api/goals', { token: viewerToken, method: 'POST', body: goalBody })).status);
    const afterDenied = await request(rootA, '/api/goals', { token: viewerToken });
    record('viewer-write-zero-mutation', 0, afterDenied.body?.goals?.length ?? -1);
    // 4. operator: create allowed and visible (create requires an idempotency key)
    const created = await request(rootA, '/api/goals', {
      token: operatorToken, method: 'POST', body: goalBody,
      headers: { 'idempotency-key': `deploy-candidate-preflight-${crypto.randomBytes(8).toString('hex')}` },
    });
    record('operator-create-allowed', 201, created.status);
    const listed = await request(rootA, '/api/goals', { token: operatorToken });
    record('operator-create-visible', true, Boolean(listed.body?.goals?.some(goal => goal.id === created.body?.goal?.id)));
    // 5. expired principal (tampered authority, restored afterwards)
    const expiredToken = crypto.randomBytes(32).toString('base64url');
    const tamperedExpired = JSON.parse(originalAuthorityBytes);
    tamperedExpired.principals.push({ id: 'p_expired_probe', role: 'viewer', tokenDigest: sha256hex(expiredToken), expiresAt: Date.now() - 1000 });
    await writeAuthorityFile(goalsAuthorityFile, tamperedExpired);
    record('expired-principal-denied', 401, (await request(rootA, '/api/goals', { token: expiredToken })).status);
    await writeAuthorityFile(goalsAuthorityFile, JSON.parse(originalAuthorityBytes));
    // 6. revoke + rotate without a restart: old token dies, replacement lives
    const rotatedToken = crypto.randomBytes(32).toString('base64url');
    const tamperedRotated = JSON.parse(originalAuthorityBytes);
    for (const principal of tamperedRotated.principals) {
      if (principal.id === operator.name) principal.revoked = true;
    }
    tamperedRotated.principals.push({ id: `${operator.name}-rotated`, role: 'operator', tokenDigest: sha256hex(rotatedToken), expiresAt: Date.now() + 3600000 });
    await writeAuthorityFile(goalsAuthorityFile, tamperedRotated);
    record('rotation-old-token-denied', 401, (await request(rootA, '/api/goals', { token: operatorToken })).status);
    record('rotation-new-token-allowed', 200, (await request(rootA, '/api/goals', { token: rotatedToken })).status);
    await writeAuthorityFile(goalsAuthorityFile, JSON.parse(originalAuthorityBytes));
    record('authority-file-restored', true, fs.readFileSync(goalsAuthorityFile, 'utf8') === originalAuthorityBytes);
    // 7. missing authority file fails closed (second server instance)
    process.env.GOALS_AUTH_FILE = path.join(stateDir, 'missing-authority.json');
    appB = await createGoalServer({
      stateDir: path.join(stateDir, 'goals-b'),
      tasks: new ControlPlaneStore({ stateDir: path.join(stateDir, 'tasks-b') }),
      runtime: stubEngine(),
      wechatStateFile: path.join(stateDir, 'wechat.json'),
    });
    await listen(appB);
    const rootB = `http://127.0.0.1:${appB.server.address().port}`;
    record('missing-authority-fails-closed', 500, (await request(rootB, '/api/goals', { token: operatorToken })).status);
  } finally {
    if (hadEnv) process.env.GOALS_AUTH_FILE = previousEnv;
    else delete process.env.GOALS_AUTH_FILE;
    await close(appB);
    await close(appA);
  }
  return { pass: results.every(result => result.pass), results };
}
