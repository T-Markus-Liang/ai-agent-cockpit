// Personal AI OS 0.3.0 M02/I03b — unified ContextAssembler (r2, budget-hardened).
//
// Design intent (docs/plans/0.3.0-upgrade.md:129): a unified ContextAssembler
// injects EXACTLY ONE persona, recent conversation/compaction and sourced facts,
// and must NOT repeatedly stack a legacy summary on top of a Pi summary.
//
// Shape reference (read-only, NOT modified):
//   - vendor/wechat-acp/src/bridge.ts:916-931 — enrichPromptWithMemory assembly
//     order: persona -> memory context -> sourceRequestId association.
//   - vendor/wechat-acp/src/storage/memory.ts:222-271 — recent turns + lossy
//     earlier excerpt + (Mem0) facts composition, with a single summary slot.
//
// NOT WIRED IN THIS SLICE: this module performs pure assembly only. It is not
// called by the bridge or the runtime adapter yet; that wiring is a later slice.
// It is fully offline: no network, no database, no credentials, no side effects.
// Its only import is the Node builtin `node:crypto` (exactly as
// runtime/contracts.mjs does) for provenance digests — no external dependency.
// It never mints authority and never touches storage.
//
// r2 hardening — responds to audit docs/audits/m02-context-assembler-r1.md
// (M02-CA-E001, 高 / 接线阻断): r1 bounded only each section text, so the MERGED
// output was still unbounded. The audit reproduced 64 facts x (1024 text /
// 2048 source) -> 196991 chars with meta.truncated empty. r2 adds a hard,
// fail-closed global budget plus independent per-field caps so no single field
// can bypass the total:
//   - limits.totalChars        REQUIRED positive integer. The merged output of
//     ALL blocks (joined by "\n") may never exceed it. On overflow the assembly
//     is reduced by a fixed sacrifice order and every reduction is recorded.
//   - limits.factsMaxCount     REQUIRED positive integer. Hard cap on the number
//     of facts kept; the OLDEST are dropped first (mirrors the turns rule).
//   - limits.factSourceMaxChars / roleChars / requestLinkChars: independent
//     per-field caps so a huge source/role/link cannot bypass the budget as
//     "metadata".
//   Every limit has a documented FLOOR; a value below its floor — including a
//   fractional value that would floor to 0 — is REFUSED, never silently zeroed.
//   Dropped/clipped entries are reported in `meta` truthfully as counts plus the
//   entry's digest and source reference — never the body text.
//
// Contract — assembleContext(input) -> { blocks, meta }:
//   blocks: [{ kind: "persona"|"conversation"|"facts"|"request-link", text }]
//           at most one block per kind, ordered persona -> conversation ->
//           facts -> request-link. A kind with no content produces no block, so
//           an all-empty input (with valid limits) yields blocks: [].
//   meta:   { truncated: string[], droppedTurns: number, summaryCount: number,
//             totalChars: number, totalOutputChars: number, budgetExceeded: boolean,
//             cutCounts: {<class>: number}, cuts: Array<{kind, action, reason, ...}> }
//
// Semantic rules:
//   1. Deterministic: identical input -> deeply equal output (no time/random).
//   2. Single summary: `summary` appears once, only inside the conversation
//      block; it is never guessed/copied out of `turns`.
//   3. Key-value retention: when turns exceed maxTurns the OLDEST are dropped
//      and the newest kept; a single turn longer than turnChars is tail-
//      truncated with the marker. Recent turns carry key values intact.
//   4. Bounded: persona/summary/fact/source/role/link text over their limits is
//      tail-truncated with the same marker and the section class is recorded in
//      meta.truncated. The merged output is additionally bounded by totalChars.
//   5. Reduction priority when over totalChars (first sacrificed -> last kept):
//      oldest turn, oldest fact, the lossy summary excerpt, request-link,
//      persona. Every dropped entry is recorded in meta.cuts.
//   6. Validation is fail-closed: non-object input, a missing/invalid required
//      limit, a limit below its floor, a turns element missing role/text, or a
//      facts element missing text throws TypeError. null/undefined top-level
//      fields are treated as absent.

import { createHash } from "node:crypto";

/** Marker appended when a section is tail-truncated. */
export const TRUNCATION_MARKER = "…[truncated]";

