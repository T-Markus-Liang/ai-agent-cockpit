// P2-B thin RuntimePort adapter over the public Pi Harness + the P2-A OwnedStorage.
//
// This is a bounded canary, not a production cutover and not a general runtime:
//   - the default registry is empty; an optional host-issued suite can query,
//     queue children and plan only. No native/shell/files/approval authority.
//     Models and modelRefs remain caller-supplied.
//   - there is no generic scheduler, state machine, or registry here. All durable
//     execution is the Pi Harness's; all writes are fenced by OwnedStorage.
//   - `submit()`/`wait()`/`recover()` persist an admission MAPPING (identities,
//     references, conversation/submission IDs). They do not promote product tasks
//     to `completed` and do not implement raw admission/busy/state machines.
//   - a request's `authorizationDigest` is a caller reference, not an approval.
//     A real authorization/OS broker is still required before native dispatch.
//
// Crash safety: the request binding is committed BEFORE the Pi submission. A
// crash between the two is recovered by reading the submission back by its SAME
// request ID; no second generation is started and no input text is replayed.

import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, LiveDoc, configure, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { getChiefToolSuiteDescriptor } from "./chief-tools.mjs";
import {
	ADMISSION_DOC_KIND,
	ADMISSION_DOC_VERSION,
	CONTRACT_VERSION,
	ContractRejected,
	RequestConflict,
	assertAdmissionDoc,
	assertRegistryVersion,
	computeDigest,
	effectiveOwnership,
	hashKey,
	initialAdmissionDoc,
	requestKeyFor,
	validateRequest,
} from "./contracts.mjs";

/** Session-scoped singleton holding the immutable bindings and the ID mapping. */
export const AdmissionDoc = defineDoc({
	kind: ADMISSION_DOC_KIND,
	version: ADMISSION_DOC_VERSION,
	scope: "session",
	initial: initialAdmissionDoc,
	migrate: (_value, fromVersion) => {
		throw new ContractRejected("unknown-mapping-version", `unsupported admission mapping version ${fromVersion}`);
	},
});

/**
 * Abort scopes the adapter understands. `submission` withdraws/fences one input,
 * `conversation` cancels the foreground (ordinary) scope of one conversation,
 * `execution` cancels the background submissions bound to one execution id.
 * `goal-wide` is deliberately NOT here: product-goal cancellation belongs to the
 * goal-runtime, so this adapter refuses it rather than escalating to a global cancel.
 */
const ABORT_SCOPE_KINDS = new Set(["submission", "conversation", "execution"]);

/** Harness settings this no-tools canary tolerates. Unknown safety-sensitive fields are refused. */
const SAFE_SETTING_KEYS = new Set(["extensions", "stream", "retry", "compaction", "progress", "toolExecution", "steeringMode", "followUpMode"]);

// Only checkpoint-safe request settings; auth, headers, metadata and callbacks
// belong to the process-local provider transport, never durable state.
const STREAM_OPTION_KEYS = new Set(["transport", "timeoutMs", "maxRetries", "maxRetryDelayMs", "cacheRetention", "deferred"]);
const TRANSPORT_VALUES = new Set(["sse", "websocket", "websocket-cached", "auto"]);
const CACHE_RETENTION_VALUES = new Set(["none", "short", "long"]);
const DEFERRED_WINDOW_VALUES = new Set(["15m", "1h", "24h"]);

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPolicyOptions(value, allowed) {
	if (!isPlainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
		throw new ContractRejected("unsafe-settings", "policy options contain unsupported fields");
	}
	for (const [key, item] of Object.entries(value)) {
		const valid = key === "enabled" ? typeof item === "boolean" : Number.isSafeInteger(item) && item >= 0;
		if (!valid) throw new ContractRejected("unsafe-settings", "policy options contain invalid values");
	}
}

function assertSafeStreamOptions(stream) {
	if (!isPlainObject(stream) || Object.keys(stream).some(key => !STREAM_OPTION_KEYS.has(key))) {
		throw new ContractRejected("unsafe-stream-option", "stream options contain unsupported or private fields");
	}
	if (Object.hasOwn(stream, "transport") && !TRANSPORT_VALUES.has(stream.transport)) {
		throw new ContractRejected("unsafe-stream-option", "invalid stream transport");
	}
	for (const key of ["timeoutMs", "maxRetries", "maxRetryDelayMs"]) {
		if (Object.hasOwn(stream, key) && (!Number.isSafeInteger(stream[key]) || stream[key] < 0 || (key === "timeoutMs" && stream[key] === 0))) {
			throw new ContractRejected("unsafe-stream-option", "invalid stream timeout or retry bound");
		}
	}
	if (Object.hasOwn(stream, "cacheRetention") && !CACHE_RETENTION_VALUES.has(stream.cacheRetention)) {
		throw new ContractRejected("unsafe-stream-option", "invalid cache retention");
	}
	if (Object.hasOwn(stream, "deferred") && typeof stream.deferred !== "boolean") {
		const deferred = stream.deferred;
		if (!isPlainObject(deferred) || Object.keys(deferred).some(key => key !== "window") ||
			(Object.hasOwn(deferred, "window") && !DEFERRED_WINDOW_VALUES.has(deferred.window))) {
			throw new ContractRejected("unsafe-stream-option", "invalid deferred window");
		}
	}
}

