import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Personal AI OS 0.3.0 S03b — control-plane per-task execution Grant
// (remediation plan docs/plans/0.3.0-remediation-2026-10-09.md §5 items 1/2/6).
//
// A Grant is the host's FORMAL admission artifact for one concrete
// (taskId, executionId) pair. It binds:
//   - taskId / executionId   — the exact queued work item it admits;
//   - owner                  — who the host admits (informational binding
//                              string, e.g. the worker/operator identity);
//   - parametersDigest       — sha256 digest of the admitted parameter set,
//                              carried on the stored execution record, so a
//                              grant minted for one parameter set can never be
//                              ported onto another (anti-portability);
//   - scope                  — the admitted action scope(s), a non-empty
//                              string or list of strings (aligned with the
//                              repository's existing scope expressions:
//                              approval action strings such as
//                              `cezar.dispatch` / `native.session.prompt`,
//                              and budget-policy's string scopeKey);
//   - issuedAt / expiresAt   — the grant's own validity window (epoch ms);
//   - effectiveDeadlineAt    — the EARLIEST of every applicable upper bound,
//                              decided ONCE at admission (issue time) and
//                              persisted with the execution BEFORE dispatch.
//
// INHERIT-DO-NOT-RESTAMP SEMANTICS (load-bearing):
//   `effectiveDeadlineAt` is derived exactly once, inside `issueGrant`, from
//   the single `issuedAt` clock reading and the supplied limits. Recovery
//   (control-plane restart) and fallback paths MUST obtain the deadline via
//   `inheritDeadline(grant)`, which returns the persisted value verbatim.
//   NO path may recompute a deadline from a fresh `now()` — that would
//   silently extend an expired admission, which is exactly the FG-F001 class
//   of bug this object exists to close on the control-plane side. `verifyGrant`
//   never re-stamps either: on success it returns the SAME grant object it was
//   given (frozen), never a new one.
//
// RELATION TO EXISTING PIECES:
//   - The vendor bridge-side `deadlineAt` (FG-F001 r2,
//     docs/handoffs/p3-foreground-background-r2.md) is the BRIDGE-side absolute
//     deadline stamped at dequeue. This module is the CONTROL-PLANE-side formal
//     Grant; the two are complementary, neither replaces the other.
//   - The approval flow (plan + parametersDigest + Approval match) stays as it
//     is: an Approval authorizes ONE action; the Grant is the admission
//     artifact for the execution itself. The Grant does NOT replace Approval,
//     and Approval expiry (when known at issue time) is just one more upper
//     bound feeding `effectiveDeadlineAt` via `limits.approvalExpiresAt`.
//
// SCOPE / BOUNDARIES:
//   Pure ESM module. No filesystem, no network, no timers, no process state,
//   no environment access, no globals beyond `node:crypto` hashing. Time is
//   the only ambient input and is ALWAYS injected as `now`. It never touches
//   production paths; persistence lives in control-plane/store.mjs, dispatch
//   wiring in control-plane/dispatcher.mjs / native-acp-executor.mjs.
//
// FAIL-CLOSED CONTRACT: every denial raises a GrantError with a stable,
// machine-readable `code` (and an `httpStatus` hint for the control-plane
// boundary, which maps it onto StoreError). Nothing here throws a bare Error.
// ---------------------------------------------------------------------------

