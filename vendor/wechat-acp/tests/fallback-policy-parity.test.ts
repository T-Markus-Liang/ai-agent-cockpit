/**
 * Differential parity guard — the vendor fallback gate vs. the canonical root policy.
 *
 * WHY THIS FILE EXISTS
 * `vendor/wechat-acp/src/acp/fallback-policy.ts` is a hand-maintained MIRROR of the
 * canonical `runtime/fallback-policy.mjs` (see the deviation note in
 * `docs/handoffs/p3-foreground-background-r2.md`): the vendor package pins
 * `rootDir: "."`, so `src/` cannot import the root `.mjs` (TS7016 under strict).
 * A mirror can silently DRIFT from its authority, so this test drives BOTH
 * implementations over one input matrix and asserts their OBSERVABLE outcomes stay
 * semantically equivalent. It is a pure guard — it never touches production code.
 *
 * WHY THE IMPORT BELOW IS LEGAL
 * The vendor package `tsconfig.json` only includes `src/**` and `bin/**`, and its
 * test runner is `node --import tsx/esm --test`. Tests are therefore NOT type-checked
 * by the package build, so importing the root `.mjs` here (which the `rootDir` boundary
 * forbids from `src/`) is fine and is exactly what lets this parity check exist.
 *
 * WHAT IS COMPARED (shape-adapted, NOT field-by-field)
 *   * classification core  — root `policy.classifyFailure({ kind, hasProducedMessage,
 *     hasUsedTools })` vs. vendor `classifyFailure(kind, hasProducedMessage, hasUsedTools)`.
 *     Both return `{ eligible, reason }`; we compare `eligible` and `reason` exactly.
 *   * next-candidate gate   — root `policy.nextAttempt(scopeKey, failure)` vs. vendor
 *     `decideFallback({ kind, hasProducedMessage, hasUsedTools, remainingMs })`. Both
 *     answer "may the NEXT candidate be tried?". We compare the boolean `allowed`
 *     (action === "fallback") and, where their guards overlap, the reason; on the
 *     branch where each side's OWN bound is spent we compare only the shared semantics
 *     ("a spent bound forbids a fallback") because the guards differ by design.
 *
 * THE THIRD AXIS ("bound state") — mapping the two shapes
 * Root is bounded by `MAX_AUTOMATIC_ATTEMPTS` (1) per scope (`fallback-exhausted`);
 * vendor mirrors no attempt counter and is bounded instead by the remaining grant
 * budget (`remainingMs`, `deadline-exhausted`). These are DIFFERENT guards covering
 * the SAME intent — "a consumed bound forbids another fallback" — so the axis is
 * expressed once and adapted to each side:
 *     fresh         root: 0 attempts spent        vendor: remainingMs = +1000
 *     at-limit      root: exactly MAX spent       vendor: remainingMs = 0
 *     beyond-limit  root: a further (clamped) call vendor: remainingMs = -1
 * Any structural drift (a kind that flips eligibility, a flag that stops being
 * required `false`, a bound that lets a second fallback through) fails this file and
 * prints the exact diverging rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Canonical authority (untyped pure ESM). Resolved only by the test runner (tsx);
// the package build never sees this file (see the header note above).
import { createFallbackPolicy, MAX_AUTOMATIC_ATTEMPTS, classifyLaunchFailure as rootClassifyLaunch } from '../../../runtime/fallback-policy.mjs';
import {
  classifyFailure as vendorClassify,
  decideFallback as vendorDecide,
  classifyLaunchFailure as vendorClassifyLaunch,
} from '../src/acp/fallback-policy.js';

type BoundState = 'fresh' | 'at-limit' | 'beyond-limit';

/** Scope key used for every root-side decision (vendor side has no scope concept). */
const SCOPE = 'parity-scope';

/** A fresh two-candidate chain: the primary plus exactly one fallback candidate. */
const chain = () => [
  { ref: 'openai/gpt-4o', provider: 'openai', modelId: 'gpt-4o' },
  { ref: 'kimi/kimi-k2', provider: 'kimi', modelId: 'kimi-k2' },
];

