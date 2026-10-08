"""Read-only memory upgrade preflight.

This module audits a legacy ``ingest.sqlite`` database *without* importing or
instantiating ``MemoryService`` (whose constructor would migrate the schema).
It opens the database with SQLite URI ``mode=ro`` plus ``PRAGMA query_only``
inside a snapshot read transaction, so committed WAL content is visible but the
source is never mutated.  The returned aggregate is redacted: no raw event ids,
user ids, payloads, digests, paths, credentials or model URLs are emitted.

The result is an advisory prerequisite audit, not a migration, revalidation or
release approval.  It intentionally never reports ``readyForServiceRestart`` as
true: the outstanding ``remainingValidation`` steps are not performed here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import stat
import sqlite3
import sys
from pathlib import Path

SCHEMA_VERSION = 1
CONVERTER_VERSION = "legacy-memory-preflight-v1"
CURRENT_EXTRACTION_VERSION = "extraction-v2"
MAX_RECEIPTS = 100_000
MAX_PAYLOAD_CHARS = 1_000_000

REMAINING_VALIDATION = [
    "legacy-source-revalidation",
    "vector-recall-verification",
    "authorized-cutover",
]

# Statuses persisted by the current service schema.
KNOWN_STATUSES = frozenset({"pending", "done", "needs_review", "forgotten"})

# Columns that carry provenance once the quality schema is applied.
QUALITY_COLUMNS = ("plan", "validation_status", "extraction_version", "quality", "stored_ids", "forgotten")
KNOWN_VALIDATION_STATUSES = frozenset({"validated", "legacy_unverified", "no_facts", "assistant_archived", "needs_review", "rejected", "forgotten"})

# Payload is ``json.dumps(turn.model_dump(), sort_keys=True, ensure_ascii=False)``
# where ``Turn`` has exactly these fields.
SERVICE_PAYLOAD_KEYS = frozenset({"event_id", "user_id", "role", "text", "source"})

_REQUIRED_COLUMNS = ("event_id", "payload", "digest", "status", "created_at")


class PreflightError(Exception):
    """Generic, redacted preflight failure.  Never carries raw paths/payloads."""


def _fail(reason: str) -> PreflightError:
    return PreflightError(reason)


def _fspath(database_path) -> str:
    try:
        raw = os.fspath(database_path)
    except TypeError:
        raise _fail("database path is not a valid path") from None
    if isinstance(raw, bytes):
        try:
            raw = os.fsdecode(raw)
        except (UnicodeDecodeError, ValueError):
            raise _fail("database path is not a valid path") from None
    if not isinstance(raw, str) or not raw:
        raise _fail("database path is not a valid path")
    return raw


def _validate_path(database_path) -> str:
    """Require an absolute, regular, non-symlink, private, current-owner file
    whose exact parent directory is a safe owned directory."""
    path = _fspath(database_path)
    if not os.path.isabs(path):
        raise _fail("database path must be absolute")
    if os.path.normpath(path) != path:
        raise _fail("database path must be a normalized absolute path")

    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise _fail("database not found") from None
    except (OSError, ValueError):
        raise _fail("database not available") from None

    if stat.S_ISLNK(st.st_mode):
        raise _fail("database must not be a symbolic link")
    if not stat.S_ISREG(st.st_mode):
        raise _fail("database must be a regular file")
    uid = os.getuid()
    if st.st_uid != uid:
        raise _fail("database must be owned by the current user")
    if st.st_mode & 0o077:
        raise _fail("database must be private to the current user")
    if st.st_size <= 0:
        raise _fail("database is empty")

    parent = os.path.dirname(path)
    if not parent or parent == path:
        raise _fail("database requires a dedicated parent directory")
    try:
        pst = os.lstat(parent)
    except (FileNotFoundError, OSError):
        raise _fail("database parent directory is not available") from None
    if stat.S_ISLNK(pst.st_mode) or not stat.S_ISDIR(pst.st_mode):
        raise _fail("database parent must be a real directory")
    if pst.st_uid != uid:
        raise _fail("database parent must be owned by the current user")
    if pst.st_mode & 0o077:
        raise _fail("database parent must be private to the current user")
    return path


def _open_readonly(path: str) -> sqlite3.Connection:
    try:
        uri = Path(path).as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
    except (sqlite3.Error, ValueError, UnicodeError):
        raise _fail("database not available") from None
    conn.isolation_level = None
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("PRAGMA trusted_schema=OFF")
        conn.execute("BEGIN")
    except sqlite3.DatabaseError:
        conn.close()
        raise _fail("database not readable") from None
    return conn


def _table_columns(conn: sqlite3.Connection, table: str):
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.DatabaseError:
        raise _fail("database schema is unreadable") from None
    return [row[1] for row in rows]


def _canonical_digest(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def inspect_upgrade(database_path) -> dict:
    """Inspect a legacy memory database and return a redacted aggregate.

    Raises :class:`PreflightError` with a generic message (never a raw path or
    payload) for missing/corrupt/unsafe databases, unknown schemas, unknown
    statuses or malformed rows.
    """
    path = _validate_path(database_path)
    conn = _open_readonly(path)
    try:
        return _inspect(conn)
    except PreflightError:
        raise
    except (sqlite3.Error, OSError, ValueError, TypeError, UnicodeError):
        raise _fail("database inspection failed") from None
    finally:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        conn.close()


def _inspect(conn: sqlite3.Connection) -> dict:
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    except sqlite3.DatabaseError:
        raise _fail("database is corrupt or unreadable") from None

    if "turns" not in tables:
        raise _fail("database schema is missing the turns table")

    columns = _table_columns(conn, "turns")
    missing = [c for c in _REQUIRED_COLUMNS if c not in columns]
    if missing:
        raise _fail("database schema is missing required columns")

    quality_schema_present = all(c in columns for c in QUALITY_COLUMNS)

    has_forgotten = "forgotten" in columns
    select = [
        "event_id",
        "payload",
        "digest",
        "status",
        "validation_status" if "validation_status" in columns else "NULL",
        "extraction_version" if "extraction_version" in columns else "NULL",
        "forgotten" if has_forgotten else "0",
        "created_at",
    ]
    try:
        cursor = conn.execute("SELECT " + ", ".join(select) + " FROM turns")
    except sqlite3.DatabaseError:
        raise _fail("database is corrupt or unreadable") from None

    total = 0
    by_status: dict[str, int] = {}
    by_validation: dict[str, int] = {}
    done = 0
    needs_review = 0
    forgotten = 0
    user_role = 0
    assistant_role = 0
    unknown_role = 0
    legacy_impact = 0
    digest_checked = 0
    digest_mismatch = 0
    unverifiable_payload = 0

    for event_id, payload, digest, status, validation_status, extraction_version, forgotten_flag, created_at in cursor:
        total += 1
        if total > MAX_RECEIPTS or isinstance(payload, str) and len(payload) > MAX_PAYLOAD_CHARS:
            raise _fail("database inspection bound exceeded")
        if not isinstance(event_id, str) or not event_id or not isinstance(payload, str) or not isinstance(digest, str) or created_at is None:
            raise _fail("database contains malformed rows")
        if not isinstance(created_at, (int, float)) or not math.isfinite(created_at) or forgotten_flag not in (0, 1):
            raise _fail("database contains malformed rows")
        if not isinstance(status, str) or status not in KNOWN_STATUSES:
            raise _fail("database contains an unknown row status")

        by_status[status] = by_status.get(status, 0) + 1
        if status == "done":
            done += 1
        if status == "needs_review":
            needs_review += 1
        if forgotten_flag:
            forgotten += 1

        if validation_status is not None and validation_status not in KNOWN_VALIDATION_STATUSES:
            raise _fail("database contains an unknown validation status")
        vs_key = validation_status if validation_status is not None else "unset"
        by_validation[vs_key] = by_validation.get(vs_key, 0) + 1

        try:
            parsed = json.loads(payload)
        except (json.JSONDecodeError, TypeError, ValueError):
            raise _fail("database contains a malformed row payload") from None
        if not isinstance(parsed, dict):
            raise _fail("database contains a malformed row payload")

        role = parsed.get("role")
        if role == "user":
            user_role += 1
        elif role == "assistant":
            assistant_role += 1
        else:
            unknown_role += 1

        valid_payload = set(parsed.keys()) == SERVICE_PAYLOAD_KEYS and all(isinstance(parsed.get(key), str) for key in SERVICE_PAYLOAD_KEYS)
        valid_payload = valid_payload and parsed["event_id"] == event_id and bool(parsed["user_id"]) and bool(parsed["text"]) and parsed["role"] in {"user", "assistant"}
        if valid_payload:
            digest_checked += 1
            if _canonical_digest(parsed) != digest:
                digest_mismatch += 1
        else:
            unverifiable_payload += 1

        if status == "done" and forgotten_flag == 0:
            if vs_key == "unset" or vs_key == "legacy_unverified":
                legacy_impact += 1
            elif vs_key == "validated" and extraction_version != CURRENT_EXTRACTION_VERSION:
                legacy_impact += 1

    payload_integrity_verified = (
        total > 0 and digest_mismatch == 0 and unverifiable_payload == 0)

    overlap = user_role + assistant_role + unknown_role
    if overlap != total:
        raise _fail("database contains malformed rows")

    # Conservative: a read-only preflight performs none of REMAINING_VALIDATION,
    # so it never authorizes a service restart, even with zero legacy impact.
    ready_for_service_restart = False

    return {
        "schemaVersion": SCHEMA_VERSION,
        "converterVersion": CONVERTER_VERSION,
        "inspectionOnly": True,
        "networkCalls": 0,
        "rows": {
            "total": total,
            "done": done,
            "needsReview": needs_review,
            "forgotten": forgotten,
            "byStatus": by_status,
            "byValidationStatus": by_validation,
            "userRole": user_role,
            "assistantRole": assistant_role,
            "unknownRole": unknown_role,
        },
        "qualitySchemaPresent": quality_schema_present,
        "legacyRecallImpactReceipts": legacy_impact,
        "payloadIntegrityVerified": payload_integrity_verified,
        "readyForServiceRestart": ready_for_service_restart,
        "remainingValidation": list(REMAINING_VALIDATION),
    }


class RedactedParser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(2, "preflight blocked: invalid arguments\n")


def _build_parser() -> argparse.ArgumentParser:
    parser = RedactedParser(
        prog="python3 -m services.memory.migration_preflight",
        description="Read-only legacy memory upgrade preflight (inspection only).",
    )
    parser.add_argument("--database", required=True,
                        help="absolute path to a private ingest.sqlite database")
    return parser


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        report = inspect_upgrade(args.database)
    except PreflightError as exc:
        sys.stderr.write("preflight blocked: %s\n" % exc)
        return 2
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