/** A supplied modelRef must be a provider/modelId object of nonempty bounded strings. */
function normalizeModelRef(modelRef, code = "invalid-model-ref") {
	if (!isPlainObject(modelRef)) throw new ContractRejected(code, "modelRef must be a provider/modelId object");
	const keys = Object.keys(modelRef);
	if (keys.length !== 2 || keys.some((key) => key !== "provider" && key !== "modelId")) {
		throw new ContractRejected(code, "modelRef must have exactly provider and modelId");
	}
	if (typeof modelRef.provider !== "string" || modelRef.provider.trim() === "" || typeof modelRef.modelId !== "string" || modelRef.modelId.trim() === "") {
		throw new ContractRejected(code, "modelRef provider/modelId must be nonempty strings");
	}
	return { provider: modelRef.provider, modelId: modelRef.modelId };
}

/**
 * This adapter intentionally offers no tools. Reject any nonempty registry and
 * any setting that could inject extensions/tools before the Harness starts, so
 * a CodingTools registry can never be quietly accepted here.
 */
function assertNoToolsRegistry(registry) {
	if (!isPlainObject(registry) || typeof registry.snapshot !== "function") {
		throw new ContractRejected("unsafe-registry", "registry must be a RegistryReader");
	}
	const snapshot = registry.snapshot();
	if (snapshot === undefined || typeof snapshot.installed !== "function" || typeof snapshot.tools !== "function") {
		throw new ContractRejected("unsafe-registry", "registry snapshot is not a RegistrySnapshot");
	}
	if (snapshot.installed().length > 0 || snapshot.tools().length > 0) {
		throw new ContractRejected("unsafe-registry", "this no-tools adapter requires an empty registry (no extensions or tools)");
	}
}

/** Validate and detach settings before Harness.open; never persist caller code. */
function assertSafeSettings(input) {
	if (input === undefined) return undefined;
	let settings;
	try {
		// ponytail: reuse Chord's strict, accessor-safe JSON clone instead of a second walker.
		settings = copyJson(input);
	} catch {
		throw new ContractRejected("unsafe-settings", "settings must be strict JSON data");
	}
	if (!isPlainObject(settings) || Object.keys(settings).some(key => !SAFE_SETTING_KEYS.has(key))) {
		throw new ContractRejected("unsafe-settings", "settings contain unsupported fields");
	}
	if (Object.hasOwn(settings, "extensions") && (!Array.isArray(settings.extensions) || settings.extensions.length > 0)) {
		throw new ContractRejected("unsafe-settings", "settings.extensions must be absent or empty for this no-tools adapter");
	}
	if (Object.hasOwn(settings, "stream")) assertSafeStreamOptions(settings.stream);
	if (Object.hasOwn(settings, "retry")) assertPolicyOptions(settings.retry, ["enabled", "maxRetries", "baseDelayMs", "maxAgentDelayMs"]);
	if (Object.hasOwn(settings, "compaction")) assertPolicyOptions(settings.compaction, ["enabled", "reserveTokens", "keepRecentTokens", "backgroundTokens"]);
	if (Object.hasOwn(settings, "progress")) assertPolicyOptions(settings.progress, ["partialIntervalMs", "outputIntervalMs"]);
	if (Object.hasOwn(settings, "toolExecution") && !["parallel", "sequential"].includes(settings.toolExecution)) {
		throw new ContractRejected("unsafe-settings", "invalid tool execution mode");
	}
	for (const key of ["steeringMode", "followUpMode"]) {
		if (Object.hasOwn(settings, key) && !["all", "one-at-a-time"].includes(settings[key])) {
			throw new ContractRejected("unsafe-settings", "invalid queue mode");
		}
	}
	return settings;
}

/** Read a scope's kind from the explicit scope argument, or throw. */
function readScopeKind(scope) {
	if (scope === undefined || scope === null) throw new ContractRejected("scope-required", "abort requires an explicit scope");
	const kind = typeof scope === "string" ? scope : scope.kind;
	if (typeof kind !== "string" || !ABORT_SCOPE_KINDS.has(kind)) {
		throw new ContractRejected("unsupported-scope", `unsupported abort scope: ${String(kind)}; goal-wide cancellation is not offered`);
	}
	return kind;
}

/** Effective-ownership equality, used to detect a same-request-id ownership change. */
function sameOwnership(a, b) {
	return a.kind === b.kind && a.executionId === b.executionId && a.goalId === b.goalId;
}

