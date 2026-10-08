"""Tests for the versioned private-copy memory migration converter.

Every fixture is a private, synthetic temp SQLite database created by the tests.
No host data, credentials, real models, SDK memory stores or services are
touched: the source is only ever read read-only, the engine is a test double and
the evaluator is a fake that never shells out.  The production state directory
``~/.local/state/personal-ai-os/mem0`` is never referenced.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import lifecycle, migration, quality  # noqa: E402
from services.memory.migration import (  # noqa: E402
    MigrationError, convert, reverify, snapshot, verify_conservation)
from services.memory.service import (  # noqa: E402
    Mem0Engine, MemoryService, Search)

# --- synthetic-DB scaffolding (same shape as the preflight tests) -----------
ORIGINAL_DDL = (
    "CREATE TABLE turns("
    "event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL, "
    "status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, "
    "retry_at REAL NOT NULL DEFAULT 0, error_kind TEXT, created_at REAL NOT NULL)"
)
QUALITY_ADDITIONS = (
    "plan TEXT", "validation_status TEXT", "extraction_version TEXT",
    "quality TEXT", "stored_ids TEXT", "forgotten INTEGER NOT NULL DEFAULT 0",
)


def payload(event_id, user_id, role, text, source="wechat"):
    return {"event_id": event_id, "user_id": user_id, "role": role,
            "text": text, "source": source}


def digest_of(obj):
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def make_db(directory, *, quality_schema=False, ddl=ORIGINAL_DDL, name="ingest.sqlite"):
    path = os.path.join(directory, name)
    conn = sqlite3.connect(path)
    conn.execute(ddl)
    if quality_schema:
        for addition in QUALITY_ADDITIONS:
            conn.execute(f"ALTER TABLE turns ADD COLUMN {addition}")
    conn.commit()
    conn.close()
    os.chmod(path, 0o600)
    return path


def insert_original(conn, event_id, user_id, role, text, *, status="done",
                    source="wechat", digest=None):
    obj = payload(event_id, user_id, role, text, source)
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    conn.execute(
        "INSERT INTO turns(event_id,payload,digest,status,created_at) "
        "VALUES(?,?,?,?,?)", (event_id, raw, digest or digest_of(obj), status, 1.0))


def read_row(path, event_id):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM turns WHERE event_id=?", (event_id,)).fetchone()
    finally:
        conn.close()
    return dict(row) if row is not None else None


def all_rows(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return {row["event_id"]: dict(row)
                for row in conn.execute("SELECT * FROM turns")}
    finally:
        conn.close()


def insert_row(path, event_id, user_id, role, text, *, status="done",
               source="wechat", created_at=1.0, digest=None):
    """Insert one baseline row with an explicit ``created_at`` (impostor fixtures)."""
    obj = payload(event_id, user_id, role, text, source)
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at) "
            "VALUES(?,?,?,?,?)",
            (event_id, raw, digest or digest_of(obj), status, created_at))
        conn.commit()
    finally:
        conn.close()


def text_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


def insert_tombstone(path, user_id, event_id, source_hash, quote_hashes,
                     request_id="seed-tombstone"):
    """Seed a lifecycle tombstone directly (row's own forgotten flag untouched)."""
    conn = sqlite3.connect(path)
    try:
        lifecycle.ensure_schema(conn)
        conn.execute(
            "INSERT INTO tombstones(user_id,event_id,source_hash,quote_hashes,"
            "request_id,created_at) VALUES(?,?,?,?,?,?)",
            (user_id, event_id, source_hash, json.dumps(sorted(quote_hashes)),
             request_id, time.time()))
        conn.commit()
    finally:
        conn.close()


# --- test doubles (no host, no model, no network) ---------------------------
def noul(probability=0.99):
    return {"type": "noul", "noul": probability}


class FakeMem0:
    """In-memory stand-in for the Mem0 SDK; makes ZERO model calls."""

    def __init__(self):
        self.rows = []
        # When > 0, the next ``add`` calls raise before writing anything, so a
        # test can drive a partial vector-store failure deterministically.
        self.failures_remaining = 0

    def add(self, messages, *, user_id=None, metadata=None, infer=False):
        if self.failures_remaining > 0:
            self.failures_remaining -= 1
            raise RuntimeError("provider-credential-must-not-be-persisted")
        results = []
        for message in messages:
            memory_id = f"mem-{len(self.rows)}"
            self.rows.append({"id": memory_id, "memory": message["content"],
                              "user_id": user_id, "metadata": dict(metadata or {})})
            results.append({"id": memory_id, "memory": message["content"], "event": "ADD"})
        return {"results": results}

    def get_all(self, *, filters=None, top_k=20):
        filters = filters or {}
        found = []
        for row in self.rows:
            if row["user_id"] != filters.get("user_id"):
                continue
            metadata = row["metadata"]
            if filters.get("event_id") and metadata.get("event_id") != filters["event_id"]:
                continue
            if filters.get("span_key") and metadata.get("span_key") != filters["span_key"]:
                continue
            found.append({"id": row["id"], "memory": row["memory"],
                          "metadata": dict(metadata)})
            if len(found) >= top_k:
                break
        return {"results": found}

    def delete(self, memory_id):
        for index, row in enumerate(self.rows):
            if row["id"] == memory_id:
                del self.rows[index]
                return True
        return False

    def search(self, query, *, filters=None, top_k=20):
        filters = filters or {}
        found = [{"id": row["id"], "memory": row["memory"], "score": 1.0,
                  "metadata": dict(row["metadata"])}
                 for row in self.rows if row["user_id"] == filters.get("user_id")]
        return {"results": found[:top_k]}


class NoDeleteMem0(FakeMem0):
    """A store the converter cannot compensate: it exposes no delete capability."""

    delete = None


class FakeEvaluator:
    def __init__(self, answers=None, error=None):
        self.answers = answers
        self.error = error
        self.calls = []

    def evaluate(self, state, questions):
        self.calls.append({"state": state, "questions": questions})
        if self.error is not None:
            raise self.error
        if callable(self.answers):
            return {"answers": self.answers(dict(questions))}
        if self.answers is None:
            return {"answers": {qid: noul() for qid in questions}}
        return {"answers": self.answers}


def make_config(**overrides):
    base = dict(max_text_chars=200, max_facts=5, semantic_threshold=0.90, max_attempts=3)
    base.update(overrides)
    return quality.QualityConfig(**base)


def make_engine(evaluator=None, memory=None, config=None):
    return Mem0Engine(memory=memory if memory is not None else FakeMem0(),
                      evaluator=evaluator if evaluator is not None else FakeEvaluator(),
                      quality_config=config or make_config())


# --- fixture ----------------------------------------------------------------
class MigrationFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="memory-migration-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.source = os.path.join(self.tmp, "source")
        self.copy = os.path.join(self.tmp, "copy")
        os.makedirs(self.source, mode=0o700)

    @property
    def source_db(self):
        return os.path.join(self.source, "ingest.sqlite")

    @property
    def copy_db(self):
        return os.path.join(self.copy, "ingest.sqlite")

    def legacy_source(self, *, name="source", quality_schema=False):
        directory = os.path.join(self.tmp, name)
        os.makedirs(directory, mode=0o700)
        return make_db(directory, quality_schema=quality_schema)

    def connect(self, path):
        return sqlite3.connect(path)

    def journal_lines(self):
        path = os.path.join(self.copy, "migration-journal.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, "r", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def copy_state(self):
        return all_rows(self.copy_db)

    def source_digests(self, path):
        conn = sqlite3.connect(path)
        try:
            return sorted(row[0] for row in conn.execute("SELECT digest FROM turns"))
        finally:
            conn.close()

    def seed_tombstone(self, event_id, user_id, text, request_id="req-1",
                       quote_hashes=None):
        """Seed a lifecycle tombstone in the copy (as a real forget would).

        ``quote_hashes`` defaults to the real complete-source sentence hashes
        derived through ``lifecycle.sentence_hashes`` so the quote_hash match
        branch is exercised faithfully.
        """
        if quote_hashes is None:
            quote_hashes = lifecycle.sentence_hashes(text)
        conn = sqlite3.connect(self.copy_db)
        try:
            lifecycle.ensure_schema(conn)
            conn.execute(
                "INSERT INTO tombstones(user_id,event_id,source_hash,quote_hashes,"
                "request_id,created_at) VALUES(?,?,?,?,?,?)",
                (user_id, event_id, hashlib.sha256(text.encode()).hexdigest(),
                 json.dumps(sorted(quote_hashes)), request_id, time.time()))
            conn.commit()
        finally:
            conn.close()


# --- 1. snapshot ------------------------------------------------------------
class SnapshotTests(MigrationFixture):
    def test_snapshot_includes_uncheckpointed_wal(self):
        path = os.path.join(self.source, "ingest.sqlite")
        writer = sqlite3.connect(path)
        os.chmod(path, 0o600)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute(ORIGINAL_DDL)
        insert_original(writer, "e1", "u1", "user", "hello in wal")
        insert_original(writer, "e2", "u1", "assistant", "pending in wal", status="pending")
        writer.commit()
        # Writer connection stays open: the committed-but-uncheckpointed WAL
        # content must still be captured by the online backup.
        try:
            stats = snapshot(self.source, self.copy)
        finally:
            writer.close()

        self.assertEqual(stats["total"], 2)
        self.assertEqual(stats["done"], 1)
        self.assertEqual(stats["byRole"]["user"], 1)
        self.assertEqual(stats["byRole"]["assistant"], 1)
        # The copy database was actually produced and is private.
        self.assertTrue(os.path.exists(self.copy_db))
        self.assertEqual(stat.S_IMODE(os.stat(self.copy_db).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.copy).st_mode), 0o700)
        self.assertEqual(len(all_rows(self.copy_db)), 2)


# --- 1b. target refusal (never overwrite the source or an unknown db) --------
class TargetGuardTests(MigrationFixture):
    def _seed_source(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha text")
        conn.commit()
        conn.close()

    def test_same_directory_target_is_refused(self):
        self._seed_source()
        with open(self.source_db, "rb") as handle:
            before = handle.read()
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.source)
        self.assertEqual(str(ctx.exception), "target_alias")
        with open(self.source_db, "rb") as handle:
            self.assertEqual(before, handle.read())

    def test_hardlink_target_is_refused(self):
        self._seed_source()
        os.makedirs(self.copy, mode=0o700)
        os.link(self.source_db, self.copy_db)  # same inode as the source
        with open(self.source_db, "rb") as handle:
            before = handle.read()
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "target_alias")
        with open(self.source_db, "rb") as handle:
            self.assertEqual(before, handle.read())

    def test_unknown_existing_database_is_refused(self):
        self._seed_source()
        os.makedirs(self.copy, mode=0o700)
        # A non-empty SQLite file with unrelated tables and no `turns` column
        # set: it is not our copy and must never be overwritten.
        conn = sqlite3.connect(self.copy_db)
        conn.execute("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)")
        conn.execute("INSERT INTO notes(body) VALUES('unrelated')")
        conn.commit()
        conn.close()
        os.chmod(self.copy_db, 0o600)
        with open(self.copy_db, "rb") as handle:
            before = handle.read()

        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        with open(self.copy_db, "rb") as handle:
            self.assertEqual(before, handle.read())

    def test_known_legacy_copy_is_resumed(self):
        self._seed_source()
        snapshot(self.source, self.copy)  # a legitimate copy, no manifest yet
        report = convert(self.source, self.copy)
        self.assertTrue(report["conservation"]["digests_match"])
        self.assertEqual(report["copy_rows"]["total"], 1)


