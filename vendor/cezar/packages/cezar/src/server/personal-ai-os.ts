import { readFileSync, statSync } from 'node:fs';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  personalAiOsControlPlaneSectionSchema,
  personalAiOsProxyResponseSchema,
} from '@open-mercato/cezar-contract';
import { paramZodValidator, queryZodValidator } from './validators.ts';

/**
 * Same-origin read-only proxy into the Personal AI OS control services
 * (AUI-03). The cockpit cards must never see those services' tokens: this
 * module holds them server-side, forwards GETs to fixed loopback upstreams,
 * and answers an honest envelope the cards render (including the degraded
 * "unavailable" state — a missing authority file shrinks the feature, it
 * never fails the boot).
 */

export interface PersonalAiOsProxyDeps {
  /** Fetch implementation; tests inject a fake. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Authority-file path; tests inject a tmp file. Defaults to
   *  `process.env.CEZ_PAI_OS_AUTHORITY` (unset => feature unavailable). */
  authorityPath?: string;
}

const UPSTREAM_TIMEOUT_MS = 3_000;

const CONTROL_PLANE_BASE = 'http://127.0.0.1:4324';
const GOALS_BASE = 'http://127.0.0.1:4326';
const WECHAT_BASE = 'http://127.0.0.1:4322';

const authorityTokensSchema = z.object({
  controlPlane: z.string().min(1).optional(),
  goals: z.string().min(1).optional(),
});

type AuthorityTokens = z.infer<typeof authorityTokensSchema>;

interface CachedAuthority {
  path: string;
  mtimeMs: number;
  tokens: AuthorityTokens | null;
}

let authorityCache: CachedAuthority | null = null;

function readAuthorityTokens(path: string | undefined): AuthorityTokens | null {
  if (!path) return null;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (authorityCache && authorityCache.path === path && authorityCache.mtimeMs === mtimeMs) {
      return authorityCache.tokens;
    }
    const parsed = authorityTokensSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    const tokens = parsed.success ? parsed.data : null;
    authorityCache = { path, mtimeMs, tokens };
    return tokens;
  } catch {
    // Missing/unreadable/malformed authority: degrade, never throw.
    authorityCache = { path, mtimeMs: -1, tokens: null };
    return null;
  }
}

async function forwardReadOnly(
  deps: PersonalAiOsProxyDeps,
  upstreamUrl: string,
  token: string | undefined,
): Promise<Response> {
  const impl = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return impl(upstreamUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

async function proxyEnvelope(
  deps: PersonalAiOsProxyDeps,
  buildUpstream: (tokens: AuthorityTokens) => { url: string; token?: string } | null,
): Promise<z.infer<typeof personalAiOsProxyResponseSchema>> {
  const tokens = readAuthorityTokens(deps.authorityPath ?? process.env.CEZ_PAI_OS_AUTHORITY);
  const upstream = tokens ? buildUpstream(tokens) : null;
  if (!upstream) return { available: false, reason: 'authority-unavailable' };
  let response: Response;
  try {
    response = await forwardReadOnly(deps, upstream.url, upstream.token);
  } catch {
    return { available: false, reason: 'upstream-unreachable' };
  }
  const body = await response.json().catch(() => null);
  return { available: true, upstreamStatus: response.status, body };
}

/** Chained family (workspace-level, single-mount): every route is GET-only. */
const controlPlaneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

// Bounded query forward surface: the approvals list card filters by decision and
// limit, and nothing else. Zod strips unknown keys, so arbitrary query strings
// cannot be smuggled toward the upstream (AUI-03: fixed paths, no open forwarder).
const controlPlaneQuerySchema = z.object({
  decision: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function personalAiOsRoutes(deps: PersonalAiOsProxyDeps = {}) {
  const controlPlaneEnvelope = (path: string, query?: z.infer<typeof controlPlaneQuerySchema>) =>
    proxyEnvelope(deps, (tokens) => {
      if (!tokens.controlPlane) return null;
      const upstream = new URL(`${CONTROL_PLANE_BASE}/api/control-plane/${path}`);
      if (query?.decision) upstream.searchParams.set('decision', query.decision);
      if (query?.limit !== undefined) upstream.searchParams.set('limit', String(query.limit));
      return { url: upstream.toString(), token: tokens.controlPlane };
    });
  return new Hono()
    .get(
      '/personal-ai-os/control-plane/:section',
      paramZodValidator(z.object({ section: personalAiOsControlPlaneSectionSchema }), {
        message: 'section must be one of tasks, executions, approvals, capabilities',
      }),
      queryZodValidator(controlPlaneQuerySchema),
      async (c) => c.json(await controlPlaneEnvelope(c.req.valid('param').section, c.req.valid('query'))),
    )
    .get(
      '/personal-ai-os/control-plane/tasks/:taskId',
      paramZodValidator(z.object({ taskId: controlPlaneIdSchema }), {
        message: 'taskId must be a single safe path segment',
      }),
      async (c) => c.json(await controlPlaneEnvelope(`tasks/${c.req.valid('param').taskId}`)),
    )
    .get(
      '/personal-ai-os/control-plane/tasks/:taskId/completion-plan',
      paramZodValidator(z.object({ taskId: controlPlaneIdSchema }), {
        message: 'taskId must be a single safe path segment',
      }),
      async (c) => c.json(await controlPlaneEnvelope(`tasks/${c.req.valid('param').taskId}/completion-plan`)),
    )
    .get('/personal-ai-os/goals', async (c) => {
      const envelope = await proxyEnvelope(deps, (tokens) =>
        tokens.goals ? { url: `${GOALS_BASE}/api/goals`, token: tokens.goals } : null,
      );
      return c.json(envelope);
    })
    .get('/personal-ai-os/wechat/status', async (c) => {
      // The wechat-control upstream is loopback-only and authenticates nothing, so
      // this route deliberately does NOT consult the authority file: gating a
      // credential-free upstream on an unrelated credential file would falsely
      // shrink the feature. It still answers the same honest envelope.
      let response: Response;
      try {
        response = await forwardReadOnly(deps, `${WECHAT_BASE}/api/wechat/status`, undefined);
      } catch {
        return c.json({ available: false, reason: 'upstream-unreachable' });
      }
      const body = await response.json().catch(() => null);
      return c.json({ available: true, upstreamStatus: response.status, body });
    });
}
