// Personal AI OS 0.3.0 Wave 5 — consistent quiesced snapshot orchestrator.
//
// This module is the missing piece the P5/P6 readiness map flagged as the single
// biggest gap: "全系统一致性停写快照编排（零）" (p5-p6-readiness-r1.md:24). It
// brings the *orchestration* half of the memory converter's evidence style — a
// consistent per-store snapshot with a redacted manifest carrying sha256 digests,
// byte counts and timestamps — to an arbitrary set of state stores, WITHOUT
// performing any conversion. It is a snapshotter, not a converter.
//
// SCOPE / HARD BOUNDARIES (identical spirit to services/memory/migration.py:12-31)
//   * This module touches only the paths a caller explicitly hands it. It never
//     reads or writes ~/.local/state/personal-ai-os/, ~/.wechat-acp/ or any other
//     production/launchd-owned state. It makes no network calls and reads no
//     environment. The clock is injected via `now`.
//   * A snapshot target is always a NEW directory under `rootDir`; an existing
//     run directory is refused, so an older snapshot is never overwritten. A
//     store's own target directory (`<runDir>/<store.name>`) is likewise refused
//     if it already exists, so an in-run name collision can never overwrite an
//     earlier store.
//   * The manifest and journal hold only names, kinds, states, deterministic
//     operation ids, sha256 digests, byte counts and timestamps — never the
//     store's raw content and never adapter error text.
//
// THE PROBLEM IT SOLVES (why a plain `cp` is wrong)
//   A WAL-mode SQLite database keeps committed data in the ``-wal`` sidecar until
//   a checkpoint; copying just the main file can silently drop everything in the
//   WAL (the readiness map measured 1.2 MB of WAL against a 28 KB main db). The
//   built-in ``sqlite`` adapter therefore uses SQLite's *online backup* API
//   (`node:sqlite`'s `backup`), which reads a consistent transaction snapshot
//   including uncheckpointed WAL content, and then re-opens the produced file and
//   runs `PRAGMA integrity_check` before declaring the snapshot good.
//
// ADAPTER INTERFACE
//   Every store is fronted by an adapter with exactly three methods:
//     quiesce(ctx)            -> pause/steady the store (async allowed)
//     snapshotTo(target, ctx) -> write a consistent snapshot into the NEW dir
//                                `target`; the adapter creates `target` itself
//     resume(ctx)             -> undo quiesce() (async allowed)
//   `ctx` is `{ runId, owner, fence, operationId }` where `fence` is the run's
//   fence token and `operationId` is the deterministic
//   `<runId>:<store.name>:<quiesce|resume>` id. The id is stable across a crash
//   so a recovery replays the *same* logical operation idempotently. The two
//   built-in adapters ignore `ctx` (they are already idempotent); a caller may
//   inject its own adapter for any other kind (the seam the deployment batch will
//   use for the real mem0 / wechat stores).
//
// RUNNABILITY / FAILURE SEMANTICS
//   run() validates EVERY store configuration (existence, kind/type match, name
//   safety, no symlink escape) plus the fresh run directory AND every per-store
//   target/stage before any write or chmod, then quiesces all stores in
//   registration order, snapshots each into `rootDir/<runId>/<name>/`, writes
//   `manifest.json` (+fsync), and finally resumes every quiesced store in reverse
//   order. Any step failing resumes the already-quiesced stores in reverse order
//   and a partial snapshot NEVER surfaces as a success.
//
// THREE-STATE RESULT (why "success" / "failed" is not enough)
//   quiesce() mutates the store (it pauses it) *before* it can return, so a
//   quiesce that throws leaves the store's pause state UNKNOWN — the caller
//   cannot tell "never called", "definitely paused", and "called, outcome
//   unknown" apart from the return value alone. run() therefore reports:
//     * "success"     — every store quiesced, snapshotted and resumed.
//     * "failed"      — a snapshot failed, a resume failed, or the manifest
//                       could not be written.
//     * "needs-review" — some store's quiesce is `unknown` (its pause window is
//                       not provable), even if the subsequent resume succeeded.
//                       A switch driven by this run must be blocked until a human
//                       or a recovery confirms the store's state.
//
// INTENT JOURNAL + OWNER / FENCE (crash recovery)
//   Before it *calls* quiesce the orchestrator persists the intent in
//   `runDir/journal.json` (atomic write: tmp + fsync + rename + fsync dir). After
//   the call returns it records `confirmed`; if it throws it records `unknown`. A
//   SIGKILL between the journal write and the call's return therefore leaves an
//   honest, inspectable record instead of a silent gap. The journal carries
//   `{ journalVersion, runId, owner, fence: { token, issuedAt, expiresAt },
//   startedAt, state, stores: [{ name, kind, quiesce, snapshot, resume }] }` and
//   never any adapter error text — only states and deterministic ids.
//   `inspectRun` is a read-only view of that journal; `recoverRun` resumes the
//   stores the journal still shows as paused, but ONLY for the run's `owner` and
//   ONLY while the fence has not expired. Recovers never re-run a snapshot and
//   never re-execute the caller's user task.
//
// MANIFEST / JOURNAL SCHEMA v2
//   SCHEMA_VERSION 2 adds the per-store `quiesce`/`snapshot`/`resume` substates
//   and replaces the old `skipped` store status with `not-run`; the top-level
//   run status gains the `needs-review` literal. A successful store's evidence
//   fields (`files`/`sha256`/`bytes`/`elapsedMs`) are unchanged so downstream
//   consumers keep working.
//
// GUARDS (M01/RBS provenance lessons)
//   `rootDir` must resolve under the explicitly passed `allowRoot`; a store path
//   must exist and match its kind; a symlink (anywhere in a store path, or at the
//   store path itself) and an unknown kind are refused; the run directory, every
//   store target directory and every staging directory must be new. Store names
//   and the run id must each be a safe single path segment (no separators, no
//   NUL, not `.`/`..`, no reserved manifest/journal name, no `.stage` suffix). All
//   of these checks run before any write/chmod, so a refused configuration leaves
//   the tree's directory entries, bytes and modes exactly as they were.
//
// SINGLE-WRITER / OWNER CONTRACT
//   runDir is created fresh by this run with mode 0700; an orchestrator instance
//   is single-flight (a concurrent run() is rejected with
//   `snapshot-in-progress`); store names are unique and filtered against the
//   reserved names. While those conditions hold there is no in-run target race —
//   `mkdirSync(runDir)` is non-recursive precisely so an existing run dir is
//   refused atomically. A caller that does not satisfy them (e.g. two writers
//   sharing a rootDir, or reusing a store name) is UNSUPPORTED: the per-store
//   target/stage pre-check and the adapter rename guard are friendly errors, not
//   a general-purpose concurrency control.
//
// Dependencies: node:fs, node:path, node:crypto, node:sqlite only.

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

