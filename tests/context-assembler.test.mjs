// Tests for runtime/context-assembler.mjs (M02/I03b first slice).
//
// Pure-module tests: no network, no DB, no credentials, no side effects. They
// pin the unified ContextAssembler contract — exactly one persona, one lossy
// excerpt and sourced facts, with bounded sections and deterministic output.

import { test } from "node:test";
import assert from "node:assert/strict";

import { assembleContext, DEFAULT_LIMITS, TRUNCATION_MARKER } from "../runtime/context-assembler.mjs";

const FULL_INPUT = {
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
	const conversation = blocks.find((block) => block.kind === "conversation");
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
	const { blocks, meta } = assembleContext({ turns });

	const conversation = blocks.find((block) => block.kind === "conversation");
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
});

test("source passthrough: fact source is preserved verbatim", () => {
	const { blocks, meta } = assembleContext({
		facts: [
			{ text: "用户希望被称为小柚", source: "user-msg-9" },
			{ text: "喜好乌龙茶", source: "" },
		],
	});
	const facts = blocks.find((block) => block.kind === "facts");
	assert.ok(facts.text.includes("用户希望被称为小柚（来源：user-msg-9）"));
	assert.ok(facts.text.includes("喜好乌龙茶"), "empty source omits parentheses");
	assert.ok(!facts.text.includes("喜好乌龙茶（来源"), "no empty-source parentheses");
	assert.equal(meta.summaryCount, 0);
});

test("bounded truncation: each over-limit section is marked and recorded", () => {
	const persona = "P".repeat(DEFAULT_LIMITS.personaChars + 50);
	const turn = "T".repeat(DEFAULT_LIMITS.turnChars + 50);
	const summary = "S".repeat(DEFAULT_LIMITS.summaryChars + 50);
	const fact = "F".repeat(DEFAULT_LIMITS.factChars + 50);
	const { blocks, meta } = assembleContext({
		persona,
		turns: [{ role: "user", text: turn }],
		summary,
		facts: [{ text: fact, source: "src-1" }],
	});

	const personaBlock = blocks.find((block) => block.kind === "persona");
	const conversation = blocks.find((block) => block.kind === "conversation");
	const facts = blocks.find((block) => block.kind === "facts");

	assert.ok(personaBlock.text.endsWith(TRUNCATION_MARKER));
	assert.ok(personaBlock.text.startsWith("P".repeat(32)));
	assert.ok(conversation.text.includes(`${"T".repeat(32)}`) && conversation.text.includes(TRUNCATION_MARKER));
	assert.ok(conversation.text.includes(`Earlier excerpt (lossy, not a smart summary)`));
	assert.ok(facts.text.endsWith(`（来源：src-1）`));

	assert.deepEqual(meta.truncated, ["persona", "turn", "summary", "fact"]);
});

test("empty and missing fields: all-empty yields no blocks", () => {
	const empty = assembleContext({});
	assert.deepEqual(empty.blocks, []);
	assert.deepEqual(empty.meta, { truncated: [], droppedTurns: 0, summaryCount: 0 });

	const noPersona = assembleContext({ turns: [{ role: "user", text: "hi" }] });
	assert.ok(!noPersona.blocks.some((block) => block.kind === "persona"));
	assert.ok(noPersona.blocks.some((block) => block.kind === "conversation"));

	const noFacts = assembleContext({ persona: "p", summary: "s" });
	assert.ok(!noFacts.blocks.some((block) => block.kind === "facts"));
	// summary alone still produces a conversation block with a single summary.
	assert.equal(noFacts.meta.summaryCount, 1);
});

test("request link: present only when sourceRequestId is non-empty", () => {
	const withLink = assembleContext({ sourceRequestId: "req-7" });
	const link = withLink.blocks.find((block) => block.kind === "request-link");
	assert.ok(link);
	assert.equal(link.text, "[可靠请求关联] sourceRequestId: req-7");

	const withoutLink = assembleContext({ turns: [{ role: "user", text: "hi" }] });
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
	assert.throws(() => assembleContext({ turns: "nope" }), TypeError);
	assert.throws(() => assembleContext({ turns: [{ role: "user" }] }), TypeError);
	assert.throws(() => assembleContext({ turns: [{ text: "hi" }] }), TypeError);
	assert.throws(() => assembleContext({ facts: "nope" }), TypeError);
	assert.throws(() => assembleContext({ facts: [{ source: "s" }] }), TypeError);
});
