import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequestAuthority, createLiveRequestAuthority, loadRequestAuthority, authorizeHttpRequest, trustedApprovalDecision, nativeRemoteInput } from '../control-plane/request-authority.mjs';

// Synthetic, short-lived test credentials only; never read production tokens.
const TOKENS = Object.fromEntries(['operator', 'chief', 'viewer', 'coordinator'].map(role => [role, `SYNTHETIC_${role.toUpperCase()}_${'x'.repeat(40)}`]));
const config = () => ({ version: 1, principals: Object.entries(TOKENS).map(([role, token]) => ({ id: `${role}-test`, role, tokenDigest: crypto.createHash('sha256').update(token).digest('hex') })) });

test('bearer tokens determine identity; headers and claims cannot select a role', () => {
  const auth = createRequestAuthority(config());
  const principal = auth.authenticate({ authorization: `Bearer ${TOKENS.chief}`, 'x-role': 'operator', 'x-actor': 'operator-test' });
  assert.deepEqual(principal, { id: 'chief-test', role: 'chief', authenticated: true });
  assert.ok(Object.isFrozen(principal));
  for (const authorization of [undefined, '', 'Bearer short', `Bearer ${'z'.repeat(50)}`, `Basic ${TOKENS.operator}`]) {
    assert.throws(() => auth.authenticate({ authorization }), error => error.code === 'AUTH_REQUIRED' && !error.message.includes(TOKENS.operator));
  }
});

test('configuration rejects duplicate credentials, unknown roles and invalid identities', () => {
  const original = config();
  for (const input of [{ version: 2, principals: original.principals }, { version: 1, principals: [] },
    { version: 1, principals: [...original.principals, { ...original.principals[0], id: 'duplicate' }] },
    { version: 1, principals: [{ ...original.principals[0], role: 'invented' }] },
    { version: 1, principals: [{ ...original.principals[0], id: null }] },
    { version: 1, principals: [{ ...original.principals[0], tokenDigest: 'bad' }] }]) assert.throws(() => createRequestAuthority(input), error => error.code === 'AUTH_CONFIGURATION');
});

test('roles separate proposal, proof and operator approval; forged subjects fail closed', () => {
  const auth = createRequestAuthority(config());
  const subjects = Object.fromEntries(Object.entries(TOKENS).map(([role, token]) => [role, auth.authenticate({ authorization: `Bearer ${token}` })]));
  authorizeHttpRequest(subjects.chief, 'POST', '/api/control-plane/tasks');
  authorizeHttpRequest(subjects.coordinator, 'POST', '/api/control-plane/executions/execution/status');
  authorizeHttpRequest(subjects.operator, 'POST', '/api/control-plane/approvals/approval/decision');
  for (const role of ['chief', 'viewer', 'coordinator']) assert.throws(() => authorizeHttpRequest(subjects[role], 'POST', '/api/control-plane/approvals/approval/decision'), error => error.code === 'AUTH_FORBIDDEN');
  assert.throws(() => authorizeHttpRequest(subjects.viewer, 'POST', '/api/control-plane/tasks'), error => error.code === 'AUTH_FORBIDDEN');
  assert.throws(() => authorizeHttpRequest(subjects.viewer, 'GET', '/api/control-plane/native-sessions'), error => error.code === 'AUTH_FORBIDDEN');
  assert.throws(() => authorizeHttpRequest({ authenticated: true, role: 'operator' }, 'POST', '/api/control-plane/tasks'), error => error.code === 'AUTH_REQUIRED');
  assert.deepEqual(trustedApprovalDecision({ decision: 'approved' }, subjects.operator), { decision: 'approved', approvedBy: 'operator-test' });
  assert.throws(() => trustedApprovalDecision({ decision: 'approved', approvedBy: 'model' }, subjects.operator), error => error.code === 'APPROVER_MISMATCH');
});