# --- 2. idempotency ---------------------------------------------------------
class IdempotencyTests(MigrationFixture):
    def _seed(self):
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "I prefer tea in the morning")
        insert_original(conn, "e2", "u1", "assistant", "noted")
        insert_original(conn, "e3", "u1", "user", "queued item", status="pending")
        conn.commit()
        conn.close()

    def test_two_converts_are_idempotent(self):
        make_db(self.source)
        self._seed()
        first = convert(self.source, self.copy)
        state_1 = self.copy_state()
        lines_1 = self.journal_lines()
        with open(os.path.join(self.copy, "migration-manifest.json")) as handle:
            manifest_1 = json.loads(handle.read())

        second = convert(self.source, self.copy)
        with open(os.path.join(self.copy, "migration-manifest.json")) as handle:
            manifest_2 = json.loads(handle.read())

        self.assertFalse(first["dry_run"])
        self.assertEqual(manifest_1["source_rows"], manifest_2["source_rows"])
        self.assertEqual(manifest_1["source_digest_set_hash"],
                         manifest_2["source_digest_set_hash"])
        self.assertEqual(first["manifest"]["source_rows"], second["manifest"]["source_rows"])
        self.assertEqual(self.copy_state(), state_1)
        # No duplicate digests in the journal, and nothing appended on rerun.
        digests = [line["digest"] for line in self.journal_lines()]
        self.assertEqual(len(digests), len(set(digests)))
        self.assertEqual(set(digests), {line["digest"] for line in lines_1})

    def test_dry_run_twice_is_idempotent(self):
        make_db(self.source)
        self._seed()
        dry_copy = os.path.join(self.tmp, "dry-copy")
        first = convert(self.source, dry_copy, dry_run=True)
        second = convert(self.source, dry_copy, dry_run=True)
        self.assertTrue(first["dry_run"])
        self.assertEqual(first["manifest"]["source_rows"], second["manifest"]["source_rows"])
        self.assertEqual(first["manifest"]["source_digest_set_hash"],
                         second["manifest"]["source_digest_set_hash"])
        self.assertEqual(first["outcomes"], second["outcomes"])
        # dry run writes no journal, no quality schema and no turn content: the
        # copy stays a byte-faithful legacy database.
        self.assertFalse(os.path.exists(os.path.join(dry_copy, "migration-journal.jsonl")))
        dry_rows = all_rows(os.path.join(dry_copy, "ingest.sqlite"))
        self.assertEqual(dry_rows["e1"]["status"], "done")
        self.assertNotIn("validation_status", dry_rows["e1"])


