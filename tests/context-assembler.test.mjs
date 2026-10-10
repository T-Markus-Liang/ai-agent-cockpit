// Tests for runtime/context-assembler.mjs (M02/I03b, r2 budget hardening).
//
// Pure-module tests: no network, no DB, no credentials, no side effects. They
// pin the unified ContextAssembler contract — exactly one persona, one lossy
// excerpt and sourced facts, with bounded sections, a hard global budget and
// deterministic output — plus the audit-reproduction NEGATIVE cases that prove
// the r1 unbounded-context path is now refused/bounded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
	assembleContext,
	DEFAULT_LIMITS,
	REQUIRED_LIMIT_KEYS,
	LIMIT_FLOORS,
	CUT_CLASSES,
	TRUNCATION_MARKER,
} from "../runtime/context-assembler.mjs";

/** Required limits every call must now supply (r2 contract). */
const LIMITS = { totalChars: 1_000_000, factsMaxCount: 100 };
const limitsOf = (over = {}) => ({ ...LIMITS, ...over });
const sha = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const mergedLength = (result) => result.blocks.map((block) => block.text).join("\n").length;
const blockOf = (result, kind) => result.blocks.find((block) => block.kind === kind);

const FULL_INPUT = {
	limits: LIMITS,
	persona: "You are a trusted assistant.",
	turns: [
		{ role: "user", text: "早上好" },
		{ role: "assistant", text: "早上好，需要我做什么？" },
		{ role: "user", text: "帮我看看日程" },
	],
	summary: "Earlier the user set up a weekly review.",
	facts: [{ text: "用户希望被称为小柚", source: "user-msg-1" }],
	sourceRequestId: "req-42",
};

test("full assembly: block order, kinds and one-per-kind", () => {
	const { blocks } = assembleContext(FULL_INPUT);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["persona", "conversation", "facts", "request-link"],
	);
	for (const kind of ["persona", "conversation", "facts", "request-link"]) {
		assert.equal(blocks.filter((block) => block.kind === kind).length, 1, `${kind} appears once`);
	}
	for (const block of blocks) assert.equal(typeof block.text, "string");
});

test("summary is injected once, only inside the conversation block", () => {
	const { blocks, meta } = assembleContext(FULL_INPUT);
	assert.equal(meta.summaryCount, 1);
	const conversation = blockOf({ blocks }, "conversation");
	const occurrences = conversation.text.split(FULL_INPUT.summary).length - 1;
	assert.equal(occurrences, 1, "summary text appears exactly once");
	// The lossy excerpt is emitted BEFORE the recent-turn history section,
	// matching the future bridge prompt layout (memory.ts buildLocalContext).
	const excerptAt = conversation.text.indexOf("Earlier excerpt (lossy, not a smart summary)");
	const historyAt = conversation.text.indexOf("[Local conversation history]");
	assert.ok(excerptAt >= 0 && historyAt >= 0, "both subsections present");
	assert.ok(excerptAt < historyAt, "excerpt comes before the local history section");
	// No other block repeats the summary.
	for (const block of blocks) {
		if (block.kind === "conversation") continue;
		assert.ok(!block.text.includes(FULL_INPUT.summary), `summary leaked into ${block.kind}`);
	}
});

test("key-value retention: oldest turns dropped, newest kept intact", () => {
	const turns = [];
	for (let i = 0; i < 22; i += 1) turns.push({ role: "user", text: `old turn #${String(i).padStart(2, "0")}` });
	turns.push({ role: "user", text: "最近我在找小柚，编号 8876 的客户" });
	const { blocks, meta } = assembleContext({ limits: LIMITS, turns });

	const conversation = blockOf({ blocks }, "conversation");
	// oldest three turns beyond the maxTurns default are dropped.
	assert.equal(meta.droppedTurns, 23 - DEFAULT_LIMITS.maxTurns);
	assert.equal(meta.droppedTurns, 3);
	assert.ok(!conversation.text.includes("old turn #00"), "oldest turn dropped");
	assert.ok(!conversation.text.includes("old turn #02"), "second-oldest turn dropped");
	// every kept turn remains intact inside the conversation block.
	const kept = turns.slice(-DEFAULT_LIMITS.maxTurns);
	for (const turn of kept) {
		assert.ok(conversation.text.includes(`${turn.role}: ${turn.text}`), `kept turn intact: ${turn.text}`);
	}
	assert.ok(conversation.text.includes("[Local conversation history]"), "history section present");
	const latest = turns[turns.length - 1].text;
	assert.ok(conversation.text.includes(latest), "latest turn kept whole");
	assert.ok(conversation.text.includes("小柚"), "key name preserved");
	assert.ok(conversation.text.includes("8876"), "key number preserved");
	// a generous budget must not force any extra drop: only the max-turns count.
	assert.equal(meta.budgetExceeded, false);
	assert.equal(meta.cutCounts.turn, 3);
});

