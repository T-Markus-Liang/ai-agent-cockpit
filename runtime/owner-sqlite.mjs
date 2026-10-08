// P2-A runtime owner/fencing over the SAME durable SQLite file.
//
// Bounded canary, not production cutover. This module adds one ancillary
// singleton table, `app_runtime_owner`, to the durable database opened by
// `openSynchronousFullDatabase`. A single owner row claims the whole durable
// file; every write transaction through the returned storage re-asserts that
// exact owner row (schema/host/pid/token/fence/active/lease) inside the SAME
// SQL transaction and again before commit, so a superseded handle fails closed.
//
// What this is NOT:
//   - Not product approval, admission, or external side-effect exactly-once.
//   - Not a generic scheduler/supervisor/registry and not a second runtime
//     state machine.
//   - `Storage.mintId()` remains an in-memory pre-commit reservation; an ID is
//     only durable once the commit that used it lands.
//
// The owner token and fence are private to the handle. Aliases (for example
// `dir/./file` or `dir/sub/../file`) resolve to the same canonical file and
// therefore the same owner row.

import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openSynchronousFullDatabase } from "./full-sqlite.mjs";

/** Owner row schema understood by this module. */
export const OWNER_SCHEMA_VERSION = 1;
/** Ancillary singleton owner table, stored inside the durable database. */
export const OWNER_TABLE = "app_runtime_owner";
/** Default owner lease before an explicit `renew()` is required. */
export const DEFAULT_OWNER_LEASE_MS = 30_000;
/** Upper bound accepted for any owner lease (24h); larger means a caller bug, not a policy. */
export const MAX_OWNER_LEASE_MS = 24 * 60 * 60 * 1000;

const OWNER_COLUMNS = "schema_version, host_hash, pid, owner_token, fence, expires_at, active";
const HOST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reject a lease that is not a finite positive bounded integer of milliseconds. */
function validateLeaseMs(value) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_OWNER_LEASE_MS) {
		throw new OwnerRejected("invalid-lease", `owner lease must be a positive integer <= ${MAX_OWNER_LEASE_MS}ms`);
	}
	return value;
}

/**
 * Wrap a caller clock so every read is a finite safe-integer timestamp. A broken
 * clock fails closed as an owner rejection instead of binding `NaN` into SQLite.
 */
function createClock(now) {
	if (typeof now !== "function") throw new OwnerRejected("invalid-clock", "owner clock must be a function");
	return () => {
		const value = now();
		if (typeof value !== "number" || !Number.isSafeInteger(value)) {
			throw new OwnerRejected("invalid-clock", "owner clock did not return a finite safe-integer timestamp");
		}
		return value;
	};
}

/**
 * Reject any stored owner row that does not satisfy the schema-1 invariants, so
 * a tampered/foreign/malformed row can never be reclaimed or accepted by guess.
 */
function assertWellFormedOwnerRow(row) {
	const malformed = (field) => {
		throw new OwnerRejected("malformed-owner", `runtime owner row has an invalid ${field}`);
	};
	if (!Number.isSafeInteger(row.schema_version) || row.schema_version < 0) malformed("schema_version");
	if (!Number.isSafeInteger(row.pid) || row.pid <= 0) malformed("pid");
	if (!Number.isSafeInteger(row.fence) || row.fence < 1) malformed("fence");
	if (typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at)) malformed("expires_at");
	if (row.active !== 0 && row.active !== 1) malformed("active");
	if (typeof row.host_hash !== "string" || !HOST_HASH_PATTERN.test(row.host_hash)) malformed("host_hash");
	if (typeof row.owner_token !== "string" || !OWNER_TOKEN_PATTERN.test(row.owner_token)) malformed("owner_token");
}

/** Fail-closed owner/lease rejection. `code` identifies the denial reason. */
export class OwnerRejected extends Error {
	constructor(code, message) {
		super(message ?? `runtime owner rejected: ${code}`);
		this.name = "OwnerRejected";
		this.code = code;
	}
}

/** SHA-256 hex of `os.hostname()`; never the raw hostname. */
export function runtimeHostHash() {
	return createHash("sha256").update(hostname()).digest("hex");
}

/**
 * @returns {true} if a process with `pid` exists,
 * @returns {false} only on ESRCH (provably dead),
 * @returns {undefined} when liveness cannot be proven (EPERM or any unknown error).
 */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		return undefined;
	}
}

async function readOwnerRow(executor) {
	try {
		return await executor.get(`SELECT ${OWNER_COLUMNS} FROM ${OWNER_TABLE} WHERE singleton = 1`);
	} catch (error) {
		throw new OwnerRejected("malformed-owner", "runtime owner row is unreadable", { cause: error });
	}
}

async function ensureOwnerTable(database) {
	await database.exec(`CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		schema_version INTEGER NOT NULL,
		host_hash TEXT NOT NULL,
		pid INTEGER NOT NULL,
		owner_token TEXT NOT NULL,
		fence INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		active INTEGER NOT NULL CHECK (active IN (0, 1))
	) STRICT`);
}