# --- 3. journal resume ------------------------------------------------------
class ResumeTests(MigrationFixture):
    def test_removed_journal_entries_are_the_only_rows_rerun(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        for index in range(1, 5):
            insert_original(conn, f"e{index}", "u1", "user", f"distinct text {index}")
        conn.commit()
        conn.close()

        convert(self.source, self.copy)
        lines = self.journal_lines()
        self.assertEqual(len(lines), 4)

        # Lose half of the journal (simulated crash before flush).
        keep = lines[:2]
        removed_digests = {line["digest"] for line in lines[2:]}
        with open(os.path.join(self.copy, "migration-journal.jsonl"), "w") as handle:
            for line in keep:
                handle.write(json.dumps(line, sort_keys=True) + "\n")

        digest_to_event = {row["digest"]: event_id
                           for event_id, row in self.copy_state().items()}
        removed_events = {digest_to_event[d] for d in removed_digests}

        with patch.object(migration, "_convert_row",
                          wraps=migration._convert_row) as wrapped:
            convert(self.source, self.copy)
            called = {call.args[1]["event_id"] for call in wrapped.call_args_list}

        # Only the rows whose journal entry was lost are reprocessed.
        self.assertEqual(called, removed_events)
        # The journal is complete and duplicate-free again.
        resumed = [line["digest"] for line in self.journal_lines()]
        self.assertEqual(len(resumed), len(set(resumed)))
        self.assertEqual(set(resumed), set(digest_to_event))


# --- 4. half-write recovery -------------------------------------------------
class HalfWriteTests(MigrationFixture):
    def test_missing_copy_row_with_journal_entry_is_reconverted(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "first durable line")
        insert_original(conn, "e2", "u1", "user", "second durable line")
        conn.commit()
        conn.close()

        convert(self.source, self.copy)
        e1_digest = self.copy_state()["e1"]["digest"]

        # Half-write: the journal recorded the row, but the copy lost it.
        conn = self.connect(self.copy_db)
        conn.execute("DELETE FROM turns WHERE event_id='e1'")
        conn.commit()
        conn.close()
        self.assertIsNone(read_row(self.copy_db, "e1"))

        with patch.object(migration, "_convert_row",
                          wraps=migration._convert_row) as wrapped:
            convert(self.source, self.copy)
            called = [call.args[1]["event_id"] for call in wrapped.call_args_list]

        self.assertIn("e1", called)
        self.assertNotIn("e2", called)
        restored = read_row(self.copy_db, "e1")
        self.assertIsNotNone(restored)
        self.assertEqual(restored["status"], "pending")
        # The journal still holds exactly one entry for that digest.
        matching = [line for line in self.journal_lines() if line["digest"] == e1_digest]
        self.assertEqual(len(matching), 1)
        self.assertEqual(len(self.copy_state()), 2)


# --- 5. privacy barrier -----------------------------------------------------
class PrivacyTests(MigrationFixture):
    def test_credential_payload_is_needs_review_and_evaluator_never_sees_it(self):
        make_db(self.source)
        secret_text = "我的密钥是 sk-ABCDEFGHIJKLMNOPQRSTUV"
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", secret_text)
        conn.commit()
        conn.close()

        convert(self.source, self.copy)
        evaluator = FakeEvaluator()
        engine = make_engine(evaluator=evaluator)
        reverify(self.copy, engine)

        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["validation_status"], "needs_review")
        self.assertEqual(row["error_kind"], "credential_like")
        self.assertEqual(row["status"], "needs_review")
        # The credential was rejected before any evaluator call.
        self.assertEqual(evaluator.calls, [])


# --- 6. tombstone respect ---------------------------------------------------
class TombstoneTests(MigrationFixture):
    def test_seeded_tombstone_is_forgotten_and_never_trusted(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "forget me please")
        insert_original(conn, "e2", "u1", "user", "keep this one")
        conn.commit()
        conn.close()

        snapshot(self.source, self.copy)
        self.seed_tombstone("e1", "u1", "forget me please")

        convert(self.source, self.copy)
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["forgotten"], 1)
        self.assertEqual(row["status"], "forgotten")

        engine = make_engine()
        reverify(self.copy, engine)
        row = read_row(self.copy_db, "e1")
        self.assertNotEqual(row["validation_status"], "validated")
        self.assertNotEqual(row["status"], "done")

        service = MemoryService(Path(self.copy), engine)
        memories = [hit["memory"] for hit in service.search(Search(user_id="u1", query="forget me"))]
        # The forgotten turn is never recalled; the untouched sibling still is.
        self.assertNotIn("forget me please", memories)
        self.assertIn("keep this one", memories)

    def test_same_source_text_under_new_event_id_is_forgotten(self):
        # source_hash branch: two rows, identical text, different event ids.
        # The tombstone records only one of them, but BOTH must be forgotten.
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "identical durable sentence")
        insert_original(conn, "e2", "u1", "user", "identical durable sentence")
        conn.commit()
        conn.close()

        snapshot(self.source, self.copy)
        self.seed_tombstone("e2", "u1", "identical durable sentence")

        convert(self.source, self.copy)
        self.assertEqual(read_row(self.copy_db, "e1")["forgotten"], 1)
        self.assertEqual(read_row(self.copy_db, "e1")["status"], "forgotten")
        self.assertEqual(read_row(self.copy_db, "e2")["forgotten"], 1)
        self.assertEqual(read_row(self.copy_db, "e2")["status"], "forgotten")

    def test_quote_hash_match_forgets_new_text_sharing_a_sentence(self):
        # quote_hash branch: the tombstone's recorded event id does not exist,
        # the full source text differs, but the row contains one complete
        # forgotten sentence verbatim -> it must be forgotten.
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "我喜欢喝茶。另外这是新的一句话。")
        conn.commit()
        conn.close()

        snapshot(self.source, self.copy)
        forgotten_text = "我喜欢喝茶。也喜欢咖啡。"
        self.seed_tombstone(
            "old-event", "u1", forgotten_text,
            quote_hashes=lifecycle.sentence_hashes(forgotten_text))

        convert(self.source, self.copy)
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["forgotten"], 1)
        self.assertEqual(row["status"], "forgotten")


# --- 7. assistant archive ---------------------------------------------------
class AssistantArchiveTests(MigrationFixture):
    def test_assistant_rows_are_archived_and_not_recalled(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "remember my preference for tea")
        insert_original(conn, "e2", "u1", "assistant", "of course")
        conn.commit()
        conn.close()

        convert(self.source, self.copy)
        row = read_row(self.copy_db, "e2")
        self.assertEqual(row["validation_status"], "assistant_archived")
        self.assertEqual(row["status"], "done")

        engine = make_engine()
        service = MemoryService(Path(self.copy), engine)
        self.assertEqual(service.search(Search(user_id="u1", query="of course")), [])
        # Nothing was ever written to the vector store for the assistant turn.
        self.assertEqual(engine.memory.rows, [])


# --- 8. user revalidation success -------------------------------------------
class ReverifySuccessTests(MigrationFixture):
    def test_validated_with_high_scores_is_recallable(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "我喜欢用中文回复")
        conn.commit()
        conn.close()

        convert(self.source, self.copy)
        self.assertEqual(read_row(self.copy_db, "e1")["status"], "pending")

        engine = make_engine()
        evaluator = engine.evaluator
        counts = reverify(self.copy, engine)
        self.assertEqual(counts["validated"], 1)
        self.assertTrue(evaluator.calls)  # the injected evaluator was consulted

        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["validation_status"], "validated")

        service = MemoryService(Path(self.copy), engine)
        hits = service.search(Search(user_id="u1", query="中文"))
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["memory"], "我喜欢用中文回复")


# --- 9. user revalidation failure -------------------------------------------
class ReverifyFailureTests(MigrationFixture):
    def _legacy_with_user_row(self, name):
        directory = os.path.join(self.tmp, name)
        os.makedirs(directory, mode=0o700)
        path = make_db(directory)
        conn = sqlite3.connect(path)
        insert_original(conn, "e1", "u1", "user", "keep every original word intact")
        conn.commit()
        conn.close()
        return directory

    def test_evaluator_error_keeps_text_and_does_not_validate(self):
        source = self._legacy_with_user_row("src-err")
        copy = os.path.join(self.tmp, "copy-err")
        convert(source, copy)
        engine = make_engine(evaluator=FakeEvaluator(error=quality.EvaluatorError("boom")))
        reverify(copy, engine)

        row = read_row(os.path.join(copy, "ingest.sqlite"), "e1")
        self.assertEqual(row["status"], "needs_review")
        self.assertEqual(row["validation_status"], "needs_review")
        self.assertEqual(row["error_kind"], "boom")
        self.assertEqual(json.loads(row["payload"])["text"],
                         "keep every original word intact")

    def test_low_score_does_not_validate_and_keeps_text(self):
        source = self._legacy_with_user_row("src-low")
        copy = os.path.join(self.tmp, "copy-low")
        convert(source, copy)
        low = FakeEvaluator(answers=lambda questions: {qid: noul(0.02) for qid in questions})
        engine = make_engine(evaluator=low)
        reverify(copy, engine)

        row = read_row(os.path.join(copy, "ingest.sqlite"), "e1")
        self.assertNotEqual(row["validation_status"], "validated")
        self.assertIn(row["status"], ("needs_review", "pending"))
        self.assertEqual(json.loads(row["payload"])["text"],
                         "keep every original word intact")