test("source passthrough: fact source is preserved verbatim", () => {
	const { blocks, meta } = assembleContext({
		limits: LIMITS,
		facts: [
			{ text: "用户希望被称为小柚", source: "user-msg-9" },
			{ text: "喜好乌龙茶", source: "" },
		],
	});
	const facts = blockOf({ blocks }, "facts");
	assert.ok(facts.text.includes("用户希望被称为小柚（来源：user-msg-9）"));
	assert.ok(facts.text.includes("喜好乌龙茶"), "empty source omits parentheses");
	assert.ok(!facts.text.includes("喜好乌龙茶（来源"), "no empty-source parentheses");
	assert.equal(meta.summaryCount, 0);
	assert.deepEqual(meta.cuts, []);
});

test("bounded truncation: each over-limit section is marked and recorded", () => {
	const persona = "P".repeat(DEFAULT_LIMITS.personaChars + 50);
	const turn = "T".repeat(DEFAULT_LIMITS.turnChars + 50);
	const summary = "S".repeat(DEFAULT_LIMITS.summaryChars + 50);
	const fact = "F".repeat(DEFAULT_LIMITS.factChars + 50);
	const { blocks, meta } = assembleContext({
		limits: LIMITS,
		persona,
		turns: [{ role: "user", text: turn }],
		summary,
		facts: [{ text: fact, source: "src-1" }],
	});

	const personaBlock = blockOf({ blocks }, "persona");
	const conversation = blockOf({ blocks }, "conversation");
	const facts = blockOf({ blocks }, "facts");

	assert.ok(personaBlock.text.endsWith(TRUNCATION_MARKER));
	assert.ok(personaBlock.text.startsWith("P".repeat(32)));
	assert.ok(conversation.text.includes(`${"T".repeat(32)}`) && conversation.text.includes(TRUNCATION_MARKER));
	assert.ok(conversation.text.includes(`Earlier excerpt (lossy, not a smart summary)`));
	assert.ok(facts.text.endsWith(`（来源：src-1）`));

	assert.deepEqual(meta.truncated, ["persona", "turn", "summary", "fact"]);
	// the clipped entries are recorded with digests of the ORIGINAL bodies.
	assert.equal(meta.budgetExceeded, false);
	assert.equal(meta.cutCounts.persona, 1);
	assert.equal(meta.cutCounts.turn, 1);
	assert.equal(meta.cutCounts.summary, 1);
	assert.equal(meta.cutCounts.fact, 1);
	const byClass = Object.fromEntries(meta.cuts.map((cut) => [cut.kind, cut]));
	assert.equal(byClass.persona.digest, sha(persona));
	assert.equal(byClass.turn.digest, sha(turn));
	assert.equal(byClass.summary.digest, sha(summary));
	assert.equal(byClass.fact.digest, sha(fact));
});

test("empty and missing fields: all-empty yields no blocks", () => {
	const empty = assembleContext({ limits: LIMITS });
	assert.deepEqual(empty.blocks, []);
	assert.deepEqual(empty.meta, {
		truncated: [],
		droppedTurns: 0,
		summaryCount: 0,
		totalChars: LIMITS.totalChars,
		totalOutputChars: 0,
		budgetExceeded: false,
		cutCounts: { persona: 0, turn: 0, summary: 0, fact: 0, factSource: 0, role: 0, requestLink: 0 },
		cuts: [],
	});

	const noPersona = assembleContext({ limits: LIMITS, turns: [{ role: "user", text: "hi" }] });
	assert.ok(!noPersona.blocks.some((block) => block.kind === "persona"));
	assert.ok(noPersona.blocks.some((block) => block.kind === "conversation"));

	const noFacts = assembleContext({ limits: LIMITS, persona: "p", summary: "s" });
	assert.ok(!noFacts.blocks.some((block) => block.kind === "facts"));
	// summary alone still produces a conversation block with a single summary.
	assert.equal(noFacts.meta.summaryCount, 1);
});

