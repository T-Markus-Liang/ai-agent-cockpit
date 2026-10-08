// Personal AI OS 0.3.0 M02/I03b — unified ContextAssembler (first slice, pure).
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
// It is fully offline: no network, no database, no credentials, no side effects,
// no runtime dependencies. It never mints authority and never touches storage.
//
// Contract — assembleContext(input) -> { blocks, meta }:
//   blocks: [{ kind: "persona"|"conversation"|"facts"|"request-link", text }]
//           at most one block per kind, ordered persona -> conversation ->
//           facts -> request-link. A kind with no content produces no block, so
//           an all-empty input yields blocks: [].
//   meta:   { truncated: string[], droppedTurns: number, summaryCount: number }
//
// Semantic rules:
//   1. Deterministic: identical input -> deeply equal output (no time/random).
//   2. Single summary: `summary` appears once, only inside the conversation
//      block; it is never guessed/copied out of `turns`.
//   3. Key-value retention: when turns exceed maxTurns the OLDEST are dropped
//      and the newest kept; a single turn longer than turnChars is tail-
//      truncated with the marker. Recent turns carry key values intact.
//   4. Bounded: persona/summary/fact text over their limits is tail-truncated
//      with the same marker and the section name is recorded in meta.truncated.
//   5. Validation: non-object input, a turns element missing role/text, or a
//      facts element missing text throws TypeError. null/undefined top-level
//      fields are treated as absent.

/** Marker appended when a section is tail-truncated. */
export const TRUNCATION_MARKER = "…[truncated]";

/** Default per-section bounds, aligned with the current bridge limits. */
export const DEFAULT_LIMITS = Object.freeze({
	personaChars: 12000,
	maxTurns: 20,
	turnChars: 4000,
	summaryChars: 6000,
	factChars: 2000,
});

const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMITS));

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

/**
 * Resolve limits against the defaults, validating shape and each bound.
 * Unknown keys are ignored so the contract can grow without breaking callers.
 */
function resolveLimits(limits) {
	const resolved = { ...DEFAULT_LIMITS };
	if (limits === undefined || limits === null) return resolved;
	if (!isPlainObject(limits)) throw new TypeError("context-assembler: limits must be an object when provided");
	for (const key of LIMIT_KEYS) {
		const value = limits[key];
		if (value === undefined || value === null) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new TypeError(`context-assembler: limits.${key} must be a positive number`);
		}
		resolved[key] = Math.floor(value);
	}
	return resolved;
}

/** Validate a turns array into a frozen [{role, text}] list. */
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

/**
 * Assemble the single-injection context. Pure and deterministic.
 * @param {object} [input]
 * @returns {{ blocks: Array<{kind: string, text: string}>, meta: {truncated: string[], droppedTurns: number, summaryCount: number} }}
 */
export function assembleContext(input = {}) {
	if (!isPlainObject(input)) throw new TypeError("context-assembler: input must be an object");

	const limits = resolveLimits(input.limits);
	const personaRaw = asOptionalString(input.persona, "persona");
	const summaryRaw = asOptionalString(input.summary, "summary");
	const linkId = asOptionalString(input.sourceRequestId, "sourceRequestId");
	const turns = normalizeTurns(input.turns);
	const facts = normalizeFacts(input.facts);

	const truncated = new Set();
	const meta = { truncated: [], droppedTurns: 0, summaryCount: 0 };
	const blocks = [];

	// --- persona ---------------------------------------------------------
	if (personaRaw) {
		const { text, truncated: cut } = truncateText(personaRaw, limits.personaChars);
		if (cut) truncated.add("persona");
		blocks.push({ kind: "persona", text });
	}

	// --- conversation (recent turns + single lossy excerpt) --------------
	{
		const kept = turns.length > limits.maxTurns ? turns.slice(turns.length - limits.maxTurns) : turns;
		meta.droppedTurns = turns.length - kept.length;

		const lines = [];
		const turnLines = [];
		for (const turn of kept) {
			const { text, truncated: cut } = truncateText(turn.text, limits.turnChars);
			if (cut) truncated.add("turn");
			turnLines.push(`${turn.role}: ${text}`);
		}
		const hasSummary = summaryRaw.length > 0;
		if (kept.length || hasSummary) {
			// Earlier excerpt comes BEFORE the recent turns, matching the current
			// buildLocalContext shape (memory.ts:263-267) so the future bridge
			// wiring keeps the exact same prompt layout.
			if (hasSummary) {
				const { text, truncated: cut } = truncateText(summaryRaw, limits.summaryChars);
				if (cut) truncated.add("summary");
				lines.push("Earlier excerpt (lossy, not a smart summary)");
				lines.push(text);
				meta.summaryCount = 1;
			}
			lines.push("[Local conversation history]");
			lines.push(...turnLines);
			blocks.push({ kind: "conversation", text: lines.join("\n") });
		}
	}

	// --- facts (sourced, terminal source preserved verbatim) -------------
	if (facts.length) {
		const factLines = facts.map((fact) => {
			const { text, truncated: cut } = truncateText(fact.text, limits.factChars);
			if (cut) truncated.add("fact");
			return fact.source ? `${text}（来源：${fact.source}）` : text;
		});
		blocks.push({ kind: "facts", text: factLines.join("\n") });
	}

	// --- request link ----------------------------------------------------
	if (linkId) {
		blocks.push({ kind: "request-link", text: `[可靠请求关联] sourceRequestId: ${linkId}` });
	}

	meta.truncated = [...truncated];
	return { blocks, meta };
}