# --- 10. conservation + source immutability ---------------------------------
class ConservationTests(MigrationFixture):
    def test_conservation_holds_and_source_is_untouched(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha text")
        insert_original(conn, "e2", "u1", "assistant", "beta text")
        insert_original(conn, "e3", "u1", "user", "gamma text", status="needs_review")
        conn.commit()
        conn.close()

        with open(self.source_db, "rb") as handle:
            before = handle.read()
        digests_before = self.source_digests(self.source_db)

        convert(self.source, self.copy)

        with open(self.source_db, "rb") as handle:
            after = handle.read()
        self.assertEqual(before, after)
        self.assertEqual(digests_before, self.source_digests(self.source_db))
        self.assertFalse(os.path.exists(self.source_db + "-wal"))
        self.assertFalse(os.path.exists(self.source_db + "-shm"))

        report = verify_conservation(self.source, self.copy)
        self.assertTrue(report["digests_match"])
        self.assertEqual(report["source_rows"], report["copy_rows"])
        self.assertEqual(report["added_rows"], 0)
        self.assertEqual(report["missing_rows"], 0)

        # A tampered copy is a conservation violation.
        conn = sqlite3.connect(self.copy_db)
        conn.execute("DELETE FROM turns WHERE event_id='e1'")
        conn.commit()
        conn.close()
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)

    def test_os_read_only_source_file_converts_and_verifies(self):
        # The source is opened read-only everywhere.  An OS-level read-only
        # source file (0o400) makes any accidental read-write open blow up, so
        # this locks the invariant that snapshot/read/verify never mutate it.
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha text")
        insert_original(conn, "e2", "u1", "assistant", "beta text")
        conn.commit()
        conn.close()
        with open(self.source_db, "rb") as handle:
            before = handle.read()

        os.chmod(self.source_db, 0o400)
        self.addCleanup(os.chmod, self.source_db, 0o600)

        report = convert(self.source, self.copy)  # must not touch the source
        verify = verify_conservation(self.source, self.copy)
        with open(self.source_db, "rb") as handle:
            after = handle.read()

        self.assertEqual(before, after)
        # No journal/WAL sidecar is ever created next to the source.
        for suffix in ("-journal", "-wal", "-shm"):
            self.assertFalse(os.path.exists(self.source_db + suffix))
        self.assertTrue(report["conservation"]["digests_match"])
        self.assertTrue(verify["digests_match"])
        self.assertEqual(verify["source_rows"], 2)

    def test_verify_conservation_opens_source_read_only(self):
        # SQLite transparently opens a write-protected file read-only even when
        # asked for read/write (documented SQLITE_OPEN_READWRITE fallback), so
        # OS permissions cannot distinguish the two.  This locks the real
        # invariant: verify_conservation reads the source exclusively through
        # the preflight read-only opener, never a read-write connection.
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha text")
        insert_original(conn, "e2", "u1", "assistant", "beta text")
        conn.commit()
        conn.close()
        convert(self.source, self.copy)

        src_abs = os.path.abspath(self.source_db)
        plain_opened = []
        ro_opened = []
        real_connect = migration._connect
        real_ro = migration.migration_preflight._open_readonly

        def spy_connect(path):
            plain_opened.append(os.path.abspath(os.fspath(path)))
            return real_connect(path)

        def spy_ro(path):
            ro_opened.append(os.path.abspath(os.fspath(path)))
            return real_ro(path)

        with patch.object(migration, "_connect", side_effect=spy_connect), \
                patch.object(migration.migration_preflight, "_open_readonly",
                             side_effect=spy_ro):
            verify_conservation(self.source, self.copy)

        self.assertIn(src_abs, ro_opened)
        self.assertNotIn(src_abs, plain_opened)

    def test_conservation_on_uncheckpointed_wal_source_is_byte_stable(self):
        # Non-trivial WAL assertion: with an open writer and uncommitted
        # checkpoint, both the main database and the -wal file must be
        # byte-for-byte unchanged across a full convert + verify.
        path = os.path.join(self.source, "ingest.sqlite")
        writer = sqlite3.connect(path)
        os.chmod(path, 0o600)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute(ORIGINAL_DDL)
        insert_original(writer, "e1", "u1", "user", "wal alpha")
        insert_original(writer, "e2", "u1", "assistant", "wal beta")
        writer.commit()
        wal_path = path + "-wal"
        self.assertTrue(os.path.exists(wal_path))
        self.assertGreater(os.path.getsize(wal_path), 0)

        with open(path, "rb") as handle:
            main_before = handle.read()
        with open(wal_path, "rb") as handle:
            wal_before = handle.read()

        try:
            report = convert(self.source, self.copy)
            verify = verify_conservation(self.source, self.copy)
        finally:
            with open(path, "rb") as handle:
                main_after = handle.read()
            with open(wal_path, "rb") as handle:
                wal_after = handle.read()
            writer.close()

        self.assertEqual(main_before, main_after)
        self.assertEqual(wal_before, wal_after)
        self.assertTrue(report["conservation"]["digests_match"])
        self.assertTrue(verify["digests_match"])
        self.assertEqual(verify["source_rows"], 2)


# --- drift guards -----------------------------------------------------------
class SourceDriftTests(MigrationFixture):
    def test_source_row_added_after_snapshot_is_refused(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha text")
        conn.commit()
        conn.close()

        snapshot(self.source, self.copy)  # freeze the copy

        # A second writer appends a new row to the source AFTER the snapshot.
        writer = sqlite3.connect(self.source_db)
        insert_original(writer, "e2", "u1", "user", "post-snapshot drift row")
        writer.commit()
        writer.close()

        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "conservation_violation")
        # The copy is NOT marked complete: no manifest was written, and the
        # drifted row never leaked into the copy.
        self.assertFalse(os.path.exists(os.path.join(self.copy, "migration-manifest.json")))
        self.assertIsNone(read_row(self.copy_db, "e2"))


class ManifestDriftTests(MigrationFixture):
    def test_converter_version_drift_is_refused(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha text")
        conn.commit()
        conn.close()

        convert(self.source, self.copy)
        manifest_path = os.path.join(self.copy, "migration-manifest.json")
        with open(manifest_path) as handle:
            manifest = json.load(handle)
        self.assertEqual(manifest["converterVersion"], "memory-migration-v1")
        manifest["converterVersion"] = "memory-migration-v0"
        with open(manifest_path, "w") as handle:
            json.dump(manifest, handle, sort_keys=True)

        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "manifest_version_drift")


class PartialStoreTests(MigrationFixture):
    def test_store_failure_is_preserved_then_recovered_on_retry(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "第一条持久偏好")
        insert_original(conn, "e2", "u1", "user", "第二条持久偏好")
        conn.commit()
        conn.close()
        convert(self.source, self.copy)

        memory = FakeMem0()
        memory.failures_remaining = 1  # exactly one add fails
        engine = Mem0Engine(memory=memory, evaluator=FakeEvaluator(),
                            quality_config=make_config())

        first = reverify(self.copy, engine)
        self.assertEqual(first["validated"], 1)
        self.assertEqual(first["errors"], 1)

        failed = [eid for eid in ("e1", "e2")
                  if read_row(self.copy_db, eid)["status"] == "needs_review"]
        self.assertEqual(len(failed), 1)
        failed_id = failed[0]
        row = read_row(self.copy_db, failed_id)
        self.assertEqual(row["error_kind"], "store_error")   # sanitized, retryable
        self.assertEqual(row["validation_status"], "needs_review")
        self.assertEqual(row["status"], "needs_review")
        # The original text is preserved verbatim.
        self.assertIn("持久偏好", json.loads(row["payload"])["text"])
        # The other row validated and stored normally.
        other_id = "e2" if failed_id == "e1" else "e1"
        self.assertEqual(read_row(self.copy_db, other_id)["validation_status"], "validated")

        # A second pass retries the failed row and it recovers.
        second = reverify(self.copy, engine)
        self.assertEqual(second["validated"], 1)
        recovered = read_row(self.copy_db, failed_id)
        self.assertEqual(recovered["status"], "done")
        self.assertEqual(recovered["validation_status"], "validated")

        # Both rows are now recallable.
        service = MemoryService(Path(self.copy), engine)
        hits = service.search(Search(user_id="u1", query="偏好"))
        self.assertEqual(len(hits), 2)