test("request link: present only when sourceRequestId is non-empty", () => {
	const withLink = assembleContext({ limits: LIMITS, sourceRequestId: "req-7" });
	const link = blockOf(withLink, "request-link");
	assert.ok(link);
	assert.equal(link.text, "[可靠请求关联] sourceRequestId: req-7");

	const withoutLink = assembleContext({ limits: LIMITS, turns: [{ role: "user", text: "hi" }] });
	assert.ok(!withoutLink.blocks.some((block) => block.kind === "request-link"));
});

test("deterministic: identical input yields deeply equal output", () => {
	const first = assembleContext(FULL_INPUT);
	const second = assembleContext(FULL_INPUT);
	assert.deepEqual(first, second);
	assert.notEqual(first, second, "fresh objects each call");
	assert.deepEqual(JSON.stringify(first), JSON.stringify(second));
});

test("validation: invalid shapes throw TypeError", () => {
	assert.throws(() => assembleContext(null), TypeError);
	assert.throws(() => assembleContext("nope"), TypeError);
	assert.throws(() => assembleContext([]), TypeError);
	assert.throws(() => assembleContext({ limits: LIMITS, turns: "nope" }), TypeError);
	assert.throws(() => assembleContext({ limits: LIMITS, turns: [{ role: "user" }] }), TypeError);
	assert.throws(() => assembleContext({ limits: LIMITS, turns: [{ text: "hi" }] }), TypeError);
	assert.throws(() => assembleContext({ limits: LIMITS, facts: "nope" }), TypeError);
	assert.throws(() => assembleContext({ limits: LIMITS, facts: [{ source: "s" }] }), TypeError);
});

// ---------------------------------------------------------------------------
// r2 negative cases — the audit repro and the new budget contract.
// ---------------------------------------------------------------------------

/** The audit M02-CA-E001 repro fixture: 64 facts, 1024 text / 2048 source each. */
const AUDIT_FACTS = Array.from({ length: 64 }, (_, i) => {
	const text = `fact-${i}-` + "x".repeat(1024 - `fact-${i}-`.length);
	const source = `src-${i}-` + "s".repeat(2048 - `src-${i}-`.length);
	return { text, source };
});

test("audit repro M02-CA-E001: without the required budget it is refused (fail-closed)", () => {
	// r1 accepted this call and emitted 196991 chars with meta.truncated empty.
	assert.throws(() => assembleContext({ facts: AUDIT_FACTS }), TypeError);
	assert.throws(() => assembleContext({ facts: AUDIT_FACTS, limits: { factsMaxCount: 100 } }), TypeError);
	assert.throws(() => assembleContext({ facts: AUDIT_FACTS, limits: { totalChars: 20000 } }), TypeError);
});

test("audit repro M02-CA-E001: with a budget the merged output is bounded and truthfully recorded", () => {
	const totalChars = 20000;
	const { blocks, meta } = assembleContext({ facts: AUDIT_FACTS, limits: { totalChars, factsMaxCount: 1000 } });
	const factsBlock = blockOf({ blocks }, "facts");

	// the merged output can never exceed the budget.
	assert.ok(mergedLength({ blocks }) <= totalChars, "merged output within budget");
	assert.ok(factsBlock.text.length <= totalChars, "single facts block within budget");
	assert.equal(meta.totalOutputChars, mergedLength({ blocks }));
	assert.equal(meta.budgetExceeded, true);
	// fact text (1024) is below factChars, but each source (2048) exceeds its own
	// independent cap → recorded as factSource truncation, not silently kept.
	assert.ok(meta.truncated.includes("fact"));
	assert.ok(meta.truncated.includes("factSource"));
	assert.equal(meta.cutCounts.factSource, 64);

	// oldest facts dropped first; newest facts retained.
	assert.ok(!factsBlock.text.includes("fact-0-"), "oldest fact dropped");
	assert.ok(!factsBlock.text.includes("fact-1-"), "second-oldest fact dropped");
	assert.ok(factsBlock.text.includes("fact-63-"), "newest fact retained");
	const keptCount = factsBlock.text.split("\n").length;
	assert.equal(meta.cutCounts.fact, 64 - keptCount, "every dropped fact is counted exactly once");

	// dropped entries carry a digest + bounded source reference, never the body.
	const droppedFact = meta.cuts.find((cut) => cut.kind === "fact" && cut.reason === "budget" && cut.index === 0);
	assert.ok(droppedFact, "oldest dropped fact is recorded");
	assert.equal(droppedFact.action, "dropped");
	assert.equal(droppedFact.digest, sha(AUDIT_FACTS[0].text), "digest of the original body");
	assert.equal(droppedFact.source, AUDIT_FACTS[0].source.slice(0, DEFAULT_LIMITS.factSourceMaxChars) + TRUNCATION_MARKER);
	for (const cut of meta.cuts) {
		assert.ok(/^sha256:[0-9a-f]{64}$/.test(cut.digest), `${cut.kind} digest is sha256`);
		assert.ok(!("text" in cut), "no body text field on a cut record");
		for (const value of Object.values(cut)) {
			if (typeof value === "string") {
				// digest (71) and bounded source (≤ cap + marker) only — never 1024/2048 bodies.
				assert.ok(value.length <= DEFAULT_LIMITS.factSourceMaxChars + TRUNCATION_MARKER.length, "bounded reference, not a body");
			}
		}
	}
});

