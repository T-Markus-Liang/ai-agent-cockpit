"""Tests for the S04 outbound inventory + secret screen (remediation §6-3).

Every fixture is a private, synthetic temp SQLite database created by these
tests. No host data, real models, evaluators, SDK memory stores or services
are touched: databases are opened ``mode=ro&immutable=1`` and never modified,
no network call is made (a test patches ``socket.socket`` to fail the suite if
one were attempted), and no real history text is used anywhere — all records
are synthetic. Historical counts (113 receipts / 43 user entries) are runtime
inventory results, never constants, and are not reproduced here.
"""
from __future__ import annotations

import json
import hashlib
import os
import shutil
import socket
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.memory import outbound_inventory, quality
from services.memory.outbound_inventory import (
    InventoryError, build_outbound_dry_run, inventory_outbound, secret_screen)

REPO_ROOT = Path(__file__).resolve().parents[1]
import sys
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DDL = (
    "CREATE TABLE turns("
    "event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL, "
    "status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, "
    "retry_at REAL NOT NULL DEFAULT 0, error_kind TEXT, created_at REAL NOT NULL, "
    "validation_status TEXT, forgotten INTEGER NOT NULL DEFAULT 0)"
)


def turn_payload(event_id, user_id, role, text):
    return json.dumps({"event_id": event_id, "user_id": user_id, "role": role,
                       "text": text, "source": "wechat"},
                      sort_keys=True, ensure_ascii=False)


def make_db(path: Path, rows):
    """rows: list of (event_id, user_id, role, text, status, validation, forgotten)"""
    conn = sqlite3.connect(path)
    try:
        conn.execute(DDL)
        for event_id, user_id, role, text, status, validation, forgotten in rows:
            # ``text=None`` writes a deliberately unparseable payload row.
            payload = (turn_payload(event_id, user_id, role, text)
                       if text is not None else "||not-json||" + event_id)
            digest = "d" + event_id
            conn.execute(
                "INSERT INTO turns(event_id,payload,digest,status,created_at,"
                "validation_status,forgotten) VALUES(?,?,?,?,?,?,?)",
                (event_id, payload, digest, status, 1_700_000_000.0,
                 validation, forgotten))
        conn.commit()
    finally:
        conn.close()
    path.chmod(0o400)  # Offline standalone snapshot, sealed by its owner.


SYNTHETIC_ROWS = [
    ("u1", "user-1", "user", "我喜欢手冲咖啡。", "pending", None, 0),
    ("u2", "user-1", "user", "明天下午三点开会。", "pending", None, 0),
    ("u3", "user-2", "user", "项目代号是蓝色灯塔。", "done", "legacy_unverified", 0),
    ("u4", "user-2", "user", "旧偏好记录。", "needs_review", "needs_review", 0),
    ("u5", "user-3", "user", "已经忘记的句子。", "done", "validated", 1),
    ("a1", "user-1", "assistant", "助手回复一。", "done", "assistant_archived", 0),
    ("a2", "user-2", "assistant", "助手回复二。", "done", "assistant_archived", 0),
    ("x1", "user-4", "user", None, "done", "legacy_unverified", 0),  # unparseable
]


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.db = Path(self._tmp.name) / "ingest.sqlite"
        make_db(self.db, SYNTHETIC_ROWS)

    def inventory(self, **kwargs):
        return inventory_outbound(self.db, **kwargs)

    def test_user_and_assistant_are_counted_separately(self):
        report = self.inventory()
        self.assertEqual(report["user_data"]["total"], 5)
        self.assertEqual(report["assistant_data"]["total"], 2)
        self.assertEqual(report["user_data"]["by_status"],
                         {"done": 2, "needs_review": 1, "pending": 2})
        self.assertEqual(report["assistant_data"]["by_status"], {"done": 2})

    def test_outbound_candidates_and_exclusions(self):
        report = self.inventory()
        # pending + done(user, not forgotten) are candidates; needs_review is
        # retained (not re-sent without re-approval); forgotten is excluded.
        self.assertEqual(report["user_data"]["outbound_candidates"], 3)
        self.assertEqual(report["user_data"]["forgotten_excluded"], 1)
        self.assertEqual(report["user_data"]["unparseable_excluded"], 1)
        self.assertEqual(report["assistant_data"]["outbound_candidates"], 0)
        self.assertIn("never sent", report["assistant_data"]["handling"])

    def test_record_categories_fields_and_provider(self):
        report = self.inventory()
        self.assertIn("user_text", report["user_data"]["fields_full_user_text"])
        self.assertIn("approved_quote", report["user_data"]["fields_minimal_quote"])
        self.assertEqual(report["provider"]["name"], "jev-eval-wrapper")
        self.assertIn("turns", report["database"]["tables"])
        self.assertEqual(report["database"]["opens"], "mode=ro&immutable=1")

    def test_suggested_call_caps_come_from_the_quality_config(self):
        cfg = quality.QualityConfig(max_text_chars=1234, max_facts=7)
        report = self.inventory(config=cfg)
        cap = report["suggested_call_cap"]
        self.assertEqual(cap["max_text_chars"], 1234)
        self.assertEqual(cap["max_facts"], 7)
        self.assertEqual(cap["per_record_batches"], 2)
        self.assertEqual(cap["total_batches_upper_bound"],
                         report["user_data"]["outbound_candidates"] * 2)

    def test_open_is_read_only_and_creates_no_sidecar(self):
        before = sorted(p.name for p in self.db.parent.iterdir())
        self.inventory()
        after = sorted(p.name for p in self.db.parent.iterdir())
        self.assertEqual(before, after)
        self.assertFalse((self.db.parent / (self.db.name + "-wal")).exists())

    def test_missing_or_invalid_database_fails_closed(self):
        with self.assertRaises(InventoryError) as ctx:
            inventory_outbound(self.db.parent / "nope.sqlite")
        self.assertEqual(ctx.exception.code, "missing-db")
        junk = self.db.parent / "junk.sqlite"
        junk.write_bytes(b"not a database at all")
        junk.chmod(0o400)
        with self.assertRaises(InventoryError) as ctx2:
            inventory_outbound(junk)
        self.assertIn(ctx2.exception.code, ("not-a-database", "missing-turns"))

    def test_report_never_contains_raw_text_or_ids(self):
        report = self.inventory()
        blob = json.dumps(report, ensure_ascii=False)
        for needle in ("我喜欢手冲咖啡", "项目代号", "user-1", "u1", "event_id"):
            self.assertNotIn(needle, blob)