# --- 11. F001 target provenance + path protection ---------------------------
class TargetProvenanceTests(MigrationFixture):
    """F001: never trust a target just because it shares our schema."""

    def _seed_source(self, text="alpha durable preference"):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", text)
        conn.commit()
        conn.close()

    def test_same_schema_impostor_is_refused_without_mutation(self):
        self._seed_source()
        os.makedirs(self.copy, mode=0o700)
        # Same baseline schema + same payload, but an INDEPENDENTLY created db
        # (different created_at).  It is not our copy and must never be written.
        make_db(self.copy)
        insert_row(self.copy_db, "e1", "u1", "user", "alpha durable preference",
                   created_at=99.0)
        before_bytes = Path(self.copy_db).read_bytes()
        before_mode = stat.S_IMODE(os.stat(self.copy_db).st_mode)
        before_entries = sorted(os.listdir(self.copy))

        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        self.assertEqual(Path(self.copy_db).read_bytes(), before_bytes)
        self.assertEqual(stat.S_IMODE(os.stat(self.copy_db).st_mode), before_mode)
        self.assertEqual(sorted(os.listdir(self.copy)), before_entries)
        self.assertEqual(read_row(self.copy_db, "e1")["status"], "done")

    def test_forged_manifest_with_bad_provenance_is_refused(self):
        self._seed_source()
        snapshot(self.source, self.copy)
        with open(os.path.join(self.copy, "migration-manifest.json"), "w") as handle:
            json.dump({"schemaVersion": 1, "converterVersion": "memory-migration-v1",
                       "source_digest_set_hash": "deadbeef"}, handle)
        before = Path(self.copy_db).read_bytes()
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        self.assertEqual(Path(self.copy_db).read_bytes(), before)

    def test_forged_manifest_with_wrong_version_is_refused(self):
        self._seed_source()
        snapshot(self.source, self.copy)
        with open(os.path.join(self.copy, "migration-manifest.json"), "w") as handle:
            json.dump({"schemaVersion": 1, "converterVersion": "memory-migration-v0",
                       "source_digest_set_hash": "deadbeef"}, handle)
        before = Path(self.copy_db).read_bytes()
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "manifest_version_drift")
        self.assertEqual(Path(self.copy_db).read_bytes(), before)

    def test_manifest_provenance_mismatch_is_refused(self):
        self._seed_source()
        convert(self.source, self.copy)
        # Source changed after the manifest froze its digest set -> provenance
        # no longer fingerprints this source.
        conn = self.connect(self.source_db)
        insert_original(conn, "e2", "u1", "user", "second line")
        conn.commit()
        conn.close()
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")

    def _victim(self, name="victim"):
        victim = os.path.join(self.tmp, name)
        os.makedirs(victim, mode=0o700)
        make_db(victim)
        victim_db = os.path.join(victim, "ingest.sqlite")
        insert_row(victim_db, "e1", "u1", "user", "victim text", created_at=99.0)
        return victim, victim_db

    def test_symlink_directory_target_is_refused(self):
        self._seed_source()
        victim, victim_db = self._victim()
        before_bytes = Path(victim_db).read_bytes()
        before_entries = sorted(os.listdir(victim))
        alias = os.path.join(self.tmp, "alias")
        os.symlink(victim, alias)
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, alias)
        self.assertEqual(str(ctx.exception), "target_symlink")
        self.assertEqual(Path(victim_db).read_bytes(), before_bytes)
        self.assertEqual(sorted(os.listdir(victim)), before_entries)
        self.assertEqual(read_row(victim_db, "e1")["status"], "done")

    def test_symlink_database_target_is_refused(self):
        self._seed_source()
        os.makedirs(self.copy, mode=0o700)
        _, victim_db = self._victim()
        before_bytes = Path(victim_db).read_bytes()
        os.symlink(victim_db, self.copy_db)
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "target_symlink")
        self.assertEqual(Path(victim_db).read_bytes(), before_bytes)

    def test_symlink_ancestor_target_is_refused(self):
        self._seed_source()
        real = os.path.join(self.tmp, "real")
        os.makedirs(real, mode=0o700)
        alias = os.path.join(self.tmp, "alias-root")
        os.symlink(real, alias)
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, os.path.join(alias, "nested"))
        self.assertEqual(str(ctx.exception), "target_symlink")

    def test_unknown_hardlink_database_is_refused(self):
        self._seed_source()
        os.makedirs(self.copy, mode=0o700)
        _, victim_db = self._victim()
        before_bytes = Path(victim_db).read_bytes()
        os.link(victim_db, self.copy_db)  # copy db shares an inode with the victim
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "target_hardlink")
        self.assertEqual(Path(victim_db).read_bytes(), before_bytes)

    def test_non_regular_database_is_refused(self):
        self._seed_source()
        os.makedirs(self.copy, mode=0o700)
        os.makedirs(self.copy_db)  # a directory, not a database file
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "target_not_regular")

    def test_legit_copy_with_manifest_reenters_safely(self):
        self._seed_source()
        first = convert(self.source, self.copy)
        second = convert(self.source, self.copy)
        self.assertTrue(first["conservation"]["digests_match"])
        self.assertTrue(second["conservation"]["digests_match"])
        self.assertEqual(first["copy_rows"]["total"], second["copy_rows"]["total"])

    def test_brand_new_directory_is_accepted(self):
        self._seed_source()
        report = convert(self.source, os.path.join(self.tmp, "brand", "new"))
        self.assertTrue(report["conservation"]["digests_match"])
        self.assertEqual(report["copy_rows"]["total"], 1)


# --- 12. F002 field-by-field conservation -----------------------------------
class ConservationFieldTests(MigrationFixture):
    """F002: digest equality alone must not be trusted as conservation."""

    def _convert_two(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "alpha durable preference")
        insert_original(conn, "e2", "u1", "assistant", "noted")
        conn.commit()
        conn.close()
        convert(self.source, self.copy)

    def _mutate_copy(self, sql, params=()):
        conn = sqlite3.connect(self.copy_db)
        try:
            conn.execute(sql, params)
            conn.commit()
        finally:
            conn.close()

    def test_created_at_tamper_is_detected(self):
        self._convert_two()
        self._mutate_copy("UPDATE turns SET created_at=99 WHERE event_id='e1'")
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)

    def test_payload_tamper_is_detected(self):
        self._convert_two()
        obj = json.loads(read_row(self.copy_db, "e1")["payload"])
        obj["text"] = "tampered content"
        self._mutate_copy("UPDATE turns SET payload=? WHERE event_id='e1'",
                          (json.dumps(obj, sort_keys=True, ensure_ascii=False),))
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)

    def test_event_id_added_is_detected(self):
        self._convert_two()
        insert_row(self.copy_db, "e3", "u1", "user", "injected row")
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)

    def test_event_id_removed_is_detected(self):
        self._convert_two()
        self._mutate_copy("DELETE FROM turns WHERE event_id='e2'")
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)

    def test_illegal_status_transition_is_detected(self):
        self._convert_two()
        # source e1 was 'done'; flipping the copy to needs_review is not a
        # trusted migration outcome.
        self._mutate_copy("UPDATE turns SET status='needs_review' WHERE event_id='e1'")
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)

    def test_legal_status_transition_is_accepted(self):
        self._convert_two()
        # done -> pending is the trusted re-verification outcome.
        self.assertEqual(read_row(self.copy_db, "e1")["status"], "pending")
        self.assertTrue(verify_conservation(self.source, self.copy)["digests_match"])

    def test_duplicate_digest_event_ids_both_survive(self):
        # Two distinct event_ids whose payloads are byte-identical (same embedded
        # event_id) share one digest; conservation is keyed by event_id so both
        # must survive rather than being collapsed by the journal.
        make_db(self.source)
        obj = payload("shared-event", "u1", "user", "identical durable sentence")
        raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
        digest = digest_of(obj)
        conn = self.connect(self.source_db)
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)",
            ("e1", raw, digest, "done", 1.0))
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)",
            ("e2", raw, digest, "done", 1.0))
        conn.commit()
        conn.close()
        convert(self.source, self.copy)
        rows = self.copy_state()
        self.assertEqual(set(rows), {"e1", "e2"})
        self.assertEqual(rows["e1"]["digest"], rows["e2"]["digest"])
        self.assertTrue(verify_conservation(self.source, self.copy)["digests_match"])
        # Collapsing the two same-digest events into one is a violation.
        self._mutate_copy("DELETE FROM turns WHERE event_id='e2'")
        with self.assertRaises(MigrationError):
            verify_conservation(self.source, self.copy)


