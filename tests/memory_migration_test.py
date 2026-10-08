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

    def search(self, query, *, filters=None, top_k=20):
        filters = filters or {}
        found = [{"id": row["id"], "memory": row["memory"], "score": 1.0,
                  "metadata": dict(row["metadata"])}
                 for row in self.rows if row["user_id"] == filters.get("user_id")]
        return {"results": found[:top_k]}


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


if __name__ == "__main__":
    unittest.main()