/**
 * Thin Pi adapter. Open one per OwnedStorage handle. Default production is
 * unchanged: this module is imported by nothing else and opens only when a
 * caller explicitly constructs it.
 */
export class PiRuntimeAdapter {
	#owned;
	#harness;
	#registry;
	#models;
	#defaultModelRef;
	#toolProfile;
	#leaseTimer;
	#closed = false;

	constructor(owned, harness, registry, models, defaultModelRef, toolProfile) {
		this.#owned = owned;
		this.#harness = harness;
		this.#registry = registry;
		this.#models = models;
		this.#defaultModelRef = defaultModelRef;
		this.#toolProfile = toolProfile;
	}

	/**
	 * Open a Harness over the caller's OwnedStorage. The registry defaults to the
	 * empty built-in registry (no tools); models and an optional default modelRef
	 * are supplied by the caller.
	 *
	 * @param {object} owned result of `openOwnedSqliteStorage`
	 * @param {object} options `{ models, registry?, modelRef?, settings?, context? }`
	 */
	static async open(owned, options = {}) {
		const context = options.context ?? BACKGROUND_CONTEXT;
		assertRegistryVersion(options.registrySchemaVersion ?? 1);
		const models = options.models;
		if (models === undefined || typeof models.getModel !== "function") {
			throw new ContractRejected("missing-models", "adapter requires caller-supplied Models");
		}
		const settings = assertSafeSettings(options.settings);
		const toolProfile = options.toolSuite === undefined ? undefined : getChiefToolSuiteDescriptor(options.toolSuite);
		if (options.toolSuite !== undefined && (toolProfile === undefined || options.registry !== undefined)) throw new ContractRejected('unsafe-registry', 'only an issued isolated chief tool suite is accepted');
		const registry = options.toolSuite ?? options.registry ?? createRegistry();
		if (toolProfile === undefined) assertNoToolsRegistry(registry);
		const defaultModelRef = options.modelRef === undefined || options.modelRef === null ? undefined : normalizeModelRef(options.modelRef, "invalid-model-ref");
		if (defaultModelRef !== undefined && models.getModel(defaultModelRef.provider, defaultModelRef.modelId) === undefined) {
			throw new ContractRejected("unresolved-model", `default modelRef ${defaultModelRef.provider}/${defaultModelRef.modelId} is not resolved in the supplied models`);
		}
		const harness = await Harness.open(owned.storage, { models, registry, ...(settings === undefined ? {} : { settings }) }, context);
		const adapter = new PiRuntimeAdapter(owned, harness, registry, models, defaultModelRef, toolProfile);
		try {
			await adapter.#loadMapping();
		} catch (error) {
			await harness.close(context).catch(() => {});
			await owned.close().catch(() => {});
			throw error;
		}
		adapter.#startLease();
		return adapter;
	}

	#assertOpen() {
		if (this.#closed) throw new ContractRejected("adapter-closed", "runtime adapter is closed");
	}

	async #renew() {
		if (this.#closed) return;
		await this.#owned.renew();
	}

