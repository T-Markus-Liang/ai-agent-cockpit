// Tests for runtime/provider-resolver.mjs (M02/I03b second slice).
//
// Pure-module tests: no network, no file reads, no credentials, no side
// effects. They pin the V38 resolver contract — fail-closed reference
// resolution, at most one lookup per resolve (no retry storm), no global
// config mutation, and credential hygiene (errors name references only).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createProviderResolver, ProviderResolutionError } from "../runtime/provider-resolver.mjs";

// A fake secret used to prove no error path ever leaks a credential value.
const FAKE_SECRET = "sk-TEST-DO-NOT-LEAK-0123456789abcdef";

const REGISTRY = {
	"openai/gpt-4o": { provider: "openai", modelId: "gpt-4o", baseUrl: "https://api.openai.com/v1", credentialRef: "openai.apiKey" },
	"local/llama": { provider: "local", modelId: "llama", baseUrl: "https://127.0.0.1/v1" },
	"kimi/kimi-k2": { provider: "kimi", modelId: "kimi-k2", credentialRef: "kimi.token" },
};

/** Build a resolver with a lookup that records every call. */
function withLookup(impl, registry = REGISTRY) {
	const calls = [];
	const resolver = createProviderResolver({
		registry,
		lookup: async (ref) => {
			calls.push(ref);
			return impl(ref);
		},
	});
	return { resolver, calls };
}

test("resolves a registered entry and passes provider/modelId/baseUrl through", async () => {
	const { resolver, calls } = withLookup(() => FAKE_SECRET);
	const result = await resolver.resolve("openai/gpt-4o");
	assert.equal(result.provider, "openai");
	assert.equal(result.modelId, "gpt-4o");
	assert.equal(result.baseUrl, "https://api.openai.com/v1");
	assert.equal(result.credential, FAKE_SECRET);
	assert.equal(calls.length, 1);
});

test("entry without credentialRef resolves with no credential and zero lookups", async () => {
	const { resolver, calls } = withLookup(() => FAKE_SECRET);
	const result = await resolver.resolve("local/llama");
	assert.deepEqual(result, { provider: "local", modelId: "llama", baseUrl: "https://127.0.0.1/v1" });
	assert.ok(!("credential" in result), "no credential field");
	assert.equal(calls.length, 0, "lookup never called");
});

test("unregistered modelRef throws unresolved-model with zero lookups", async () => {
	const { resolver, calls } = withLookup(() => FAKE_SECRET);
	await assert.rejects(
		() => resolver.resolve("acme/nonexistent"),
		(error) => {
			assert.ok(error instanceof ProviderResolutionError);
			assert.equal(error.code, "unresolved-model");
			assert.match(error.message, /acme\/nonexistent/);
			return true;
		},
	);
	assert.equal(calls.length, 0, "lookup never called for an unregistered model");

	// A non-string reference is also unresolved, and still never touches lookup.
	await assert.rejects(() => resolver.resolve(undefined), (error) => error.code === "unresolved-model");
	assert.equal(calls.length, 0);
});

test("credentialRef calls lookup exactly once and passes the value through", async () => {
	const { resolver, calls } = withLookup(() => FAKE_SECRET);
	const result = await resolver.resolve("kimi/kimi-k2");
	assert.equal(result.credential, FAKE_SECRET);
	assert.deepEqual(calls, ["kimi.token"], "lookup called once with the reference name");
});

test("aliases to the same provider/modelId resolve independently, credentials never cross over", async () => {
	// Multi-account scenario: two reference names, one model, distinct creds.
	const WORK_TOKEN = "sk-work-token";
	const PERSONAL_TOKEN = "sk-personal-token";
	const registry = {
		"kimi/work": { provider: "kimi", modelId: "kimi-k3", credentialRef: "kimi.work" },
		"kimi/personal": { provider: "kimi", modelId: "kimi-k3", credentialRef: "kimi.personal" },
	};
	const tokens = { "kimi.work": WORK_TOKEN, "kimi.personal": PERSONAL_TOKEN };
	const calls = [];
	const resolver = createProviderResolver({
		registry,
		lookup: async (ref) => {
			calls.push(ref);
			return tokens[ref];
		},
	});

	const work = await resolver.resolve("kimi/work");
	const personal = await resolver.resolve("kimi/personal");
	assert.deepEqual({ provider: work.provider, modelId: work.modelId }, { provider: "kimi", modelId: "kimi-k3" });
	assert.deepEqual({ provider: personal.provider, modelId: personal.modelId }, { provider: "kimi", modelId: "kimi-k3" });
	assert.equal(work.credential, WORK_TOKEN, "alias keeps its own credential");
	assert.equal(personal.credential, PERSONAL_TOKEN, "sibling alias keeps its own credential");
	assert.notEqual(work.credential, personal.credential, "no credential crossover");
	assert.deepEqual(calls, ["kimi.work", "kimi.personal"], "each resolve looked up its own reference exactly once");
});

test("empty credential result throws unresolved-credential with no retry", async () => {
	for (const empty of [undefined, "", null]) {
		const { resolver, calls } = withLookup(() => empty);
		await assert.rejects(
			() => resolver.resolve("openai/gpt-4o"),
			(error) => {
				assert.equal(error.code, "unresolved-credential");
				assert.match(error.message, /openai\.apiKey/);
				return true;
			},
		);
		assert.equal(calls.length, 1, "lookup called exactly once — no retry storm");
	}
});