/** On-disk manifest schema understood by this module. */
export const SCHEMA_VERSION = 2;
/** On-disk intent-journal schema understood by this module. */
export const JOURNAL_VERSION = 1;
export const ORCHESTRATOR_VERSION = "snapshot-orchestrator-v1";
export const MANIFEST_NAME = "manifest.json";
export const JOURNAL_NAME = "journal.json";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SEGMENT_LENGTH = 255;
const DEFAULT_FENCE_TTL_MS = 3_600_000;

/** Names that would collide with the orchestrator's own bookkeeping files. */
const RESERVED_SEGMENTS = new Set([
	MANIFEST_NAME,
	`${MANIFEST_NAME}.tmp`,
	JOURNAL_NAME,
	`${JOURNAL_NAME}.tmp`,
]);

/** Built-in kinds; any other kind must be accompanied by a caller adapter. */
const BUILTIN_KINDS = new Set(["sqlite", "filedir"]);

const ERROR_CODES = new Set([
	"invalid-config", "invalid-store", "invalid-run-id", "duplicate-store", "unknown-kind",
	"root-missing", "root-outside-allow-root", "store-missing", "unsafe-store-path",
	"store-type-mismatch", "target-exists", "snapshot-in-progress", "snapshot-integrity",
	"journal-missing", "recovery-not-authorized", "fence-expired", "adapter-failed",
	"quiesce-failed", "snapshot-failed", "resume-failed", "journal-write-failed", "manifest-write-failed",
]);
const ADAPTER_CODES = {
	quiesce: new Set(["quiesce-failed"]),
	snapshot: new Set(["snapshot-failed", "snapshot-integrity", "target-exists", "unsafe-store-path", "store-type-mismatch"]),
	resume: new Set(["resume-failed"]),
};

/** A redacted orchestrator failure. Never carries store content. */
export class SnapshotOrchestratorError extends Error {
	constructor(code, message) {
		const safeCode = ERROR_CODES.has(code) ? code : "adapter-failed";
		super(message ?? safeCode);
		this.name = "SnapshotOrchestratorError";
		this.code = safeCode;
	}
}

// Root-level system aliases (macOS) the OS installer creates and that a private
// temp tree legitimately lives under. Mirrors migration.py:_ROOT_SYSTEM_ALIASES:
// only these exact link->target pairs, owned by root, are exempt from the symlink
// refusal. An arbitrary "/"-child symlink (or an alias pointing elsewhere) is not.
const ROOT_SYSTEM_ALIASES = new Map([
	["/var", "/private/var"],
	["/tmp", "/private/tmp"],
	["/etc", "/private/etc"],
]);

function isRootSystemAlias(path) {
	if (dirname(path) !== sep) return false;
	const expected = ROOT_SYSTEM_ALIASES.get(path);
	if (expected === undefined) return false;
	try {
		if (realpathSync(path) !== realpathSync(expected)) return false;
		return lstatSync(path).uid === 0;
	} catch {
		return false;
	}
}

/**
 * Symlink components of an absolute path (self + ancestors), excluding verified
 * root-level system aliases. Any other symlink is a redirect that could point a
 * snapshot at a victim, so it is refused upstream.
 */
function symlinkComponents(path) {
	const found = [];
	let current = resolvePath(path);
	for (;;) {
		const parent = dirname(current);
		if (parent === current) break;
		try {
			if (lstatSync(current).isSymbolicLink() && !isRootSystemAlias(current)) {
				found.push(current);
			}
		} catch {
			// A missing component is reported as store-missing elsewhere.
		}
		current = parent;
	}
	return found;
}