/**
 * Default per-section bounds (aligned with the current bridge limits). These
 * keyed limits are OPTIONAL — the two REQUIRED limits below have no default.
 */
export const DEFAULT_LIMITS = Object.freeze({
	personaChars: 12000,
	maxTurns: 20,
	turnChars: 4000,
	summaryChars: 6000,
	factChars: 2000,
	factSourceMaxChars: 512,
	roleChars: 64,
	requestLinkChars: 512,
});

/** Limits the caller MUST supply: the global budget and the facts count cap. */
export const REQUIRED_LIMIT_KEYS = Object.freeze(["totalChars", "factsMaxCount"]);

/**
 * Smallest accepted value per limit. A supplied value that is not a finite
 * integer >= its floor is refused (fail-closed) instead of being floored to a
 * smaller value — in particular a fractional value like 0.5 must NOT silently
 * become 0.
 */
export const LIMIT_FLOORS = Object.freeze({
	totalChars: 1,
	factsMaxCount: 1,
	personaChars: 1,
	maxTurns: 1,
	turnChars: 1,
	summaryChars: 1,
	factChars: 1,
	factSourceMaxChars: 1,
	roleChars: 1,
	requestLinkChars: 1,
});

/** Canonical class order for meta.truncated / meta.cutCounts. */
export const CUT_CLASSES = Object.freeze(["persona", "turn", "summary", "fact", "factSource", "role", "requestLink"]);

/**
 * Sacrifice order for the global budget: the first-listed segment is dropped
 * first. turns (oldest first) and facts (oldest first) are bulk recall and go
 * first; the lossy summary excerpt is expendable by construction; the persona
 * (the module's single-injection headline) is kept until last.
 */
const SEGMENT_SACRIFICE_ORDER = Object.freeze(["summary", "requestLink", "persona"]);

/** True for a non-null, non-array, plain-ish object. */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a section string: null/undefined -> "", non-string -> TypeError. */
function asOptionalString(value, label) {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new TypeError(`context-assembler: ${label} must be a string when provided`);
	return value;
}

/** SHA-256 provenance digest of a string; never the body itself. */
function digestOf(text) {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Resolve limits against the defaults, validating shape, required keys and each
 * bound (finite integer >= floor). Unknown keys are ignored so the contract can
 * grow without breaking callers; the required keys can NOT be defaulted.
 */
function resolveLimits(limits) {
	if (!isPlainObject(limits)) {
		throw new TypeError("context-assembler: limits is required and must be an object");
	}
	const resolved = { ...DEFAULT_LIMITS };
	for (const key of Object.keys(LIMIT_FLOORS)) {
		const value = limits[key];
		if (value === undefined || value === null) {
			if (REQUIRED_LIMIT_KEYS.includes(key)) {
				throw new TypeError(`context-assembler: limits.${key} is required`);
			}
			continue;
		}
		const floor = LIMIT_FLOORS[key];
		if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < floor) {
			throw new TypeError(`context-assembler: limits.${key} must be an integer >= ${floor}`);
		}
		resolved[key] = value;
	}
	return resolved;
}

/** Validate a turns array into a [{role, text}] list. */
function normalizeTurns(turns) {
	if (turns === undefined || turns === null) return [];
	if (!Array.isArray(turns)) throw new TypeError("context-assembler: turns must be an array when provided");
	return turns.map((turn, index) => {
		if (!isPlainObject(turn)) throw new TypeError(`context-assembler: turns[${index}] must be an object`);
		if (typeof turn.role !== "string") throw new TypeError(`context-assembler: turns[${index}].role must be a string`);
		if (typeof turn.text !== "string") throw new TypeError(`context-assembler: turns[${index}].text must be a string`);
		return { role: turn.role, text: turn.text };
	});
}

/** Validate a facts array into a [{text, source}] list; source defaults to "". */
function normalizeFacts(facts) {
	if (facts === undefined || facts === null) return [];
	if (!Array.isArray(facts)) throw new TypeError("context-assembler: facts must be an array when provided");
	return facts.map((fact, index) => {
		if (!isPlainObject(fact)) throw new TypeError(`context-assembler: facts[${index}] must be an object`);
		if (typeof fact.text !== "string") throw new TypeError(`context-assembler: facts[${index}].text must be a string`);
		const source = fact.source === undefined || fact.source === null ? "" : fact.source;
		if (typeof source !== "string") throw new TypeError(`context-assembler: facts[${index}].source must be a string when provided`);
		return { text: fact.text, source };
	});
}