/** The failure kinds exercised: every degradable kind, auth, both uncertain names,
 *  unrecognized strings (incl. empty), and assorted non-string kinds. */
const KINDS: unknown[] = [
  'startup_error',
  'timeout',
  'protocol_error',
  'rate_limit',
  'auth_error',
  'mid_generation_failure',
  'unknown',
  'some_future_kind',
  '',
  undefined,
  null,
  42,
  {},
  true,
];

/** Each side-effect flag ranges over true / false / undefined. */
const FLAG_STATES: unknown[] = [true, false, undefined];

const BOUND_STATES: BoundState[] = ['fresh', 'at-limit', 'beyond-limit'];

/** Stable, readable label for a (possibly non-string) kind. */
const label = (kind: unknown): string =>
  typeof kind === 'string' ? JSON.stringify(kind) : `${typeof kind}:${String(kind)}`;

// --------------------------------------------------------------------------
// Shape adapters: normalize each implementation to the compared observables.
// --------------------------------------------------------------------------

/** Root classification: object arg -> { eligible, reason }. */
function rootClassify(kind: unknown, hasProducedMessage: unknown, hasUsedTools: unknown) {
  const policy = createFallbackPolicy({ chain: chain() });
  return policy.classifyFailure({ kind, hasProducedMessage, hasUsedTools });
}

/** Vendor classification: positional args -> { eligible, reason }. */
function vendorClassifyOf(kind: unknown, hasProducedMessage: unknown, hasUsedTools: unknown) {
  return vendorClassify(kind, hasProducedMessage, hasUsedTools);
}

/** A proven-clean input used to spend the automatic attempt in the root pre-states. */
const cleanProbe = { kind: 'startup_error', hasProducedMessage: false, hasUsedTools: false };

/** Root next-candidate gate, positioned at the requested bound state. */
function rootDecide(kind: unknown, hasProducedMessage: unknown, hasUsedTools: unknown, bound: BoundState) {
  const policy = createFallbackPolicy({ chain: chain() });
  if (bound === 'at-limit' || bound === 'beyond-limit') policy.nextAttempt(SCOPE, cleanProbe);
  if (bound === 'beyond-limit') policy.nextAttempt(SCOPE, cleanProbe); // the extra, still-clamped call
  const decision = policy.nextAttempt(SCOPE, { kind, hasProducedMessage, hasUsedTools });
  const scopes = policy.toJSON().scopes as Array<{ scopeKey: string; attemptsUsed: number }>;
  const attemptsUsed = scopes.find((scope) => scope.scopeKey === SCOPE)?.attemptsUsed ?? 0;
  return { allowed: decision.action === 'fallback', reason: decision.reason as string, attemptsUsed };
}

/** Vendor next-candidate gate, with the budget bound mapped from the bound state. */
function vendorDecideOf(kind: unknown, hasProducedMessage: unknown, hasUsedTools: unknown, bound: BoundState) {
  const remainingMs = bound === 'fresh' ? 1000 : bound === 'at-limit' ? 0 : -1;
  const decision = vendorDecide({ kind, hasProducedMessage, hasUsedTools, remainingMs });
  return { allowed: decision.action === 'fallback', reason: decision.reason };
}

/** Print a divergence ledger and fail if any row drifted. */
function report(testName: string, rows: number, divergences: string[]): void {
  if (divergences.length > 0) {
    console.error(`\n[${testName}] ${divergences.length}/${rows} rows DIVERGED:\n${divergences.join('\n')}`);
  }
  assert.deepEqual(
    divergences,
    [],
    `${divergences.length}/${rows} matrix rows diverged between root and vendor (see stderr)`,
  );
}

