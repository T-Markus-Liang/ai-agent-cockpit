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
//     run directory is refused, so an older snapshot is never overwritten.
//   * The manifest holds only names, kinds, sha256 digests, byte counts and
//     timestamps — never the store's raw content.
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
//     quiesce()            -> pause/steady the store (async allowed)
//     snapshotTo(target)   -> write a consistent snapshot into the NEW dir
//                             `target`; the adapter creates `target` itself
//     resume()             -> undo quiesce() (async allowed)
//   Two adapters are built in — `sqlite` (online backup + integrity check) and
//   `filedir` (atomic directory copy: copy into a staging dir, then rename) —
//   and a caller may inject its own adapter for any other kind (the seam the
//   deployment batch will use for the real mem0 / wechat stores).
//
// RUNNABILITY / FAILURE SEMANTICS
//   run() validates EVERY store configuration (existence, kind/type match, no
//   symlink escape) and the fresh target directory BEFORE any write or chmod, then
//   quiesces all stores in registration order, snapshots each into
//   `rootDir/<runId>/<name>/`, writes `manifest.json` (+fsync), and finally
//   resumes every quiesced store in reverse order. Any step failing resumes the
//   already-quiesced stores in reverse order, records the failure in the manifest
//   with status 'failed' and returns `{ status: 'failed', ... }` — a partial
//   snapshot NEVER surfaces as a success. A resume that itself fails is recorded
//   honestly (in `resumeErrors`) and never aborts the rest of the cleanup chain.
//
// GUARDS (M01/RBS provenance lessons)
//   `rootDir` must resolve under the explicitly passed `allowRoot`; a store path
//   must exist and match its kind; a symlink (anywhere in a store path, or at the
//   store path itself) and an unknown kind are refused; the run directory must be
//   new. All of these checks run before any write/chmod, so a refused configuration
//   leaves the tree's directory entries, bytes and modes exactly as they were.
//
// Single-flight: one orchestrator instance runs at most one run at a time; a
// concurrent run() is rejected with SnapshotOrchestratorError('snapshot-in-progress').
//
// Dependencies: node:fs, node:path, node:crypto, node:sqlite only.

import { createHash } from "node:crypto";
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
export const SCHEMA_VERSION = 1;
export const ORCHESTRATOR_VERSION = "snapshot-orchestrator-v1";
export const MANIFEST_NAME = "manifest.json";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Built-in kinds; any other kind must be accompanied by a caller adapter. */
const BUILTIN_KINDS = new Set(["sqlite", "filedir"]);