/**
 * Atomically decide and claim the singleton owner row. Runs under
 * `BEGIN IMMEDIATE`, so concurrent claimants serialize on the SQLite write lock.
 * Never steals from a live pid (even when the lease is expired), never guesses
 * across hosts or schema versions, and only reclaims a released row or a
 * same-host pid that is provably dead (ESRCH).
 */
async function claimOwnerRow(database, { host, pid, clock, leaseMs }) {
	return database.transaction(async (tx) => {
		const row = await readOwnerRow(tx);
		let token;
		let fence;
		let reason;
		if (row === undefined) {
			token = randomUUID();
			fence = 1;
			reason = "created";
		} else {
			assertWellFormedOwnerRow(row);
			if (row.schema_version !== OWNER_SCHEMA_VERSION) {
				throw new OwnerRejected("unknown-schema", `unsupported runtime owner schema ${row.schema_version}`);
			}
			if (row.host_hash !== host) {
				throw new OwnerRejected("foreign-host", "runtime owner belongs to another host");
			}
			if (row.active === 1) {
				const alive = processAlive(row.pid);
				if (alive === true) throw new OwnerRejected("live-owner", "runtime owner pid is alive");
				if (alive === undefined) throw new OwnerRejected("unknown-liveness", "cannot prove runtime owner pid is dead");
				reason = "reclaimed-dead";
			} else {
				reason = "reclaimed-released";
			}
			token = randomUUID();
			fence = row.fence + 1;
		}
		const expiresAt = clock() + leaseMs;
		if (!Number.isSafeInteger(expiresAt)) throw new OwnerRejected("invalid-clock", "owner lease deadline is not a finite timestamp");
		await tx.run(
			`INSERT INTO ${OWNER_TABLE} (singleton, schema_version, host_hash, pid, owner_token, fence, expires_at, active)
				VALUES (1, ?, ?, ?, ?, ?, ?, 1)
				ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version,
					host_hash = excluded.host_hash, pid = excluded.pid, owner_token = excluded.owner_token,
					fence = excluded.fence, expires_at = excluded.expires_at, active = 1`,
			OWNER_SCHEMA_VERSION,
			host,
			pid,
			token,
			fence,
			expiresAt,
		);
		return { token, fence, expiresAt, reason };
	});
}

/** Reject a row that is not the exact, active, unexpired identity of `owner`. */
function ownerMismatch(row, owner, clock) {
	if (row === undefined) return new OwnerRejected("owner-missing", "runtime owner row is missing");
	try {
		assertWellFormedOwnerRow(row);
	} catch (error) {
		return error;
	}
	if (row.schema_version !== OWNER_SCHEMA_VERSION) return new OwnerRejected("unknown-schema", `unsupported runtime owner schema ${row.schema_version}`);
	if (row.host_hash !== owner.host) return new OwnerRejected("foreign-host", "runtime owner belongs to another host");
	if (row.pid !== owner.pid) return new OwnerRejected("owner-pid-mismatch", "runtime owner pid changed");
	if (row.owner_token !== owner.token || row.fence !== owner.fence) return new OwnerRejected("stale-owner", "runtime owner was reclaimed by another handle");
	if (row.active !== 1) return new OwnerRejected("owner-inactive", "runtime owner is released");
	if (row.expires_at <= clock()) return new OwnerRejected("owner-lease-expired", "runtime owner lease expired; renew before writing");
	return undefined;
}

async function assertOwner(executor, owner, clock) {
	const error = ownerMismatch(await readOwnerRow(executor), owner, clock);
	if (error !== undefined) throw error;
}

/**
 * Wrap the raw database facade so every write method and transaction asserts the
 * exact owner row inside the transaction and again before commit. Reads are
 * delegated unfenced; close does a guarded exact-owner release, then raw close.
 */
function createFencedDatabase(raw, owner, clock) {
	let closed = false;
	let released = false;

	const assertOpen = () => {
		if (closed) throw new OwnerRejected("storage-closed", "owned storage is closed");
	};

	async function release() {
		if (released) return;
		released = true;
		try {
			await raw.transaction(async (tx) => {
				await tx.run(
					`UPDATE ${OWNER_TABLE} SET active = 0
						WHERE singleton = 1 AND owner_token = ? AND fence = ? AND host_hash = ? AND pid = ? AND active = 1`,
					owner.token,
					owner.fence,
					owner.host,
					owner.pid,
				);
			});
		} catch {
			// Best-effort release; a close must still release the raw handle.
		}
	}

	async function fencedTransaction(operation) {
		assertOpen();
		return raw.transaction(async (tx) => {
			await assertOwner(tx, owner, clock);
			const result = await operation(tx);
			await assertOwner(tx, owner, clock);
			return result;
		});
	}

	return {
		isClosed() {
			return closed;
		},
		async get(sql, ...params) {
			assertOpen();
			return raw.get(sql, ...params);
		},
		async all(sql, ...params) {
			assertOpen();
			return raw.all(sql, ...params);
		},
		async run(sql, ...params) {
			return fencedTransaction((tx) => tx.run(sql, ...params));
		},
		async exec(sql) {
			return fencedTransaction((tx) => tx.exec(sql));
		},
		async transaction(callback) {
			return fencedTransaction((tx) => callback(tx));
		},
		async close() {
			if (closed) return;
			closed = true;
			await release();
			await raw.close();
		},
	};
}