/** Fail-closed grant denial. `code` identifies the reason. */
export class GrantError extends Error {
  constructor(code, message, httpStatus) {
    super(message ?? `execution grant rejected: ${code}`)
    this.name = 'GrantError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export const GRANT_VERSION = 1

// Default single-execution lifetime cap: 30 minutes, aligned with the vendor
// bridge-side grant deadline default (`grantDeadlineMs: 30 * 60_000`,
// vendor/wechat-acp/src/config.ts:304) so the control-plane admission window
// and the bridge-side absolute deadline speak the same default language.
// Entries may override it through CONFIGURATION (never through the admitted
// caller's payload): an env/flag value the operator sets, passed as
// `maxLifetimeMs`. A caller-facing request can only ever NARROW the window
// (an explicit `expiresAt` earlier than the cap), never widen it — the cap
// still participates in the minimum.
export const DEFAULT_MAX_EXECUTION_LIFETIME_MS = 30 * 60_000

// The exact, complete field set of a version-1 grant record.
const GRANT_FIELDS = Object.freeze([
  'version',
  'grantId',
  'taskId',
  'executionId',
  'owner',
  'parametersDigest',
  'scope',
  'issuedAt',
  'expiresAt',
  'effectiveDeadlineAt',
])

// The limit keys `issueGrant` understands. Any OTHER key is refused
// (grant-invalid) so a misspelled cap is never silently dropped — a limit the
// issuer meant to apply must either participate in the minimum or fail the
// issuance. Missing keys simply do not participate.
const LIMIT_KEYS = Object.freeze(['approvalExpiresAt', 'maxLifetimeMs'])

/** Throw a GrantError with the given code/status. */
function fail(code, message, httpStatus) {
  throw new GrantError(code, message, httpStatus)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Canonical JSON (sorted keys) so the default grantId is deterministic. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Normalize an absolute instant to epoch milliseconds. Numbers must be finite;
 * strings must parse as dates. Anything else is a grant-invalid input.
 */
function toEpochMs(value, field) {
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN)
  if (!Number.isFinite(parsed)) fail('grant-invalid', `${field} must be a finite epoch-ms number or a parseable timestamp`, 400)
  return parsed
}

/**
 * Read the injected clock exactly once for one operation. A deadline can only
 * be evaluated against a real instant, so an unusable reading — the clock is
 * not a function, threw, or returned a non-number / non-finite / negative
 * value — is clock-invalid and is refused BEFORE anything is derived or
 * admitted (mirrors runtime/budget-policy.mjs readClock: an unverifiable
 * instant is never treated as "still within the deadline").
 */
function readClock(now) {
  if (typeof now !== 'function') fail('clock-invalid', 'an injectable now() clock is required', 500)
  let value
  try {
    value = now()
  } catch {
    fail('clock-invalid', 'clock threw while reading the current time', 500)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('clock-invalid', 'clock must return a finite, non-negative epoch-ms number', 500)
  }
  return value
}

/** Validate and normalize the scope expression to a frozen string list. */
function normalizeScope(scope) {
  const entries = typeof scope === 'string' ? [scope] : scope
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => !nonEmptyString(entry))) {
    fail('grant-invalid', 'scope must be a non-empty string or a non-empty array of non-empty strings', 400)
  }
  return Object.freeze([...new Set(entries.map((entry) => entry.trim()))])
}

/**
 * Structural validation of a persisted/resent grant record (no clock, no
 * expiry judgment). Throws grant-missing / grant-invalid. Returns the record.
 */
function requireGrantShape(grant) {
  if (grant === undefined || grant === null) fail('grant-missing', 'the stored execution carries no grant', 403)
  if (!isPlainObject(grant)) fail('grant-invalid', 'grant must be a plain object', 400)
  const keys = Object.keys(grant)
  if (grant.version !== GRANT_VERSION || keys.length !== GRANT_FIELDS.length || keys.some((key) => !GRANT_FIELDS.includes(key))) {
    fail('grant-invalid', `grant must be a version-${GRANT_VERSION} record with exactly the fields: ${GRANT_FIELDS.join(', ')}`, 400)
  }
  for (const field of ['grantId', 'taskId', 'executionId', 'owner', 'parametersDigest']) {
    if (!nonEmptyString(grant[field])) fail('grant-invalid', `grant ${field} must be a non-empty string`, 400)
  }
  if (!Array.isArray(grant.scope) || grant.scope.length === 0 || grant.scope.some((entry) => !nonEmptyString(entry))) {
    fail('grant-invalid', 'grant scope must be a non-empty array of non-empty strings', 400)
  }
  for (const field of ['issuedAt', 'expiresAt', 'effectiveDeadlineAt']) {
    if (typeof grant[field] !== 'number' || !Number.isFinite(grant[field])) fail('grant-invalid', `grant ${field} must be a finite epoch-ms number`, 400)
  }
  // Internal consistency: the persisted window must be one this module could
  // have issued. A record that disagrees with itself was tampered with or
  // hand-built and is refused rather than interpreted.
  if (grant.expiresAt <= grant.issuedAt || grant.effectiveDeadlineAt > grant.expiresAt || grant.effectiveDeadlineAt <= grant.issuedAt) {
    fail('grant-invalid', 'grant time window is inconsistent (expiresAt/effectiveDeadlineAt out of order)', 400)
  }
  return grant
}