# --- 13. F003 forget races during revalidation ------------------------------
class ForgetDuringReverifyTests(MigrationFixture):
    """F003: a forget committed mid-pipeline never yields a validated receipt."""

    def _prepare(self, text="我喜欢用中文回复"):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", text)
        conn.commit()
        conn.close()
        convert(self.source, self.copy)

    def _forget_store(self):
        return lifecycle.ForgetStore(lambda: sqlite3.connect(self.copy_db))

    def _forget(self, store, *, request_id="req-forget", event_ids=("e1",),
                user_id="u1"):
        store.forget(lifecycle.ForgetRequest(
            request_id=request_id, user_id=user_id, event_ids=list(event_ids)))

    def _engine(self, memory=None, evaluator=None):
        return Mem0Engine(memory=memory if memory is not None else FakeMem0(),
                          evaluator=evaluator if evaluator is not None else FakeEvaluator(),
                          quality_config=make_config(), version="synthetic-only")

    def test_forget_before_reverify_leaves_no_vector(self):
        self._prepare()
        self._forget(self._forget_store())  # real forget: row flag set
        memory = FakeMem0()
        counts = reverify(self.copy, self._engine(memory=memory))
        self.assertEqual(counts["validated"], 0)
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["forgotten"], 1)
        self.assertNotEqual(row["validation_status"], "validated")
        self.assertEqual(memory.rows, [])

    def test_tombstone_without_row_flag_is_caught_before_store(self):
        # A tombstone that matches the row, but whose ``forgotten`` flag was not
        # (yet) written, must still stop the vector effect.
        self._prepare()
        insert_tombstone(self.copy_db, "u1", "e1", text_hash("我喜欢用中文回复"), [])
        memory = FakeMem0()
        counts = reverify(self.copy, self._engine(memory=memory))
        self.assertEqual(counts["forgotten"], 1)
        self.assertEqual(counts["validated"], 0)
        self.assertEqual(memory.rows, [])
        self.assertEqual(read_row(self.copy_db, "e1")["forgotten"], 1)

    def test_forget_during_prepare_never_starts_store(self):
        self._prepare()
        store = self._forget_store()
        memory = FakeMem0()
        engine = self._engine(memory=memory)
        real_prepare = engine.prepare

        def prepare_then_forget(turn):
            plan = real_prepare(turn)
            self._forget(store)
            return plan

        engine.prepare = prepare_then_forget
        counts = reverify(self.copy, engine)
        self.assertEqual(counts["forgotten"], 1)
        self.assertEqual(counts["validated"], 0)
        self.assertEqual(memory.rows, [])
        self.assertEqual(read_row(self.copy_db, "e1")["forgotten"], 1)

    def test_forget_during_store_compensates_vector_effect(self):
        self._prepare()
        store = self._forget_store()
        memory = FakeMem0()
        engine = self._engine(memory=memory)
        real_store = engine.store

        def store_then_forget(turn, plan):
            result = real_store(turn, plan)
            self._forget(store)  # forget commits after the vector effect
            return result

        engine.store = store_then_forget
        counts = reverify(self.copy, engine)
        self.assertEqual(counts["validated"], 0)
        self.assertEqual(read_row(self.copy_db, "e1")["forgotten"], 1)
        self.assertEqual(memory.rows, [])  # the effect was compensated away

    def test_forget_during_store_without_delete_fails_closed(self):
        self._prepare()
        store = self._forget_store()
        memory = NoDeleteMem0()
        engine = self._engine(memory=memory)
        real_store = engine.store

        def store_then_forget(turn, plan):
            result = real_store(turn, plan)
            self._forget(store)
            return result

        engine.store = store_then_forget
        counts = reverify(self.copy, engine)
        self.assertEqual(counts["validated"], 0)
        self.assertEqual(counts["needs_review"], 1)
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["forgotten"], 1)
        self.assertNotEqual(row["validation_status"], "validated")

    def test_forget_before_settlement_guard_blocks_validated(self):
        self._prepare()
        store = self._forget_store()
        memory = FakeMem0()
        engine = self._engine(memory=memory)
        real_receipt = migration._write_receipt

        def receipt_after_forget(copy_path, event_id, **kwargs):
            if (kwargs.get("status") == "done"
                    and kwargs.get("validation_status") == "validated"):
                self._forget(store)  # forget races in right before settlement
            return real_receipt(copy_path, event_id, **kwargs)

        with patch.object(migration, "_write_receipt", side_effect=receipt_after_forget):
            counts = reverify(self.copy, engine)
        self.assertEqual(counts["validated"], 0)
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["forgotten"], 1)
        self.assertNotEqual(row["validation_status"], "validated")
        self.assertEqual(memory.rows, [])  # compensated

    def _reverify_with_tombstone(self, text, t_event, source_hash, quote_hashes):
        tag = f"{t_event}-{len(quote_hashes)}"
        src = os.path.join(self.tmp, "s-" + tag)
        copy = os.path.join(self.tmp, "c-" + tag)
        os.makedirs(src, mode=0o700)
        make_db(src)
        conn = sqlite3.connect(os.path.join(src, "ingest.sqlite"))
        insert_original(conn, "e1", "u1", "user", text)
        conn.commit()
        conn.close()
        convert(src, copy)
        copy_db = os.path.join(copy, "ingest.sqlite")
        insert_tombstone(copy_db, "u1", t_event, source_hash, quote_hashes)
        memory = FakeMem0()
        engine = Mem0Engine(memory=memory, evaluator=FakeEvaluator(),
                            quality_config=make_config(), version="synthetic-only")
        counts = reverify(copy, engine)
        return counts, read_row(copy_db, "e1"), memory, copy, copy_db

    def test_event_source_quote_tombstones_all_suppress(self):
        text = "我喜欢用中文回复。另外一句。"
        sentence = sorted(lifecycle.sentence_hashes(text))
        cases = {
            "event": ("e1", text_hash("unrelated text"), []),
            "source": ("other-event", text_hash(text), []),
            "quote": ("other-event", text_hash("unrelated text"), sentence[:1]),
        }
        for kind, (t_event, source_hash, quote_hashes) in cases.items():
            with self.subTest(kind=kind):
                counts, row, memory, copy, copy_db = self._reverify_with_tombstone(
                    text, t_event, source_hash, quote_hashes)
                self.assertEqual(counts["forgotten"], 1)
                self.assertEqual(counts["validated"], 0)
                self.assertEqual(row["forgotten"], 1)
                self.assertNotEqual(row["validation_status"], "validated")
                self.assertEqual(memory.rows, [])
                # A forgotten turn is never recallable through the service.
                service = MemoryService(Path(copy), Mem0Engine(
                    memory=memory, evaluator=FakeEvaluator(),
                    quality_config=make_config(), version="synthetic-only"))
                self.assertEqual(
                    service.search(Search(user_id="u1", query="中文")), [])


