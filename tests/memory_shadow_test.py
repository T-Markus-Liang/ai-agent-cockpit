"""Tests for the read-only memory shadow projection layer.

Every fixture is a private, synthetic temp SQLite database created by the tests.
No host data, credentials, real models, SDK memory stores or services are
touched: both databases are opened read-only and the module never touches the
production state directory ``~/.local/state/personal-ai-os/mem0``.  The
joint-verification tests drive the REAL converter (``services.memory.migration``)
over a synthetic 0.2.2-shaped source, exactly as a deployment batch would, but
only ever on synthetic temp directories.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import migration, shadow  # noqa: E402
from services.memory.shadow import (  # noqa: E402
    PROJECTION_NAMES, SHADOW_PROJECTION_VERSION, ShadowProjectionError,
    run_shadow_projection)

FIXED_MS = 1_700_000_000_000
FIXED_ISO = "2023-11-14T22:13:20.000Z"
fixed_clock = lambda: FIXED_MS  # noqa: E731

# --- synthetic-DB scaffolding (0.2.2 baseline shape) ------------------------
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


def make_db(directory, *, name="ingest.sqlite", quality_schema=True):
    path = os.path.join(directory, name)
    conn = sqlite3.connect(path)
    conn.execute(ORIGINAL_DDL)
    if quality_schema:
        for addition in QUALITY_ADDITIONS:
            conn.execute("ALTER TABLE turns ADD COLUMN " + addition)
    conn.commit()
    conn.close()
    os.chmod(path, 0o600)
    return path


def make_row(event_id, user_id="u1", role="user", text="t", *, status="done",
             created_at=1.0, validation_status=None, extraction_version=None,
             forgotten=0, digest=None):
    obj = payload(event_id, user_id, role, text)
    return {
        "event_id": event_id, "payload": obj,
        "digest": digest if digest is not None else digest_of(obj),
        "status": status, "created_at": created_at,
        "validation_status": validation_status,
        "extraction_version": extraction_version, "forgotten": forgotten,
    }


def insert_row(conn, row, *, quality_schema=True):
    raw = (json.dumps(row["payload"], sort_keys=True, ensure_ascii=False)
           if isinstance(row["payload"], dict) else row["payload"])
    if quality_schema:
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at,"
            "validation_status,extraction_version,forgotten) VALUES(?,?,?,?,?,?,?,?)",
            (row["event_id"], raw, row["digest"], row["status"], row["created_at"],
             row["validation_status"], row["extraction_version"], row["forgotten"]))
    else:
        conn.execute(
            "INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)",
            (row["event_id"], raw, row["digest"], row["status"], row["created_at"]))


def build_db(directory, rows, *, name="ingest.sqlite", quality_schema=True):
    path = make_db(directory, name=name, quality_schema=quality_schema)
    conn = sqlite3.connect(path)
    try:
        for row in rows:
            insert_row(conn, row, quality_schema=quality_schema)
        conn.commit()
    finally:
        conn.close()
    return path


def insert_raw(conn, event_id, raw_payload, *, status="done", created_at=1.0, digest=None):
    conn.execute(
        "INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)",
        (event_id, raw_payload,
         digest or hashlib.sha256(raw_payload.encode("utf-8")).hexdigest(),
         status, created_at))


def mismatches(report):
    return [entry["name"] for entry in report["projections"] if not entry["match"]]


def projection_named(report, name):
    return next(entry for entry in report["projections"] if entry["name"] == name)


def base_rows():
    return [
        make_row("e1", "u1", "user", "alpha", status="done", created_at=10.0,
                 validation_status="validated", extraction_version="extraction-v2"),
        make_row("e2", "u1", "assistant", "beta", status="done", created_at=20.0),
        make_row("e3", "u2", "user", "gamma", status="needs_review", created_at=30.0,
                 forgotten=1),
    ]


# --- fixture ----------------------------------------------------------------
class ShadowFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="memory-shadow-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.legacy_dir = os.path.join(self.tmp, "legacy")
        self.converted_dir = os.path.join(self.tmp, "converted")
        os.makedirs(self.legacy_dir, mode=0o700)
        os.makedirs(self.converted_dir, mode=0o700)

    def write_pair(self, legacy_rows, converted_rows, *, tag=""):
        legacy_db = build_db(self.legacy_dir, legacy_rows, name="legacy%s.sqlite" % tag)
        converted_db = build_db(
            self.converted_dir, converted_rows, name="converted%s.sqlite" % tag)
        return legacy_db, converted_db


# --- happy paths / determinism ----------------------------------------------
class HappyPathTests(ShadowFixture):
    def test_identical_databases_all_match(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        report = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        self.assertEqual(report["version"], SHADOW_PROJECTION_VERSION)
        self.assertEqual(report["kind"], "memory")
        self.assertTrue(report["allMatch"])
        self.assertEqual(mismatches(report), [])
        self.assertEqual(
            [entry["name"] for entry in report["projections"]], list(PROJECTION_NAMES))
        for entry in report["projections"]:
            self.assertEqual(entry["status"], "ok")
            self.assertTrue(entry["match"])
            self.assertRegex(entry["legacyDigest"], r"^sha256:[0-9a-f]{64}$")
            self.assertEqual(entry["legacyDigest"], entry["convertedDigest"])
            self.assertNotIn("detail", entry)
        self.assertRegex(report["reportDigest"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(report["generatedAt"], FIXED_ISO)
        self.assertEqual(
            set(report), {"version", "kind", "projections", "allMatch",
                          "reportDigest", "generatedAt"})

    def test_same_input_same_reportDigest(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        first = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        second = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        self.assertEqual(first, second)
        self.assertEqual(first["reportDigest"], second["reportDigest"])

    def test_reportDigest_excludes_generated_at(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        first = run_shadow_projection(legacy_db, converted_db, now=lambda: FIXED_MS)
        later = run_shadow_projection(legacy_db, converted_db, now=lambda: FIXED_MS + 5000)
        self.assertNotEqual(first["generatedAt"], later["generatedAt"])
        self.assertEqual(first["reportDigest"], later["reportDigest"])

    def test_now_accepts_a_plain_number(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        report = run_shadow_projection(legacy_db, converted_db, now=FIXED_MS)
        self.assertEqual(report["generatedAt"], FIXED_ISO)

    def test_projection_values_are_order_independent(self):
        # Row order must not change any projection (the report is a canonical,
        # order-independent summary).
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, list(reversed(copy.deepcopy(rows))))
        report = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        self.assertTrue(report["allMatch"])

    def test_created_at_bounds_shape(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        report = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        entry = projection_named(report, "createdAtBounds")
        self.assertTrue(entry["match"])
        # value = {count:3, min:10.0, max:30.0} on both sides; digest equal.
        self.assertEqual(entry["legacyDigest"], entry["convertedDigest"])

    def test_created_at_bounds_empty(self):
        legacy_db = build_db(self.legacy_dir, [], name="legacy.sqlite")
        converted_db = build_db(self.converted_dir, [], name="converted.sqlite")
        report = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        self.assertTrue(report["allMatch"])


# --- per-projection isolation -----------------------------------------------
def _mut_status(rows):
    rows[0]["status"] = "pending"


def _mut_validation(rows):
    rows[0]["validation_status"] = "needs_review"


def _mut_forgotten(rows):
    rows[1]["forgotten"] = 1


def _mut_extraction(rows):
    rows[1]["extraction_version"] = "extraction-v1"


def _mut_user(rows):
    # Change the parsed user_id while holding the digest column fixed, so only
    # the payload-derived projection reacts.
    row = rows[0]
    obj = dict(row["payload"])
    obj["user_id"] = "u9"
    row["payload"] = obj  # digest column deliberately kept as-is


def _mut_created(rows):
    rows[0]["created_at"] = 99.0


def _mut_digest(rows):
    rows[0]["digest"] = "f" * 64  # payload deliberately kept as-is


ISOLATION_CASES = (
    ("statusHistogram", _mut_status),
    ("validationStatusHistogram", _mut_validation),
    ("forgottenCount", _mut_forgotten),
    ("extractionVersionHistogram", _mut_extraction),
    ("eventsPerUser", _mut_user),
    ("createdAtBounds", _mut_created),
    ("digestSet", _mut_digest),
)


class IsolationTests(ShadowFixture):
    def test_each_projection_flags_exactly_its_own_divergence(self):
        for index, (name, mutate) in enumerate(ISOLATION_CASES):
            with self.subTest(projection=name):
                legacy_rows = base_rows()
                converted_rows = copy.deepcopy(legacy_rows)
                mutate(converted_rows)
                legacy_db, converted_db = self.write_pair(
                    legacy_rows, converted_rows, tag=str(index))
                report = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
                self.assertFalse(report["allMatch"])
                self.assertEqual(mismatches(report), [name])
                entry = projection_named(report, name)
                self.assertEqual(entry["status"], "ok")
                self.assertFalse(entry["match"])
                self.assertNotEqual(entry["legacyDigest"], entry["convertedDigest"])
                self.assertNotEqual(entry["detail"]["legacy"], entry["detail"]["converted"])

    def test_a_mismatch_is_never_reported_as_a_match_and_detail_is_truthful(self):
        legacy_rows = base_rows()
        converted_rows = copy.deepcopy(legacy_rows)
        _mut_status(converted_rows)
        legacy_db, converted_db = self.write_pair(legacy_rows, converted_rows)
        report = run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        entry = projection_named(report, "statusHistogram")
        self.assertFalse(entry["match"])
        # The truthful canonical summaries show the two distinct status values.
        self.assertIn("done", entry["detail"]["legacy"])
        self.assertIn("pending", entry["detail"]["converted"])


# --- payload parsing --------------------------------------------------------
class EventsPerUserTests(ShadowFixture):
    def test_bad_payloads_are_counted_in_the_unparseable_bucket(self):
        path = make_db(self.legacy_dir, name="legacy.sqlite")
        conn = sqlite3.connect(path)
        try:
            insert_row(conn, make_row("e1", "u1", "user", "one"))
            insert_raw(conn, "e2", "this is not json at all")
            insert_raw(conn, "e3", "[1, 2, 3]")  # valid JSON, not an object
            insert_raw(conn, "e4", json.dumps({"role": "user"}))  # object, no user_id
            conn.commit()
        finally:
            conn.close()
        histogram = shadow._project_events_per_user(shadow._load_rows(path))
        # Two unparseable payloads (non-JSON and a non-object) share one bucket; a
        # valid object without a user_id lands in the ``(absent)`` bucket.
        self.assertEqual(histogram, {"u1": 1, "unparseable": 2, "(absent)": 1})
        self.assertEqual(shadow._project_events_per_user([]), {})

    def test_identical_dbs_with_bad_payloads_still_match(self):
        rows = []
        for directory, name in ((self.legacy_dir, "legacy.sqlite"),
                                (self.converted_dir, "converted.sqlite")):
            path = make_db(directory, name=name)
            conn = sqlite3.connect(path)
            try:
                insert_row(conn, make_row("e1", "u1", "user", "one"))
                insert_raw(conn, "e2", "not json")
                insert_raw(conn, "e3", "[1,2]")
                insert_raw(conn, "e4", json.dumps({"role": "user"}))
                conn.commit()
            finally:
                conn.close()
        report = run_shadow_projection(
            os.path.join(self.legacy_dir, "legacy.sqlite"),
            os.path.join(self.converted_dir, "converted.sqlite"), now=fixed_clock)
        self.assertTrue(report["allMatch"])


# --- injection seam / isolation of a raising projection ---------------------
def row_count(rows):
    return len(rows)


def boom(rows):
    raise RuntimeError("kaboom")


class InjectionTests(ShadowFixture):
    def test_injected_projections_replace_the_builtins(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        report = run_shadow_projection(
            legacy_db, converted_db, now=fixed_clock, projections=[row_count])
        self.assertEqual([entry["name"] for entry in report["projections"]], ["row_count"])
        self.assertTrue(report["allMatch"])

    def test_a_throwing_projection_is_isolated_and_never_a_match(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        report = run_shadow_projection(
            legacy_db, converted_db, now=fixed_clock, projections=[row_count, boom])
        self.assertFalse(report["allMatch"])
        failed = projection_named(report, "boom")
        self.assertEqual(failed["status"], "failed")
        self.assertFalse(failed["match"])
        self.assertIsNone(failed["legacyDigest"])
        self.assertIsNone(failed["convertedDigest"])
        self.assertEqual(failed["detail"], {"side": "legacy", "error": "kaboom"})
        # The sibling projection still ran and matched.
        self.assertTrue(projection_named(report, "row_count")["match"])


# --- invalid configuration (fail-closed) ------------------------------------
class InvalidConfigTests(ShadowFixture):
    def _pair(self):
        rows = base_rows()
        return self.write_pair(rows, copy.deepcopy(rows))

    def test_empty_projections_is_refused(self):
        legacy_db, converted_db = self._pair()
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(legacy_db, converted_db, projections=[])
        self.assertEqual(ctx.exception.code, "invalid-config")

    def test_non_callable_projection_is_refused(self):
        legacy_db, converted_db = self._pair()
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(legacy_db, converted_db, projections=[42])
        self.assertEqual(ctx.exception.code, "invalid-config")

    def test_bad_now_is_refused(self):
        legacy_db, converted_db = self._pair()
        for bad in (lambda: "not a number", True):
            with self.subTest(now=bad):
                with self.assertRaises(ShadowProjectionError) as ctx:
                    run_shadow_projection(legacy_db, converted_db, now=bad)
                self.assertEqual(ctx.exception.code, "invalid-config")


# --- fail-closed database handling ------------------------------------------
class FailClosedTests(ShadowFixture):
    def _valid_legacy(self):
        return build_db(self.legacy_dir, base_rows(), name="legacy.sqlite")

    def test_missing_file_is_refused(self):
        legacy_db = self._valid_legacy()
        missing = os.path.join(self.tmp, "does-not-exist.sqlite")
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(missing, legacy_db)
        self.assertEqual(ctx.exception.code, "missing-db")
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(legacy_db, missing)
        self.assertEqual(ctx.exception.code, "missing-db")

    def test_not_a_database_is_refused(self):
        legacy_db = self._valid_legacy()
        junk = os.path.join(self.converted_dir, "junk.sqlite")
        with open(junk, "wb") as handle:
            handle.write(b"this is definitely not a sqlite database file")
        os.chmod(junk, 0o600)
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(junk, legacy_db)
        self.assertEqual(ctx.exception.code, "not-a-database")

    def test_missing_turns_table_is_refused(self):
        legacy_db = self._valid_legacy()
        path = os.path.join(self.converted_dir, "no-turns.sqlite")
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)")
        conn.commit()
        conn.close()
        os.chmod(path, 0o600)
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(legacy_db, path)
        self.assertEqual(ctx.exception.code, "missing-turns")

    def test_missing_baseline_columns_is_refused(self):
        legacy_db = self._valid_legacy()
        path = os.path.join(self.converted_dir, "thin.sqlite")
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE turns(event_id TEXT PRIMARY KEY, payload TEXT)")
        conn.commit()
        conn.close()
        os.chmod(path, 0o600)
        with self.assertRaises(ShadowProjectionError) as ctx:
            run_shadow_projection(path, legacy_db)
        self.assertEqual(ctx.exception.code, "missing-columns")


# --- read-only guarantee ----------------------------------------------------
class ReadOnlyTests(ShadowFixture):
    def test_neither_database_is_mutated(self):
        rows = base_rows()
        legacy_db, converted_db = self.write_pair(rows, copy.deepcopy(rows))
        before_legacy = Path(legacy_db).read_bytes()
        before_converted = Path(converted_db).read_bytes()
        run_shadow_projection(legacy_db, converted_db, now=fixed_clock)
        self.assertEqual(before_legacy, Path(legacy_db).read_bytes())
        self.assertEqual(before_converted, Path(converted_db).read_bytes())
        # No WAL/journal sidecar is ever created next to either database.
        for path in (legacy_db, converted_db):
            for suffix in ("-journal", "-wal", "-shm"):
                self.assertFalse(os.path.exists(path + suffix))


# --- joint verification against the REAL converter --------------------------
class ConverterIntegrationTests(ShadowFixture):
    def _source(self, entries):
        """A synthetic 0.2.2-shaped source directory with baseline rows."""
        source_dir = os.path.join(self.tmp, "source")
        os.makedirs(source_dir, mode=0o700)
        path = make_db(source_dir, quality_schema=False)
        conn = sqlite3.connect(path)
        try:
            for event_id, user_id, role, text, status in entries:
                obj = payload(event_id, user_id, role, text)
                raw = json.dumps(obj, sort_keys=True, ensure_ascii=False)
                conn.execute(
                    "INSERT INTO turns(event_id,payload,digest,status,created_at) "
                    "VALUES(?,?,?,?,?)",
                    (event_id, raw, digest_of(obj), status, 1.0))
            conn.commit()
        finally:
            conn.close()
        return source_dir

    def test_real_conversion_of_a_no_op_fixture_projects_all_match(self):
        # Rows the converter's per-row classification leaves untouched: user rows
        # that are not yet trusted (non-done) and a row with an unknown role.  Its
        # status/validation/forgotten/extraction observables are invariant, so the
        # source and its converted copy project to an all-match report.
        source_dir = self._source([
            ("e1", "u1", "user", "one", "needs_review"),
            ("e2", "u1", "user", "two", "pending"),
            ("e3", "tool", "system", "three", "done"),  # unknown role -> skipped
            ("e4", "u2", "user", "four", "needs_review"),
        ])
        copy_dir = os.path.join(self.tmp, "copy")
        report = migration.convert(source_dir, copy_dir)
        self.assertTrue(report["conservation"]["digests_match"])

        shadow_report = run_shadow_projection(
            os.path.join(source_dir, "ingest.sqlite"),
            os.path.join(copy_dir, "ingest.sqlite"), now=fixed_clock)
        self.assertTrue(shadow_report["allMatch"])
        self.assertEqual(mismatches(shadow_report), [])

    def test_real_conversion_surfaces_the_intended_status_transformation(self):
        # A legacy done user turn is re-queued to `pending` by the conversion, so
        # the status histogram *must* diverge -- and no other projection does, since
        # the immutable facts (payload, digest, created_at, user_id) are conserved.
        source_dir = self._source([
            ("e1", "u1", "user", "alpha", "done"),
            ("e2", "u1", "user", "beta", "done"),
        ])
        copy_dir = os.path.join(self.tmp, "copy")
        report = migration.convert(source_dir, copy_dir)
        self.assertTrue(report["conservation"]["digests_match"])

        shadow_report = run_shadow_projection(
            os.path.join(source_dir, "ingest.sqlite"),
            os.path.join(copy_dir, "ingest.sqlite"), now=fixed_clock)
        self.assertFalse(shadow_report["allMatch"])
        self.assertEqual(mismatches(shadow_report), ["statusHistogram"])
        # The invariant projections still match: payload/digest/created_at survive.
        for name in ("digestSet", "eventsPerUser", "createdAtBounds",
                     "validationStatusHistogram", "extractionVersionHistogram",
                     "forgottenCount"):
            self.assertTrue(projection_named(shadow_report, name)["match"], name)


if __name__ == "__main__":
    unittest.main()