/**
 * Issue a formal admission grant for one (taskId, executionId) pair.
 *
 *   issueGrant({ taskId, executionId, owner, parametersDigest, scope,
 *                expiresAt, limits?, now, random? }) -> frozen grant
 *
 * - taskId / executionId / owner / parametersDigest: required non-empty
 *   strings (grant-invalid otherwise).
 * - scope: non-empty string or array of non-empty strings; normalized to a
 *   deduplicated, frozen array.
 * - expiresAt: the grant's own absolute expiry (epoch ms or parseable
 *   timestamp); must be finite and strictly after issuedAt.
 * - limits: optional object of additional upper bounds. Recognized keys:
 *     approvalExpiresAt  absolute instant (epoch ms or timestamp) — the
 *                        expiry of the dispatch Approval, when already known
 *                        at admission time;
 *     maxLifetimeMs      positive finite duration, applied relative to the
 *                        SINGLE issuedAt reading (never a second now() call),
 *                        e.g. a host execution-lifetime cap.
 *   Missing keys do not participate; unknown keys are grant-invalid.
 * - now: injectable clock, read EXACTLY ONCE (issuedAt). A broken clock is
 *   clock-invalid.
 * - random: optional id source for reproducible tests; when omitted the
 *   grantId is DETERMINISTIC — sha256 over the canonical record content.
 *
 * effectiveDeadlineAt = min(expiresAt, every applicable limit-derived
 * deadline). The derivation is fully deterministic: it depends only on the
 * inputs and the single issuedAt reading.
 */
export function issueGrant({ taskId, executionId, owner, parametersDigest, scope, expiresAt, limits, now, random } = {}) {
  for (const [field, value] of Object.entries({ taskId, executionId, owner, parametersDigest })) {
    if (!nonEmptyString(value)) fail('grant-invalid', `${field} must be a non-empty string`, 400)
  }
  const issuedAt = readClock(now)
  const expiry = toEpochMs(expiresAt, 'expiresAt')
  if (expiry <= issuedAt) fail('grant-invalid', 'expiresAt must be strictly after issuedAt', 400)

  const caps = [expiry]
  if (limits !== undefined) {
    if (!isPlainObject(limits)) fail('grant-invalid', 'limits must be a plain object when provided', 400)
    for (const key of Object.keys(limits)) {
      if (!LIMIT_KEYS.includes(key)) fail('grant-invalid', `unknown limit key ${JSON.stringify(key)}; known keys: ${LIMIT_KEYS.join(', ')}`, 400)
    }
    if (limits.approvalExpiresAt !== undefined) caps.push(toEpochMs(limits.approvalExpiresAt, 'limits.approvalExpiresAt'))
    if (limits.maxLifetimeMs !== undefined) {
      const lifetime = limits.maxLifetimeMs
      if (typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0) {
        fail('grant-invalid', 'limits.maxLifetimeMs must be a positive finite number', 400)
      }
      caps.push(issuedAt + lifetime)
    }
  }
  const effectiveDeadlineAt = Math.min(...caps)
  // Every derived cap must itself be a usable instant strictly inside the
  // representable range and after issue; otherwise the record would carry a
  // deadline comparisons cannot trust (mirrors budget-policy's range guard).
  if (!Number.isFinite(effectiveDeadlineAt) || effectiveDeadlineAt > Number.MAX_SAFE_INTEGER || effectiveDeadlineAt <= issuedAt) {
    fail('grant-invalid', 'the derived effective deadline is out of range (a limit must be after issuedAt)', 400)
  }

  const scopeList = normalizeScope(scope)
  const content = {
    version: GRANT_VERSION,
    taskId: taskId.trim(),
    executionId: executionId.trim(),
    owner: owner.trim(),
    parametersDigest: parametersDigest.trim(),
    scope: scopeList,
    issuedAt,
    expiresAt: expiry,
    effectiveDeadlineAt,
  }
  let grantId
  if (random !== undefined) {
    if (typeof random !== 'function') fail('grant-invalid', 'random must be a function when provided', 400)
    const value = random()
    if (!nonEmptyString(String(value))) fail('grant-invalid', 'random() must return a non-empty id component', 400)
    grantId = `grant_${String(value)}`
  } else {
    grantId = `grant_${crypto.createHash('sha256').update(stable(content)).digest('hex')}`
  }
  return Object.freeze({ version: GRANT_VERSION, grantId, ...content })
}

