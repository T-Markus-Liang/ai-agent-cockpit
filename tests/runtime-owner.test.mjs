// Focused owner/fencing tests for runtime/owner-sqlite.mjs.
//
// Evidence only: this file exercises the actual public SDK (SqliteStorage,
// Harness) and the owned-storage handle. It never mocks the fence, never
// touches any SDK-private `.db` handle, and only creates `.owner-state-*`
// temp directories inside the workspace cwd. Fixture owner rows are written
// with the public `node:sqlite` DatabaseSync API against those temp DBs.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, ROOT_CONVERSATION_ID, createRegistry } from "@earendil-works/pi-durable";

import { openOwnedSqliteStorage, OwnerRejected, OWNER_TABLE, MAX_OWNER_LEASE_MS } from "../runtime/owner-sqlite.mjs";
import { openSynchronousFullDatabase } from "../runtime/full-sqlite.mjs";

const OWNER_MODULE_URL = new URL("../runtime/owner-sqlite.mjs", import.meta.url).href;
const context = BACKGROUND_CONTEXT;

const tempDirs = [];
const cleanups = [];

/** Create a private temp dir; only exact paths this file created are ever removed. */
function makeTempDir(label) {
	const dir = mkdtempSync(join(process.cwd(), `.owner-state-${label}-`));
	tempDirs.push(dir);
	return dir;
}

/** Run every registered resource cleanup, newest first, then remove exact temp dirs. */
function cleanupAll() {
	while (cleanups.length > 0) {
		const close = cleanups.pop();
		try {
			close();
		} catch {
			// best-effort cleanup of resources this test created
		}
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup of an exact path this test created
		}
	}
}
after(async () => {
	while (cleanups.length) await cleanups.pop()();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Open an owned handle and register its close for teardown. */
async function openOwner(file, options) {
	const handle = await openOwnedSqliteStorage(file, options);
	cleanups.push(() => handle.close());
	return handle;
}

function trackHarness(harness) {
	cleanups.push(() => harness.close(context));
	return harness;
}

/** Read the singleton owner row through public node:sqlite (read-only probe). */
function readOwnerRow(file) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db
			.prepare(
				`SELECT schema_version, host_hash, pid, owner_token, fence, expires_at, active FROM ${OWNER_TABLE} WHERE singleton = 1`,
			)
			.get();
	} finally {
		db.close();
	}
}

/** Controlled raw fixture edit of the owner row (test DB only). */
function updateOwnerRow(file, assignments, ...params) {
	const db = new DatabaseSync(file);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		db.prepare(`UPDATE ${OWNER_TABLE} SET ${assignments} WHERE singleton = 1`).run(...params);
	} finally {
		db.close();
	}
}

/** Seed an owned DB inside a private temp dir, then close it so the row is released. */
async function seedReleasedOwner(label) {
	const dir = makeTempDir(label);
	const file = join(dir, "owned.db");
	const handle = await openOwner(file, { leaseMs: 60_000 });
	await handle.close();
	assert.equal(readOwnerRow(file).active, 0, "seeded owner row should be released");
	return { dir, file };
}

test("first owner claims, same-PID second owner on same file is denied", async (t) => {
	const dir = makeTempDir("same-pid");
	const file = join(dir, "owned.db");

	const first = await openOwner(file, { leaseMs: 60_000 });
	assert.equal(first.claim, "created");
	assert.equal(first.owner.pid, process.pid);
	const info = await first.inspect();
	assert.equal(info.fence, 1);
	assert.equal(info.active, true);
	assert.equal(info.current, true);

	await assert.rejects(
		() => openOwnedSqliteStorage(file, { leaseMs: 60_000 }),
		(error) => error instanceof OwnerRejected && error.code === "live-owner",
	);
	assert.ok(existsSync(file));
});

test("path alias resolving to the same DB is denied as the same owner", async (t) => {
	const dir = makeTempDir("alias");
	const file = join(dir, "owned.db");

	await openOwner(file, { leaseMs: 60_000 });

	const alias = join(dir, "nested", "..", "owned.db");
	await assert.rejects(
		() => openOwnedSqliteStorage(alias, { leaseMs: 60_000 }),
		(error) => error instanceof OwnerRejected && error.code === "live-owner",
	);
});

test("fake-clock expired LIVE pid is not stolen; explicit renew restores assertCurrent", async (t) => {
	const dir = makeTempDir("expired-live");
	const file = join(dir, "owned.db");

	let now = 1_000_000;
	const clock = () => now;
	const owner = await openOwner(file, { leaseMs: 1_000, now: clock });

	now += 5_000; // lease expired, but this pid is still alive
	await assert.rejects(
		() => owner.assertCurrent(),
		(error) => error instanceof OwnerRejected && error.code === "owner-lease-expired",
	);
	await assert.rejects(
		() => owner.renew(-1),
		(error) => error instanceof OwnerRejected && error.code === "invalid-lease",
	);
	await assert.rejects(
		() => openOwnedSqliteStorage(file, { leaseMs: 1_000, now: clock }),
		(error) => error instanceof OwnerRejected && error.code === "live-owner",
	);

	const expiresAt = await owner.renew(1_000);
	assert.equal(expiresAt, now + 1_000);
	await owner.assertCurrent();
	assert.equal((await owner.inspect()).current, true);
});