def source_state(directory):
    """Bytes, inode, size, mode, mtime/ctime and names (excluding read atime)."""
    result = {}
    for path in directory.iterdir():
        st = path.lstat()
        result[path.name] = (st.st_ino, st.st_size, st.st_mode,
                             st.st_mtime_ns, st.st_ctime_ns,
                             hashlib.sha256(path.read_bytes()).hexdigest())
    return result


class StandaloneSnapshotTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.db = self.root / "synthetic.sqlite"
        make_db(self.db, SYNTHETIC_ROWS[:1])

    def wal_with_committed_row(self):
        self.db.chmod(0o600)
        conn = sqlite3.connect(self.db)
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
        conn.execute("PRAGMA wal_autocheckpoint=0")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("INSERT INTO turns(event_id,payload,digest,status,created_at) "
                     "VALUES(?,?,?,?,?)",
                     ("wal-row", turn_payload("wal-row", "synthetic-user", "user", "合成 WAL 行"),
                      "synthetic-digest", "pending", 1.0))
        conn.commit()
        self.assertEqual(conn.execute("SELECT count(*) FROM turns").fetchone(), (2,))
        self.assertGreater(Path(str(self.db) + "-wal").stat().st_size, 0)
        self.db.chmod(0o400)
        return conn

    def assert_rejected_unchanged(self, db):
        before = source_state(self.root)
        with patch.object(outbound_inventory.sqlite3, "connect",
                          side_effect=AssertionError("unsafe source reached SQLite")):
            with self.assertRaises(InventoryError) as ctx:
                inventory_outbound(db)
        self.assertEqual(ctx.exception.code, "unsafe-snapshot")
        self.assertEqual(source_state(self.root), before)

    def test_committed_wal_rows_are_rejected_without_source_side_effects(self):
        self.wal_with_committed_row()
        self.assert_rejected_unchanged(self.db)

    def test_copied_wal_main_without_sidecars_is_still_rejected(self):
        self.wal_with_committed_row()
        copied = self.root / "copied-main.sqlite"
        shutil.copyfile(self.db, copied)
        copied.chmod(0o400)
        self.assertEqual(copied.read_bytes()[18:20], b"\x02\x02")
        self.assertFalse(Path(str(copied) + "-wal").exists())
        self.assert_rejected_unchanged(copied)

    def test_checkpointed_wal_header_alone_is_not_standalone_proof(self):
        conn = self.wal_with_committed_row()
        self.db.chmod(0o600)
        self.assertEqual(conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0], 0)
        conn.close()
        self.db.chmod(0o400)
        self.assertFalse(Path(str(self.db) + "-wal").exists())
        self.assert_rejected_unchanged(self.db)

    def test_checkpoint_then_delete_mode_sealed_snapshot_counts_every_row(self):
        conn = self.wal_with_committed_row()
        self.db.chmod(0o600)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.assertEqual(conn.execute("PRAGMA journal_mode=DELETE").fetchone(), ("delete",))
        conn.close()
        self.db.chmod(0o400)
        before = source_state(self.root)
        real_connect = sqlite3.connect
        with patch.object(outbound_inventory.sqlite3, "connect", wraps=real_connect) as connect:
            report = inventory_outbound(self.db)
        self.assertEqual(report["user_data"]["total"], 2)
        self.assertEqual(source_state(self.root), before)
        opened_uri = connect.call_args.args[0]
        self.assertTrue(opened_uri.endswith("?mode=ro&immutable=1"))
        self.assertNotIn(str(self.db), opened_uri)

    def test_regular_sealed_snapshot_has_zero_source_writes(self):
        before = source_state(self.root)
        self.assertEqual(inventory_outbound(self.db)["database"]["turns_rows"], 1)
        self.assertEqual(source_state(self.root), before)

    def test_writable_snapshot_and_any_existing_sidecar_are_refused(self):
        self.db.chmod(0o600)
        self.assert_rejected_unchanged(self.db)
        self.db.chmod(0o400)
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(self.db) + suffix)
            sidecar.write_bytes(b"")
            self.assert_rejected_unchanged(self.db)
            sidecar.unlink()
        dangling = Path(str(self.db) + "-wal")
        dangling.symlink_to(self.root / "missing")
        with self.assertRaises(InventoryError) as ctx:
            inventory_outbound(self.db)
        self.assertEqual(ctx.exception.code, "unsafe-snapshot")
        self.assertTrue(dangling.is_symlink())

    def test_inconsistent_main_header_cannot_authorize_inventory(self):
        self.db.chmod(0o600)
        raw = bytearray(self.db.read_bytes())
        raw[92:96] = (int.from_bytes(raw[24:28], "big") + 1).to_bytes(4, "big")
        self.db.write_bytes(raw)
        self.db.chmod(0o400)
        self.assert_rejected_unchanged(self.db)

    def test_source_change_during_copy_fails_closed(self):
        original = shutil.copyfileobj

        def change_source(source, target):
            original(source, target)
            self.db.chmod(0o600)

        with patch.object(outbound_inventory.shutil, "copyfileobj", change_source):
            with self.assertRaises(InventoryError) as ctx:
                inventory_outbound(self.db)
        self.assertEqual(ctx.exception.code, "unsafe-snapshot")


