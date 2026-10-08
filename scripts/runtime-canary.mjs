// Bounded P0 runtime canary.
//
// Default mode is fake-only: no network, no credentials, isolated SQLite with
// explicit `synchronous = FULL`, and a faux provider. It exercises the real
// published Pi Durable / Pi-AI / Chord APIs rather than reinventing a runtime
// state machine, scheduler, or registry.
//
// `--live` is an explicit, bounded opt-in probe for an already-running loopback
// Kimi shim. It is a compatibility check, not a product path, and this task
// never runs it.
//
// Scope limits:
//  - Pi submission "done" is NOT a product Task "completed" and is never
//    promoted to one here.
//  - The full-SQLite helper raises synchronous to FULL but is NOT an owner
//    fence; same-user processes can still open the file.
//  - No host-suspend or power-loss durability claim is made.

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPaseoClient } from "@getpaseo/client";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";

import { openSqliteStorageSynchronousFull } from "../runtime/full-sqlite.mjs";

const FAUX_PROVIDER = "faux";
const FAUX_MODEL = "faux-1";
const FAUX_RESPONSE = "canary-response";
const CANARY_MARKER = "CANARY_OK";
const LIVE_PROVIDER = "local-kimi-canary";
const LIVE_MODEL = "kimi-k3";
const LIVE_BASE_URL = "http://127.0.0.1:4323/v1";
const LIVE_MAX_OUTPUT_TOKENS = 96;
const LIVE_TIMEOUT_MS = 35_000;
const LIVE_DUMMY_AUTH = "loopback-shim";

const HELP = `runtime-canary: bounded P0 runtime canary

Usage:
  node scripts/runtime-canary.mjs            fake-only canary (no network)
  node scripts/runtime-canary.mjs --live     opt-in loopback Kimi shim probe
  node scripts/runtime-canary.mjs --help     show this help

Default mode uses a faux provider and isolated SQLite with
PRAGMA synchronous = FULL. It performs no network access and touches no
credentials or profile data. --live makes exactly one bounded request to a
loopback shim only when that shim is already running.
`;

function packageVersion(specifier) {
	try {
		const resolved = fileURLToPath(import.meta.resolve(specifier));
		let current = resolved;
		for (;;) {
			const parent = join(current, "..");
			if (parent === current) return undefined;
			current = parent;
			const candidate = join(current, "package.json");
			try {
				const parsed = JSON.parse(readFileSync(candidate, "utf8"));
				if (typeof parsed.name === "string" && parsed.version) return parsed.version;
			} catch {
				// Keep walking up.
			}
		}
	} catch {
		return undefined;
	}
}