test("invalid lease is rejected before any database state exists", async (t) => {
	const dir = makeTempDir("bad-lease");
	const file = join(dir, "owned.db");

	for (const leaseMs of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_OWNER_LEASE_MS + 1, "1000"]) {
		await assert.rejects(
			() => openOwnedSqliteStorage(file, { leaseMs }),
			(error) => error instanceof OwnerRejected && error.code === "invalid-lease",
			`leaseMs=${String(leaseMs)}`,
		);
	}
	assert.equal(existsSync(file), false, "invalid lease must not create a database file");
});

test("invalid clock is rejected before any database state exists", async (t) => {
	const dir = makeTempDir("bad-clock");
	const file = join(dir, "owned.db");

	await assert.rejects(
		() => openOwnedSqliteStorage(file, { now: () => Number.NaN }),
		(error) => error instanceof OwnerRejected && error.code === "invalid-clock",
	);
	await assert.rejects(
		() => openOwnedSqliteStorage(file, { now: () => "not-a-number" }),
		(error) => error instanceof OwnerRejected && error.code === "invalid-clock",
	);
	await assert.rejects(
		() => openOwnedSqliteStorage(file, { now: 5 }),
		(error) => error instanceof OwnerRejected && error.code === "invalid-clock",
	);
	assert.equal(existsSync(file), false, "invalid clock must not create a database file");
});

test("malformed owner row denies instead of being reclaimed", async (t) => {
	const { file } = await seedReleasedOwner("malformed");

	updateOwnerRow(file, "pid = ?", 0);
	await assert.rejects(
		() => openOwnedSqliteStorage(file, { leaseMs: 60_000 }),
		(error) => error instanceof OwnerRejected && error.code === "malformed-owner",
	);
});

test("foreign-host owner row denies instead of being reclaimed", async (t) => {
	const { file } = await seedReleasedOwner("foreign-host");

	assert.notEqual(readOwnerRow(file).host_hash, "0".repeat(64));
	updateOwnerRow(file, "host_hash = ?", "0".repeat(64));
	await assert.rejects(
		() => openOwnedSqliteStorage(file, { leaseMs: 60_000 }),
		(error) => error instanceof OwnerRejected && error.code === "foreign-host",
	);
});

test("unknown-schema owner row denies instead of being reclaimed", async (t) => {
	const { file } = await seedReleasedOwner("unknown-schema");

	updateOwnerRow(file, "schema_version = ?", 2);
	await assert.rejects(
		() => openOwnedSqliteStorage(file, { leaseMs: 60_000 }),
		(error) => error instanceof OwnerRejected && error.code === "unknown-schema",
	);
});

test("released storage denies writes/reads/renew after close", async (t) => {
	const dir = makeTempDir("post-close");
	const file = join(dir, "owned.db");

	const owner = await openOwner(file, { leaseMs: 60_000 });
	await owner.close();

	await assert.rejects(
		() => owner.assertCurrent(),
		(error) => error instanceof OwnerRejected && error.code === "storage-closed",
	);
	await assert.rejects(
		() => owner.renew(60_000),
		(error) => error instanceof OwnerRejected && error.code === "storage-closed",
	);
	await assert.rejects(() => owner.storage.conversation(ROOT_CONVERSATION_ID, context));
	assert.equal(readOwnerRow(file).active, 0, "release must mark the owner row inactive");
});

test("actual Harness faux submit survives close/reopen with no rerun", async (t) => {
	const dir = makeTempDir("harness");
	const file = join(dir, "owned.db");

	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("fenced-response")]);
	const registry = createRegistry();

	const first = await openOwner(file, { leaseMs: 60_000 });
	const harness1 = trackHarness(await Harness.open(first.storage, { models, registry }, context));
	const root1 = await harness1.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, tools: [] } });
	const rootId = root1.id;
	const submission = await root1.submit(
		{ type: "write", entry: { kind: "test.note", data: { hello: "world" } } },
		context,
	);
	const settled = await submission.wait(context);
	assert.equal(settled.status, "done");
	const before = await root1.entries({}, 10, undefined, context);
	assert.equal(before.items.length, 1);
	const input = await root1.submit({ type: "input", content: "synthetic fenced generation", requestId: "fenced-once" }, context);
	assert.equal((await input.wait(context)).status, "done");
	assert.equal(faux.state.callCount, 1);
	const afterInput = await root1.entries({}, 20, undefined, context);
	await harness1.close(context);

	const second = await openOwner(file, { leaseMs: 60_000 });
	assert.equal(second.claim, "reclaimed-released");
	const harness2 = trackHarness(await Harness.open(second.storage, { models, registry }, context));
	const root2 = await harness2.root(context);
	assert.equal(root2.id, rootId);
	const reopened = await root2.entries({}, 10, undefined, context);
	assert.equal(reopened.items.length, afterInput.items.length, "reopen must not rerun settled input");
	const again = await root2.submit({ type: "input", content: "synthetic fenced generation", requestId: "fenced-once" }, context);
	assert.equal(again.id, input.id);
	assert.equal((await again.wait(context)).status, "done");
	assert.equal(faux.state.callCount, 1);
});