test('private auth files are required when selected; malformed/symlink/public files never downgrade', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-authority-files-'));
  try {
    const file = path.join(dir, 'authority.json'); await fs.writeFile(file, JSON.stringify(config()), { mode: 0o600 });
    assert.equal((await loadRequestAuthority({ file })).mode, 'strict');
    assert.equal((await loadRequestAuthority()).mode, 'legacy-loopback');
    await assert.rejects(() => loadRequestAuthority({ required: true }), error => error.code === 'AUTH_CONFIGURATION');
    await fs.chmod(file, 0o644); await assert.rejects(() => loadRequestAuthority({ file }), error => error.code === 'AUTH_CONFIGURATION');
    await fs.chmod(file, 0o600);
    const link = path.join(dir, 'link.json'); await fs.symlink(file, link);
    await assert.rejects(() => loadRequestAuthority({ file: link }), error => error.code === 'AUTH_CONFIGURATION');
    await fs.writeFile(file, 'malformed'); await assert.rejects(() => loadRequestAuthority({ file }), error => error.code === 'AUTH_CONFIGURATION');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('native remote arguments cannot carry a command, env or hidden host dependencies', () => {
  for (const key of ['command', 'args', 'env', 'store', 'principal']) assert.throws(() => nativeRemoteInput({ taskId: 'task', [key]: 'SYNTHETIC_PRIVATE_VALUE' }), error => error.code === 'UNEXPECTED_ARGUMENT' && !error.message.includes('SYNTHETIC_PRIVATE_VALUE'));
});

async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('actual strict HTTP server authenticates, rejects self-approval/injection and accepts operator approval', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-authority-http-'));
  let child, output = '';
  const file = path.join(dir, 'authority.json'); await fs.writeFile(file, JSON.stringify(config()), { mode: 0o600 });
  const port = await freePort();
  const request = async (url, { role, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(role ? { Authorization: `Bearer ${TOKENS[role]}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': `synthetic-${crypto.randomUUID()}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    child = spawn(process.execPath, ['gateway/control-plane.mjs'], { cwd: process.cwd(), env: { ...process.env, CONTROL_PLANE_PORT: String(port), PERSONAL_AI_OS_STATE_DIR: path.join(dir, 'state'), CONTROL_PLANE_AUTH_FILE: file, CONTROL_PLANE_REQUIRE_AUTH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { health = await request('/health'); if (health.status === 200) break; } catch {}
      if (child.exitCode !== null) throw Error('isolated strict server exited');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(health?.body.authorizationMode, 'strict'); assert.equal(health.body.persistence, undefined);
    assert.equal((await request('/api/control-plane/tasks')).status, 401);
    assert.equal((await request('/api/control-plane/tasks', { role: 'viewer', body: { goal: 'forged' } })).status, 403);
    const task = await request('/api/control-plane/tasks', { role: 'chief', body: { goal: 'synthetic authorized task' } });
    assert.equal(task.status, 201);
    const plan = { action: 'synthetic.action', target: task.body.task.id, parametersDigest: 'sha256:synthetic' };
    assert.equal((await request('/api/control-plane/approvals', { role: 'chief', body: { ...plan, decision: 'approved', approvedBy: 'operator-test' } })).status, 400);
    const created = await request('/api/control-plane/approvals', { role: 'chief', body: plan }); assert.equal(created.status, 201);
    const approvalId = created.body.approval.id;
    assert.equal((await request(`/api/control-plane/approvals/${approvalId}/decision`, { role: 'chief', body: { decision: 'approved', approvedBy: 'operator-test' } })).status, 403);
    assert.equal((await request(`/api/control-plane/approvals/${approvalId}/decision`, { role: 'operator', body: { decision: 'approved', approvedBy: 'model' } })).status, 403);
    const decided = await request(`/api/control-plane/approvals/${approvalId}/decision`, { role: 'operator', body: { decision: 'approved' } });
    assert.equal(decided.status, 200); assert.equal(decided.body.approval.approvedBy, 'operator-test');
    const viewerCreate = await request('/mcp', { role: 'viewer', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { goal: 'viewer-forged', idempotencyKey: 'viewer-forged' } } } });
    assert.equal(viewerCreate.body.result.isError, true);
    const fakeOp = await request('/mcp', { role: 'chief', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'decide_approval', arguments: { approvalId, decision: 'approved', approvedBy: 'operator-test', idempotencyKey: 'model-forged' } }, principal: { authenticated: true, role: 'operator', id: 'operator-test' } } });
    assert.equal(fakeOp.body.result.isError, true);
    const exec = await request(`/api/control-plane/tasks/${task.body.task.id}/executions`, { role: 'chief', body: { workerId: 'synthetic', status: 'succeeded' } });
    assert.equal(exec.status, 400);
    const injected = await request('/api/control-plane/executions/synthetic/native/prompt', { role: 'chief', body: { command: 'SYNTHETIC_PRIVATE_VALUE', args: ['never-run'] } });
    assert.equal(injected.status, 400); assert.equal(JSON.stringify(injected.body).includes('SYNTHETIC_PRIVATE_VALUE'), false);
    const tasks = await request('/api/control-plane/tasks', { role: 'viewer' }); assert.equal(tasks.body.tasks.length, 1);
    for (const token of Object.values(TOKENS)) assert.equal(output.includes(token), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- M02 ID-E001: live request authority (proven synchronous reload) ---------
// Synthetic tmp fixtures only; rotation is written atomically (tmp + rename),
// mirroring the contract a real writer must follow. No production file is read.

const digestOf = value => crypto.createHash('sha256').update(value).digest('hex');

async function writeAtomic(file, document, mode = 0o600) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(document));
  await fs.chmod(tmp, mode); // chmod is umask-independent, unlike writeFile mode
  await fs.rename(tmp, file);
}

const withPrincipal = (id, patch) => ({ version: 1, principals: config().principals.map(principal => principal.id === id ? { ...principal, ...patch } : principal) });

test('live authority: atomic rotation is visible immediately without a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-rotate-'));
  try {
    const file = path.join(dir, 'authority.json');
    await writeAtomic(file, config());
    const live = createLiveRequestAuthority({ file });
    assert.equal(live.mode, 'strict');
    assert.deepEqual(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), { id: 'chief-test', role: 'chief', authenticated: true });
    assert.equal(live.generation, 1);

    const rotated = `SYNTHETIC_ROTATED_${'y'.repeat(41)}`;
    await writeAtomic(file, withPrincipal('chief-test', { tokenDigest: digestOf(rotated) }));
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), error => error.code === 'AUTH_REQUIRED' && error.status === 401);
    assert.deepEqual(live.authenticate({ authorization: `Bearer ${rotated}` }), { id: 'chief-test', role: 'chief', authenticated: true });
    assert.equal(live.generation, 2);
    // the untouched principals keep working across the same reload
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.operator}` }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('live authority: revoked entries stop authenticating and are kept as evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-revoke-'));
  try {
    const file = path.join(dir, 'authority.json');
    await writeAtomic(file, config());
    const live = createLiveRequestAuthority({ file });
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.viewer}` }));
    await writeAtomic(file, withPrincipal('viewer-test', { revoked: true }));
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.viewer}` }), error => error.code === 'AUTH_REQUIRED' && error.status === 401);
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.operator}` }), 'other principals are unaffected by the revocation');
    // `revoked`, when present, must be exactly true; anything else is a config error
    for (const revoked of [false, 'true', 1, null]) {
      assert.throws(() => createRequestAuthority({ version: 1, principals: [{ ...config().principals[0], revoked }] }), error => error.code === 'AUTH_CONFIGURATION');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('live authority: expiry honours the injected clock and rejects at the instant reached', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-expiry-'));
  try {
    const file = path.join(dir, 'authority.json');
    let now = 1_000_000;
    const clock = () => now;
    const expiresAt = now + 1_000;
    await writeAtomic(file, withPrincipal('chief-test', { expiresAt }));
    const live = createLiveRequestAuthority({ file, clock });
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }));
    now = expiresAt - 1;
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }));
    now = expiresAt; // clock() >= expiresAt is no longer a match
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), error => error.code === 'AUTH_REQUIRED' && error.status === 401);
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.operator}` }), 'principal without expiresAt is unaffected');
    const plain = createRequestAuthority(withPrincipal('chief-test', { expiresAt }), { clock });
    assert.throws(() => plain.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), error => error.code === 'AUTH_REQUIRED');
    // invalid expiresAt values are configuration errors, never silently ignored
    for (const bad of [NaN, -1, '1000', Infinity, null]) {
      assert.throws(() => createRequestAuthority({ version: 1, principals: [{ ...config().principals[0], expiresAt: bad }] }), error => error.code === 'AUTH_CONFIGURATION');
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('live authority: an unchanged file is served from the parsed cache (no re-parse)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-cache-'));
  try {
    const file = path.join(dir, 'authority.json');
    const FIXED_SECONDS = 1_700_000_000; // integer seconds -> deterministic mtimeMs
    await writeAtomic(file, config());
    await fs.utimes(file, FIXED_SECONDS, FIXED_SECONDS);
    const live = createLiveRequestAuthority({ file });
    const principal = { id: 'chief-test', role: 'chief', authenticated: true };
    assert.deepEqual(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), principal);
    assert.equal(live.generation, 1);

    // Corrupt the payload while restoring the change key (same inode via in-place
    // write, same size, same mtime). A re-parse would now throw AUTH_CONFIGURATION;
    // serving the cached principal proves the unchanged file was not re-read.
    const { size } = await fs.stat(file);
    await fs.writeFile(file, 'x'.repeat(size));
    await fs.utimes(file, FIXED_SECONDS, FIXED_SECONDS);
    assert.deepEqual(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), principal);
    assert.equal(live.generation, 1); // no successful reload occurred
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('live authority: every reload failure fails closed and never falls back to the previous cache', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-failclosed-'));
  try {
    const file = path.join(dir, 'authority.json');
    await writeAtomic(file, config());
    const live = createLiveRequestAuthority({ file });
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }));
    const isConfigError = error => error.code === 'AUTH_CONFIGURATION' && error.status === 500;

    // (a) file removed
    await fs.rm(file);
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), isConfigError);

    // (b) reloads with world/group-readable permissions
    await writeAtomic(file, config(), 0o644);
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), isConfigError);

    // (c) malformed JSON
    await writeAtomic(file, config());
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), 'valid file recovers the live authority');
    await fs.writeFile(file, 'not json');
    await fs.chmod(file, 0o600);
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), isConfigError);

    // (d) schema-invalid (unknown key) after a healthy load
    await writeAtomic(file, config());
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }));
    await writeAtomic(file, { version: 1, principals: [{ ...config().principals[0], surprise: true }] });
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), isConfigError);
    // still no fallback on the next request either
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), isConfigError);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('live authority: a partial (non-atomic) write is rejected, never half-parsed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-partial-'));
  try {
    const file = path.join(dir, 'authority.json');
    await writeAtomic(file, config());
    const live = createLiveRequestAuthority({ file });
    assert.ok(live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }));
    const text = JSON.stringify(config());
    await fs.writeFile(file, text.slice(0, Math.floor(text.length / 2))); // observed mid-write window
    assert.throws(() => live.authenticate({ authorization: `Bearer ${TOKENS.chief}` }), error => error.code === 'AUTH_CONFIGURATION' && error.status === 500);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('live authority: an unconfigured deployment stays legacy-loopback; required-without-file fails closed', () => {
  const legacy = createLiveRequestAuthority();
  assert.equal(legacy.mode, 'legacy-loopback');
  assert.equal(legacy.authenticate({ authorization: 'Bearer whatever' }), undefined);
  assert.equal(legacy.generation, 0);
  assert.ok(Object.isFrozen(legacy));
  assert.throws(() => createLiveRequestAuthority({ required: true }), error => error.code === 'AUTH_CONFIGURATION' && error.status === 500);
  assert.throws(() => createLiveRequestAuthority({ file: 'relative.json' }), error => error.code === 'AUTH_CONFIGURATION');
});

test('live authority over the real HTTP gateway: an on-disk rotation/revocation takes effect without restarting the process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-live-http-'));
  let child;
  const file = path.join(dir, 'authority.json');
  await writeAtomic(file, config());
  const port = await freePort();
  const request = async (url, { token, method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': `synthetic-${crypto.randomUUID()}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    child = spawn(process.execPath, ['gateway/control-plane.mjs'], { cwd: process.cwd(), env: { ...process.env, CONTROL_PLANE_PORT: String(port), PERSONAL_AI_OS_STATE_DIR: path.join(dir, 'state'), CONTROL_PLANE_AUTH_FILE: file, CONTROL_PLANE_REQUIRE_AUTH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { health = await request('/health'); if (health.status === 200) break; } catch {}
      if (child.exitCode !== null) throw Error('isolated strict server exited');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(health?.body.authorizationMode, 'strict');

    // Rotate the on-disk authority; the same long-running child must observe it.
    const rotated = `SYNTHETIC_HTTP_ROTATED_${'z'.repeat(38)}`;
    await writeAtomic(file, withPrincipal('chief-test', { tokenDigest: digestOf(rotated) }));
    assert.equal((await request('/api/control-plane/tasks', { token: TOKENS.chief })).status, 401, 'old token rejected live');
    const created = await request('/api/control-plane/tasks', { method: 'POST', token: rotated, body: { goal: 'synthetic rotated task' } });
    assert.equal(created.status, 201, 'new token valid without a restart');
    assert.equal(child.exitCode, null, 'the gateway process was never restarted');

    // Revocation is equally live.
    await writeAtomic(file, withPrincipal('chief-test', { revoked: true }));
    assert.equal((await request('/api/control-plane/tasks', { token: rotated })).status, 401);
    assert.equal(child.exitCode, null);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