/**
 * Claim the durable file and return an `OwnedStorage` handle.
 *
 * Handle API:
 *   `storage`       fenced `SqliteStorage`; all writes assert the owner.
 *   `owner`         frozen public identity `{ schemaVersion, hostHash, pid, leaseMs }`.
 *                   The random `ownerToken` and `fence` stay private to the handle.
 *   `claim`         why this handle got the row: created | reclaimed-dead | reclaimed-released.
 *   `inspect()`     observed row `{ schemaVersion, hostHash, pid, fence, active, expiresAt, current }`.
 *   `renew(ms?)`    explicit async lease extension; only the exact owner succeeds, even if expired.
 *   `assertCurrent()` rejects unless this handle is the exact active unexpired owner.
 *   `close()`       guarded exact-owner release then raw close; safe to call again.
 *
 * @param {string} file
 * @param {{ now?: () => number, leaseMs?: number }} [options]
 */
export async function openOwnedSqliteStorage(file, options = {}) {
	const clock = createClock(options.now ?? (() => Date.now()));
	const leaseMs = validateLeaseMs(options.leaseMs ?? DEFAULT_OWNER_LEASE_MS);
	clock();
	const host = runtimeHostHash();
	const pid = process.pid;

	const { database } = await openSynchronousFullDatabase(file);
	let storage;
	try {
		await ensureOwnerTable(database);
		const claimed = await claimOwnerRow(database, { host, pid, clock, leaseMs });
		const owner = { token: claimed.token, fence: claimed.fence, host, pid };
		const fenced = createFencedDatabase(database, owner, clock);
		storage = await SqliteStorage.open(fenced);

		let closed = false;
		return {
			storage,
			owner: Object.freeze({ schemaVersion: OWNER_SCHEMA_VERSION, hostHash: host, pid, leaseMs }),
			claim: claimed.reason,
			async inspect() {
				const row = await database.get(`SELECT ${OWNER_COLUMNS} FROM ${OWNER_TABLE} WHERE singleton = 1`);
				const current =
					row !== undefined &&
					row.schema_version === OWNER_SCHEMA_VERSION &&
					row.host_hash === host &&
					row.pid === pid &&
					row.owner_token === owner.token &&
					row.fence === owner.fence &&
					row.active === 1 &&
					row.expires_at > clock();
				return {
					schemaVersion: row?.schema_version,
					hostHash: row?.host_hash,
					pid: row?.pid,
					fence: row?.fence,
					active: row?.active === 1,
					expiresAt: row?.expires_at,
					current,
				};
			},
			async renew(nextLeaseMs = leaseMs) {
				if (closed) throw new OwnerRejected("storage-closed", "owned storage is closed");
				const expiresAt = clock() + validateLeaseMs(nextLeaseMs);
				if (!Number.isSafeInteger(expiresAt)) throw new OwnerRejected("invalid-clock", "invalid owner deadline");
				await database.transaction(async (tx) => {
					const row = await readOwnerRow(tx);
					if (row === undefined) throw new OwnerRejected("owner-missing", "runtime owner row is missing");
					if (row.schema_version !== OWNER_SCHEMA_VERSION) throw new OwnerRejected("unknown-schema", `unsupported runtime owner schema ${row.schema_version}`);
					if (row.host_hash !== host || row.pid !== pid || row.owner_token !== owner.token || row.fence !== owner.fence) {
						throw new OwnerRejected("stale-owner", "runtime owner was reclaimed by another handle");
					}
					if (row.active !== 1) throw new OwnerRejected("owner-inactive", "runtime owner is released");
					await tx.run(
						`UPDATE ${OWNER_TABLE} SET expires_at = ? WHERE singleton = 1 AND owner_token = ? AND fence = ? AND active = 1`,
						expiresAt,
						owner.token,
						owner.fence,
					);
				});
				return expiresAt;
			},
			async assertCurrent() {
				if (closed) throw new OwnerRejected("storage-closed", "owned storage is closed");
				await assertOwner(database, owner, clock);
			},
			async close() {
				if (closed) return;
				closed = true;
				await storage.close();
			},
		};
	} catch (error) {
		// Claim/setup failure: close the raw handle without releasing a row we do
		// not own. If storage opened, its close already released our exact row.
		try {
			await storage?.close();
		} catch {
			// Preserve the setup failure.
		}
		try {
			await database.close();
		} catch {
			// Preserve the setup failure.
		}
		throw error;
	}
}