test('parity: classification core agrees on eligible + reason for every kind x flags', () => {
  const rows = KINDS.length * FLAG_STATES.length * FLAG_STATES.length;
  const divergences: string[] = [];
  console.log(`[parity] classification matrix: ${KINDS.length} kinds x ${FLAG_STATES.length} x ${FLAG_STATES.length} flags = ${rows} rows`);

  for (const kind of KINDS) {
    for (const hasProducedMessage of FLAG_STATES) {
      for (const hasUsedTools of FLAG_STATES) {
        const root = rootClassify(kind, hasProducedMessage, hasUsedTools);
        const vendor = vendorClassifyOf(kind, hasProducedMessage, hasUsedTools);
        if (root.eligible !== vendor.eligible || root.reason !== vendor.reason) {
          divergences.push(
            `kind=${label(kind)} pm=${String(hasProducedMessage)} ut=${String(hasUsedTools)}: ` +
              `root=${JSON.stringify(root)} vendor=${JSON.stringify(vendor)}`,
          );
        }
      }
    }
  }
  report('classification parity', rows, divergences);
});

test('parity: next-candidate gate agrees on allowance for every kind x flags x bound state', () => {
  const rows = KINDS.length * FLAG_STATES.length * FLAG_STATES.length * BOUND_STATES.length;
  const divergences: string[] = [];
  console.log(`[parity] decision matrix: ${KINDS.length} kinds x ${FLAG_STATES.length} x ${FLAG_STATES.length} flags x ${BOUND_STATES.length} bounds = ${rows} rows`);

  for (const kind of KINDS) {
    for (const hasProducedMessage of FLAG_STATES) {
      for (const hasUsedTools of FLAG_STATES) {
        // The classification core is bound-independent: compare it once per input.
        const rootClass = rootClassify(kind, hasProducedMessage, hasUsedTools);
        const vendorClass = vendorClassifyOf(kind, hasProducedMessage, hasUsedTools);
        const at = `kind=${label(kind)} pm=${String(hasProducedMessage)} ut=${String(hasUsedTools)}`;
        if (rootClass.eligible !== vendorClass.eligible || rootClass.reason !== vendorClass.reason) {
          divergences.push(`classification ${at}: root=${JSON.stringify(rootClass)} vendor=${JSON.stringify(vendorClass)}`);
        }

        for (const bound of BOUND_STATES) {
          const where = `${at} bound=${bound}`;
          const root = rootDecide(kind, hasProducedMessage, hasUsedTools, bound);
          const vendor = vendorDecideOf(kind, hasProducedMessage, hasUsedTools, bound);

          // 1. The headline observable: may the next candidate be tried?
          if (root.allowed !== vendor.allowed) {
            divergences.push(`allowance ${where}: root=${root.allowed}(${root.reason}) vendor=${vendor.allowed}(${vendor.reason})`);
            continue;
          }

          if (!rootClass.eligible) {
            // Ineligible on both sides -> the stop carries the classification reason,
            // independent of each side's own bound.
            if (root.reason !== rootClass.reason || vendor.reason !== vendorClass.reason) {
              divergences.push(`ineligible reason ${where}: root=${root.reason} vendor=${vendor.reason} expected=${rootClass.reason}`);
            }
          } else if (bound === 'fresh') {
            // Eligible + bound available -> both authorize the next candidate, same reason.
            if (root.reason !== rootClass.reason || vendor.reason !== vendorClass.reason) {
              divergences.push(`fresh eligible reason ${where}: root=${root.reason} vendor=${vendor.reason} expected=${rootClass.reason}`);
            }
          } else {
            // Eligible, but each side's OWN bound is spent -> a hard stop. The guards
            // differ (attempts vs. deadline), so the reason NAMES differ by design; we
            // assert only the SHARED semantics: a spent bound forbids the fallback.
            if (root.reason !== 'fallback-exhausted') divergences.push(`root spent-bound reason ${where}: ${root.reason}`);
            if (vendor.reason !== 'deadline-exhausted') divergences.push(`vendor spent-bound reason ${where}: ${vendor.reason}`);
          }

          // 2. Root invariant: the automatic-attempt counter can never exceed the bound.
          if (root.attemptsUsed > MAX_AUTOMATIC_ATTEMPTS) {
            divergences.push(`root attempts over bound ${where}: attemptsUsed=${root.attemptsUsed} > ${MAX_AUTOMATIC_ATTEMPTS}`);
          }
        }
      }
    }
  }
  report('decision parity', rows, divergences);
});