/**
 * Verify a stored grant at dispatch-admission time.
 *
 *   verifyGrant(grant, { taskId, executionId, parametersDigest, requiredScope?, now })
 *
 * Refusals, in order:
 *   grant-missing    no grant on the stored execution record;
 *   grant-invalid    structural / version / internal-consistency violation;
 *   grant-mismatch   the grant is bound to a different task, execution or
 *                    parameter digest than the stored record being dispatched
 *                    (anti-portability: a grant minted for execution A can
 *                    never admit execution B);
 *   grant-scope-denied the stored scope does not admit the required action;
 *   clock-invalid    the injected clock cannot produce a trustworthy instant;
 *   grant-expired    now() has reached the persisted effectiveDeadlineAt. The
 *                    comparison is against the VALUE FIXED AT ISSUE TIME —
 *                    never a recomputed deadline. Equality is expired.
 *
 * On success returns the SAME grant object it was given (freezing it in place
 * if it arrived thawed, e.g. fresh from JSON parsing) — never a new object,
 * never a re-stamped one.
 */
export function verifyGrant(grant, { taskId, executionId, parametersDigest, requiredScope, now } = {}) {
  const record = requireGrantShape(grant)
  if (record.taskId !== taskId || record.executionId !== executionId || record.parametersDigest !== parametersDigest) {
    fail('grant-mismatch', 'grant is bound to a different task/execution/parametersDigest than the stored execution being dispatched', 409)
  }
  if (requiredScope !== undefined && (!nonEmptyString(requiredScope) || !record.scope.includes(requiredScope))) {
    fail('grant-scope-denied', `grant does not admit action ${String(requiredScope)}`, 403)
  }
  const at = readClock(now)
  if (at >= record.effectiveDeadlineAt) {
    fail('grant-expired', `grant expired at ${new Date(record.effectiveDeadlineAt).toISOString()}; no new dispatch is admitted`, 409)
  }
  if (!Object.isFrozen(record.scope)) Object.freeze(record.scope)
  if (!Object.isFrozen(record)) Object.freeze(record)
  return record
}

/**
 * The ONE way recovery and fallback paths may obtain a deadline: the value
 * persisted at issue time, verbatim. There is deliberately no parameter here
 * that could widen it — no now, no limits, no re-issue. A path that needs a
 * deadline MUST call this and MUST NOT recompute one from the current time;
 * extending an admission is only ever possible by issuing a brand-new grant
 * for a brand-new execution (a new admission, not an extension).
 *
 * Structural validity is still enforced (grant-missing / grant-invalid), but
 * no clock is read and no expiry judgment is made: an expired grant's
 * deadline is inherited exactly as faithfully as a live one's — whether the
 * deadline has passed is verifyGrant's call, made at the next real admission.
 */