class SecretScreenTests(unittest.TestCase):
    def test_plain_chinese_and_english_prose_are_clear(self):
        self.assertEqual(secret_screen("我明天下午三点和李雷在咖啡馆讨论项目进度。"), [])
        self.assertEqual(secret_screen("Let's meet tomorrow and review the schedule."), [])

    def test_token_shapes(self):
        # Synthetic positives are constructed at runtime, not stored as credential literals.
        self.assertIn("token_shape", secret_screen("key is sk-abcdef1234567890XYZ here"))
        self.assertIn("token_shape", secret_screen("AKIA" + "IOSFODNN7EXAMPLE"))
        self.assertIn("token_shape", secret_screen("ghp" + "_abcdefghij0123456789abcdefghij0123456"))
        self.assertIn("token_shape", secret_screen("eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigpart"))
        self.assertIn("token_shape", secret_screen("Authorization: Bearer abcdef1234567890"))

    def test_secret_assignments_in_both_languages(self):
        self.assertIn("secret_assignment", secret_screen("api_key: abcdef123456"))
        self.assertIn("secret_assignment", secret_screen("密码是 hunter2"))
        self.assertIn("secret_assignment", secret_screen("access_token=xyz12345"))

    def test_long_base64(self):
        self.assertIn("long_base64", secret_screen("dGVzdHN0cmluZw" + "x" * 40))
        self.assertEqual(secret_screen("dGVzdA"), [])  # too short

    def test_email_and_phone(self):
        self.assertIn("email_address", secret_screen("邮箱 zhangsan@163.com 谢谢"))
        self.assertIn("phone_number", secret_screen("手机 13812345678 打给我"))
        self.assertIn("phone_number", secret_screen("+86-13912345678"))
        self.assertEqual(secret_screen("我们三个人后天动身"), [])  # no phone shape

    def test_filesystem_paths(self):
        self.assertIn("filesystem_path", secret_screen("文件在 /Users/someone/secret.txt"))
        self.assertIn("filesystem_path", secret_screen("路径 ~/.local/state/app 下"))
        self.assertIn("filesystem_path", secret_screen("相对 ./config/settings 文件"))
        self.assertEqual(secret_screen("目录和文件要分开放置"), [])

    def test_private_key_block(self):
        self.assertIn("private_key_block",
                      secret_screen("-----BEGIN " + "PRIVATE KEY-----\nMII..."))

    def test_nested_payloads_are_scanned_and_only_categories_returned(self):
        payload = {"state": {"user_text": "mail me at a@b.co please"},
                   "questions": {"q1": "x"}, "list": ["token sk-zzzzzzzzzzzzzz"]}
        hits = secret_screen(payload)
        self.assertEqual(hits, ["email_address", "token_shape"])
        for hit in hits:
            self.assertNotIn("a@b.co", hit)
            self.assertNotIn("sk-zzzz", hit)

    def test_no_secret_body_is_returned(self):
        secret = "sk-body1234567890XYZ"
        hits = secret_screen("value " + secret)
        self.assertEqual(hits, ["token_shape"])
        self.assertNotIn(secret, json.dumps(hits))