test('contract anchor: the decisive negatives and the positive hold on BOTH sides', () => {
  assert.equal(MAX_AUTOMATIC_ATTEMPTS, 1, 'the root bound the matrix axis is built on');

  // NEGATIVE — protocol_error carrying a side-effect marker must be refused on both
  // sides, with the shared reason (NOT the timeout-specific one).
  assert.deepEqual(rootClassify('protocol_error', true, false), { eligible: false, reason: 'unclean-side-effects' });
  assert.deepEqual(vendorClassifyOf('protocol_error', true, false), { eligible: false, reason: 'unclean-side-effects' });
  const rootProtoDirty = rootDecide('protocol_error', true, false, 'fresh');
  const vendorProtoDirty = vendorDecideOf('protocol_error', true, false, 'fresh');
  assert.equal(rootProtoDirty.allowed, false);
  assert.equal(rootProtoDirty.reason, 'unclean-side-effects');
  assert.equal(vendorProtoDirty.allowed, false);
  assert.equal(vendorProtoDirty.reason, 'unclean-side-effects');

  // NEGATIVE — a dirty timeout reports its kind-specific reason on both sides.
  assert.deepEqual(rootClassify('timeout', false, true), { eligible: false, reason: 'timeout-dirty' });
  assert.deepEqual(vendorClassifyOf('timeout', false, true), { eligible: false, reason: 'timeout-dirty' });
  assert.equal(rootDecide('timeout', false, true, 'fresh').reason, 'timeout-dirty');
  assert.equal(vendorDecideOf('timeout', false, true, 'fresh').reason, 'timeout-dirty');

  // NEGATIVE — a missing flag is UNKNOWN, never a clean proof, on both sides.
  assert.deepEqual(rootClassify('startup_error', undefined, false), { eligible: false, reason: 'unclean-side-effects' });
  assert.deepEqual(vendorClassifyOf('startup_error', undefined, false), { eligible: false, reason: 'unclean-side-effects' });

  // NEGATIVE — auth_error is never swapped to another engine, even with a clean proof.
  assert.deepEqual(rootClassify('auth_error', false, false), { eligible: false, reason: 'auth-failure' });
  assert.deepEqual(vendorClassifyOf('auth_error', false, false), { eligible: false, reason: 'auth-failure' });

  // POSITIVE — a startup failure with a proven-clean host proof is allowed on both sides.
  assert.deepEqual(rootClassify('startup_error', false, false), { eligible: true, reason: 'startup-failure' });
  assert.deepEqual(vendorClassifyOf('startup_error', false, false), { eligible: true, reason: 'startup-failure' });
  const rootClean = rootDecide('startup_error', false, false, 'fresh');
  const vendorClean = vendorDecideOf('startup_error', false, false, 'fresh');
  assert.equal(rootClean.allowed, true);
  assert.equal(rootClean.reason, 'startup-failure');
  assert.equal(vendorClean.allowed, true);
  assert.equal(vendorClean.reason, 'startup-failure');
});

// --------------------------------------------------------------------------
// S03a launch gate: classifyLaunchFailure must agree on BOTH mirrors for every
// kind x providerSessionTouched state. Same shape on both sides
// ({ kind, providerSessionTouched } -> frozen { advance, reason }), so the
// comparison is field-by-field.
// --------------------------------------------------------------------------

/** Every launch kind the gate names, plus near-misses and non-string kinds. */
const LAUNCH_KINDS: unknown[] = [
  'spawn-not-found',
  'startup-exit',
  'startup-timeout',
  'aborted',
  'auth_error',
  'spawn-permission',
  'cleanup-uncertain',
  'launch-error',
  'initialize-error',
  'spawn-error',
  'startup_error',
  'timeout',
  'unknown',
  'some_future_kind',
  '',
  undefined,
  null,
  42,
  {},
  true,
];