export function inheritDeadline(grant) {
  return requireGrantShape(grant).effectiveDeadlineAt
}

/**
 * Admission glue for production enqueue entries (S03b gap closure): mint the
 * execution id (when the entry did not assign one), derive the expiry from
 * the entry's explicit request-level `expiresAt` or — when absent — from the
 * lifetime cap, and issue the grant in ONE call so the grant can be persisted
 * with the execution record BEFORE the record is queued.
 *
 *   issueGrantForAdmission({ taskId, executionId?, owner, parametersDigest,
 *     scope, expiresAt?, authorizerExpiresAt?, maxLifetimeMs?, now?, random? })
 *     -> { id, grant, parametersDigest }
 *
 * - executionId: when omitted an id is minted — RANDOM (`execution_<uuid>`)
 *   by default, or DETERMINISTIC from `idSeed` when the entry needs
 *   idempotency-replay safety: an entry whose createExecution call is
 *   idempotency-keyed MUST derive the id from the request (e.g.
 *   `idSeed: { taskId, idempotencyKey, parameters }`), otherwise a retried
 *   request would mint a different id and read as an IDEMPOTENCY_CONFLICT
 *   instead of a replay. Either way the returned `id` is what the entry must
 *   store (and what the grant binds).
 * - expiresAt: the entry's explicit request-level deadline (epoch ms or a
 *   parseable timestamp). When present it wins as the grant's own expiry, but
 *   the lifetime cap STILL participates in the minimum — a caller-facing
 *   request can only narrow the window, never widen it.
 * - authorizerExpiresAt: the expiry of the authorizing artifact when already
 *   known at admission time (a dispatch Approval's expiresAt, a goal grant's
 *   expiresAt). Fed into limits.approvalExpiresAt so it participates in the
 *   effective minimum; absent artifacts simply do not participate.
 * - maxLifetimeMs: the single-execution lifetime cap; defaults to
 *   DEFAULT_MAX_EXECUTION_LIFETIME_MS. Entries pass operator configuration
 *   here — never caller payload.
 * - The clock is read at most ONCE and that single reading is shared by the
 *   expiry derivation and the issuance (issueGrant receives it as a fixed
 *   clock), so the result is fully deterministic for a given reading.
 *
 * Returns the fields the entry spreads into store.createExecution input:
 * `{ id, grant, parametersDigest }`. All validation is issueGrant's own —
 * an unusable clock, an illegal expiresAt or an out-of-range derived window
 * throws GrantError BEFORE anything is persisted.
 */
export function issueGrantForAdmission({ taskId, executionId, owner, parametersDigest, scope, expiresAt, authorizerExpiresAt, maxLifetimeMs = DEFAULT_MAX_EXECUTION_LIFETIME_MS, now = Date.now, random, idSeed } = {}) {
  if (typeof maxLifetimeMs !== 'number' || !Number.isFinite(maxLifetimeMs) || maxLifetimeMs <= 0) {
    fail('grant-invalid', 'maxLifetimeMs must be a positive finite number (operator configuration, never caller payload)', 400)
  }
  const id = nonEmptyString(executionId)
    ? executionId
    : (idSeed !== undefined
      ? `execution_adm_${crypto.createHash('sha256').update(stable(idSeed)).digest('hex')}`
      : `execution_${crypto.randomUUID()}`)
  // One reading, shared: the expiry derivation and issueGrant see the SAME
  // instant, so issuedAt is exactly the reading the expiry was derived from.
  let reading
  const clock = () => (reading ??= readClock(now))
  const expiry = expiresAt ?? clock() + maxLifetimeMs
  const grant = issueGrant({
    taskId,
    executionId: id,
    owner,
    parametersDigest,
    scope,
    expiresAt: expiry,
    limits: { maxLifetimeMs, ...(authorizerExpiresAt === undefined ? {} : { approvalExpiresAt: authorizerExpiresAt }) },
    now: clock,
    ...(random === undefined ? {} : { random }),
  })
  return { id, grant, parametersDigest }
}