	#startLease() {
		const leaseMs = this.#owned.owner?.leaseMs ?? 30_000;
		const period = Math.max(25, Math.floor(leaseMs / 3));
		this.#leaseTimer = setInterval(() => {
			void this.#renew().catch(() => this.#stopLease());
		}, period);
		this.#leaseTimer.unref?.();
	}

	#stopLease() {
		if (this.#leaseTimer !== undefined) {
			clearInterval(this.#leaseTimer);
			this.#leaseTimer = undefined;
		}
	}

	/** Read the admission document. Unknown versions reject; nothing is reset. */
	async #readMapping() {
		let snapshot;
		try {
			snapshot = await this.#harness.snapshot(AdmissionDoc, BACKGROUND_CONTEXT);
		} catch (error) {
			throw new ContractRejected("unknown-mapping-version", error?.message ?? "admission mapping is unreadable", { cause: error });
		}
		if (snapshot === undefined) return initialAdmissionDoc();
		assertAdmissionDoc(snapshot);
		return snapshot;
	}

	async #loadMapping() {
		const mapping = await this.#readMapping();
		for (const owner of Object.values(mapping.owners)) this.#assertToolProfile(owner);
		for (const request of Object.values(mapping.requests)) this.#assertSuiteBinding(request);
	}

	#assertToolProfile(owner) {
		const expected = this.#toolProfile;
		if (owner.toolProfile === undefined && expected === undefined) return;
		if (!owner.toolProfile || !expected || owner.toolProfile.version !== expected.version || owner.toolProfile.digest !== expected.digest) throw new ContractRejected('tool-profile-mismatch', 'stored tool profile cannot be widened or changed on reopen');
	}

	#assertSuiteBinding(request) {
		if (this.#toolProfile === undefined) return;
		for (const [key, value] of Object.entries(this.#toolProfile.binding)) {
			if (request[key] !== value) throw new ContractRejected('tool-scope-mismatch', 'request does not match the host task tool binding');
		}
	}

	/**
	 * M02-F003 admission guard. A background request must resolve to one durable
	 * execution binding BEFORE any row is created or model is called, so a running
	 * background task can never be admitted without a scoped cancel path. `contracts`
	 * normalizes this already; the guard is defense-in-depth against a caller that
	 * reaches the adapter with an un-normalized request.
	 */
	#assertBackgroundBinding(request) {
		const ownership = request.ownership;
		if (ownership === undefined || ownership.kind !== "background") return;
		if (typeof ownership.executionId !== "string" || ownership.executionId.trim() === "") {
			throw new ContractRejected("missing-execution-binding", "background ownership requires a resolvable executionId");
		}
	}

	#mappingOwners(mapping) {
		return Object.values(mapping.owners ?? {});
	}

	#submissionKeyFor(mapping, submissionId) {
		for (const [key, value] of Object.entries(mapping.submissions ?? {})) {
			if (value === submissionId) return key;
		}
		return undefined;
	}

	#conversationForSubmission(mapping, submissionId) {
		const key = this.#submissionKeyFor(mapping, submissionId);
		if (key === undefined) return undefined;
		return mapping.requests?.[key]?.conversationId;
	}

	/** Every persisted request/submission bound to one conversation, with effective ownership. */
	#rowsInConversation(mapping, conversationId) {
		const rows = [];
		for (const [key, request] of Object.entries(mapping.requests ?? {})) {
			if (request.conversationId !== conversationId) continue;
			rows.push({
				key,
				conversationId: request.conversationId,
				submissionId: mapping.submissions?.[key],
				ownership: effectiveOwnership(request),
			});
		}
		return rows;
	}

	/** The conversation's live run control (`taskId` + placed input ids), if busy. */
	async #liveRun(conversationId) {
		const live = await this.#harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
		return live?.run;
	}

	/** Durable status of one submission, or undefined when it is unknown. */
	async #submissionStatus(submissionId, context) {
		const handle = await this.#harness.submission(submissionId, context);
		if (handle === undefined) return undefined;
		return (await handle.status(context)).status;
	}

	/**
	 * Cancel a set of submissions inside one conversation and report the EXACT
	 * resulting state of every submission; it never fabricates a stop.
	 *
	 *   - A run holding only target inputs is aborted as a unit, so its inputs settle
	 *     `unanswered`.
	 *   - A run that ALSO holds inputs outside the target set (e.g. an explicit
	 *     background input placed by `followUpMode:'all'`) is never swept: aborting it
	 *     would stop non-target work, and `abortSubmission` only withdraws QUEUED
	 *     inputs, so its placed targets are reported `still-running` (M02-F002).
	 *   - A submission left `queued` in an idle conversation is reported `stalled`
	 *     with reason `sdk-queue-not-advanced`: the SDK places queued inputs only at a
	 *     generation boundary, which a stopped run never reaches (M02-F001).
	 */
	async #cancelSubmissions(mapping, conversationId, submissionIds, context) {
		const ids = [...new Set(submissionIds.filter((id) => id !== undefined))];
		const run = await this.#liveRun(conversationId);
		const runInputs = run === undefined ? [] : run.inputs;
		const reasons = new Set();
		if (ids.some((id) => runInputs.includes(id))) {
			if (runInputs.some((id) => !ids.includes(id))) reasons.add("mixed-run-not-cancellable");
			else await this.#harness.abortTask(run.taskId, context);
		}
		for (const id of ids) {
			if (runInputs.includes(id)) continue;
			await this.#harness.abortSubmission(id, context, conversationId);
		}
		const cancelled = [];
		const stillRunning = [];
		for (const id of ids) {
			const status = await this.#submissionStatus(id, context);
			if (status === undefined) continue;
			if (status === "done" || status === "unanswered") cancelled.push(id);
			else stillRunning.push({ submissionId: id, state: status });
		}
		// Any other submission of this conversation still queued while nothing is
		// running is stranded: report it rather than let a silent `queued` imply it
		// will ever be placed.
		if ((await this.#liveRun(conversationId)) === undefined) {
			for (const row of this.#rowsInConversation(mapping, conversationId)) {
				if (row.submissionId === undefined || ids.includes(row.submissionId)) continue;
				if ((await this.#submissionStatus(row.submissionId, context)) !== "queued") continue;
				stillRunning.push({ submissionId: row.submissionId, state: "stalled", reason: "sdk-queue-not-advanced", ownership: row.ownership });
				reasons.add("sdk-queue-not-advanced");
			}
		}
		return { cancelled, stillRunning, reasons: [...reasons] };
	}

	/** Merge per-conversation cancellation outcomes into one structured report. */
	#mergeCancellations(outcomes) {
		const cancelled = [];
		const stillRunning = [];
		const reasons = new Set();
		for (const outcome of outcomes) {
			cancelled.push(...outcome.cancelled);
			stillRunning.push(...outcome.stillRunning);
			for (const reason of outcome.reasons) reasons.add(reason);
		}
		return { cancelled, stillRunning, reasons: [...reasons] };
	}

	/**
	 * Public abort return. A fully-cancelled scope keeps the historical `"aborted"`
	 * string; anything the SDK could not precisely stop returns a structured report
	 * (`partial` / `still-running` / `unsupported`) so a caller can never read a
	 * success that did not happen.
	 */
	#abortReport(outcome) {
		if (outcome.stillRunning.length === 0) return "aborted";
		const result = outcome.cancelled.length > 0
			? "partial"
			: outcome.reasons.includes("mixed-run-not-cancellable") ? "unsupported" : "still-running";
		return Object.freeze({
			result,
			cancelled: [...outcome.cancelled],
			stillRunning: outcome.stillRunning.map((entry) => ({ ...entry })),
			reason: outcome.reasons.join(", ") || "not-all-cancelled",
		});
	}

	/** Submission ids reported stalled by one cancellation outcome. */
	#strandedIds(outcome) {
		return new Set(outcome.stillRunning.filter((entry) => entry.state === "stalled").map((entry) => entry.submissionId));
	}

	/**
	 * Persist the exact stalled/queued state of a conversation's submissions in the
	 * durable mapping so a later `recover()` can corroborate what a cancellation left
	 * behind (M02-F001). Only a marker on the request record is written; the live
	 * status read by `observe()` stays authoritative.
	 */
	async #persistQueueStates(mapping, conversationId, strandedIds, context) {
		const rows = Object.entries(mapping.requests ?? {}).filter(([, request]) => request.conversationId === conversationId);
		const stale = rows.some(([key, request]) => strandedIds.has(mapping.submissions?.[key]) !== (request.queueState !== undefined));
		if (!stale) return;
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(AdmissionDoc);
			assertAdmissionDoc(doc);
			for (const [key, request] of Object.entries(doc.requests)) {
				if (request.conversationId !== conversationId) continue;
				if (strandedIds.has(doc.submissions?.[key])) request.queueState = { state: "stalled", reason: "sdk-queue-not-advanced" };
				else if (request.queueState !== undefined) delete request.queueState;
			}
		}, context);
	}

	async #submissionHandle(submissionId) {
		if (typeof submissionId !== "number" || !Number.isSafeInteger(submissionId)) {
			throw new ContractRejected("invalid-submission-id", "submissionId must be an integer");
		}
		const handle = await this.#harness.submission(submissionId, BACKGROUND_CONTEXT);
		if (handle === undefined) throw new ContractRejected("submission-not-found", `no submission ${submissionId}`);
		return handle;
	}

	/**
	 * Admit a request. Validates the schema/digest before any effect, verifies the
	 * same request key, reserves the binding, then submits to Pi. Same-request-ID
	 * retries reuse the durable submission; changed identity/body/profile rejects.
	 */
	async submit(request) {
		this.#assertOpen();
		const normalized = validateRequest(request);
		this.#assertBackgroundBinding(normalized);
		this.#assertSuiteBinding(normalized);
		// The EFFECTIVE modelRef (request-supplied or adapter default) is resolved
		// and folded into the digest BEFORE any admission effect. A reopened adapter
		// whose default drifted therefore rejects reuse instead of replaying an old
		// profile.
		const modelRef = normalizeModelRef(normalized.modelRef ?? this.#defaultModelRef, "missing-model-ref");
		if (this.#models.getModel(modelRef.provider, modelRef.modelId) === undefined) {
			throw new ContractRejected("unresolved-model", `modelRef ${modelRef.provider}/${modelRef.modelId} is not resolved in the supplied models`);
		}
		const effective = { ...normalized, modelRef };
		const digest = computeDigest(effective);
		if (normalized.payloadDigest !== undefined && normalized.payloadDigest !== digest) {
			throw new ContractRejected("payload-digest-mismatch", "supplied payloadDigest does not match the computed request digest");
		}
		const ownerHash = hashKey(normalized.ownerId);
		const requestKey = requestKeyFor(normalized.ownerId, normalized.sourceRequestId);
		await this.#renew();

		const { conversationId, reused } = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(AdmissionDoc);
			assertAdmissionDoc(doc);
			const existing = doc.requests[requestKey];
			if (existing !== undefined) {
				const changed =
					existing.digest !== digest ||
					existing.ownerId !== normalized.ownerId ||
					existing.sourceRequestId !== normalized.sourceRequestId ||
					existing.productTaskId !== normalized.productTaskId ||
					existing.executionId !== normalized.executionId ||
					existing.profileId !== normalized.profileId ||
					!sameOwnership(effectiveOwnership(existing), normalized.ownership);
				if (changed) {
					throw new RequestConflict("request-conflict", `request ${normalized.sourceRequestId} is already bound to different content/profile/authorization`);
				}
				return { conversationId: existing.conversationId, reused: true };
			}
			let owner = doc.owners[ownerHash];
			if (owner === undefined) {
				const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
				// The default stays empty. The only nonempty choice is a host-issued
				// scoped product suite, never arbitrary coding tools or an environment.
				await configure(tx, record.id, {
					model: { provider: modelRef.provider, modelId: modelRef.modelId },
                    tools: this.#toolProfile === undefined ? [] : this.#registry.snapshot().tools().map(row => row.tool),
                    ...(this.#toolProfile === undefined ? {} : { extensions: this.#registry.snapshot().installed() }),
					...(normalized.cwd === undefined ? {} : { cwd: normalized.cwd }),
				});
				owner = {
					ownerId: normalized.ownerId,
					conversationId: record.id,
					profileId: normalized.profileId,
					cwd: normalized.cwd ?? null,
					modelRef: { provider: modelRef.provider, modelId: modelRef.modelId },
					...(this.#toolProfile === undefined ? {} : { toolProfile: { version: this.#toolProfile.version, digest: this.#toolProfile.digest } }),
				};
				doc.owners[ownerHash] = owner;
			} else {
				this.#assertToolProfile(owner);
				// An owner's conversation is pinned to its original profile/cwd/model.
				// A new source request cannot claim a different cwd while the actual
				// conversation still carries the old one.
				if (owner.ownerId !== normalized.ownerId) {
					throw new ContractRejected("owner-identity-mismatch", "owner conversation belongs to a different owner identity");
				}
				if (owner.profileId !== normalized.profileId) {
					throw new ContractRejected("profile-mismatch", "owner conversation is already pinned to its original profile");
				}
				if ((owner.cwd ?? null) !== (normalized.cwd ?? null)) {
					throw new ContractRejected("cwd-mismatch", "owner conversation is already pinned to its original cwd");
				}
				if (owner.modelRef.provider !== modelRef.provider || owner.modelRef.modelId !== modelRef.modelId) {
					throw new ContractRejected("model-profile-mismatch", "owner conversation is already pinned to its original model profile");
				}
			}
			doc.requests[requestKey] = {
				ownerHash,
				ownerId: normalized.ownerId,
				sourceRequestId: normalized.sourceRequestId,
				digest,
				productTaskId: normalized.productTaskId,
				executionId: normalized.executionId,
				profileId: normalized.profileId,
				authorizationDigest: normalized.authorizationDigest,
				modelRef: { provider: modelRef.provider, modelId: modelRef.modelId },
				...(normalized.cwd === undefined ? {} : { cwd: normalized.cwd }),
				// Adapter-level ownership binding. The SDK conversation itself stays
				// ownerless (ConversationOwnership has no execution/goal kind), so this
				// record in the mapping is the authority for cancellation scope.
				ownership: normalized.ownership,
				conversationId: owner.conversationId,
			};
			return { conversationId: owner.conversationId, reused: false };
		}, BACKGROUND_CONTEXT);

		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new ContractRejected("conversation-missing", `conversation ${conversationId} is missing`);
		const submission = await conversation.submit(
			{ type: "input", content: normalized.content, requestId: normalized.sourceRequestId, whenBusy: "followUp" },
			BACKGROUND_CONTEXT,
		);

		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(AdmissionDoc);
			assertAdmissionDoc(doc);
			doc.submissions[requestKey] = submission.id;
		}, BACKGROUND_CONTEXT);

		return Object.freeze({
			ownerId: normalized.ownerId,
			sourceRequestId: normalized.sourceRequestId,
			requestKey,
			digest,
			conversationId,
			submissionId: submission.id,
			reused,
		});
	}

	/**
	 * Wait for a submission. `waitContext` only cancels this waiter; it never
	 * aborts the underlying generation. Defaults to BACKGROUND (no cancellation).
	 */
	async wait(submissionId, waitContext = BACKGROUND_CONTEXT) {
		this.#assertOpen();
		await this.#renew();
		const handle = await this.#submissionHandle(submissionId);
		// Pass the caller context straight to the SDK wait: cancellation rejects
		// only this waiter and leaves the underlying generation running, instead
		// of leaking a separate unobserved background waiter.
		return await handle.wait(waitContext);
	}

	/** Durable status of one submission, or the whole admission mapping when omitted. */
	async observe(target, context = BACKGROUND_CONTEXT) {
		this.#assertOpen();
		if (target === undefined) {
			const mapping = await this.#readMapping();
			return {
				contractVersion: CONTRACT_VERSION,
				owners: this.#mappingOwners(mapping),
				requests: Object.values(mapping.requests ?? {}),
				submissions: { ...(mapping.submissions ?? {}) },
			};
		}
		await this.#renew();
		const submissionId = typeof target === "object" && target !== null ? target.submissionId : target;
		const handle = await this.#submissionHandle(submissionId);
		const record = await handle.status(context);
		// A queued submission whose conversation is idle can never be placed by the
		// SDK — queued inputs are placed only at a generation boundary, and no run is
		// coming — so report it truthfully as `stalled` instead of an endless `queued`
		// (M02-F001). Any other status is the SDK's own record.
		if (record.status === "queued" && (await this.#liveRun(record.conversationId)) === undefined) {
			return Object.freeze({ ...record, status: "stalled", reason: "sdk-queue-not-advanced" });
		}
		return record;
	}

	/**
	 * Restore the durable submission mapping, then resume scheduling. It never
	 * creates a conversation, never replays input text, and fails closed BEFORE
	 * any scheduling advance when a mapped model is unresolved.
	 */
	async recover() {
		this.#assertOpen();
		await this.#renew();
		const mapping = await this.#readMapping();
		for (const owner of Object.values(mapping.owners)) this.#assertToolProfile(owner);
		for (const request of Object.values(mapping.requests)) this.#assertSuiteBinding(request);
		const unresolvedModels = [];
		for (const binding of Object.values(mapping.requests ?? {})) {
			const model = this.#models.getModel(binding.modelRef.provider, binding.modelRef.modelId);
			if (model === undefined) unresolvedModels.push(`${binding.modelRef.provider}/${binding.modelRef.modelId}`);
		}
		if (unresolvedModels.length > 0) {
			// Fail closed before resume: do not advance a mapping whose models
			// cannot be resolved, and do not fall back to a new conversation.
			throw new ContractRejected("unresolved-models", `cannot recover with unresolved models: ${unresolvedModels.join(", ")}`);
		}
		const restored = [];
		for (const [key, binding] of Object.entries(mapping.requests ?? {})) {
			if (mapping.submissions?.[key] !== undefined) continue;
			// Reacquire the existing durable submission by the SAME request id; never
			// look up an unknown conversation and never resubmit the input text.
			const found = await this.#harness.commit(
				(tx) => tx.submissionByRequest(binding.conversationId, binding.sourceRequestId),
				BACKGROUND_CONTEXT,
			);
			if (found === undefined) continue;
			await this.#harness.commit(async (tx) => {
				const doc = await tx.doc(AdmissionDoc);
				assertAdmissionDoc(doc);
				doc.submissions[key] = found.id;
			}, BACKGROUND_CONTEXT);
			restored.push(key);
		}
		// A submission left queued while its conversation is idle will not be advanced
		// by resume(); surface it so recovery does not imply the work is running, and
		// reconcile any marker a prior cancellation persisted (M02-F001).
		const stalled = [];
		const strandedByConversation = new Map();
		for (const [key, request] of Object.entries(mapping.requests ?? {})) {
			const submissionId = mapping.submissions?.[key];
			if (submissionId === undefined) continue;
			if ((await this.#submissionStatus(submissionId, BACKGROUND_CONTEXT)) !== "queued") continue;
			if ((await this.#liveRun(request.conversationId)) !== undefined) continue;
			stalled.push({ requestKey: key, submissionId, conversationId: request.conversationId });
			if (!strandedByConversation.has(request.conversationId)) strandedByConversation.set(request.conversationId, new Set());
			strandedByConversation.get(request.conversationId).add(submissionId);
		}
		const conversations = new Set(Object.values(mapping.requests ?? {}).map((request) => request.conversationId));
		for (const conversationId of conversations) {
			await this.#persistQueueStates(mapping, conversationId, strandedByConversation.get(conversationId) ?? new Set(), BACKGROUND_CONTEXT);
		}
		this.#harness.resume();
		return Object.freeze({ recovered: true, requests: Object.keys(mapping.requests ?? {}).length, restored, unresolvedModels, stalled });
	}

	/**
	 * Abort one explicit scope.
	 *   - `submission`: withdraw/fence exactly that submission; returns the SDK result.
	 *   - `conversation`: cancel only the conversation's FOREGROUND submissions; a
	 *     background submission in it keeps running to its terminal state (V11).
	 *   - `execution`: cancel the background submissions bound to one execution id;
	 *     an unknown id fails closed and aborts nothing. Goal-wide cancellation stays
	 *     refused (product-goal cancel lives in the goal-runtime).
	 *
	 * Returns `"aborted"` only when the scope was fully cancelled. When the SDK cannot
	 * precisely stop a target (a run mixing target and non-target inputs) or leaves a
	 * queued input stranded by an ended run, it returns a structured
	 * `{ result, cancelled, stillRunning, reason }` instead — never a false success
	 * (M02-F001/F002).
	 */
	async abort(scope, context = BACKGROUND_CONTEXT) {
		this.#assertOpen();
		await this.#renew();
		const kind = readScopeKind(scope);
		if (kind === "submission") {
			const submissionId = typeof scope === "object" && scope !== null ? scope.submissionId : undefined;
			if (typeof submissionId !== "number" || !Number.isSafeInteger(submissionId)) {
				throw new ContractRejected("invalid-submission-id", "submission scope requires an integer submissionId");
			}
			const mapping = await this.#readMapping();
			const conversationId = this.#conversationForSubmission(mapping, submissionId);
			return this.#harness.abortSubmission(submissionId, context, conversationId);
		}
		if (kind === "execution") {
			const executionId = typeof scope === "object" && scope !== null ? scope.executionId : undefined;
			if (typeof executionId !== "string" || executionId.trim() === "") {
				// A scope that names no concrete execution (e.g. `{kind:"execution"}`)
				// cannot be resolved and is refused, not silently treated as a global cancel.
				throw new ContractRejected("unsupported-scope", "execution scope requires a nonempty executionId");
			}
			const mapping = await this.#readMapping();
			const bound = Object.entries(mapping.requests ?? {}).filter(([, request]) => {
				const ownership = effectiveOwnership(request);
				return ownership.kind === "background" && ownership.executionId === executionId;
			});
			if (bound.length === 0) {
				// Fail closed: an unknown execution id must not look like a successful cancel.
				throw new ContractRejected("unknown-execution", `no background submissions are bound to execution ${executionId}`);
			}
			const byConversation = new Map();
			for (const [key, request] of bound) {
				const submissionId = mapping.submissions?.[key];
				if (submissionId === undefined) continue;
				if (!byConversation.has(request.conversationId)) byConversation.set(request.conversationId, []);
				byConversation.get(request.conversationId).push(submissionId);
			}
			const outcomes = [];
			for (const [conversationId, ids] of byConversation) {
				const outcome = await this.#cancelSubmissions(mapping, conversationId, ids, context);
				await this.#persistQueueStates(mapping, conversationId, this.#strandedIds(outcome), context);
				outcomes.push(outcome);
			}
			return this.#abortReport(this.#mergeCancellations(outcomes));
		}
		const conversationId = typeof scope === "object" && scope !== null ? scope.conversationId : undefined;
		if (typeof conversationId !== "number" || !Number.isSafeInteger(conversationId)) {
			throw new ContractRejected("invalid-conversation-id", "conversation scope requires an integer conversationId");
		}
		const conversation = await this.#harness.conversation(conversationId, context);
		if (conversation === undefined) throw new ContractRejected("conversation-not-found", `no conversation ${conversationId}`);
		// Cancel the foreground scope only. `conversation.abort()` would sweep every
		// input of the conversation, so foreground submissions are cancelled by scope
		// and background ones are deliberately left running (V11).
		const mapping = await this.#readMapping();
		const foregroundIds = this.#rowsInConversation(mapping, conversationId)
			.filter((row) => row.ownership.kind === "foreground" && row.submissionId !== undefined)
			.map((row) => row.submissionId);
		const outcome = await this.#cancelSubmissions(mapping, conversationId, foregroundIds, context);
		await this.#persistQueueStates(mapping, conversationId, this.#strandedIds(outcome), context);
		return this.#abortReport(outcome);
	}

	/** Durable inspection: harness work plus the lease, registry, and mapping. */
	async inspect() {
		this.#assertOpen();
		await this.#renew();
		const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
		const mapping = await this.#readMapping();
		const ownerState = await this.#owned.inspect();
		const snapshot = this.#registry.snapshot();
		return {
			contractVersion: CONTRACT_VERSION,
			scheduling: inspection.scheduling,
			tasks: inspection.tasks.length,
			liveSubmissions: inspection.submissions,
			lease: { current: ownerState.current, expiresAt: ownerState.expiresAt, schemaVersion: ownerState.schemaVersion },
			registry: {
				extensions: snapshot.installed().map((extension) => extension.name),
				tools: snapshot.tools().map((entry) => entry.tool.name),
			},
			owners: this.#mappingOwners(mapping),
			requests: Object.entries(mapping.requests ?? {}).map(([key, binding]) => ({
				requestKey: key,
				sourceRequestId: binding.sourceRequestId,
				digest: binding.digest,
				conversationId: binding.conversationId,
				submissionId: mapping.submissions?.[key],
			})),
		};
	}

	/** Session-wide Pi usage. */
	async usage() {
		this.#assertOpen();
		await this.#renew();
		return this.#harness.usage(BACKGROUND_CONTEXT);
	}

	/** Stop lease renewal, close the Harness (the now-owner), release the lease. */
	async close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#stopLease();
		try {
			await this.#harness.close(BACKGROUND_CONTEXT);
		} finally {
			await this.#owned.close().catch(() => {});
		}
	}
}
