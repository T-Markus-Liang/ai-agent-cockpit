/**
 * Vendor-side fallback decision gate — P3 FG-F001 r2.
 *
 * CANONICAL POLICY lives at `runtime/fallback-policy.mjs` (root, pure ESM). The
 * vendor package CANNOT import it: `tsconfig.json` pins `rootDir: "."`, so a
 * module outside the package fails the build (TS7016 implicit-any under strict /
 * TS6059 not-under-rootDir). This mirrors the `submission-registry` precedent — a
 * vendor-side, file-type implementation aligned to the root semantic contract —
 * rather than reaching across the package boundary. This deliberate mirror is
 * recorded as a DEVIATION for adjudication in
 * `docs/handoffs/p3-foreground-background-r2.md`.
 *
 * Scope is deliberately minimal: ONLY two pure predicates that decide whether a
 * failed turn may be retried on another candidate. No decision log, no snapshot,
 * no scope counters — those stay in the canonical root library so no second
 * engine is built here.
 *
 * Semantics mirror `runtime/fallback-policy.mjs` `classify`:
 *   * A fallback is authorized ONLY on an explicit host proof that nothing ran:
 *     `hasProducedMessage === false` AND `hasUsedTools === false`. A missing /
 *     undefined (or otherwise non-`false`) flag reads as unknown and is refused —
 *     a same-named error can land mid tool-loop, so `kind` alone never proves a
 *     clean start.
 *   * `auth_error` is always refused (never swap engines to guess credentials).
 *   * Unknown / non-degradable kinds are always refused (fail closed).
 *   * `decideFallback` additionally refuses when the grant budget is spent
 *     (`deadline-exhausted`), so an elapsed absolute deadline can never trigger a
 *     resend.
 */

/** Kinds that MAY fall back, mapped to the reason a PROVEN-CLEAN one reports. */
const DEGRADABLE_KINDS = new Map<string, string>([
  ["startup_error", "startup-failure"],
  ["timeout", "timeout-clean"],
  ["protocol_error", "protocol-failure"],
  ["rate_limit", "rate-limited"],
]);

/** Frozen classification result. */
export interface FallbackClassification {
  eligible: boolean;
  reason: string;
}

/** Frozen outcome of the full gate (classification + remaining-budget check). */
export type FallbackDecision =
  | { action: "fallback"; reason: string }
  | { action: "stop"; reason: string };

/**
 * Whether a classified failure may be replayed on a fallback candidate.
 * The side-effect barrier runs for EVERY degradable kind: only an explicit
 * `hasProducedMessage === false && hasUsedTools === false` authorizes a fallback.
 */
export function classifyFailure(
  kind: unknown,
  hasProducedMessage: unknown,
  hasUsedTools: unknown,
): FallbackClassification {
  if (kind === "auth_error") return { eligible: false, reason: "auth-failure" };
  const cleanReason = typeof kind === "string" ? DEGRADABLE_KINDS.get(kind) : undefined;
  if (cleanReason === undefined) return { eligible: false, reason: "uncertain-side-effects" };
  if (hasProducedMessage !== false || hasUsedTools !== false) {
    return { eligible: false, reason: kind === "timeout" ? "timeout-dirty" : "unclean-side-effects" };
  }
  return { eligible: true, reason: cleanReason };
}

/**
 * The full gate: classify the failure, then additionally require remaining grant
 * budget. `remainingMs` is the budget left on the turn's absolute deadline
 * (`deadlineAt - now`); `Infinity` means no grant is configured (unbounded, so
 * budget never blocks a proven-clean degradable fallback). A spent budget
 * (`remainingMs <= 0`, or a non-numeric NaN) is always `stop`/`deadline-exhausted`.
 */
export function decideFallback(input: {
  kind?: unknown;
  hasProducedMessage?: unknown;
  hasUsedTools?: unknown;
  remainingMs: number;
}): FallbackDecision {
  const classification = classifyFailure(input.kind, input.hasProducedMessage, input.hasUsedTools);
  if (!classification.eligible) return { action: "stop", reason: classification.reason };
  if (!(input.remainingMs > 0)) return { action: "stop", reason: "deadline-exhausted" };
  return { action: "fallback", reason: classification.reason };
}