/** True when `child` is `parent` itself or lives below it (both absolute). */
function isWithin(child, parent) {
	if (child === parent) return true;
	const base = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(base);
}

/** True when any directory entry (file, dir or symlink) exists at `path`. */
function entryExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function makeClock(now) {
	if (now !== undefined && typeof now !== "function") {
		throw new SnapshotOrchestratorError("invalid-config", "now must be a function when provided");
	}
	return now ?? Date.now;
}

/**
 * Assert `value` is a safe single path segment usable as a directory name under
 * the run directory: non-empty, at most 255 chars, not `.`/`..`, no path
 * separator (POSIX or Windows) and no NUL, not one of the orchestrator's own
 * reserved names, and not a staging suffix (`*.stage`). Throws `code` on any
 * violation; `what` names the offending item for the (throw-only) message.
 */
function assertSafeSegment(value, code, what) {
	if (typeof value !== "string" || value.length === 0) {
		throw new SnapshotOrchestratorError(code, `${what} must be a non-empty string`);
	}
	if (value.length > MAX_SEGMENT_LENGTH) {
		throw new SnapshotOrchestratorError(code, `${what} must be at most ${MAX_SEGMENT_LENGTH} characters`);
	}
	if (value === "." || value === "..") {
		throw new SnapshotOrchestratorError(code, `${what} must not be "." or ".."`);
	}
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
		throw new SnapshotOrchestratorError(code, `${what} must be a single path segment`);
	}
	if (RESERVED_SEGMENTS.has(value)) {
		throw new SnapshotOrchestratorError(code, `${what} must not use a reserved name`);
	}
	if (value.endsWith(".stage")) {
		throw new SnapshotOrchestratorError(code, `${what} must not end with ".stage"`);
	}
	return value;
}

/**
 * A content-free, path-free failure record for the manifest, the journal-adjacent
 * resume list and the run DTO. It reads ONLY the error's identity — never its
 * name, message, stack or cause — so an adapter error can never smuggle a secret
 * (a leaked credential in a message, say) into a persisted file. Our own
 * SnapshotOrchestratorError is checked against a stage-specific code allowlist;
 * every unknown error collapses to the fixed `<stage>-failed` code.
 */
