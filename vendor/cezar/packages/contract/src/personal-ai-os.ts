import { z } from 'zod';

/**
 * Same-origin read-only proxy into the Personal AI OS control services
 * (AUI-03). The cockpit must never hold those services' tokens: the cezar
 * server fetches server-side and returns an envelope the cards render.
 */

/** Read-only control-plane sections the proxy is willing to forward. */
export const personalAiOsControlPlaneSectionSchema = z.enum([
  'tasks',
  'executions',
  'approvals',
  'capabilities',
]);
export type PersonalAiOsControlPlaneSection = z.infer<typeof personalAiOsControlPlaneSectionSchema>;

/**
 * Envelope every proxy route answers, always with HTTP 200 from cezar's side.
 *
 * `available:false` is a HONEST degradation (no authority configured, unreadable
 * authority file, upstream timeout/network failure) — the cockpit renders its
 * existing "unavailable" state instead of a broken card. `upstreamStatus` and
 * `body` carry the upstream answer verbatim when one was received; the proxy
 * never copies credentials into either field.
 */
export const personalAiOsProxyResponseSchema = z.object({
  available: z.boolean(),
  /** Stable, UI-friendly reason token when unavailable (never secret material). */
  reason: z.string().optional(),
  /** Upstream HTTP status, present exactly when an upstream answer was received. */
  upstreamStatus: z.number().int().optional(),
  /** Upstream JSON body, present exactly when an upstream answer was received. */
  body: z.unknown().optional(),
});
export type PersonalAiOsProxyResponse = z.infer<typeof personalAiOsProxyResponseSchema>;