test("spawned child owner killed; next claim reclaims with higher fence", async (t) => {
	const dir = makeTempDir("child");
	const file = join(dir, "owned.db");

	const childCode = `
import { openOwnedSqliteStorage } from ${JSON.stringify(OWNER_MODULE_URL)};
const dbPath = process.argv[1];
const handle = await openOwnedSqliteStorage(dbPath, { leaseMs: 60000 });
const info = await handle.inspect();
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, fence: info.fence }) + "\\n");
setInterval(() => {}, 1000);
`;

	const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, file], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const earlyExit = new Promise((_, reject) => {
		child.once("error", (error) => reject(error));
		child.once("exit", (code, signal) => reject(new Error(`child exited early code=${code} signal=${signal} ${stderr}`)));
	});
	const readySignal = new Promise((resolve) => {
		let buffered = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			let index;
			while ((index = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, index);
				buffered = buffered.slice(index + 1);
				try {
					const message = JSON.parse(line);
					if (message.ready) resolve(message);
				} catch {
					// ignore non-JSON noise
				}
			}
		});
	});
	const timeout = new Promise((_, reject) => {
		const timer = setTimeout(() => reject(new Error("child did not become ready within 8000ms")), 8000);
		timer.unref?.();
	});
	const ready = await Promise.race([readySignal, earlyExit, timeout]);
	assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
	assert.equal(ready.fence, 1);

	child.kill("SIGKILL");
	const [code, signal] = await once(child, "exit");
	assert.ok(code !== null || signal !== null, "child must have terminated");

	const reclaimed = await openOwner(file, { leaseMs: 60_000 });
	assert.equal(reclaimed.claim, "reclaimed-dead");
	assert.equal((await reclaimed.inspect()).fence, ready.fence + 1);
});

test("administrative revocation: old close cannot release the new owner", async (t) => {
	const dir = makeTempDir("revocation");
	const file = join(dir, "owned.db");

	const old = await openOwner(file, { leaseMs: 60_000 });
	assert.equal(old.claim, "created");

	// Test fixture: administratively release the old row while the old handle is open.
	updateOwnerRow(file, "active = 0");

	const fresh = await openOwner(file, { leaseMs: 60_000 });
	assert.equal(fresh.claim, "reclaimed-released");
	assert.equal(fresh.owner.pid, process.pid);
	const freshFence = (await fresh.inspect()).fence;
	assert.equal(freshFence, 2);
	await assert.rejects(() => old.storage.commit([], context), error => error.code === "stale-owner");

	await old.close();
	await fresh.assertCurrent();
	const row = readOwnerRow(file);
	assert.equal(row.active, 1, "new owner must remain active after old close");
	assert.equal(row.fence, freshFence);
});

test("full-sqlite facade keeps FULL/WAL and private modes", async (t) => {
	const dir = makeTempDir("modes");
	const file = join(dir, "owned.db");

	const opened = await openSynchronousFullDatabase(file);
	cleanups.push(() => opened.database.close());
	assert.equal(opened.synchronous, 2);
	assert.equal(opened.journalMode, "wal");
	assert.equal(opened.fileMode, 0o600);
	assert.equal(opened.parentMode, 0o700);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("lease expires inside a durable transaction: admission rolls back", async () => {
	const dir = makeTempDir("expiry-rollback");
	const file = join(dir, "owned.db");
	let expiring = false, calls = 0;
	const now = () => expiring ? (++calls === 1 ? 1000 : 5000) : 1000;
	const owner = await openOwner(file, { now, leaseMs: 1000 });
	const harness = trackHarness(await Harness.open(owner.storage, { models: createModels(), registry: createRegistry() }, context));
	const root = await harness.root(context);
	const db = new DatabaseSync(file, { readOnly: true });
	const count = () => db.prepare("SELECT count(*) AS n FROM entries").get().n;
	const before = count();
	expiring = true;
	try {
		await assert.rejects(() => root.submit({ type: "write", entry: { kind: "test.expiry", data: {} } }, context), error => error.code === "owner-lease-expired");
		assert.equal(count(), before);
	} finally {
		expiring = false;
		db.close();
		await harness.close(context);
	}
});
