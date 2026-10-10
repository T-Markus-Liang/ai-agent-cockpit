// Explicit full-durability SQLite storage for the P0 runtime canary.
//
// Why this exists: the published Node SQLite helper (`openNodeSqliteDatabase`)
// defaults to `PRAGMA synchronous = NORMAL`, which in WAL mode does not fsync
// every commit. The canary wants an explicit `synchronous = FULL` connection
// without editing upstream or replacing the public storage API. This module
// does the minimum: open the PUBLIC Node DB facade, run the PRAGMA, verify it,
// then hand the same facade to the PUBLIC `SqliteStorage.open`.
//
// This is NOT an owner fence. It only sets restrictive file modes (0600 file,
// 0700 parent). Any other process running as the same OS user can still open
// the file. Ownership/uid fencing and power-loss guarantees are out of scope.

import { chmod, lstat, mkdir, open as openFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** Numeric value SQLite reports for `PRAGMA synchronous = FULL`. */
export const SQLITE_SYNCHRONOUS_FULL = 2;

const ownedFileMode = 0o600;
const ownedDirectoryMode = 0o700;

function sqliteScalar(row, key) {
	if (row === undefined || row === null) return undefined;
	return row[key];
}

async function modeOfPath(path) {
	return (await lstat(path)).mode & 0o777;
}

/**
 * Ensure the database parent directory is private without mutating an existing
 * directory. A missing parent is created with mode 0700; an existing parent is
 * only accepted when it is a real, already-private directory. Symlinked or
 * broad/public parents are refused rather than chmod'd, so the helper never
 * changes permissions on a directory it did not create.
 */
async function ensurePrivateParent(parent) {
	let info;
	try {
		info = await lstat(parent);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (info !== undefined) {
		if (info.isSymbolicLink()) throw new Error(`refusing symlinked parent directory: ${parent}`);
		if (!info.isDirectory()) throw new Error(`parent path is not a directory: ${parent}`);
		if ((info.mode & 0o077) !== 0) {
			throw new Error(`refusing to chmod an already existing broad/public parent directory: ${parent}`);
		}
		return;
	}
	await mkdir(parent, { recursive: true, mode: ownedDirectoryMode });
	const created = await lstat(parent);
	if (!created.isDirectory() || (created.mode & 0o077) !== 0 || created.isSymbolicLink()) {
		throw new Error(`refusing unsafe parent directory after create: ${parent}`);
	}
	if ((created.mode & 0o777) !== ownedDirectoryMode) await chmod(parent, ownedDirectoryMode);
}

/**
 * Validate a database target before opening it. Symlinks and non-regular files
 * are refused so the helper never chmods an arbitrary existing path. A missing
 * target is pre-created privately to avoid a world-readable window; an existing
 * regular file is restricted to 0600.
 */
async function preparePrivateDatabaseFile(file) {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (info !== undefined) {
		if (info.isSymbolicLink()) throw new Error(`refusing symlink database target: ${file}`);
		if (!info.isFile()) throw new Error(`refusing non-regular database target: ${file}`);
		await chmod(file, ownedFileMode);
		return;
	}
	try {
		const handle = await openFile(file, "wx", ownedFileMode);
		await handle.close();
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		// Lost a pre-creation race; re-validate the winner before touching it.
		const raced = await lstat(file);
		if (raced.isSymbolicLink() || !raced.isFile()) throw new Error(`refusing non-regular database target: ${file}`);
		await chmod(file, ownedFileMode);
	}
}

/**
 * Open the file-backed PUBLIC Node SQLite facade with explicit
 * `PRAGMA synchronous = FULL` and WAL journaling, and return it together with
 * the observed configuration.
 *
 * The caller owns the returned `database` and must close it. Parent/file
 * permission rules are identical to `openSqliteStorageSynchronousFull`.
 *
 * Returns `{ database, synchronous, journalMode, file, parentMode, fileMode }`.
 * On any setup failure the underlying database is closed before the error is
 * rethrown.
 *
 * @param {string} file
 */
export async function openSynchronousFullDatabase(file) {
	const absolute = resolve(file);
	const parent = dirname(absolute);
	await ensurePrivateParent(parent);
	await preparePrivateDatabaseFile(absolute);

	/** @type {Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined} */
	let database;
	try {
		database = await openNodeSqliteDatabase(absolute);
		// The helper above sets `synchronous = NORMAL`; raise it to FULL on the
		// same connection. `exec` goes through the library's serial queue, so
		// this stays ordered with the helper's own PRAGMAs.
		await database.exec("PRAGMA synchronous = FULL");
		const synchronous = Number(sqliteScalar(await database.get("PRAGMA synchronous"), "synchronous"));
		const journalMode = String(sqliteScalar(await database.get("PRAGMA journal_mode"), "journal_mode") ?? "").toLowerCase();
		if (synchronous !== SQLITE_SYNCHRONOUS_FULL) {
			throw new Error(`sqlite synchronous is ${synchronous}, expected ${SQLITE_SYNCHRONOUS_FULL}`);
		}
		if (journalMode !== "wal") {
			throw new Error(`sqlite journal_mode is ${journalMode || "unknown"}, expected wal`);
		}
		await chmod(absolute, ownedFileMode);
		const parentMode = await modeOfPath(parent);
		const fileMode = await modeOfPath(absolute);
		if (parentMode !== ownedDirectoryMode) throw new Error(`parent mode is ${parentMode.toString(8)}, expected ${ownedDirectoryMode.toString(8)}`);
		if (fileMode !== ownedFileMode) throw new Error(`file mode is ${fileMode.toString(8)}, expected ${ownedFileMode.toString(8)}`);
		return { database, synchronous, journalMode, file: absolute, parentMode, fileMode };
	} catch (error) {
		if (database !== undefined) {
			try {
				await database.close();
			} catch {
				// Preserve the setup failure.
			}
		}
		throw error;
	}
}

/**
 * Open file-backed `SqliteStorage` with explicit `PRAGMA synchronous = FULL`
 * and WAL journaling.
 *
 * Returns `{ storage, synchronous, journalMode, file, parentMode, fileMode }`.
 * On any setup failure the underlying database is closed before the error is
 * rethrown.
 *
 * @param {string} file
 */
export async function openSqliteStorageSynchronousFull(file) {
	const { database, ...config } = await openSynchronousFullDatabase(file);
	try {
		const storage = await SqliteStorage.open(database);
		return { storage, ...config };
	} catch (error) {
		try {
			await database.close();
		} catch {
			// Preserve the initialization failure.
		}
		throw error;
	}
}