/** providerSessionTouched ranges over the explicit clean proof and unknowns. */
const TOUCH_STATES: unknown[] = [false, true, undefined, null, 0, 'false'];

test('parity: launch gate agrees on advance + reason for every kind x touched state', () => {
  const rows = LAUNCH_KINDS.length * TOUCH_STATES.length;
  const divergences: string[] = [];
  console.log(`[parity] launch matrix: ${LAUNCH_KINDS.length} kinds x ${TOUCH_STATES.length} touched states = ${rows} rows`);

  for (const kind of LAUNCH_KINDS) {
    for (const providerSessionTouched of TOUCH_STATES) {
      const root = rootClassifyLaunch({ kind, providerSessionTouched });
      const vendor = vendorClassifyLaunch({ kind, providerSessionTouched });
      if (root.advance !== vendor.advance || root.reason !== vendor.reason) {
        divergences.push(
          `kind=${label(kind)} touched=${String(providerSessionTouched)}: ` +
            `root=${JSON.stringify(root)} vendor=${JSON.stringify(vendor)}`,
        );
      }
      // Both mirrors freeze the verdict.
      if (!Object.isFrozen(root) || !Object.isFrozen(vendor)) {
        divergences.push(`unfrozen verdict at kind=${label(kind)} touched=${String(providerSessionTouched)}`);
      }
    }
  }
  report('launch parity', rows, divergences);
});

test('parity: launch gate fails closed on malformed input and honors the decisive rows on BOTH sides', () => {
  for (const malformed of [undefined, null, 42, 'kind', [], true]) {
    assert.deepEqual(rootClassifyLaunch(malformed), { advance: false, reason: 'unknown-launch-effect' });
    assert.deepEqual(vendorClassifyLaunch(malformed as never), { advance: false, reason: 'unknown-launch-effect' });
  }
  // NEGATIVE — the unknown-launch-effect barrier dominates every kind, even a
  // degradable one, on both sides (missing touched flag included).
  assert.deepEqual(rootClassifyLaunch({ kind: 'spawn-not-found', providerSessionTouched: true }), { advance: false, reason: 'unknown-launch-effect' });
  assert.deepEqual(vendorClassifyLaunch({ kind: 'spawn-not-found', providerSessionTouched: true }), { advance: false, reason: 'unknown-launch-effect' });
  assert.deepEqual(rootClassifyLaunch({ kind: 'startup-exit' }), { advance: false, reason: 'unknown-launch-effect' });
  assert.deepEqual(vendorClassifyLaunch({ kind: 'startup-exit' }), { advance: false, reason: 'unknown-launch-effect' });
  // NEGATIVE — auth, permission, abort and unstructured kinds never advance.
  assert.deepEqual(rootClassifyLaunch({ kind: 'auth_error', providerSessionTouched: false }), { advance: false, reason: 'auth-failure' });
  assert.deepEqual(vendorClassifyLaunch({ kind: 'auth_error', providerSessionTouched: false }), { advance: false, reason: 'auth-failure' });
  assert.deepEqual(rootClassifyLaunch({ kind: 'spawn-permission', providerSessionTouched: false }), { advance: false, reason: 'permission-denied' });
  assert.deepEqual(vendorClassifyLaunch({ kind: 'spawn-permission', providerSessionTouched: false }), { advance: false, reason: 'permission-denied' });
  assert.deepEqual(rootClassifyLaunch({ kind: undefined, providerSessionTouched: false }), { advance: false, reason: 'uncertain-side-effects' });
  assert.deepEqual(vendorClassifyLaunch({ kind: undefined, providerSessionTouched: false }), { advance: false, reason: 'uncertain-side-effects' });
  // POSITIVE — a proven-clean spawn-not-found advances on both sides.
  assert.deepEqual(rootClassifyLaunch({ kind: 'spawn-not-found', providerSessionTouched: false }), { advance: true, reason: 'spawn-not-found' });
  assert.deepEqual(vendorClassifyLaunch({ kind: 'spawn-not-found', providerSessionTouched: false }), { advance: true, reason: 'spawn-not-found' });
});