function assistantTextFromEntries(entries) {
	for (const entry of entries) {
		// Pi's built-in assistant entry kind is "pi.assistant" (AssistantEntry),
		// not the bare "assistant".
		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return undefined;
}

async function readTranscript(conversation, context) {
	const page = await conversation.entries({}, 50, undefined, context);
	return page.items;
}

/**
 * Run the fake-only canary. Resolves with a JSON-serializable report.
 *
 * @param {{ stateDir?: string, context?: import("@earendil-works/chord").Context }} [options]
 */
export async function runCanary(options = {}) {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const ownsState = options.stateDir === undefined;
	const stateDir = options.stateDir ?? (await mkdtemp(join(process.cwd(), ".canary-state-")));
	const file = join(stateDir, "canary.sqlite");

	let harness;
	let activeStorage;
	const closeHarness = async () => {
		if (harness !== undefined) {
			const current = harness;
			harness = undefined;
			await current.close(context);
		}
	};

	try {
		let opened = await openSqliteStorageSynchronousFull(file);
		activeStorage = opened.storage;
		const storage = {
			engine: "sqlite",
			synchronous: opened.synchronous,
			journalMode: opened.journalMode,
			file,
			privacy: {
				parentMode: opened.parentMode.toString(8),
				fileMode: opened.fileMode.toString(8),
			},
		};

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage(FAUX_RESPONSE)]);
		const registry = createRegistry();

		harness = await Harness.open(activeStorage, { models, registry }, context);
		const root = await harness.root(context, {
			agent: { model: { provider: FAUX_PROVIDER, modelId: FAUX_MODEL }, tools: [] },
		});

		const first = await root.submit({ type: "input", content: "canary-1", requestId: "canary-request" }, context);
		const firstSettled = await first.wait(context);
		const callCountAfterFirst = faux.state.callCount;
		const entries = await readTranscript(root, context);
		const responseText = assistantTextFromEntries(entries);

		const duplicate = await root.submit({ type: "input", content: "canary-1", requestId: "canary-request" }, context);
		const duplicateSettled = await duplicate.wait(context);
		const callCountAfterDuplicate = faux.state.callCount;

		// Upstream limitation: Pi dedupes on conversation + requestId only, so a
		// different body under the same requestId reuses the existing submission.
		const changedBody = await root.submit({ type: "input", content: "canary-different-body", requestId: "canary-request" }, context);
		const changedSettled = await changedBody.wait(context);
		const callCountAfterChangedBody = faux.state.callCount;

		await closeHarness();

		const reopened = await openSqliteStorageSynchronousFull(file);
		activeStorage = reopened.storage;
		harness = await Harness.open(activeStorage, { models, registry }, context);
		// Reacquire the durable submission by its public id, then use the public
		// Submission.wait(context) to read its settled record.
		const reacquired = await harness.submission(first.id, context);
		const reacquiredSettled = reacquired === undefined ? undefined : await reacquired.wait(context);
		const callCountAfterReopen = faux.state.callCount;
		await closeHarness();

		const report = {
			ok: false,
			mode: "fake",
			versions: {
				piDurable: packageVersion("@earendil-works/pi-durable"),
				piAi: packageVersion("@earendil-works/pi-ai"),
				chord: packageVersion("@earendil-works/chord"),
				paseoClient: packageVersion("@getpaseo/client"),
			},
			scope: {
				realInference: 0,
				tools: 0,
				networkAttempted: false,
				liveTouched: false,
				defaultProductionUnchanged: true,
				piCompletedIsNotProductTaskCompleted: true,
			},
			storage,
			paseo: {
				packageVersion: packageVersion("@getpaseo/client"),
				// Imported from the public entry point; merely constructing the
				// export is never done here, so no client connection occurs.
				createPaseoClientIsFunction: typeof createPaseoClient === "function",
				clientConnected: false,
			},
			faux: {
				callCountAfterFirst,
				callCountAfterDuplicate,
				callCountAfterChangedBody,
				callCountAfterReopen,
			},
			submission: {
				id: first.id,
				requestId: firstSettled.requestId,
				status: firstSettled.status,
				answer: firstSettled.answer,
				responseText,
			},
			duplicateRequest: {
				sameSubmission: duplicate.id === first.id,
				status: duplicateSettled.status,
				extraModelCalls: callCountAfterDuplicate - callCountAfterFirst,
			},
			changedBodySameRequestId: {
				reusesSubmission: changedBody.id === first.id,
				status: changedSettled.status,
				extraModelCalls: callCountAfterChangedBody - callCountAfterDuplicate,
				limitation: "Pi dedupes by conversation + requestId only; a different request body with the same requestId reuses the existing submission. A product-level payload digest gate is still required.",
			},
			reopened: {
				sameId: reacquired !== undefined && reacquired.id === first.id && reacquiredSettled?.id === first.id,
				status: reacquiredSettled?.status,
				requestId: reacquiredSettled?.requestId,
				answer: reacquiredSettled?.answer,
				extraModelCalls: callCountAfterReopen - callCountAfterChangedBody,
			},
			limitations: [
				"full-sqlite: raises PRAGMA synchronous to FULL and sets file mode 0600 / parent 0700, but is NOT an owner fence; same-user processes can still open the file.",
				"requestId dedup is body-blind in this Pi version; a product payload digest gate is still required.",
				"Pi submission done is not a product Task completed; no promotion or mapping is asserted.",
				"no host-suspend or power-loss durability claim is made; only this connection's synchronous=FULL is verified.",
			],
		};
		report.ok =
			callCountAfterFirst === 1 &&
			report.duplicateRequest.sameSubmission === true &&
			report.duplicateRequest.extraModelCalls === 0 &&
			report.changedBodySameRequestId.reusesSubmission === true &&
			report.changedBodySameRequestId.extraModelCalls === 0 &&
			report.reopened.sameId === true &&
			report.reopened.status === "done" &&
			report.reopened.extraModelCalls === 0 &&
			storage.synchronous === 2 &&
			storage.journalMode === "wal" &&
			report.paseo.createPaseoClientIsFunction === true &&
			responseText === FAUX_RESPONSE;
		return report;
	} finally {
		await closeHarness().catch(() => {});
		if (activeStorage !== undefined) {
			try {
				await activeStorage.close(context);
			} catch {
				// Already closed by the harness.
			}
		}
		if (ownsState) {
			await rm(stateDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

function liveModelMetadata() {
	return [
		{
			id: LIVE_MODEL,
			name: "Kimi K3 (loopback canary)",
			api: "openai-completions",
			provider: LIVE_PROVIDER,
			baseUrl: LIVE_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 4096,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		},
	];
}

/**
 * Bounded loopback Kimi shim compatibility probe. Explicit opt-in only.
 * Makes at most one request and never accesses credential stores.
 */
export async function runLiveProbe(options = {}) {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const timeoutMs = Math.min(options.timeoutMs ?? LIVE_TIMEOUT_MS, LIVE_TIMEOUT_MS);
	const [{ createProvider }, { openAICompletionsApi }] = await Promise.all([
		import("@earendil-works/pi-ai/models"),
		import("@earendil-works/pi-ai/api/openai-completions.lazy"),
	]);

	const provider = createProvider({
		id: LIVE_PROVIDER,
		name: "Local Kimi Canary (loopback shim)",
		baseUrl: LIVE_BASE_URL,
		auth: {
			apiKey: {
				name: "Loopback Kimi shim (dummy)",
				resolve: async () => ({ auth: { apiKey: LIVE_DUMMY_AUTH }, source: "canary-dummy-loopback" }),
			},
		},
		models: liveModelMetadata(),
		api: openAICompletionsApi(),
	});

	const models = options.models ?? createModels();
	models.setProvider(provider);
	const model = models.getModel(LIVE_PROVIDER, LIVE_MODEL);
	if (model === undefined) throw new Error("live canary model was not registered");

	let prepared = 0;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const report = {
		ok: false,
		mode: "live",
		provider: LIVE_PROVIDER,
		model: LIVE_MODEL,
		baseUrl: LIVE_BASE_URL,
		// A prepared payload is NOT proof a request was sent; the prepared count
		// and the response/usage are reported separately.
		responseReceived: false,
		preparedPayloads: 0,
		stopReason: undefined,
		markerSeen: false,
		usage: undefined,
	};
	try {
		const message = await models.completeSimple(
			model,
			{ messages: [{ role: "user", content: `Reply only with ${CANARY_MARKER}. No tools or external actions.`, timestamp: Date.now() }], tools: [] },
			{
				signal: controller.signal,
				timeoutMs,
				maxTokens: LIVE_MAX_OUTPUT_TOKENS,
				temperature: 0.6,
				samplingParams: { top_p: 0.95 },
				onPayload: (payload) => {
					prepared += 1;
					const next = { ...payload, temperature: 0.6, top_p: 0.95, max_tokens: LIVE_MAX_OUTPUT_TOKENS };
					delete next.reasoning_effort;
					next.thinking = { type: "disabled" };
					if (typeof next.enable_thinking === "boolean") next.enable_thinking = false;
					return next;
				},
				onResponse: (response) => {
					report.responseReceived = Number.isInteger(response.status);
					report.httpStatus = response.status;
				},
			},
		);
		report.preparedPayloads = prepared;
		// An error AssistantMessage can resolve before HTTP; only the transport
		// callback proves that a response was observed.
		report.stopReason = message.stopReason;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		report.markerSeen = text.trim() === CANARY_MARKER;
		report.usage = {
			input: message.usage?.input,
			output: message.usage?.output,
			totalTokens: message.usage?.totalTokens,
		};
		report.ok = report.responseReceived && message.stopReason === "stop" && report.markerSeen === true;
	} catch (error) {
		// Never surface raw provider errors, headers, or payload keys.
		report.preparedPayloads = prepared;
		report.errorName = error instanceof Error ? error.name : "UnknownError";
		report.ok = false;
	} finally {
		clearTimeout(timer);
	}
	void context;
	return report;
}

/**
 * Parse CLI args. Returns `{ error }` for an unknown flag or `{ flags }`.
 */
export function parseArgs(argv) {
	const flags = { help: false, live: false };
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") flags.help = true;
		else if (arg === "--live") flags.live = true;
		else return { error: `Unknown argument: ${arg}` };
	}
	return { flags };
}

/** CLI entry point. Returns the intended process exit code. */
export async function main(argv = process.argv.slice(2)) {
	const parsed = parseArgs(argv);
	if (parsed.error !== undefined) {
		process.stderr.write(`${parsed.error}\n`);
		return 2;
	}
	if (parsed.flags.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const report = parsed.flags.live ? await runLiveProbe() : await runCanary();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	return report.ok ? 0 : 1;
}

const invoked = process.argv[1] === undefined ? "" : pathToFileURL(process.argv[1]).href;
if (import.meta.url === invoked) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`canary failed: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