/** A redacted orchestrator failure. Never carries store content. */
export class SnapshotOrchestratorError extends Error {
	constructor(code, message) {
		super(message ?? code);
		this.name = "SnapshotOrchestratorError";
		this.code = code;
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

function makeClock(now) {
	if (now !== undefined && typeof now !== "function") {
		throw new SnapshotOrchestratorError("invalid-config", "now must be a function when provided");
	}
	return now ?? Date.now;
}

/** A concise, path-bearing but content-free reason string for the manifest. */
function describe(error) {
	if (error instanceof SnapshotOrchestratorError) return `${error.code}: ${error.message}`;
	const name = error && error.name ? error.name : "Error";
	const message = error && error.message ? error.message : String(error);
	return `${name}: ${message}`.slice(0, 500);
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

/** Atomically write + fsync the manifest (temp file, fsync, rename, fsync dir). */
function writeManifestSync(runDir, manifest) {
	const target = join(runDir, MANIFEST_NAME);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });
	fsyncPath(tmp);
	renameSync(tmp, target);
	fsyncPath(runDir);
	return target;
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
 * never observes a half-copied snapshot directory.
 */
function makeFiledirAdapter(path) {
	return {
		async quiesce() {},
		async snapshotTo(targetDir) {
			const stage = `${targetDir}.stage`;
			try {
				copyTreeSync(path, stage);
				renameSync(stage, targetDir);
			} catch (error) {
				rmSync(stage, { recursive: true, force: true });
				throw error;
			}
		},
		async resume() {},
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
 */
export function createSnapshotOrchestrator({ rootDir, allowRoot, now } = {}) {
	if (typeof rootDir !== "string" || rootDir.length === 0) {
		throw new SnapshotOrchestratorError("invalid-config", "rootDir must be a non-empty string");
	}
	if (typeof allowRoot !== "string" || allowRoot.length === 0) {
		throw new SnapshotOrchestratorError("invalid-config", "allowRoot is required and must be a non-empty string");
	}
	if (!isAbsolute(allowRoot)) {
		throw new SnapshotOrchestratorError("invalid-config", "allowRoot must be an absolute path");
	}
	const clock = makeClock(now);
	const absRoot = resolvePath(rootDir);
	const absAllow = resolvePath(allowRoot);

	// Pure read-only containment check: the snapshot root must resolve under the
	// caller's explicitly passed allowed root. No mutation happens here.
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
	 * implementing `{ quiesce, snapshotTo, resume }`. An unknown kind with no
	 * adapter is refused here, before any run.
	 */
	function registerStore({ name, kind, path, adapter } = {}) {
		assertIdle();
		if (typeof name !== "string" || name.length === 0) {
			throw new SnapshotOrchestratorError("invalid-store", "store name must be a non-empty string");
		}
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

	function defaultRunId() {
		seq += 1;
		return `run-${clock()}-${seq}`;
	}

	/**
	 * Perform one consistent snapshot run. Returns a result object; guard
	 * violations (bad config, symlink, unknown kind, existing target, concurrent
	 * run) throw SnapshotOrchestratorError, while an operational store failure is
	 * reported as `{ status: 'failed', ... }` with a matching manifest.
	 */
	async function run(options = {}) {
		assertIdle();
		running = true;
		try {
			// 1. Validate everything BEFORE any write/chmod.
			validateStores();

			const runId = options.runId !== undefined ? options.runId : defaultRunId();
			if (typeof runId !== "string" || runId.length === 0) {
				throw new SnapshotOrchestratorError("invalid-run-id", "runId must be a non-empty string");
			}
			if (runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
				throw new SnapshotOrchestratorError("invalid-run-id", "runId must be a single path segment");
			}
			const runDir = join(absRoot, runId);
			if (!isWithin(runDir, absRoot)) {
				throw new SnapshotOrchestratorError("invalid-run-id", "runId escapes the snapshot root");
			}
			if (existsSync(runDir)) {
				throw new SnapshotOrchestratorError("target-exists", `run directory already exists: ${runId}`);
			}

			// 2. All validation passed: only now create directories (private).
			mkdirSync(absRoot, { recursive: true, mode: DIR_MODE });
			mkdirSync(runDir, { mode: DIR_MODE });
			chmodSync(runDir, DIR_MODE);

			const startedAt = clock();
			const results = stores.map((store) => ({ name: store.name, kind: store.kind, status: "skipped" }));
			const quiesced = [];
			const resumeErrors = [];
			let failure = null;

			try {
				// 3. Quiesce every store in registration order.
				for (let index = 0; index < stores.length; index += 1) {
					await stores[index].adapter.quiesce();
					quiesced.push(stores[index]);
				}
				// 4. Snapshot each store into its own fresh directory.
				for (let index = 0; index < stores.length; index += 1) {
					const store = stores[index];
					const targetDir = join(runDir, store.name);
					const t0 = clock();
					try {
						await store.adapter.snapshotTo(targetDir);
						const evidence = collectEvidence(targetDir);
						results[index] = {
							name: store.name,
							kind: store.kind,
							status: "ok",
							...evidence,
							elapsedMs: clock() - t0,
						};
					} catch (error) {
						results[index] = {
							name: store.name,
							kind: store.kind,
							status: "failed",
							error: describe(error),
							elapsedMs: clock() - t0,
						};
						throw error;
					}
				}
			} catch (error) {
				failure = error;
			} finally {
				// 5. Resume every quiesced store in reverse order. A resume that
				// fails is recorded but never aborts the rest of the chain.
				for (let index = quiesced.length - 1; index >= 0; index -= 1) {
					const store = quiesced[index];
					try {
						await store.adapter.resume();
					} catch (error) {
						resumeErrors.push({ name: store.name, error: describe(error) });
					}
				}
			}

			const finishedAt = clock();
			const status = failure === null && resumeErrors.length === 0 ? "success" : "failed";
			const manifest = {
				schemaVersion: SCHEMA_VERSION,
				orchestratorVersion: ORCHESTRATOR_VERSION,
				runId,
				startedAt,
				finishedAt,
				status,
				stores: results,
				quiesceOrder: quiesced.map((store) => store.name),
				resumeOrder: quiesced.map((store) => store.name).reverse(),
				resumeErrors,
				error: failure === null ? null : { reason: describe(failure) },
				network_calls: 0,
			};

			let manifestPath = null;
			let manifestError = null;
			try {
				manifestPath = writeManifestSync(runDir, manifest);
			} catch (error) {
				// A failed manifest write must never masquerade as success.
				manifestError = describe(error);
				manifest.status = "failed";
				manifest.error = { reason: `manifest-write-failed: ${manifestError}` };
			}

			return {
				status: manifest.status,
				runId,
				dir: runDir,
				manifestPath,
				startedAt,
				finishedAt,
				stores: results,
				resumeErrors,
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