# --- 14. F004 store-retry reuses the persisted plan -------------------------
class StoreRetryPlanReuseTests(MigrationFixture):
    """F004: a store retry never re-runs prepare/evaluator; a bad plan fails closed."""

    def _prepare(self, text="我喜欢用中文回复"):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", text)
        conn.commit()
        conn.close()
        convert(self.source, self.copy)

    def _engine(self, memory, evaluator):
        return Mem0Engine(memory=memory, evaluator=evaluator,
                          quality_config=make_config(), version="synthetic-only")

    def test_store_retry_reuses_persisted_plan_without_repreparing(self):
        self._prepare()
        memory = FakeMem0()
        memory.failures_remaining = 1
        evaluator = FakeEvaluator()
        engine = self._engine(memory, evaluator)

        first = reverify(self.copy, engine)
        first_calls = len(evaluator.calls)
        self.assertEqual(first["errors"], 1)
        plan_after_first = read_row(self.copy_db, "e1")["plan"]
        self.assertIsNotNone(plan_after_first)

        second = reverify(self.copy, engine)
        self.assertEqual(second["validated"], 1)
        # Zero additional evaluator (semantic) calls on the retry.
        self.assertEqual(len(evaluator.calls), first_calls)
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["validation_status"], "validated")
        self.assertEqual(json.loads(row["plan"]), json.loads(plan_after_first))

    def test_persisted_plan_settles_after_simulated_crash(self):
        self._prepare()
        memory = FakeMem0()
        evaluator = FakeEvaluator()
        engine = self._engine(memory, evaluator)
        real_store = engine.store

        def store_then_crash(turn, plan):
            real_store(turn, plan)  # the vector effect happens...
            raise RuntimeError("crash after effect, before receipt")

        engine.store = store_then_crash
        first = reverify(self.copy, engine)
        self.assertEqual(first["errors"], 1)
        self.assertEqual(len(memory.rows), 1)
        plan_after_first = json.loads(read_row(self.copy_db, "e1")["plan"])

        # Resume from the persisted plan: same plan, no re-extraction, no dup.
        engine.store = real_store
        before_calls = len(evaluator.calls)
        second = reverify(self.copy, engine)
        self.assertEqual(second["validated"], 1)
        self.assertEqual(len(evaluator.calls), before_calls)
        self.assertEqual(len(memory.rows), 1)
        self.assertEqual(json.loads(read_row(self.copy_db, "e1")["plan"]),
                         plan_after_first)

    def test_tampered_persisted_plan_fails_closed(self):
        self._prepare()
        memory = FakeMem0()
        memory.failures_remaining = 1
        evaluator = FakeEvaluator()
        engine = self._engine(memory, evaluator)
        self.assertEqual(reverify(self.copy, engine)["errors"], 1)

        plan = json.loads(read_row(self.copy_db, "e1")["plan"])
        plan["facts"][0]["quote"] = "a quote that is not in the source text"
        conn = sqlite3.connect(self.copy_db)
        conn.execute("UPDATE turns SET plan=? WHERE event_id='e1'",
                     (json.dumps(plan, ensure_ascii=False),))
        conn.commit()
        conn.close()

        before_calls = len(evaluator.calls)
        store_calls = []
        real_store = engine.store

        def spy_store(turn, plan):
            store_calls.append(turn.event_id)
            return real_store(turn, plan)

        engine.store = spy_store
        second = reverify(self.copy, engine)
        self.assertEqual(second["validated"], 0)
        self.assertEqual(second["needs_review"], 1)
        self.assertEqual(len(evaluator.calls), before_calls)  # no re-extraction
        self.assertEqual(store_calls, [])  # no effect attempted
        row = read_row(self.copy_db, "e1")
        self.assertEqual(row["status"], "needs_review")
        self.assertNotEqual(row["validation_status"], "validated")

    def test_plan_version_drift_fails_closed(self):
        self._prepare()
        memory = FakeMem0()
        memory.failures_remaining = 1
        evaluator = FakeEvaluator()
        engine = self._engine(memory, evaluator)
        self.assertEqual(reverify(self.copy, engine)["errors"], 1)

        plan = json.loads(read_row(self.copy_db, "e1")["plan"])
        plan["extraction_version"] = "extraction-v0"
        conn = sqlite3.connect(self.copy_db)
        conn.execute("UPDATE turns SET plan=? WHERE event_id='e1'",
                     (json.dumps(plan, ensure_ascii=False),))
        conn.commit()
        conn.close()

        before_calls = len(evaluator.calls)
        second = reverify(self.copy, engine)
        self.assertEqual(second["validated"], 0)
        self.assertEqual(second["needs_review"], 1)
        self.assertEqual(len(evaluator.calls), before_calls)
        self.assertNotEqual(
            read_row(self.copy_db, "e1")["validation_status"], "validated")