test("required limits: missing, non-finite, non-positive, non-integer and below-floor are refused", () => {
	// required keys
	assert.throws(() => assembleContext({}), TypeError);
	assert.throws(() => assembleContext({ limits: {} }), TypeError);
	assert.throws(() => assembleContext({ limits: { factsMaxCount: 5 } }), TypeError);
	assert.throws(() => assembleContext({ limits: { totalChars: 5 } }), TypeError);
	// not a positive finite integer
	for (const value of [0, -1, NaN, Infinity, -Infinity, 10.5, "100", true]) {
		assert.throws(() => assembleContext({ limits: { totalChars: value, factsMaxCount: 5 } }), TypeError, `totalChars=${value}`);
	}
	// below the floor: a fractional value would floor to 0 and must be refused
	assert.throws(() => assembleContext({ limits: { totalChars: 100, factsMaxCount: 0 } }), TypeError);
	assert.throws(() => assembleContext({ limits: { totalChars: 100, factsMaxCount: 0.5 } }), TypeError);
	assert.throws(() => assembleContext({ limits: { totalChars: 100, factsMaxCount: undefined } }), TypeError);
	// floors / required keys are exported for callers to derive budgets.
	assert.deepEqual([...REQUIRED_LIMIT_KEYS], ["totalChars", "factsMaxCount"]);
	for (const key of REQUIRED_LIMIT_KEYS) assert.equal(LIMIT_FLOORS[key], 1);
});

test("factsMaxCount: oldest-over-cap are dropped, boundary is exact, floor is enforced", () => {
	const facts = [
		{ text: "f0", source: "s0" },
		{ text: "f1", source: "s1" },
		{ text: "f2", source: "s2" },
	];

	const exact = assembleContext({ limits: limitsOf({ factsMaxCount: 3 }), facts });
	assert.equal(exact.meta.cutCounts.fact, 0, "exactly the cap drops nothing");
	assert.ok(blockOf(exact, "facts").text.includes("f0"));

	const over = assembleContext({ limits: limitsOf({ factsMaxCount: 2 }), facts });
	assert.ok(!blockOf(over, "facts").text.includes("f0"), "oldest fact dropped");
	assert.ok(blockOf(over, "facts").text.includes("f1") && blockOf(over, "facts").text.includes("f2"));
	assert.equal(over.meta.cutCounts.fact, 1);
	const cut = over.meta.cuts.find((entry) => entry.kind === "fact");
	assert.equal(cut.reason, "facts-max-count");
	assert.equal(cut.index, 0);
	assert.equal(cut.source, "s0");
	assert.equal(cut.digest, sha("f0"));
	assert.equal(over.meta.budgetExceeded, false, "a count cap is not a budget event");

	const one = assembleContext({ limits: limitsOf({ factsMaxCount: 1 }), facts });
	assert.equal(one.meta.cutCounts.fact, 2);
	assert.ok(blockOf(one, "facts").text.includes("f2") && !blockOf(one, "facts").text.includes("f0"));
});

