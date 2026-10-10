"""Tests for the read-only memory upgrade preflight.

All fixtures are private temp SQLite databases created by the tests.  No host
data, credentials, real models, SDK memory stores or services are touched.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import migration_preflight  # noqa: E402
from services.memory.migration_preflight import PreflightError, inspect_upgrade  # noqa: E402

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


def make_db(directory, *, quality=True, ddl=ORIGINAL_DDL, name="ingest.sqlite"):
    path = os.path.join(directory, name)
    conn = sqlite3.connect(path)
    conn.execute(ddl)
    if quality:
        for addition in QUALITY_ADDITIONS:
            conn.execute(f"ALTER TABLE turns ADD COLUMN {addition}")
    conn.commit()
    conn.close()
    os.chmod(path, 0o600)
    return path


def insert_original(conn, event_id, user_id, role, text, *, status="done",
                    digest=None):
    obj = payload(event_id, user_id, role, text)
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    digest = digest or digest_of(obj)
    conn.execute(
        "INSERT INTO turns(event_id,payload,digest,status,created_at) "
        "VALUES(?,?,?,?,?)", (event_id, raw, digest, status, 1.0))


def insert(conn, event_id, user_id, role, text, *, status="done",
           validation_status=None, extraction_version=None, source="wechat",
           digest=None, forgotten=0):
    obj = payload(event_id, user_id, role, text, source)
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    digest = digest or digest_of(obj)
    conn.execute(
        "INSERT INTO turns(event_id,payload,digest,status,validation_status,"
        "extraction_version,forgotten,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (event_id, raw, digest, status, validation_status, extraction_version,
         forgotten, 1.0))


class PreflightFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="preflight-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def db(self, **kwargs):
        return make_db(self.tmp, **kwargs)

    def connect(self, path):
        return sqlite3.connect(path)
    def assert_generic(self, callable_):
        with self.assertRaises(PreflightError) as ctx:
            callable_()
        message = str(ctx.exception)
        self.assertTrue(message)
        self.assertNotIn(self.tmp, message)
        return message


class PathSafetyTests(PreflightFixture):
    def test_public_parent_and_null_path_refused(self):
        path = self.db()
        os.chmod(self.tmp, 0o755)
        try:
            self.assert_generic(lambda: inspect_upgrade(path))
        finally:
            os.chmod(self.tmp, 0o700)
        self.assert_generic(lambda: inspect_upgrade(path + "\x00SYNTHETIC_SECRET"))

    def test_missing_database_refused(self):
        missing = os.path.join(self.tmp, "nope.sqlite")
        self.assert_generic(lambda: inspect_upgrade(missing))

    def test_symlink_database_refused(self):
        real = self.db()
        link = os.path.join(self.tmp, "link.sqlite")
        os.symlink(real, link)
        self.assert_generic(lambda: inspect_upgrade(link))

    def test_public_permissions_refused(self):
        path = self.db()
        os.chmod(path, 0o644)
        self.assert_generic(lambda: inspect_upgrade(path))

    def test_corrupt_file_refused(self):
        path = os.path.join(self.tmp, "corrupt.sqlite")
        with open(path, "wb") as handle:
            handle.write(b"this is not a sqlite database at all")
        os.chmod(path, 0o600)
        self.assert_generic(lambda: inspect_upgrade(path))

    def test_relative_and_nonregular_refused(self):
        path = self.db()
        self.assert_generic(lambda: inspect_upgrade("ingest.sqlite"))
        self.assert_generic(lambda: inspect_upgrade(self.tmp))


class RowSemanticsTests(PreflightFixture):
    def test_bounded_inspection_and_unencodable_payload_fail_redacted(self):
        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "synthetic")
        conn.commit(); conn.close()
        with patch.object(migration_preflight, "MAX_RECEIPTS", 0):
            self.assert_generic(lambda: inspect_upgrade(path))
        with patch.object(migration_preflight, "MAX_PAYLOAD_CHARS", 1):
            self.assert_generic(lambda: inspect_upgrade(path))
        conn = self.connect(path)
        obj = payload("a", "u1", "user", "\ud800")
        conn.execute("UPDATE turns SET payload=?", (json.dumps(obj),))
        conn.commit(); conn.close()
        self.assert_generic(lambda: inspect_upgrade(path))

    def test_unknown_validation_status_never_leaks_as_an_aggregate_key(self):
        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "synthetic", validation_status="SYNTHETIC_SECRET")
        conn.commit(); conn.close()
        message = self.assert_generic(lambda: inspect_upgrade(path))
        self.assertNotIn("SYNTHETIC_SECRET", message)

    def test_forgotten_done_receipt_is_not_a_new_recall_impact(self):
        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "forgotten", forgotten=1)
        conn.commit(); conn.close()
        report = inspect_upgrade(path)
        self.assertEqual(report["rows"]["forgotten"], 1)
        self.assertEqual(report["legacyRecallImpactReceipts"], 0)

    def test_partial_quality_columns_are_not_a_complete_quality_schema(self):
        path = self.db(quality=False)
        conn = self.connect(path)
        conn.execute("ALTER TABLE turns ADD COLUMN validation_status TEXT")
        conn.execute("ALTER TABLE turns ADD COLUMN extraction_version TEXT")
        insert_original(conn, "a", "u1", "user", "synthetic")
        conn.commit(); conn.close()
        self.assertFalse(inspect_upgrade(path)["qualitySchemaPresent"])

    def test_payload_identity_mismatch_cannot_claim_integrity(self):
        path = self.db()
        conn = self.connect(path)
        obj = payload("foreign-event", "u1", "user", "synthetic")
        conn.execute("INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)", ("stored-event", json.dumps(obj), digest_of(obj), "done", 1))
        conn.commit(); conn.close()
        self.assertFalse(inspect_upgrade(path)["payloadIntegrityVerified"])

    def test_original_pre_quality_schema(self):
        path = self.db(quality=False)
        conn = self.connect(path)
        insert_original(conn, "e1", "u1", "user", "hello", status="done")
        insert_original(conn, "e2", "u1", "assistant", "hi", status="done")
        insert_original(conn, "e3", "u1", "user", "queued", status="pending")
        conn.commit()
        conn.close()

        report = inspect_upgrade(path)
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["converterVersion"], "legacy-memory-preflight-v1")
        self.assertTrue(report["inspectionOnly"])
        self.assertEqual(report["networkCalls"], 0)
        self.assertFalse(report["qualitySchemaPresent"])
        self.assertEqual(report["rows"]["total"], 3)
        self.assertEqual(report["rows"]["done"], 2)
        self.assertEqual(report["legacyRecallImpactReceipts"], 2)
        self.assertEqual(report["rows"]["userRole"], 2)
        self.assertEqual(report["rows"]["assistantRole"], 1)
        self.assertFalse(report["readyForServiceRestart"])
        self.assertEqual(report["remainingValidation"], [
            "legacy-source-revalidation", "vector-recall-verification",
            "authorized-cutover"])

    def test_mixed_quality_schema_and_extraction_versions(self):
        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "clean", validation_status="validated",
               extraction_version="extraction-v2")
        insert(conn, "b", "u1", "user", "old", validation_status="validated",
               extraction_version="extraction-v1")
        insert(conn, "c", "u1", "assistant", "legacy",
               validation_status="legacy_unverified")
        insert(conn, "d", "u1", "user", "unset", validation_status=None)
        insert(conn, "e", "u1", "user", "review", status="needs_review",
               validation_status="needs_review")
        conn.commit()
        conn.close()

        report = inspect_upgrade(path)
        self.assertTrue(report["qualitySchemaPresent"])
        self.assertEqual(report["rows"]["byStatus"]["done"], 4)
        self.assertEqual(report["rows"]["needsReview"], 1)
        self.assertEqual(report["legacyRecallImpactReceipts"], 3)
        self.assertTrue(report["payloadIntegrityVerified"])
        self.assertFalse(report["readyForServiceRestart"])
        self.assertEqual(report["rows"]["byValidationStatus"]["unset"], 1)

    def test_digest_mismatch_disables_integrity(self):
        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "good")
        insert(conn, "b", "u1", "user", "tampered", digest="0" * 64)
        conn.commit()
        conn.close()

        report = inspect_upgrade(path)
        self.assertFalse(report["payloadIntegrityVerified"])
        self.assertEqual(report["legacyRecallImpactReceipts"], 2)

    def test_malformed_rows_rejected(self):
        # Malformed JSON payload.
        json_path = self.db(name="malformed.sqlite")
        conn = self.connect(json_path)
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at) "
            "VALUES(?,?,?,?,?)", ("x", "{not json", "0" * 64, "done", 1.0))
        conn.commit()
        conn.close()
        self.assert_generic(lambda: inspect_upgrade(json_path))

        # NULL in a required field.
        null_path = self.db(name="nulled.sqlite")
        conn = self.connect(null_path)
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at) "
            "VALUES(?,?,?,?,?)",
            (None, json.dumps(payload("n", "u", "user", "t")), "0" * 64, "done", 1.0))
        conn.commit()
        conn.close()
        self.assert_generic(lambda: inspect_upgrade(null_path))

        # Unknown status token.
        status_path = self.db(name="status.sqlite")
        conn = self.connect(status_path)
        insert(conn, "a", "u1", "user", "x", status="weird")
        conn.commit()
        conn.close()
        self.assert_generic(lambda: inspect_upgrade(status_path))


class ReadOnlyIsolationTests(PreflightFixture):
    def test_no_schema_or_source_mutation_and_repeatability(self):
        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "stable", validation_status="validated",
               extraction_version="extraction-v2")
        conn.commit()
        conn.close()

        with open(path, "rb") as handle:
            before = handle.read()
        first = inspect_upgrade(path)
        second = inspect_upgrade(path)
        with open(path, "rb") as handle:
            after = handle.read()

        self.assertEqual(first, second)
        self.assertEqual(before, after)
        self.assertFalse(os.path.exists(path + "-wal"))
        self.assertFalse(os.path.exists(path + "-shm"))
        self.assertTrue(first["payloadIntegrityVerified"])

    def test_committed_wal_visibility_with_held_writer(self):
        path = os.path.join(self.tmp, "wal.sqlite")
        writer = sqlite3.connect(path)
        os.chmod(path, 0o600)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute(ORIGINAL_DDL)
        for addition in QUALITY_ADDITIONS:
            writer.execute(f"ALTER TABLE turns ADD COLUMN {addition}")
        insert(writer, "w1", "u1", "user", "in wal", validation_status="validated",
               extraction_version="extraction-v2")
        insert(writer, "w2", "u1", "assistant", "pending wal", status="pending")
        writer.commit()
        # Writer connection stays open; committed WAL content must still be seen.
        try:
            report = inspect_upgrade(path)
        finally:
            writer.close()

        self.assertEqual(report["rows"]["total"], 2)
        self.assertEqual(report["rows"]["done"], 1)
        self.assertEqual(report["rows"]["userRole"], 1)
        self.assertEqual(report["rows"]["assistantRole"], 1)
        self.assertTrue(report["payloadIntegrityVerified"])
        self.assertEqual(report["legacyRecallImpactReceipts"], 0)


class SecurityAndCliTests(PreflightFixture):
    def test_cli_argument_errors_do_not_echo_unknown_secrets(self):
        proc = subprocess.run([sys.executable, "-m", "services.memory.migration_preflight", "--database", "/SYNTHETIC_SECRET", "--apply", "SYNTHETIC_SECRET"], cwd=str(REPO_ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.assertNotIn("SYNTHETIC_SECRET", proc.stdout + proc.stderr)

    def test_no_service_import_generic_errors_and_cli(self):
        # Check a fresh interpreter, not the test runner's unrelated imports.
        # A joint suite legitimately imports FastAPI/MemoryService elsewhere.
        cold = subprocess.run([sys.executable, "-c", "import sys; import services.memory.migration_preflight; assert all(name not in sys.modules for name in ['services.memory.service', 'pydantic', 'fastapi'])"], cwd=str(REPO_ROOT), capture_output=True, text=True)
        self.assertEqual(cold.returncode, 0, cold.stderr)

        missing = os.path.join(self.tmp, "gone.sqlite")
        with self.assertRaises(PreflightError) as ctx:
            inspect_upgrade(missing)
        message = str(ctx.exception)
        self.assertNotIn(missing, message)
        self.assertNotIn("gone.sqlite", message)

        path = self.db()
        conn = self.connect(path)
        insert(conn, "a", "u1", "user", "text-secret", validation_status="validated",
               extraction_version="extraction-v2")
        conn.commit()
        conn.close()

        base = [sys.executable, "-m", "services.memory.migration_preflight"]
        proc = subprocess.run(base + ["--database", path], cwd=str(REPO_ROOT),
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertTrue(report["inspectionOnly"])
        self.assertEqual(report["networkCalls"], 0)
        self.assertNotIn("text-secret", proc.stdout)
        self.assertNotIn(path, proc.stdout)

        for forbidden in ("--apply", "--live"):
            bad = subprocess.run(base + ["--database", path, forbidden],
                                 cwd=str(REPO_ROOT), capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)


if __name__ == "__main__":
    unittest.main()