class DryRunTests(unittest.TestCase):
    RECORD = {"text": "我喜欢手冲咖啡，明天下午三点见。", "quotes": ["我喜欢手冲咖啡"]}

    def test_full_mode_reports_the_honest_status_quo(self):
        report = build_outbound_dry_run(self.RECORD, "full_user_text")
        self.assertEqual(report["mode"], "full_user_text")
        self.assertTrue(report["would_send_full_user_text"])
        self.assertIn("user_text", report["fields"])
        self.assertTrue(report["screen_clear"])
        self.assertEqual(report["recommendation"], "screen_clear")
        self.assertFalse(report["send_authorized"])
        self.assertEqual(report["network_calls"], 0)

    def test_minimal_mode_sends_no_full_text(self):
        report = build_outbound_dry_run(self.RECORD, "minimal_quote")
        self.assertFalse(report["would_send_full_user_text"])
        self.assertNotIn("user_text", report["fields"])
        self.assertEqual(report["field_sizes"]["quote_count"], 1)
        self.assertEqual(report["recommendation"], "screen_clear")

    def test_minimal_mode_scope_reduction_drops_secret_bearing_full_text(self):
        record = {"text": "我的密码是 hunter2 请记住", "quotes": ["请记住"]}
        full = build_outbound_dry_run(record, "full_user_text")
        minimal = build_outbound_dry_run(record, "minimal_quote")
        self.assertEqual(full["recommendation"], "hold_needs_review")
        self.assertNotEqual(full["screen_hits"], [])
        # The minimal payload carries only the approved quote: clear.
        self.assertEqual(minimal["recommendation"], "screen_clear")
        self.assertEqual(minimal["screen_hits"], [])

    def test_secret_hit_holds_both_modes_and_report_holds_no_body(self):
        secret = "sk-abcdef1234567890XYZ"
        record = {"text": "token " + secret, "quotes": ["token " + secret]}
        for mode in ("full_user_text", "minimal_quote"):
            report = build_outbound_dry_run(record, mode)
            self.assertEqual(report["recommendation"], "hold_needs_review")
            self.assertEqual(report["reason"], "screen_hits")
            self.assertIn("token_shape", report["screen_hits"])
            self.assertNotIn(secret, json.dumps(report, ensure_ascii=False))

    def test_minimal_mode_without_approved_quotes_is_held(self):
        report = build_outbound_dry_run({"text": "普通句子。", "quotes": []},
                                        "minimal_quote")
        self.assertEqual(report["recommendation"], "hold_needs_review")
        self.assertEqual(report["reason"], "no_approved_quote")

    def test_invalid_mode_and_record_fail_closed(self):
        with self.assertRaises(InventoryError):
            build_outbound_dry_run(self.RECORD, "everything")
        with self.assertRaises(InventoryError):
            build_outbound_dry_run(["not", "a", "dict"], "full_user_text")

    def test_report_contains_content_never(self):
        report = build_outbound_dry_run(self.RECORD, "full_user_text")
        self.assertNotIn("手冲咖啡", json.dumps(report, ensure_ascii=False))


class ZeroNetworkTests(unittest.TestCase):
    """The inventory, screen and dry run are local-only by construction; any
    socket use during their execution fails the test."""

    def _no_network(self):
        return patch.object(socket, "socket", side_effect=AssertionError("network use"))

    def test_inventory_uses_no_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "ingest.sqlite"
            make_db(db, SYNTHETIC_ROWS[:3])
            with self._no_network():
                report = inventory_outbound(db)
            self.assertEqual(report["user_data"]["total"], 3)

    def test_screen_and_dry_run_use_no_network(self):
        with self._no_network():
            hits = secret_screen("mail a@b.co")
            report = build_outbound_dry_run({"text": "普通。", "quotes": ["普通"]},
                                            "full_user_text")
        self.assertEqual(hits, ["email_address"])
        self.assertEqual(report["network_calls"], 0)


if __name__ == "__main__":
    unittest.main()