test("factSourceMaxChars: an independent source cap bounds oversized sources", () => {
	const source = "S".repeat(100);
	const under = assembleContext({ limits: limitsOf({ factSourceMaxChars: 200 }), facts: [{ text: "t", source }] });
	assert.equal(under.meta.cutCounts.factSource, 0);
	assert.ok(blockOf(under, "facts").text.includes(`（来源：${source}）`));

	const over = assembleContext({ limits: limitsOf({ factSourceMaxChars: 10 }), facts: [{ text: "t", source }] });
	const bounded = source.slice(0, 10) + TRUNCATION_MARKER;
	assert.ok(blockOf(over, "facts").text.includes(`（来源：${bounded}）`));
	assert.ok(over.meta.truncated.includes("factSource"));
	assert.equal(over.meta.cutCounts.factSource, 1);
	assert.equal(over.meta.cuts.find((cut) => cut.kind === "factSource").digest, sha(source));

	assert.throws(() => assembleContext({ limits: limitsOf({ factSourceMaxChars: 0 }), facts: [{ text: "t", source }] }), TypeError);
	assert.throws(() => assembleContext({ limits: limitsOf({ factSourceMaxChars: 0.5 }), facts: [{ text: "t", source }] }), TypeError);
});

test("role and request-link length caps are independent and enforced", () => {
	const roleTurn = assembleContext({ limits: limitsOf({ roleChars: 5 }), turns: [{ role: "roleeeeeee", text: "hi" }] });
	assert.ok(blockOf(roleTurn, "conversation").text.includes(`${"roleeeeeee".slice(0, 5)}${TRUNCATION_MARKER}: hi`));
	assert.ok(roleTurn.meta.truncated.includes("role"));
	assert.equal(roleTurn.meta.cuts.find((cut) => cut.kind === "role").digest, sha("roleeeeeee"));

	const longId = "L".repeat(1000);
	const link = assembleContext({ limits: limitsOf({ requestLinkChars: 20 }), sourceRequestId: longId });
	const linkBlock = blockOf(link, "request-link");
	const rendered = `[可靠请求关联] sourceRequestId: ${longId}`;
	assert.equal(linkBlock.text, rendered.slice(0, 20) + TRUNCATION_MARKER);
	assert.ok(linkBlock.text.length <= 20 + TRUNCATION_MARKER.length, "link block bounded by its cap");
	assert.ok(link.meta.truncated.includes("requestLink"));
	assert.equal(link.meta.cuts.find((cut) => cut.kind === "requestLink").digest, sha(longId));

	assert.throws(() => assembleContext({ limits: limitsOf({ roleChars: 0 }), turns: [{ role: "r", text: "t" }] }), TypeError);
	assert.throws(() => assembleContext({ limits: limitsOf({ requestLinkChars: 0 }), sourceRequestId: "x" }), TypeError);
});

const PRIORITY_INPUT = {
	persona: "PERSONA-BODY",
	summary: "SUMMARY-BODY",
	sourceRequestId: "LINK-BODY",
	turns: [
		{ role: "user", text: "TURN-ONE" },
		{ role: "user", text: "TURN-TWO" },
	],
	facts: [
		{ text: "FACT-ONE", source: "src-1" },
		{ text: "FACT-TWO", source: "src-2" },
	],
};

/** Measure a variant's merged length with a budget that never bites. */
const measured = (over) => mergedLength(assembleContext({ ...PRIORITY_INPUT, ...over, limits: LIMITS }));