function errorRecord(error, stage, store) {
	const candidate = error instanceof SnapshotOrchestratorError ? error.code : null;
	const code = ADAPTER_CODES[stage]?.has(candidate) ? candidate : `${stage}-failed`;
	const record = { code, stage };
	if (store !== undefined) record.store = store;
	return record;
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(dir, acc = []) {
	for (const name of readdirSync(dir).sort()) {
		const child = join(dir, name);
		const stats = lstatSync(child);
		if (stats.isDirectory()) walkFiles(child, acc);
		else if (stats.isFile()) acc.push(child);
	}
	return acc;
}

/**
 * Evidence for one store's snapshot directory: per-file sha256 + bytes plus a
 * combined digest over the sorted (relative path, sha256) listing and the total
 * byte count. The orchestrator computes this itself — it never trusts the
 * adapter's account of what it wrote.
 */
function collectEvidence(targetDir) {
	const files = walkFiles(targetDir)
		.map((absolute) => ({
			path: relative(targetDir, absolute),
			sha256: hashFile(absolute),
			bytes: statSync(absolute).size,
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const hasher = createHash("sha256");
	let total = 0;
	for (const file of files) {
		hasher.update(file.path);
		hasher.update("\0");
		hasher.update(file.sha256);
		hasher.update("\n");
		total += file.bytes;
	}
	return { files, sha256: hasher.digest("hex"), bytes: total };
}

function fsyncPath(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is not portable; a failure here never invalidates the
		// snapshot (the file write itself is already durable enough for our needs).
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Atomically write + fsync a JSON file (temp file, fsync, rename, fsync dir). */
function writeAtomicJsonSync(dir, name, value) {
	const target = join(dir, name);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
	fsyncPath(tmp);
	renameSync(tmp, target);
	fsyncPath(dir);
	return target;
}

function writeManifestSync(runDir, manifest) {
	return writeAtomicJsonSync(runDir, MANIFEST_NAME, manifest);
}

function writeJournalSync(runDir, journal) {
	return writeAtomicJsonSync(runDir, JOURNAL_NAME, journal);
}

/**
 * Resolve + authorize a snapshot root against an explicit allowed root. Shared by
 * createSnapshotOrchestrator, inspectRun and recoverRun so all three apply the
 * identical containment boundary. Pure read-only (realpath + stat); throws
 * closed on a missing root, a non-directory root or an out-of-bounds root.
 */
function resolveRoots({ rootDir, allowRoot }) {
	if (typeof rootDir !== "string" || rootDir.length === 0) {
		throw new SnapshotOrchestratorError("invalid-config", "rootDir must be a non-empty string");
	}
	if (typeof allowRoot !== "string" || allowRoot.length === 0) {
		throw new SnapshotOrchestratorError("invalid-config", "allowRoot is required and must be a non-empty string");
	}
	if (!isAbsolute(allowRoot)) {
		throw new SnapshotOrchestratorError("invalid-config", "allowRoot must be an absolute path");
	}
	const absRoot = resolvePath(rootDir);
	const absAllow = resolvePath(allowRoot);

	let realRoot;
	try {
		realRoot = realpathSync(absRoot);
	} catch {
		throw new SnapshotOrchestratorError("root-missing", "rootDir does not exist");
	}
	let realAllow;
	try {
		realAllow = realpathSync(absAllow);
	} catch {
		throw new SnapshotOrchestratorError("root-missing", "allowRoot does not exist");
	}
	if (!statSync(realRoot).isDirectory()) {
		throw new SnapshotOrchestratorError("root-missing", "rootDir is not a directory");
	}
	if (!isWithin(realRoot, realAllow)) {
		throw new SnapshotOrchestratorError("root-outside-allow-root", "rootDir resolves outside the allowed root");
	}
	return { realRoot, realAllow };
}

/**
 * Built-in `sqlite` adapter: an online-backup (WAL-consistent) snapshot of a live
 * database file. `quiesce`/`resume` are deliberate no-ops — the online backup
 * reads a single transaction snapshot, so the source is never mutated (no
 * checkpoint on the live db) and no writer needs to be paused for correctness.
 */
function makeSqliteAdapter(path) {
	return {
		async quiesce() {},
		async snapshotTo(targetDir) {
			mkdirSync(targetDir, { mode: DIR_MODE });
			const target = join(targetDir, "snapshot.sqlite");
			const source = new DatabaseSync(path, { readOnly: true });
			try {
				await backup(source, target);
			} finally {
				source.close();
			}
			// The online backup inherits the source's journal mode; a WAL-mode
			// snapshot would spawn -wal/-shm sidecars the moment it is opened. Fold
			// the snapshot back into a single self-contained file, then re-open it
			// and prove it is a coherent database before we ever report success.
			const check = new DatabaseSync(target);
			try {
				check.exec("PRAGMA journal_mode=DELETE");
				const row = check.prepare("PRAGMA integrity_check").get();
				const value = row === undefined ? "" : String(Object.values(row)[0] ?? "");
				if (value !== "ok") {
					throw new SnapshotOrchestratorError("snapshot-integrity", "sqlite snapshot failed integrity_check");
				}
			} finally {
				check.close();
			}
			chmodSync(target, FILE_MODE);
			return { files: ["snapshot.sqlite"] };
		},
		async resume() {},
	};
}

/** Recursively copy a directory tree, refusing symlinks and special files. */
function copyTreeSync(source, target) {
	const stats = lstatSync(source);
	if (stats.isSymbolicLink()) {
		throw new SnapshotOrchestratorError("unsafe-store-path", "filedir source contains a symlink");
	}
	if (stats.isDirectory()) {
		mkdirSync(target, { mode: DIR_MODE });
		for (const name of readdirSync(source).sort()) {
			copyTreeSync(join(source, name), join(target, name));
		}
		return;
	}
	if (stats.isFile()) {
		writeFileSync(target, readFileSync(source), { mode: FILE_MODE });
		return;
	}
	throw new SnapshotOrchestratorError("store-type-mismatch", "filedir source contains a non-regular entry");
}

/**
 * Built-in `filedir` adapter: an atomic directory copy. The tree is copied into a
 * sibling staging directory first and then `rename`d into place, so a caller
 * never observes a half-copied snapshot directory. The rename is guarded: if the
 * target already exists (an in-run name collision or a racing writer) the staging
 * directory is removed and `target-exists` is thrown — an existing directory is
 * never overwritten.
 */
function makeFiledirAdapter(path) {
	return {
		async quiesce() {},
		async snapshotTo(targetDir) {
			const stage = `${targetDir}.stage`;
			try {
				copyTreeSync(path, stage);
				if (entryExists(targetDir)) {
					throw new SnapshotOrchestratorError("target-exists", "filedir target already exists");
				}
				renameSync(stage, targetDir);
			} catch (error) {
				rmSync(stage, { recursive: true, force: true });
				throw error;
			}
		},
		async resume() {},
	};
}

/** Deterministic per-store operation context handed to an adapter method. */
function makeOperationContext({ runId, owner, fenceToken, storeName, operation }) {
	return {
		runId,
		owner,
		fence: fenceToken,
		operationId: `${runId}:${storeName}:${operation}`,
	};
}

/**
 * Create a snapshot orchestrator rooted at `rootDir`.
 *
 * `allowRoot` is REQUIRED and must be an absolute path: the snapshot root must
 * resolve under it. A missing / non-string / relative `allowRoot` (or a missing
 * `rootDir`) is refused at construction time with `invalid-config`, before any
 * filesystem access — fail closed rather than silently widening the boundary.
 *
 * @param {object} options
 * @param {string} options.rootDir   snapshot root; must exist, be a directory
 *                                   and resolve under `allowRoot`.
 * @param {string} options.allowRoot REQUIRED absolute allowed root the snapshot
 *                                   root must live under.
 * @param {() => number} [options.now] injected clock (defaults to Date.now).
 * @param {string} [options.owner]   identity recorded in the journal and
 *                                   required to authorize a later recoverRun
 *                                   (defaults to a fresh random UUID).
 * @param {number} [options.fenceTtlMs] how long the run's fence stays valid for
 *                                   recovery (defaults to one hour; must be a
 *                                   positive finite number).
 */
export function createSnapshotOrchestrator({ rootDir, allowRoot, now, owner, fenceTtlMs } = {}) {
	const clock = makeClock(now);
	const { realRoot } = resolveRoots({ rootDir, allowRoot });

	let runOwner;
	if (owner === undefined) {
		runOwner = randomUUID();
	} else if (typeof owner !== "string" || owner.length === 0) {
		throw new SnapshotOrchestratorError("invalid-config", "owner must be a non-empty string when provided");
	} else {
		runOwner = owner;
	}
	const ttl = fenceTtlMs === undefined ? DEFAULT_FENCE_TTL_MS : fenceTtlMs;
	if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
		throw new SnapshotOrchestratorError("invalid-config", "fenceTtlMs must be a positive finite number");
	}

	const stores = [];
	const names = new Set();
	let seq = 0;
	let running = false;

	function assertIdle() {
		if (running) {
			throw new SnapshotOrchestratorError("snapshot-in-progress", "a snapshot run is already in progress");
		}
	}

	/**
	 * Register a store to be snapshotted. `kind` is one of the built-ins
	 * (`sqlite`, `filedir`) or any custom string accompanied by an `adapter`
	 * implementing `{ quiesce, snapshotTo, resume }`. The store `name` must be a
	 * safe single path segment (it becomes a directory under the run dir) and an
	 * unknown kind with no adapter is refused here, before any run.
	 */
	function registerStore({ name, kind, path, adapter } = {}) {
		assertIdle();
		assertSafeSegment(name, "invalid-store", "store name");
		if (names.has(name)) {
			throw new SnapshotOrchestratorError("duplicate-store", `store already registered: ${name}`);
		}
		if (typeof kind !== "string" || kind.length === 0) {
			throw new SnapshotOrchestratorError("invalid-store", "store kind must be a non-empty string");
		}
		let resolved;
		if (adapter !== undefined) {
			if (
				adapter === null ||
				typeof adapter.quiesce !== "function" ||
				typeof adapter.snapshotTo !== "function" ||
				typeof adapter.resume !== "function"
			) {
				throw new SnapshotOrchestratorError(
					"invalid-store",
					"injected adapter must implement quiesce(), snapshotTo() and resume()",
				);
			}
			resolved = adapter;
		} else if (BUILTIN_KINDS.has(kind)) {
			if (typeof path !== "string" || path.length === 0) {
				throw new SnapshotOrchestratorError("invalid-store", `store ${name} requires a path`);
			}
			resolved = kind === "sqlite" ? makeSqliteAdapter(resolvePath(path)) : makeFiledirAdapter(resolvePath(path));
		} else {
			throw new SnapshotOrchestratorError("unknown-kind", `unknown store kind: ${kind}`);
		}
		names.add(name);
		stores.push({
			name,
			kind,
			path: typeof path === "string" && path.length > 0 ? resolvePath(path) : undefined,
			adapter: resolved,
		});
		return api;
	}

	function listStores() {
		return stores.map((store) => ({ name: store.name, kind: store.kind, path: store.path }));
	}

	/**
	 * Validate every store before any write/chmod: the path must exist, must not
	 * be a symlink (nor sit under one) and must match its kind's expected type.
	 * Throws fail-closed; a throw here leaves the tree byte-, mode- and entry-
	 * identical.
	 */
	function validateStores() {
		for (const store of stores) {
			if (store.path === undefined) continue;
			let stats;
			try {
				stats = lstatSync(store.path);
			} catch {
				throw new SnapshotOrchestratorError("store-missing", `store ${store.name} path does not exist`);
			}
			if (stats.isSymbolicLink()) {
				throw new SnapshotOrchestratorError("unsafe-store-path", `store ${store.name} path is a symlink`);
			}
			if (symlinkComponents(store.path).length > 0) {
				throw new SnapshotOrchestratorError("unsafe-store-path", `store ${store.name} path sits under a symlink`);
			}
			if (store.kind === "sqlite" && !stats.isFile()) {
				throw new SnapshotOrchestratorError("store-type-mismatch", `store ${store.name} is not a regular file`);
			}
			if (store.kind === "filedir" && !stats.isDirectory()) {
				throw new SnapshotOrchestratorError("store-type-mismatch", `store ${store.name} is not a directory`);
			}
		}
	}

	/**
	 * Pre-flight the run directory and every per-store target/stage for existence
	 * — BEFORE any mkdir. This produces the friendly `target-exists` error, but it
	 * is NOT the atomic guard: the non-recursive `mkdirSync(runDir)` below is.
	 */
	function preflightTargets(runDir) {
		if (existsSync(runDir)) {
			throw new SnapshotOrchestratorError("target-exists", `run directory already exists: ${basenameOf(runDir)}`);
		}
		for (const store of stores) {
			const targetDir = join(runDir, store.name);
			const stage = `${targetDir}.stage`;
			if (!isWithin(targetDir, runDir) || targetDir === runDir) {
				throw new SnapshotOrchestratorError(
					"invalid-store",
					`store ${store.name} target escapes the run directory`,
				);
			}
			if (existsSync(targetDir) || existsSync(stage)) {
				throw new SnapshotOrchestratorError("target-exists", `store ${store.name} target already exists`);
			}
		}
	}

	function defaultRunId() {
		seq += 1;
		return `run-${clock()}-${seq}`;
	}

	/**
	 * Perform one consistent snapshot run. Returns a result object; guard
	 * violations (bad config, symlink, unknown kind, unsafe name, existing target,
	 * concurrent run) throw SnapshotOrchestratorError, while an operational store
	 * failure is reported as `{ status: 'failed' | 'needs-review', ... }` with a
	 * matching manifest and journal.
	 */
	async function run(options = {}) {
		assertIdle();
		running = true;
		try {
			// 1. Validate everything BEFORE any write/chmod. A throw here leaves the
			//    filesystem byte-, mode- and entry-identical.
			validateStores();
			const runId = options.runId !== undefined ? options.runId : defaultRunId();
			assertSafeSegment(runId, "invalid-run-id", "runId");
			const runDir = join(realRoot, runId);
			if (!isWithin(runDir, realRoot) || runDir === realRoot) {
				throw new SnapshotOrchestratorError("invalid-run-id", "runId escapes the snapshot root");
			}
			preflightTargets(runDir);

			// 2. All validation passed: only now create directories (private).
			mkdirSync(realRoot, { recursive: true, mode: DIR_MODE });
			mkdirSync(runDir, { mode: DIR_MODE });
			chmodSync(runDir, DIR_MODE);

			const startedAt = clock();
			const fence = {
				token: randomUUID(),
				issuedAt: startedAt,
				expiresAt: startedAt + ttl,
			};
			// The journal mirrors the run's honest, crash-survivable state. It is
			// written immediately after the run dir exists, before any store is
			// touched.
			const journal = {
				journalVersion: JOURNAL_VERSION,
				runId,
				owner: runOwner,
				fence: { token: fence.token, issuedAt: fence.issuedAt, expiresAt: fence.expiresAt },
				startedAt,
				state: "running",
				stores: stores.map((store) => ({
					name: store.name,
					kind: store.kind,
					quiesce: "not-attempted",
					snapshot: "not-attempted",
					resume: "not-attempted",
				})),
			};
			// Initial intent must be durable before any adapter is called.
			try {
				writeJournalSync(runDir, journal);
			} catch {
				throw new SnapshotOrchestratorError("journal-write-failed", "journal persistence failed");
			}
			let journalFailed = false;
			function recordJournal() {
				try {
					writeJournalSync(runDir, journal);
					return true;
				} catch {
					journalFailed = true;
					return false;
				}
			}
			const issued = new Set();

			const evidence = new Array(stores.length).fill(null);
			const elapsed = new Array(stores.length).fill(null);
			const storeErrors = new Array(stores.length).fill(null);
			const quiesceOrder = [];
			const resumeOrder = [];
			const resumeErrors = [];
			let failure = null;

			// 3. Quiesce every store in registration order. Persist the intent BEFORE
			//    the call: a crash between the journal write and the call's return is
			//    then recorded as `intent`, not lost.
			for (let index = 0; index < stores.length; index += 1) {
				const store = stores[index];
				const state = journal.stores[index];
				state.quiesce = "intent";
				if (!recordJournal()) {
					state.quiesce = "not-attempted";
					break;
				}
				quiesceOrder.push(store.name);
				issued.add(index);
				try {
					await store.adapter.quiesce(
						makeOperationContext({ runId, owner: runOwner, fenceToken: fence.token, storeName: store.name, operation: "quiesce" }),
					);
					state.quiesce = "confirmed";
					if (!recordJournal()) break;
				} catch (error) {
					// The store was mutated (or may have been) before it threw; only the
					// journal can say so honestly now. Abort the run without snapshotting.
					state.quiesce = "unknown";
					recordJournal();
					failure = errorRecord(error, "quiesce", store.name);
					break;
				}
			}

			// 4. Snapshot each store into its own fresh directory — only if every
			//    quiesce succeeded.
			if (failure === null && !journalFailed) {
				for (let index = 0; index < stores.length; index += 1) {
					const store = stores[index];
					const state = journal.stores[index];
					const targetDir = join(runDir, store.name);
					const t0 = clock();
					try {
						await store.adapter.snapshotTo(
							targetDir,
							makeOperationContext({ runId, owner: runOwner, fenceToken: fence.token, storeName: store.name, operation: "snapshot" }),
						);
						evidence[index] = collectEvidence(targetDir);
						elapsed[index] = clock() - t0;
						state.snapshot = "ok";
						if (!recordJournal()) break;
					} catch (error) {
						elapsed[index] = clock() - t0;
						storeErrors[index] = errorRecord(error, "snapshot", store.name);
						state.snapshot = "failed";
						recordJournal();
						failure = storeErrors[index];
						break;
					}
				}
			}

			// 5. Resume every store whose quiesce was ISSUED (confirmed, unknown or
			//    intent) in reverse order. `intent`/`unknown` mean the pause may or
			//    may not have applied, so resume must be idempotent. A resume that
			//    fails is recorded but never aborts the rest of the chain.
			for (let index = stores.length - 1; index >= 0; index -= 1) {
				const store = stores[index];
				const state = journal.stores[index];
				if (!issued.has(index)) {
					continue;
				}
				resumeOrder.push(store.name);
				try {
					await store.adapter.resume(
						makeOperationContext({ runId, owner: runOwner, fenceToken: fence.token, storeName: store.name, operation: "resume" }),
					);
					state.resume = "confirmed";
				} catch (error) {
					state.resume = "failed";
					resumeErrors.push(errorRecord(error, "resume", store.name));
				}
				recordJournal();
			}

			// 6. Failed persistence leaves recovery uncertain regardless of cleanup.
			//    Otherwise hard failures win, then unprovable pause windows.
			const anySnapshotFailed = journal.stores.some((state) => state.snapshot === "failed");
			const anyUnknown = journal.stores.some((state) => state.quiesce === "unknown");
			const hardFailure = resumeErrors.length > 0 || anySnapshotFailed;
			let status = "success";
			if (hardFailure) status = "failed";
			else if (anyUnknown) status = "needs-review";
			if (journalFailed) status = "needs-review";

			const topError = journalFailed ? { code: "journal-write-failed", stage: "journal-write" }
				: failure ?? (resumeErrors.length > 0 ? resumeErrors[0] : null);
			const finishedAt = clock();
			const manifestStores = stores.map((store, index) => {
				const state = journal.stores[index];
				const entry = {
					name: store.name,
					kind: store.kind,
					status: state.snapshot === "ok" ? "ok" : state.snapshot === "failed" ? "failed" : "not-run",
					quiesce: state.quiesce,
					snapshot: state.snapshot,
					resume: state.resume,
				};
				if (state.snapshot === "ok" && evidence[index] !== null) {
					Object.assign(entry, evidence[index]);
					entry.elapsedMs = elapsed[index];
				}
				if (state.snapshot === "failed") {
					entry.error = storeErrors[index];
					entry.elapsedMs = elapsed[index];
				}
				return entry;
			});
			const manifest = {
				schemaVersion: SCHEMA_VERSION,
				orchestratorVersion: ORCHESTRATOR_VERSION,
				runId,
				startedAt,
				finishedAt,
				status,
				stores: manifestStores,
				quiesceOrder,
				resumeOrder,
				resumeErrors,
				error: topError,
				journalPersistence: journalFailed ? "uncertain" : "confirmed",
				network_calls: 0,
			};

			journal.state = status === "success" ? "completed" : "aborted";
			if (!recordJournal()) {
				status = "needs-review";
				manifest.status = status;
				manifest.error = { code: "journal-write-failed", stage: "journal-write" };
				manifest.journalPersistence = "uncertain";
			}
			let manifestPath = null;
			try {
				manifestPath = writeManifestSync(runDir, manifest);
			} catch {
				// A failed manifest write must never masquerade as success, and the
				// raw filesystem error is never persisted — only a fixed code.
				status = "failed";
				manifest.status = "failed";
				manifest.error = { code: "manifest-write-failed", stage: "manifest-write" };
			}

			// Manifest failure still updates the journal, without blocking cleanup.
			if (manifestPath === null) {
				journal.state = "aborted";
				if (!recordJournal()) {
					status = "needs-review";
					manifest.status = status;
					manifest.journalPersistence = "uncertain";
				}
			}

			return {
				status,
				runId,
				dir: runDir,
				manifestPath,
				startedAt,
				finishedAt,
				stores: manifestStores,
				resumeErrors,
				journalPersistence: manifest.journalPersistence,
				error: manifest.error,
				manifest,
			};
		} finally {
			running = false;
		}
	}

	const api = { registerStore, run, listStores };
	return api;
}

/** basename without importing node:path's basename twice in two helper scopes. */
function basenameOf(path) {
	const parts = path.split(sep);
	return parts[parts.length - 1];
}

/**
 * Read-only inspection of a run's intent journal. Applies the same root /
 * allowRoot containment as createSnapshotOrchestrator (nothing is written).
 * Returns the journal's honest state plus the derived views a caller needs to
 * decide whether to recover:
 *   * needsReview — stores whose quiesce is `unknown` or `intent`
 *                   (pause window unprovable)
 *   * resumable   — stores whose quiesce was issued and whose resume is not yet
 *                   confirmed (the set recoverRun would act on)
 *
 * @param {object} options
 * @param {string} options.rootDir
 * @param {string} options.allowRoot
 * @param {string} options.runId
 */
export function inspectRun({ rootDir, allowRoot, runId } = {}) {
	const { realRoot } = resolveRoots({ rootDir, allowRoot });
	assertSafeSegment(runId, "invalid-run-id", "runId");
	const runDir = join(realRoot, runId);
	if (!isWithin(runDir, realRoot) || runDir === realRoot) {
		throw new SnapshotOrchestratorError("invalid-run-id", "runId escapes the snapshot root");
	}
	const journalPath = join(runDir, JOURNAL_NAME);
	if (!existsSync(journalPath)) {
		throw new SnapshotOrchestratorError("journal-missing", `no journal for run ${runId}`);
	}
	const journal = JSON.parse(readFileSync(journalPath, "utf8"));
	const stores = Array.isArray(journal.stores) ? journal.stores : [];
	const needsReview = stores.filter((state) => state.quiesce === "unknown" || state.quiesce === "intent").map((state) => state.name);
	const resumable = stores
		.filter(
			(state) =>
				(state.quiesce === "intent" || state.quiesce === "unknown" || state.quiesce === "confirmed") &&
				state.resume !== "confirmed",
		)
		.map((state) => state.name);
	return {
		runId: journal.runId,
		owner: journal.owner,
		state: journal.state,
		stores,
		needsReview,
		resumable,
	};
}

/**
 * Resume the stores a crashed/aborted run left paused — and nothing else. Never
 * re-runs a snapshot and never re-executes the caller's user task. Authorized by
 * `owner === journal.owner` and bounded by the run's fence: once `now()`
 * (`Date.now` by default) is past `fence.expiresAt` no store is touched. For each
 * resumable store the caller must supply an `adapter` (missing -> `invalid-store`,
 * validated for ALL stores before any resume is attempted); `resume(ctx)` is
 * replayed with the SAME fence token and the SAME deterministic operationId the
 * original run used, so an idempotent adapter is safe to replay. Each outcome is
 * written back to the journal (confirmed/failed). Persistence failure never
 * interrupts the remaining resumes; it returns needs-review with uncertain
 * journal persistence, rather than claiming recovery was recorded.
 *
 * @param {object} options
 * @param {string} options.rootDir
 * @param {string} options.allowRoot
 * @param {string} options.runId
 * @param {string} options.owner
 * @param {{name: string, adapter: object}[]} [options.stores]
 * @param {() => number} [options.now]
 */
export async function recoverRun({ rootDir, allowRoot, runId, owner, stores, now } = {}) {
	const { realRoot } = resolveRoots({ rootDir, allowRoot });
	assertSafeSegment(runId, "invalid-run-id", "runId");
	const runDir = join(realRoot, runId);
	if (!isWithin(runDir, realRoot) || runDir === realRoot) {
		throw new SnapshotOrchestratorError("invalid-run-id", "runId escapes the snapshot root");
	}
	const journalPath = join(runDir, JOURNAL_NAME);
	if (!existsSync(journalPath)) {
		throw new SnapshotOrchestratorError("journal-missing", `no journal for run ${runId}`);
	}
	const journal = JSON.parse(readFileSync(journalPath, "utf8"));

	// Authorization first: a caller who is not the run's owner learns nothing and
	// touches nothing.
	if (typeof owner !== "string" || owner.length === 0 || owner !== journal.owner) {
		throw new SnapshotOrchestratorError("recovery-not-authorized", "owner does not match the run journal");
	}
	const clock = makeClock(now);
	if (clock() > journal.fence.expiresAt) {
		throw new SnapshotOrchestratorError("fence-expired", "the run fence has expired; recovery is refused");
	}

	const adapters = new Map();
	for (const entry of stores ?? []) {
		if (entry && typeof entry.name === "string") adapters.set(entry.name, entry.adapter);
	}

	const journalStores = Array.isArray(journal.stores) ? journal.stores : [];
	const resumable = journalStores.filter(
		(state) =>
			(state.quiesce === "intent" || state.quiesce === "unknown" || state.quiesce === "confirmed") &&
			state.resume !== "confirmed",
	);
	// Fail closed: prove every resumable store has an adapter before resuming any.
	for (const state of resumable) {
		const adapter = adapters.get(state.name);
		if (adapter === null || adapter === undefined || typeof adapter.resume !== "function") {
			throw new SnapshotOrchestratorError("invalid-store", `no adapter supplied for store ${state.name}`);
		}
	}

	const resumed = [];
	const failed = [];
	let journalFailed = false;
	function recordRecovery() {
		try {
			writeJournalSync(runDir, journal);
		} catch {
			journalFailed = true;
		}
	}
	for (const state of resumable) {
		const adapter = adapters.get(state.name);
		try {
			await adapter.resume(
				makeOperationContext({
					runId: journal.runId,
					owner: journal.owner,
					fenceToken: journal.fence.token,
					storeName: state.name,
					operation: "resume",
				}),
			);
			state.resume = "confirmed";
			resumed.push(state.name);
		} catch {
			state.resume = "failed";
			failed.push(state.name);
		}
		recordRecovery();
	}

	journal.state = failed.length === 0 ? "recovered" : "aborted";
	recordRecovery();
	if (journalFailed) return {
		runId: journal.runId, resumed, failed, status: "needs-review", journalPersistence: "uncertain",
		error: { code: "journal-write-failed", stage: "journal-write" },
	};
	return { runId: journal.runId, resumed, failed };
}