/** Tail-truncate `text` to `limit` code units, appending the marker if cut. */
function truncateText(text, limit) {
	if (text.length <= limit) return { text, truncated: false };
	return { text: text.slice(0, limit) + TRUNCATION_MARKER, truncated: true };
}

/** Render one fact line, preserving a non-empty source verbatim. */
function renderFactLine(fact) {
	return fact.source ? `${fact.text}（来源：${fact.source}）` : fact.text;
}

/**
 * Build the ordered blocks for the current reduction state. This reproduces the
 * r1 block shape exactly when nothing is reduced.
 */
function renderBlocks(state) {
	const blocks = [];
	if (state.personaText !== null) blocks.push({ kind: "persona", text: state.personaText });
	if (state.summaryText !== null || state.turns.length) {
		const lines = [];
		if (state.summaryText !== null) {
			lines.push("Earlier excerpt (lossy, not a smart summary)");
			lines.push(state.summaryText);
		}
		lines.push("[Local conversation history]");
		for (const turn of state.turns) lines.push(`${turn.role}: ${turn.text}`);
		blocks.push({ kind: "conversation", text: lines.join("\n") });
	}
	if (state.facts.length) {
		blocks.push({ kind: "facts", text: state.facts.map(renderFactLine).join("\n") });
	}
	if (state.linkText !== null) blocks.push({ kind: "request-link", text: state.linkText });
	return blocks;
}

/** Length of the merged output: all block texts joined by a single "\n". */
function mergedLength(blocks) {
	let length = 0;
	for (const block of blocks) length += block.text.length;
	return length + Math.max(0, blocks.length - 1);
}

/**
 * Assemble the single-injection context. Pure and deterministic.
 * @param {object} [input]
 * @returns {{ blocks: Array<{kind: string, text: string}>, meta: object }}
 */