test("throwing lookup is wrapped as credential-lookup-failed without the raw message", async () => {
	const { resolver, calls } = withLookup(() => {
		throw new Error(`token /Users/private/.dsh/.credentials.yaml contained ${FAKE_SECRET}`);
	});
	await assert.rejects(
		() => resolver.resolve("openai/gpt-4o"),
		(error) => {
			assert.ok(error instanceof ProviderResolutionError);
			assert.equal(error.code, "credential-lookup-failed");
			// The raw error message (which embeds a secret and a private path) is dropped.
			assert.ok(!error.message.includes(FAKE_SECRET), "raw secret must not leak");
			assert.ok(!/credentials\.yaml/.test(error.message), "raw path must not leak");
			assert.match(error.message, /openai\.apiKey/, "reference name is retained");
			return true;
		},
	);
	assert.equal(calls.length, 1, "no retry after a lookup failure");
});

test("secret hygiene: every error path names only the reference, never the fake secret", async () => {
	const scenarios = [
		{ modelRef: "acme/nonexistent", impl: () => FAKE_SECRET },
		{ modelRef: "openai/gpt-4o", impl: () => undefined },
		{ modelRef: "openai/gpt-4o", impl: () => { throw new Error(`boom ${FAKE_SECRET}`); } },
	];
	for (const { modelRef, impl } of scenarios) {
		const { resolver } = withLookup(impl);
		await assert.rejects(
			() => resolver.resolve(modelRef),
			(error) => {
				assert.ok(!String(error.message).includes(FAKE_SECRET), "secret must never appear in an error message");
				assert.ok(!JSON.stringify(error).includes(FAKE_SECRET), "secret must never appear in a serialized error");
				return true;
			},
		);
	}
});

test("registry validation: invalid entries throw invalid-registry", () => {
	const base = { provider: "openai", modelId: "gpt-4o" };
	const invalid = [
		{ "openai/gpt-4o": { modelId: "gpt-4o" } }, // missing provider
		{ "openai/gpt-4o": { provider: "openai" } }, // missing modelId
		{ "openai/gpt-4o": { ...base, provider: "" } }, // empty provider
		{ "openai/gpt-4o": { ...base, baseUrl: "ftp://example.com" } }, // non-http(s) URL
		{ "openai/gpt-4o": { ...base, baseUrl: "not a url" } }, // malformed URL
		{ "openai/gpt-4o": { ...base, credentialRef: "" } }, // empty credentialRef
		{ "openai/gpt-4o": { ...base, credentialRef: 42 } }, // non-string credentialRef
		{ "not-a-reference": base }, // reference name without "provider/modelId"
		{ "openai/": base }, // empty model half
		{ "openai/gpt-4o": "nope" }, // entry not an object
	];
	for (const registry of invalid) {
		assert.throws(
			() => createProviderResolver({ registry, lookup: () => FAKE_SECRET }),
			(error) => {
				assert.ok(error instanceof ProviderResolutionError, `expected ProviderResolutionError for ${JSON.stringify(registry)}`);
				assert.equal(error.code, "invalid-registry");
				return true;
			},
		);
	}
	assert.throws(() => createProviderResolver({}), (error) => error.code === "invalid-registry");
});

test("registry is deep-frozen: mutating it after construction is ineffective", async () => {
	const registry = {
		"openai/gpt-4o": { provider: "openai", modelId: "gpt-4o", baseUrl: "https://api.openai.com/v1", credentialRef: "openai.apiKey" },
	};
	const resolver = createProviderResolver({ registry, lookup: () => FAKE_SECRET });
	await resolver.resolve("openai/gpt-4o");

	assert.ok(Object.isFrozen(registry), "registry frozen in place");
	assert.ok(Object.isFrozen(registry["openai/gpt-4o"]), "entry frozen in place");
	assert.throws(() => {
		registry["openai/gpt-4o"].provider = "attacker";
	}, TypeError);
	assert.throws(() => {
		registry["evil/entry"] = { provider: "evil", modelId: "entry" };
	}, TypeError);
	// The frozen value is unchanged and still resolves to the original provider.
	const again = await resolver.resolve("openai/gpt-4o");
	assert.equal(again.provider, "openai");
});

test("deterministic: identical inputs yield deeply equal output", async () => {
	const { resolver } = withLookup(() => FAKE_SECRET);
	const first = await resolver.resolve("openai/gpt-4o");
	const second = await resolver.resolve("openai/gpt-4o");
	assert.deepEqual(first, second);
	assert.notEqual(first, second, "fresh objects each call");
	assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("no side effects: a failed resolve leaves the registry untouched and lookup counts as expected", async () => {
	const registry = {
		"openai/gpt-4o": { provider: "openai", modelId: "gpt-4o", baseUrl: "https://api.openai.com/v1", credentialRef: "openai.apiKey" },
	};
	const snapshot = JSON.stringify(registry);
	const { resolver, calls } = withLookup(() => undefined);

	await assert.rejects(() => resolver.resolve("openai/gpt-4o"), (error) => error.code === "unresolved-credential");
	await assert.rejects(() => resolver.resolve("missing/entry"), (error) => error.code === "unresolved-model");

	assert.equal(JSON.stringify(registry), snapshot, "registry contents unchanged");
	assert.deepEqual(calls, ["openai.apiKey"], "exactly one lookup total across both resolves");
});
