import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personalAiOsProxyResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const dirs: string[] = [];
const stores: RunStore[] = [];
const cleanups: Array<() => void> = [];
const savedHome = process.env.CEZ_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'cez-paios-home-'));
  dirs.push(home);
  process.env.CEZ_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const s of stores.splice(0)) s.flush();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.CEZ_HOME;
  else process.env.CEZ_HOME = savedHome;
});

function bootApp(extra: Partial<Parameters<typeof createApp>[0]>) {
  const root = mkdtempSync(join(tmpdir(), 'cez-paios-boot-'));
  dirs.push(root);
  const store = RunStore.open(join(root, '.ai/cezar'));
  stores.push(store);
  return createApp({ ...extra, repoRoot: root, store, manager: {} as RunManager,
    version: 'test', onDispose: (cleanup) => cleanups.push(cleanup) });
}

function writeAuthority(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cez-paios-auth-')), 'authority.json');
  dirs.push(join(path, '..'));
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('personal-ai-os same-origin read proxy', () => {
  it('answers the degraded envelope when no authority is configured', async () => {
    const app = bootApp({});
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks');
    expect(response.status).toBe(200);
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope).toEqual({ available: false, reason: 'authority-unavailable' });
  });

  it('degrades when the authority file is malformed', async () => {
    const app = bootApp({ personalAiOsAuthorityPath: writeAuthority('{not json') });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks');
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope).toEqual({ available: false, reason: 'authority-unavailable' });
  });

  it('degrades when the authority lacks the token for that upstream', async () => {
    const app = bootApp({ personalAiOsAuthorityPath: writeAuthority({ goals: 'g-token' }),
      personalAiOsFetch: vi.fn() });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks');
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope).toEqual({ available: false, reason: 'authority-unavailable' });
    expect(app).toBeDefined();
  });

  it('forwards the read with the server-side token and passes the answer through', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:4324/api/control-plane/tasks');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cp-token');
      return new Response(JSON.stringify({ tasks: [{ id: 't1' }] }), { status: 200 });
    });
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token', goals: 'g-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks');
    expect(response.status).toBe(200);
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope.available).toBe(true);
    expect(envelope.upstreamStatus).toBe(200);
    expect(envelope.body).toEqual({ tasks: [{ id: 't1' }] });
  });

  it('routes goals to the goals upstream with the goals token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('http://127.0.0.1:4326/api/goals');
      return new Response(JSON.stringify({ goals: [] }), { status: 200 });
    });
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token', goals: 'g-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/goals');
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope.available).toBe(true);
    expect(envelope.body).toEqual({ goals: [] });
  });

  it('never copies the token into the response body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    for (const path of ['/api/v1/personal-ai-os/control-plane/tasks',
      '/api/v1/personal-ai-os/control-plane/approvals']) {
      const response = await apiRequest(app, path);
      expect(JSON.stringify(await response.json())).not.toContain('cp-token');
    }
  });

  it('passes upstream errors through the envelope without rewriting them', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'TASK_NOT_FOUND' }), { status: 500 }));
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks');
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope.available).toBe(true);
    expect(envelope.upstreamStatus).toBe(500);
    expect(envelope.body).toEqual({ error: 'TASK_NOT_FOUND' });
  });

  it('reports unreachable upstreams as a degraded envelope', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('fetch failed'); });
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks');
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope).toEqual({ available: false, reason: 'upstream-unreachable' });
  });

  it('refuses sections outside the allowlist', async () => {
    const app = bootApp({ personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }) });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/decision');
    expect(response.status).toBe(400);
  });

  it('forwards the task detail and completion-plan reads', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cp-token');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    const detail = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks/task_1');
    expect(detail.status).toBe(200);
    const plan = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks/task_1/completion-plan');
    expect(plan.status).toBe(200);
    expect(seen).toEqual([
      'http://127.0.0.1:4324/api/control-plane/tasks/task_1',
      'http://127.0.0.1:4324/api/control-plane/tasks/task_1/completion-plan',
    ]);
  });

  it('refuses unsafe task ids before any upstream call', async () => {
    const fetchImpl = vi.fn();
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    for (const bad of ['../escape', 'a/b', 'x'.repeat(201)]) {
      const response = await apiRequest(app, `/api/v1/personal-ai-os/control-plane/tasks/${encodeURIComponent(bad)}`);
      expect(response.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes no mutating route (POST is not in the family)', async () => {
    const app = bootApp({ personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }) });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/tasks',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  });

  it('forwards only the bounded approvals query (decision + limit) to the upstream URL', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
    });
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/control-plane/approvals?decision=pending&limit=20&ignored=drop-me');
    expect(response.status).toBe(200);
    expect(seen).toEqual(['http://127.0.0.1:4324/api/control-plane/approvals?decision=pending&limit=20']);
  });

  it('refuses out-of-contract approval query values before any upstream call', async () => {
    const fetchImpl = vi.fn();
    const app = bootApp({
      personalAiOsAuthorityPath: writeAuthority({ controlPlane: 'cp-token' }),
      personalAiOsFetch: fetchImpl as unknown as typeof fetch,
    });
    for (const query of ['decision=bogus', 'limit=0', 'limit=101', 'limit=abc']) {
      const response = await apiRequest(app, `/api/v1/personal-ai-os/control-plane/approvals?${query}`);
      expect(response.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proxies the wechat status read without any authorization header', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ status: 'connected', botId: 'bot-42' }), { status: 200 });
    });
    // No authority file at all: the credential-free wechat upstream must not be gated on one.
    const app = bootApp({ personalAiOsFetch: fetchImpl as unknown as typeof fetch });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/wechat/status');
    expect(response.status).toBe(200);
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope.available).toBe(true);
    expect(envelope.body).toEqual({ status: 'connected', botId: 'bot-42' });
    expect(seen).toEqual([{ url: 'http://127.0.0.1:4322/api/wechat/status', auth: null }]);
  });

  it('degrades the wechat status read when the upstream is unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('fetch failed'); });
    const app = bootApp({ personalAiOsFetch: fetchImpl as unknown as typeof fetch });
    const response = await apiRequest(app, '/api/v1/personal-ai-os/wechat/status');
    const envelope = personalAiOsProxyResponseSchema.parse(await response.json());
    expect(envelope).toEqual({ available: false, reason: 'upstream-unreachable' });
  });
});