# --- CLI smoke tests --------------------------------------------------------
class CliTests(MigrationFixture):
    def test_cli_help(self):
        proc = subprocess.run(
            [sys.executable, "-m", "services.memory.migration", "--help"],
            cwd=str(REPO_ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--dry-run", proc.stdout)
        self.assertIn("--allow-real-engine", proc.stdout)

    def test_cli_dry_run_on_synthetic_directory(self):
        make_db(self.source)
        secret = "synthetic-marker-SYNTHETIC_SECRET"
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", f"my api_key = {secret}")
        insert_original(conn, "e2", "u1", "assistant", "ok")
        conn.commit()
        conn.close()

        interpreter = shutil.which("python3") or sys.executable
        proc = subprocess.run(
            [interpreter, "-m", "services.memory.migration",
             "--source", self.source, "--copy", self.copy, "--dry-run"],
            cwd=str(REPO_ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report["dry_run"])
        self.assertEqual(report["network_calls"], 0)
        self.assertTrue(report["conservation"]["digests_match"])
        # Redacted output: no raw text, secret, paths or ids.
        self.assertNotIn(secret, proc.stdout)
        self.assertNotIn(self.tmp, proc.stdout)
        self.assertNotIn("e1", proc.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.copy, "migration-manifest.json")))

    def test_cli_reverify_without_allow_real_engine_fails_closed(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "some text")
        conn.commit()
        conn.close()

        proc = subprocess.run(
            [sys.executable, "-m", "services.memory.migration",
             "--source", self.source, "--copy", self.copy, "--reverify"],
            cwd=str(REPO_ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("allow-real-engine", proc.stderr)
        self.assertEqual(proc.stdout, "")
        # Redacted stderr: no raw paths.
        self.assertNotIn(self.tmp, proc.stderr)
        # Fail closed happens before any migration side effect.
        self.assertFalse(os.path.exists(os.path.join(self.copy, "migration-manifest.json")))

    def test_cli_reverify_with_flag_does_not_build_a_real_evaluator(self):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", "some text")
        conn.commit()
        conn.close()

        # The real engine / evaluator must never be constructed here: patch
        # ``_default_engine`` and ``reverify`` so only argument handling runs.
        with patch.object(migration, "_default_engine", return_value=object()) as fake_engine, \
                patch.object(migration, "reverify",
                             return_value={"validated": 0}) as fake_reverify:
            with contextlib.redirect_stdout(io.StringIO()):
                code = migration.main(["--source", self.source, "--copy", self.copy,
                                       "--reverify", "--allow-real-engine"])
        self.assertEqual(code, 0)
        fake_engine.assert_called_once()
        fake_reverify.assert_called_once()


# --- 15. F001 r3: refusal happens before any write --------------------------
class TargetRefusalBeforeWriteTests(MigrationFixture):
    """F001 r3: every read/identity/provenance check precedes mkdir/chmod/DDL.

    A refused target must keep byte-for-byte identical content, mode and
    directory entries -- in particular its directory mode must not be tightened
    to 0700 on the way to the refusal.
    """

    def _seed_source(self, text="alpha durable preference"):
        make_db(self.source)
        conn = self.connect(self.source_db)
        insert_original(conn, "e1", "u1", "user", text)
        conn.commit()
        conn.close()

    def _unknown_target(self, dir_mode):
        """An existing, independently created db with no ``turns`` schema."""
        os.makedirs(self.copy, mode=dir_mode)
        os.chmod(self.copy, dir_mode)
        conn = sqlite3.connect(self.copy_db)
        conn.execute("CREATE TABLE unrelated(value TEXT)")
        conn.execute("INSERT INTO unrelated(value) VALUES('x')")
        conn.commit()
        conn.close()
        os.chmod(self.copy_db, 0o600)

    def _assert_zero_mutation(self, before_bytes, before_entries):
        self.assertEqual(Path(self.copy_db).read_bytes(), before_bytes)
        self.assertEqual(sorted(os.listdir(self.copy)), before_entries)

    def test_unknown_target_0755_is_refused_without_touching_mode(self):
        self._seed_source()
        self._unknown_target(0o755)
        before_bytes = Path(self.copy_db).read_bytes()
        before_entries = sorted(os.listdir(self.copy))
        with self.assertRaises(MigrationError) as ctx:
            snapshot(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        self._assert_zero_mutation(before_bytes, before_entries)
        self.assertEqual(stat.S_IMODE(os.stat(self.copy).st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(os.stat(self.copy_db).st_mode), 0o600)

    def test_unknown_target_0770_is_refused_without_touching_mode(self):
        self._seed_source()
        self._unknown_target(0o770)
        before_bytes = Path(self.copy_db).read_bytes()
        before_entries = sorted(os.listdir(self.copy))
        with self.assertRaises(MigrationError) as ctx:
            snapshot(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        self._assert_zero_mutation(before_bytes, before_entries)
        self.assertEqual(stat.S_IMODE(os.stat(self.copy).st_mode), 0o770)

    def test_unknown_target_0755_via_convert_is_refused_without_change(self):
        self._seed_source()
        self._unknown_target(0o755)
        before_bytes = Path(self.copy_db).read_bytes()
        before_entries = sorted(os.listdir(self.copy))
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, self.copy)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        self._assert_zero_mutation(before_bytes, before_entries)
        self.assertEqual(stat.S_IMODE(os.stat(self.copy).st_mode), 0o755)
        self.assertFalse(
            os.path.exists(os.path.join(self.copy, "migration-manifest.json")))


# --- 16. F001 r3: a manifest-less target must be a COMPLETE snapshot ---------
class FaithfulSnapshotSetEqualityTests(MigrationFixture):
    """F001 r3: a manifest-less target must be a complete faithful snapshot."""

    def _source_with(self, event_ids):
        make_db(self.source)
        conn = self.connect(self.source_db)
        for index, event_id in enumerate(event_ids, start=1):
            insert_original(conn, event_id, "u1", "user", f"durable line {index}")
        conn.commit()
        conn.close()

    def _baseline_target(self, event_ids, name):
        directory = os.path.join(self.tmp, name)
        os.makedirs(directory, mode=0o700)
        path = make_db(directory)
        for index, event_id in enumerate(event_ids, start=1):
            insert_row(path, event_id, "u1", "user", f"durable line {index}")
        return directory, path

    def test_empty_baseline_target_snapshot_is_refused(self):
        # The exact audit probe: source 1 row, independent 0-row target.
        self._source_with(["e1"])
        directory, path = self._baseline_target([], "empty-baseline")
        before_bytes = Path(path).read_bytes()
        before_entries = sorted(os.listdir(directory))
        with self.assertRaises(MigrationError) as ctx:
            snapshot(self.source, directory)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        self.assertEqual(Path(path).read_bytes(), before_bytes)
        self.assertEqual(sorted(os.listdir(directory)), before_entries)

    def test_empty_baseline_target_convert_is_refused_without_backup(self):
        self._source_with(["e1"])
        directory, path = self._baseline_target([], "empty-baseline-2")
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, directory)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")
        conn = sqlite3.connect(path)
        try:
            self.assertEqual(
                conn.execute("SELECT count(*) FROM turns").fetchone()[0], 0)
        finally:
            conn.close()
        self.assertFalse(
            os.path.exists(os.path.join(directory, "migration-manifest.json")))

    def test_non_empty_subset_target_is_refused(self):
        # source {e1,e2}, independent byte-faithful subset {e1}.
        self._source_with(["e1", "e2"])
        directory, path = self._baseline_target(["e1"], "subset-baseline")
        before_bytes = Path(path).read_bytes()
        before_entries = sorted(os.listdir(directory))
        with self.assertRaises(MigrationError) as ctx:
            snapshot(self.source, directory)
        self.assertEqual(str(ctx.exception), "conservation_violation")
        self.assertEqual(Path(path).read_bytes(), before_bytes)
        self.assertEqual(sorted(os.listdir(directory)), before_entries)

    def test_half_copy_without_marker_is_refused(self):
        # A target missing source rows and carrying no manifest/journal marker
        # is not a resumable converter copy.
        self._source_with(["e1", "e2"])
        directory, path = self._baseline_target(["e1"], "half-no-marker")
        before_bytes = Path(path).read_bytes()
        with self.assertRaises(MigrationError) as ctx:
            convert(self.source, directory)
        self.assertEqual(str(ctx.exception), "conservation_violation")
        self.assertEqual(Path(path).read_bytes(), before_bytes)
        self.assertFalse(
            os.path.exists(os.path.join(directory, "migration-manifest.json")))

    def test_half_copy_with_manifest_marker_is_resumed(self):
        # A converter copy that lost a row but kept its manifest marker is
        # resumed (the missing row is restored), not refused.
        self._source_with(["e1", "e2"])
        convert(self.source, self.copy)
        conn = self.connect(self.copy_db)
        conn.execute("DELETE FROM turns WHERE event_id='e1'")
        conn.commit()
        conn.close()
        self.assertIsNone(read_row(self.copy_db, "e1"))

        report = convert(self.source, self.copy)
        self.assertTrue(report["conservation"]["digests_match"])
        self.assertEqual(set(self.copy_state()), {"e1", "e2"})
        self.assertEqual(read_row(self.copy_db, "e1")["status"], "pending")

    def test_complete_same_source_snapshot_is_accepted_and_reentrant(self):
        self._source_with(["e1", "e2"])
        first = snapshot(self.source, self.copy)
        second = snapshot(self.source, self.copy)
        self.assertEqual(first["total"], 2)
        self.assertEqual(second["total"], 2)

    def test_complete_independent_same_schema_copy_is_accepted(self):
        # Independently built rows that are byte-identical to the source form a
        # verifiable content mapping (equal id set + digest + payload + time).
        self._source_with(["e1", "e2"])
        directory, _ = self._baseline_target(["e1", "e2"], "independent-full")
        report = snapshot(self.source, directory)
        self.assertEqual(report["total"], 2)
        self.assertTrue(
            verify_conservation(self.source, directory)["digests_match"])

    def test_empty_source_with_empty_target_is_accepted(self):
        self._source_with([])
        directory, _ = self._baseline_target([], "empty-both")
        report = snapshot(self.source, directory)
        self.assertEqual(report["total"], 0)

    def test_empty_source_with_nonempty_target_is_refused(self):
        self._source_with([])
        directory, _ = self._baseline_target(["e1"], "source-empty-target-full")
        with self.assertRaises(MigrationError) as ctx:
            snapshot(self.source, directory)
        self.assertEqual(str(ctx.exception), "unknown_existing_db")


# --- 17. root-level symlink exemption is narrowed ---------------------------
class RootAliasExemptionTests(MigrationFixture):
    """F001 r3: only verified, root-owned system aliases are exempt."""

    def test_unknown_root_child_name_is_not_exempt(self):
        self.assertFalse(migration._is_root_system_alias("/not-a-system-alias"))

    def test_alias_named_symlink_below_root_is_not_exempt(self):
        target = os.path.join(self.tmp, "alias-target")
        os.makedirs(target, mode=0o700)
        fake = os.path.join(self.tmp, "var")
        os.symlink(target, fake)
        self.assertFalse(migration._is_root_system_alias(fake))

    def test_verified_root_alias_is_exempt_only_when_it_is_a_system_alias(self):
        if os.path.islink("/var"):
            self.assertTrue(migration._is_root_system_alias("/var"))
        else:
            self.assertFalse(migration._is_root_system_alias("/var"))


if __name__ == "__main__":
    unittest.main()