test("reduction priority: oldest turn first, then oldest fact, then summary, link, persona", () => {
	// Each variant's length is the exact post-drop length the reducer must reach
	// to stop, because the variant removes precisely the units the reducer drops
	// first (turns -> facts -> summary -> request-link -> persona).
	const afterTurns = measured({ turns: [] });
	const afterFacts = measured({ turns: [], facts: [] });
	const afterSummary = measured({ turns: [], facts: [], summary: null });
	const afterLink = measured({ turns: [], facts: [], summary: null, sourceRequestId: null });

	// budget that only fits "everything but the turns" → both turns dropped, rest kept.
	const rTurn = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: afterTurns }) });
	assert.equal(rTurn.meta.budgetExceeded, true);
	assert.ok(!blockOf(rTurn, "conversation").text.includes("TURN-ONE"));
	assert.ok(!blockOf(rTurn, "conversation").text.includes("TURN-TWO"));
	assert.ok(blockOf(rTurn, "facts").text.includes("FACT-ONE") && blockOf(rTurn, "facts").text.includes("FACT-TWO"));
	assert.ok(blockOf(rTurn, "persona") && blockOf(rTurn, "conversation").text.includes("SUMMARY-BODY") && blockOf(rTurn, "request-link"));

	// turns are sacrificed before facts.
	const rFact = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: afterFacts }) });
	assert.ok(!blockOf(rFact, "facts"), "facts dropped after turns");
	assert.ok(blockOf(rFact, "persona") && blockOf(rFact, "conversation").text.includes("SUMMARY-BODY") && blockOf(rFact, "request-link"));
	assert.equal(rFact.meta.cutCounts.turn, 2);
	assert.equal(rFact.meta.cutCounts.fact, 2);

	// facts are sacrificed before the summary excerpt.
	const rSummary = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: afterSummary }) });
	assert.ok(!blockOf(rSummary, "conversation") || !blockOf(rSummary, "conversation").text.includes("SUMMARY-BODY"));
	assert.ok(blockOf(rSummary, "persona") && blockOf(rSummary, "request-link"));
	assert.equal(rSummary.meta.cutCounts.summary, 1);

	// after the summary, the request-link goes before the persona (kept last).
	const rLink = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: afterLink }) });
	assert.deepEqual(rLink.blocks.map((block) => block.kind), ["persona"]);
	assert.ok(rLink.meta.truncated.includes("requestLink"));
	assert.ok(rLink.meta.cuts.some((cut) => cut.kind === "requestLink" && cut.reason === "budget"));
	assert.ok(!rLink.meta.cuts.some((cut) => cut.kind === "persona"), "persona survives a link-level budget");

	// a budget below even the persona drops everything, never exceeding the cap.
	const rEmpty = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: 1 }) });
	assert.deepEqual(rEmpty.blocks, []);
	assert.equal(rEmpty.meta.totalOutputChars, 0);
	assert.ok(rEmpty.meta.cuts.some((cut) => cut.kind === "persona" && cut.reason === "budget"));
});

test("reduction order is stable: oldest-first and deterministic across calls", () => {
	const all = assembleContext({ ...PRIORITY_INPUT, limits: LIMITS });
	const fullLen = mergedLength(all);

	// one char below capacity → exactly the OLDEST turn is sacrificed.
	const trimmed = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: fullLen - 1 }) });
	assert.ok(!blockOf(trimmed, "conversation").text.includes("TURN-ONE"), "oldest turn dropped");
	assert.ok(blockOf(trimmed, "conversation").text.includes("TURN-TWO"), "newer turn kept");
	const dropped = trimmed.meta.cuts.find((cut) => cut.kind === "turn" && cut.reason === "budget");
	assert.equal(dropped.index, 0);

	const again = assembleContext({ ...PRIORITY_INPUT, limits: limitsOf({ totalChars: fullLen - 1 }) });
	assert.deepEqual(trimmed, again, "identical input + budget → identical output");
	assert.deepEqual(trimmed.meta.cuts, again.meta.cuts, "cut order is stable");
});

test("no silent field loss: input is not mutated and in-budget input keeps all fields", () => {
	const input = {
		limits: LIMITS,
		persona: "p",
		summary: "s",
		sourceRequestId: "req-1",
		turns: [{ role: "user", text: "hello" }],
		facts: [{ text: "f", source: "src" }],
	};
	const snapshot = JSON.stringify(input);
	const { blocks, meta } = assembleContext(input);

	assert.equal(JSON.stringify(input), snapshot, "input object untouched");
	assert.deepEqual(blocks.map((block) => block.kind), ["persona", "conversation", "facts", "request-link"]);
	assert.equal(meta.budgetExceeded, false);
	assert.deepEqual(meta.cuts, []);
	assert.deepEqual(meta.cutCounts, { persona: 0, turn: 0, summary: 0, fact: 0, factSource: 0, role: 0, requestLink: 0 });
	assert.deepEqual(meta.truncated, []);
	// exported class order is the canonical order used by meta.truncated.
	assert.deepEqual([...CUT_CLASSES], ["persona", "turn", "summary", "fact", "factSource", "role", "requestLink"]);
});