export function assembleContext(input = {}) {
	if (!isPlainObject(input)) throw new TypeError("context-assembler: input must be an object");

	const limits = resolveLimits(input.limits);
	const personaRaw = asOptionalString(input.persona, "persona");
	const summaryRaw = asOptionalString(input.summary, "summary");
	const linkId = asOptionalString(input.sourceRequestId, "sourceRequestId");
	const turns = normalizeTurns(input.turns);
	const facts = normalizeFacts(input.facts);

	const affected = new Set();
	const cuts = [];
	const record = (entry) => {
		affected.add(entry.kind);
		cuts.push(entry);
	};

	// --- prepare persona -------------------------------------------------
	let personaText = null;
	if (personaRaw) {
		const { text, truncated } = truncateText(personaRaw, limits.personaChars);
		personaText = text;
		if (truncated) record({ kind: "persona", action: "truncated", reason: "limit", digest: digestOf(personaRaw) });
	}

	// --- prepare turns (independent role + text caps) --------------------
	const preparedTurns = turns.map((turn, index) => {
		const role = truncateText(turn.role, limits.roleChars);
		if (role.truncated) record({ kind: "role", action: "truncated", reason: "limit", index, digest: digestOf(turn.role) });
		const text = truncateText(turn.text, limits.turnChars);
		if (text.truncated) record({ kind: "turn", action: "truncated", reason: "limit", index, role: role.text, digest: digestOf(turn.text) });
		return { index, role: role.text, text: text.text };
	});

	// --- prepare summary -------------------------------------------------
	let summaryText = null;
	if (summaryRaw) {
		const { text, truncated } = truncateText(summaryRaw, limits.summaryChars);
		summaryText = text;
		if (truncated) record({ kind: "summary", action: "truncated", reason: "limit", digest: digestOf(summaryRaw) });
	}

	// --- prepare facts (independent text + source caps) ------------------
	const preparedFacts = facts.map((fact, index) => {
		const source = truncateText(fact.source, limits.factSourceMaxChars);
		if (source.truncated) record({ kind: "factSource", action: "truncated", reason: "limit", index, digest: digestOf(fact.source) });
		const text = truncateText(fact.text, limits.factChars);
		if (text.truncated) record({ kind: "fact", action: "truncated", reason: "limit", index, source: source.text, digest: digestOf(fact.text) });
		return { index, text: text.text, source: source.text };
	});

	// --- prepare request link --------------------------------------------
	let linkText = null;
	if (linkId) {
		const rendered = `[可靠请求关联] sourceRequestId: ${linkId}`;
		const { text, truncated } = truncateText(rendered, limits.requestLinkChars);
		linkText = text;
		if (truncated) record({ kind: "requestLink", action: "truncated", reason: "limit", digest: digestOf(linkId) });
	}

	// --- count caps: oldest dropped first (mirrors the turns rule) -------
	const maxTurnsDropped = preparedTurns.length > limits.maxTurns ? preparedTurns.length - limits.maxTurns : 0;
	const activeTurns = preparedTurns.slice(maxTurnsDropped);
	for (const turn of preparedTurns.slice(0, maxTurnsDropped)) {
		record({ kind: "turn", action: "dropped", reason: "max-turns", index: turn.index, role: turn.role, digest: digestOf(turns[turn.index].text) });
	}

	const factsCountDropped = preparedFacts.length > limits.factsMaxCount ? preparedFacts.length - limits.factsMaxCount : 0;
	const activeFacts = preparedFacts.slice(factsCountDropped);
	for (const fact of preparedFacts.slice(0, factsCountDropped)) {
		record({ kind: "fact", action: "dropped", reason: "facts-max-count", index: fact.index, source: fact.source, digest: digestOf(facts[fact.index].text) });
	}

	// --- global budget reduction (fail-closed on the merged output) ------
	const state = { personaText, turns: activeTurns.slice(), summaryText, facts: activeFacts.slice(), linkText };
	let budgetDroppedTurns = 0;
	let budgetExceeded = false;

	if (mergedLength(renderBlocks(state)) > limits.totalChars) {
		budgetExceeded = true;
		// Stage 1 — drop OLDEST turns first (existing semantics, extended).
		while (state.turns.length && mergedLength(renderBlocks(state)) > limits.totalChars) {
			const turn = state.turns.shift();
			budgetDroppedTurns += 1;
			record({ kind: "turn", action: "dropped", reason: "budget", index: turn.index, role: turn.role, digest: digestOf(turns[turn.index].text) });
		}
		// Stage 2 — then drop OLDEST facts.
		while (state.facts.length && mergedLength(renderBlocks(state)) > limits.totalChars) {
			const fact = state.facts.shift();
			record({ kind: "fact", action: "dropped", reason: "budget", index: fact.index, source: fact.source, digest: digestOf(facts[fact.index].text) });
		}
		// Stage 3 — then sacrifice whole segments in the fixed order.
		for (const segment of SEGMENT_SACRIFICE_ORDER) {
			if (mergedLength(renderBlocks(state)) <= limits.totalChars) break;
			if (segment === "summary" && state.summaryText !== null) {
				record({ kind: "summary", action: "dropped", reason: "budget", digest: digestOf(summaryRaw) });
				state.summaryText = null;
			} else if (segment === "requestLink" && state.linkText !== null) {
				record({ kind: "requestLink", action: "dropped", reason: "budget", digest: digestOf(linkId) });
				state.linkText = null;
			} else if (segment === "persona" && state.personaText !== null) {
				record({ kind: "persona", action: "dropped", reason: "budget", digest: digestOf(personaRaw) });
				state.personaText = null;
			}
		}
	}

	const blocks = renderBlocks(state);

	const cutCounts = {};
	for (const kind of CUT_CLASSES) cutCounts[kind] = 0;
	for (const entry of cuts) cutCounts[entry.kind] += 1;

	const meta = {
		truncated: CUT_CLASSES.filter((kind) => affected.has(kind)),
		droppedTurns: maxTurnsDropped + budgetDroppedTurns,
		summaryCount: state.summaryText !== null ? 1 : 0,
		totalChars: limits.totalChars,
		totalOutputChars: mergedLength(blocks),
		budgetExceeded,
		cutCounts,
		cuts,
	};

	return { blocks, meta };
}
