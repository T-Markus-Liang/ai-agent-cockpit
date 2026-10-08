"""Versioned private-copy migration converter for legacy memory databases.

The 0.2.2-era ``ingest.sqlite`` predates the quality schema: its ``turns`` table
has only the baseline columns and every ``status='done'`` row is a
``legacy_unverified`` receipt that the current service can never recall.  The
in-place ``MemoryService._migrate`` path marks those rows ``legacy_unverified``
and moves on.  This module is the *converter*: it works on a **private copy** of
the database, gives legacy user turns a chance to be re-validated into a
``validated`` trusted receipt, archives assistant turns, honours existing
tombstones, and re-verifies each user turn through an *injected* engine.

Hard boundaries (see the project contract):

* The production state directory ``~/.local/state/personal-ai-os/mem0`` is never
  read or written here.  Callers point ``--source``/``--copy`` at private
  synthetic directories; the source is only ever opened read-only (SQLite URI
  ``mode=ro`` + ``PRAGMA query_only``) and captured through the online backup
  API (which is WAL-consistent, unlike a raw file copy).
* ``MemoryService`` is never instantiated to read production state.  The library
  API never constructs a real evaluator: ``reverify`` receives an
  already-constructed engine (``Mem0Engine`` with an injected memory/evaluator,
  or a test double), so the real ``JevEvaluator`` is never invoked from the
  library functions here.  The CLI only builds a real local engine -- always
  pointed at the private copy, never production -- when the operator explicitly
  passes ``--allow-real-engine``; ``--reverify`` without that flag fails closed.
* The manifest and journal contain only sha256 digests, counts and timestamps --
  never raw text, ``event_id`` or ``user_id``.

Public API: :func:`snapshot`, :func:`convert`, :func:`reverify`,
:func:`verify_conservation` and :class:`MigrationError`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time

from . import migration_preflight, quality
from .migration_preflight import PreflightError

SCHEMA_VERSION = 1
CONVERTER_VERSION = "memory-migration-v1"
DB_NAME = "ingest.sqlite"
MANIFEST_NAME = "migration-manifest.json"
JOURNAL_NAME = "migration-journal.jsonl"

OUTCOME_ARCHIVED = "archived"
OUTCOME_PENDING = "pending_reverify"
OUTCOME_FORGOTTEN = "forgotten"
OUTCOME_SKIPPED = "skipped"
_OUTCOMES = (OUTCOME_ARCHIVED, OUTCOME_PENDING, OUTCOME_FORGOTTEN, OUTCOME_SKIPPED)

# Quality columns the current service adds to ``turns`` (mirrors
# ``MemoryService._migrate``).  The converter adds the columns only; it never
# applies that method's ``legacy_unverified`` stamp -- re-validation is the point.
_QUALITY_ADDITIONS = (
    ("plan", "TEXT"),
    ("validation_status", "TEXT"),
    ("extraction_version", "TEXT"),
    ("quality", "TEXT"),
    ("stored_ids", "TEXT"),
    ("forgotten", "INTEGER NOT NULL DEFAULT 0"),
)

# The baseline columns a legacy memory database always has.  A non-empty
# ``ingest.sqlite`` that lacks them (and is not marked by our manifest) is an
# unknown database we must never overwrite.
_BASELINE_COLUMNS = ("event_id", "payload", "digest", "status", "created_at")

# ``error_kind`` values that a later ``reverify`` pass may retry.  Only a
# transient vector-store failure is retried; semantic/credential/plan decisions
# are terminal.
_RETRYABLE_ERROR_KINDS = ("store_error",)

# The only status transitions a *trusted* conversion may apply to an immutable
# source row.  ``done`` legacy receipts may be re-queued (``pending``), archived
# (``done``) or tombstoned (``forgotten``); every other status is preserved
# verbatim.  Any transition outside this whitelist is conservation drift.
_ALLOWED_MIGRATED_STATUS = {
    "done": frozenset({"done", "pending", "forgotten"}),
    "pending": frozenset({"pending"}),
    "needs_review": frozenset({"needs_review"}),
    "forgotten": frozenset({"forgotten"}),
}


def _digest_set_hash(digests) -> str:
    """sha256 over the sorted stored digests (duplicates preserved)."""
    return hashlib.sha256(
        "\n".join(sorted(digests)).encode("utf-8")).hexdigest()


class MigrationError(Exception):
    """A redacted migration failure.  Never carries raw paths or payloads."""


def _fail(reason: str) -> MigrationError:
    return MigrationError(reason)


# ---------------------------------------------------------------------------
# path / connection helpers
# ---------------------------------------------------------------------------
def _db_path(directory) -> str:
    try:
        return os.path.join(os.fspath(directory), DB_NAME)
    except TypeError:
        raise _fail("directory is not a valid path") from None


def _validated_source(source_dir) -> str:
    """Path-safety checks re-exported as :class:`MigrationError` (redacted)."""
    try:
        return migration_preflight._validate_path(_db_path(source_dir))
    except PreflightError:
        raise _fail("source_path_invalid") from None


def _connect(path: str) -> sqlite3.Connection:
    return sqlite3.connect(path, timeout=5)


def _is_usable_copy(path: str) -> bool:
    if not os.path.isfile(path) or os.path.getsize(path) <= 0:
        return False
    try:
        conn = _connect(path)
        try:
            conn.execute("SELECT count(*) FROM turns").fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return False
    return True


def _check_target_alias(source_path: str, source_dir, copy_dir, copy_path: str) -> None:
    """Refuse a target that is the source itself (same dir, symlink or hardlink).

    Never let the copy destination alias the source: the online backup would
    then read and write the same file.
    """
    if os.path.realpath(os.fspath(copy_dir)) == os.path.realpath(os.fspath(source_dir)):
        raise _fail("target_alias")
    if os.path.exists(copy_path):
        try:
            if os.path.samefile(copy_path, source_path):
                raise _fail("target_alias")
        except OSError:
            pass
    if os.path.realpath(copy_path) == os.path.realpath(source_path):
        raise _fail("target_alias")


def _symlink_components(path):
    """Symlink components of an absolute path, excluding root-level system
    aliases (macOS ``/var`` -> ``/private/var``), which only the superuser and
    the OS installer create.  Any symlink below the filesystem root is a
    redirect an attacker (or a mistaken operator) can point at a victim.
    """
    found = []
    current = os.path.abspath(os.fspath(path))
    while True:
        parent = os.path.dirname(current)
        if parent == current:
            break
        try:
            if os.path.islink(current) and parent != os.sep:
                found.append(current)
        except OSError:
            pass
        current = parent
    return found


def _validate_target_path(copy_dir, copy_path: str) -> None:
    """Refuse an unsafe target *before* any write/chmod.

    A symlink anywhere in ``copy_dir``/DB path (or the DB itself), a DB that is
    not a regular file, or a DB with more than one hard link (an unknown
    hardlink the caller deliberately pointed us at) is rejected.  The
    source-aliasing hardlink is caught earlier by :func:`_check_target_alias`.
    """
    if _symlink_components(copy_path):
        raise _fail("target_symlink")
    if os.path.lexists(copy_path):
        st = os.lstat(copy_path)
        if stat.S_ISLNK(st.st_mode):
            raise _fail("target_symlink")
        if not stat.S_ISREG(st.st_mode):
            raise _fail("target_not_regular")
        if st.st_nlink > 1:
            raise _fail("target_hardlink")


def _source_provenance(source_path: str):
    """``(digest_set_hash, {event_id: (digest, payload, created_at)})`` read-only.

    Used to (a) fingerprint the source for the manifest and (b) verify that an
    existing manifest-less target is a *byte-faithful snapshot* of this source
    (same rows, same created_at) rather than a same-schema impostor.
    """
    conn = migration_preflight._open_readonly(source_path)
    try:
        digests = []
        rows = {}
        for event_id, digest, payload, created_at in conn.execute(
                "SELECT event_id,digest,payload,created_at FROM turns"):
            digests.append(digest)
            rows[event_id] = (digest, payload, created_at)
        return _digest_set_hash(digests), rows
    finally:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        conn.close()


def _read_target_rows_readonly(copy_path: str):
    """Read ``{event_id: (digest, payload, created_at)}`` read-only; ``None`` when
    the target is not a readable memory database.

    Opened read-only so probing an existing (possibly hostile) target never
    mutates its bytes, permissions or directory entry.
    """
    try:
        conn = migration_preflight._open_readonly(os.path.abspath(copy_path))
    except PreflightError:
        return None
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(turns)")}
        if not all(name in columns for name in _BASELINE_COLUMNS):
            return None
        rows = {}
        for event_id, digest, payload, created_at in conn.execute(
                "SELECT event_id,digest,payload,created_at FROM turns"):
            rows[event_id] = (digest, payload, created_at)
        return rows
    except sqlite3.Error:
        return None
    finally:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        conn.close()


def _copy_is_faithful_snapshot(copy_path: str, source_rows) -> bool:
    """True when every target row is byte-identical to a source row.

    A manifest-less target is only trusted when it is a verifiable content
    mapping of the current source: same ``(digest, payload, created_at)`` for
    every ``event_id`` it holds.  A same-schema impostor (e.g. one that copied
    the payloads but rewrote ``created_at``) fails this and is refused.
    """
    target_rows = _read_target_rows_readonly(copy_path)
    if target_rows is None:
        return False
    for event_id, triple in target_rows.items():
        if source_rows.get(event_id) != triple:
            return False
    return True


def _is_known_copy(copy_dir, copy_path: str, source_digest_hash: str, source_rows) -> bool:
    """True only for a target we can prove provenance for.

    A copy is *known* when it carries our converter manifest with a matching
    ``converterVersion`` **and** a provenance fingerprint equal to the current
    source's digest-set hash.  Without a manifest, the target must be a
    verifiable byte-faithful snapshot of the source.  A bare baseline ``turns``
    schema, a forged/mismatched manifest, or a same-schema impostor is **not**
    known and must never reach ``_backup``'s delete/rebuild.
    """
    manifest = _load_manifest(copy_dir)
    if manifest is not None:
        if manifest.get("converterVersion") != CONVERTER_VERSION:
            raise _fail("manifest_version_drift")
        recorded = manifest.get("source_digest_set_hash")
        return isinstance(recorded, str) and recorded == source_digest_hash
    return _copy_is_faithful_snapshot(copy_path, source_rows)


# ---------------------------------------------------------------------------
# 1. snapshot
# ---------------------------------------------------------------------------
def snapshot(source_dir, copy_dir) -> dict:
    """Consistently back up the source ``ingest.sqlite`` into ``copy_dir``.

    The source is validated with the preflight path-safety checks and opened
    read-only; the copy is produced with ``sqlite3.Connection.backup()`` so any
    committed-but-uncheckpointed WAL content is included.  A pre-existing usable
    copy (see :func:`_is_known_copy`) is left untouched, which is what makes
    :func:`convert` resumable.  A target that aliases the source, or a non-empty
    unknown database, is refused rather than overwritten.
    """
    source_path = _validated_source(source_dir)
    copy_path = _db_path(copy_dir)

    _check_target_alias(source_path, source_dir, copy_dir, copy_path)
    _validate_target_path(copy_dir, copy_path)

    try:
        source_digest_hash, source_rows = _source_provenance(source_path)
    except PreflightError:
        raise _fail("source_not_readable") from None

    os.makedirs(copy_dir, mode=0o700, exist_ok=True)
    os.chmod(copy_dir, 0o700)

    if os.path.exists(copy_path):
        if not _is_known_copy(copy_dir, copy_path, source_digest_hash, source_rows):
            raise _fail("unknown_existing_db")

    if not _is_usable_copy(copy_path):
        try:
            _backup(source_path, copy_path)
        except PreflightError:
            raise _fail("source_not_readable") from None
    os.chmod(copy_path, 0o600)
    return _copy_stats(copy_path)


def _backup(source_path: str, copy_path: str) -> None:
    source = migration_preflight._open_readonly(source_path)
    try:
        if os.path.exists(copy_path):
            os.remove(copy_path)
        target = _connect(copy_path)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        try:
            source.rollback()
        except sqlite3.Error:
            pass
        source.close()


def _copy_stats(copy_path: str) -> dict:
    conn = _connect(copy_path)
    try:
        total = conn.execute("SELECT count(*) FROM turns").fetchone()[0]
        done = conn.execute(
            "SELECT count(*) FROM turns WHERE status='done'").fetchone()[0]
        by_role: dict[str, int] = {}
        for (payload,) in conn.execute("SELECT payload FROM turns"):
            role = _role_of(payload)
            by_role[role] = by_role.get(role, 0) + 1
    finally:
        conn.close()
    return {"total": total, "done": done, "byRole": by_role}


def _role_of(payload) -> str:
    try:
        obj = json.loads(payload)
    except (json.JSONDecodeError, TypeError, ValueError):
        return "unknown"
    role = obj.get("role") if isinstance(obj, dict) else None
    return role if role in ("user", "assistant") else "unknown"


# ---------------------------------------------------------------------------
# row reading
# ---------------------------------------------------------------------------
def _read_source_rows(source_path: str) -> list:
    """Read every legacy row read-only.  ``forgotten`` defaults to 0 when the
    legacy schema has no such column."""
    conn = migration_preflight._open_readonly(source_path)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(turns)")}
        remembered = "forgotten" if "forgotten" in columns else "0"
        select = ("event_id,payload,digest,status,created_at," + remembered)
        rows = []
        for event_id, payload, digest, status, created_at, forgotten in conn.execute(
                "SELECT " + select + " FROM turns"):
            try:
                obj = json.loads(payload)
            except (json.JSONDecodeError, TypeError, ValueError):
                obj = {}
            if not isinstance(obj, dict):
                obj = {}
            role = obj.get("role")
            rows.append({
                "event_id": event_id,
                "payload": payload,
                "digest": digest,
                "status": status,
                "created_at": created_at,
                "forgotten": int(forgotten or 0),
                "role": role if role in ("user", "assistant") else "unknown",
                "user_id": obj.get("user_id"),
                "text": obj.get("text"),
                "source": obj.get("source") or "wechat",
            })
        return rows
    finally:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        conn.close()


def _copy_event_ids(copy_path: str) -> set:
    conn = _connect(copy_path)
    try:
        return {row[0] for row in conn.execute("SELECT event_id FROM turns")}
    finally:
        conn.close()


def _write_columns(copy_path: str, event_id: str, columns: dict, *, require=None) -> None:
    keys = list(columns)
    assignments = ",".join(f"{key}=?" for key in keys)
    where = "event_id=?"
    params = [columns[key] for key in keys] + [event_id]
    for guard_key, guard_value in (require or {}).items():
        where += f" AND {guard_key}=?"
        params.append(guard_value)
    conn = _connect(copy_path)
    try:
        conn.execute(f"UPDATE turns SET {assignments} WHERE {where}", params)
        conn.commit()
    finally:
        conn.close()


def _insert_row(copy_path: str, row: dict) -> None:
    conn = _connect(copy_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO turns(event_id,payload,digest,status,created_at) "
            "VALUES(?,?,?,?,?)",
            (row["event_id"], row["payload"], row["digest"], row["status"],
             row["created_at"]))
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 2. manifest
# ---------------------------------------------------------------------------
def _build_manifest(rows: list, dry_run: bool) -> dict:
    digest_hash = _digest_set_hash(row["digest"] for row in rows)
    done = 0
    by_role: dict[str, int] = {}
    for row in rows:
        by_role[row["role"]] = by_role.get(row["role"], 0) + 1
        if row["status"] == "done":
            done += 1
    return {
        "schemaVersion": SCHEMA_VERSION,
        "converterVersion": CONVERTER_VERSION,
        "source_rows": {"total": len(rows), "done": done, "byRole": by_role},
        "source_digest_set_hash": digest_hash,
        "created_at": time.time(),
        "dry_run": bool(dry_run),
        "network_calls": 0,
    }


def _write_manifest(copy_dir, manifest: dict) -> None:
    path = os.path.join(os.fspath(copy_dir), MANIFEST_NAME)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(path, 0o600)


def _load_manifest(copy_dir):
    """Return the existing manifest dict, or ``None`` when there is none."""
    path = os.path.join(os.fspath(copy_dir), MANIFEST_NAME)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------------------
# 3. journal
# ---------------------------------------------------------------------------
def _journal_path(copy_dir) -> str:
    return os.path.join(os.fspath(copy_dir), JOURNAL_NAME)


def _load_journal(copy_dir) -> dict:
    """Return ``{digest: outcome}`` from an existing journal (last write wins)."""
    path = _journal_path(copy_dir)
    journal: dict[str, str] = {}
    if not os.path.exists(path):
        return journal
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            digest = entry.get("digest") if isinstance(entry, dict) else None
            if isinstance(digest, str) and digest:
                journal[digest] = entry.get("outcome")
    return journal


def _append_journal(copy_dir, digest: str, outcome: str) -> None:
    path = _journal_path(copy_dir)
    entry = {"digest": digest, "outcome": outcome, "at": time.time()}
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    os.chmod(path, 0o600)


# ---------------------------------------------------------------------------
# schema application (copy only)
# ---------------------------------------------------------------------------
def _ensure_copy_schema(copy_path: str) -> None:
    # Imported lazily so importing this module (and the read-only preflight-style
    # CLI) does not require pydantic/fastapi.
    from . import lifecycle

    conn = _connect(copy_path)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(turns)")}
        for name, ddl in _QUALITY_ADDITIONS:
            if name not in columns:
                conn.execute(f"ALTER TABLE turns ADD COLUMN {name} {ddl}")
        lifecycle.ensure_schema(conn)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 4. convert
# ---------------------------------------------------------------------------
def _config_from(engine_factory) -> quality.QualityConfig:
    if engine_factory is not None:
        try:
            engine = engine_factory()
            config = getattr(engine, "quality", None)
            if isinstance(config, quality.QualityConfig):
                return config
        except Exception:  # noqa: BLE001 - optional hint only
            pass
    return quality.QualityConfig()


def _assistant_plan(row: dict, config: quality.QualityConfig) -> dict:
    """Mirror ``Mem0Engine._plan(turn, "assistant_archived", [])``."""
    text = row["text"] if isinstance(row["text"], str) else ""
    return {
        "event_id": row["event_id"],
        "user_id": row["user_id"],
        "role": "assistant",
        "source": row["source"],
        "extraction_version": config.extraction_version,
        "extraction_mode": quality.EXTRACTION_MODE_SOURCE_SPANS,
        "validation_status": "assistant_archived",
        "source_digest": hashlib.sha256(text.encode()).hexdigest(),
        "text_chars": len(text),
        "facts": [],
        "error_kind": None,
        "quality": {"semantic": {}, "fact_count": 0, "no_durable_facts": False},
    }


def _convert_row(copy_path: str, row: dict, config: quality.QualityConfig, store) -> str:
    role = row["role"]
    if role == "assistant":
        if row["forgotten"]:
            return OUTCOME_SKIPPED
        plan = _assistant_plan(row, config)
        _write_columns(copy_path, row["event_id"], {
            "status": "done",
            "validation_status": "assistant_archived",
            "error_kind": None,
            "extraction_version": plan["extraction_version"],
            "quality": json.dumps(plan["quality"], ensure_ascii=False),
            "plan": json.dumps(plan, ensure_ascii=False),
            "stored_ids": json.dumps({"stored": [], "reused": []}),
        })
        return OUTCOME_ARCHIVED
    if role != "user":
        return OUTCOME_SKIPPED
    if row["forgotten"] or row["status"] != "done":
        # Already-forgotten rows and non-done rows (needs_review, pending,
        # forgotten) are preserved exactly as they are.
        return OUTCOME_SKIPPED
    matched = store.match(row["user_id"], row["event_id"], row["text"])
    if matched is not None:
        _write_columns(copy_path, row["event_id"], {
            "status": "forgotten", "validation_status": None, "forgotten": 1})
        return OUTCOME_FORGOTTEN
    # A legacy done user row becomes a re-verification candidate; it is NOT yet
    # trusted.  ``reverify`` decides validated / needs_review.
    _write_columns(copy_path, row["event_id"], {
        "status": "pending", "validation_status": None})
    return OUTCOME_PENDING


def _classify(copy_path: str, rows: list, copy_dir, config: quality.QualityConfig) -> dict:
    from . import lifecycle

    journal = _load_journal(copy_dir)
    journal_set = set(journal)
    copy_ids = _copy_event_ids(copy_path)
    store = lifecycle.ForgetStore(lambda: _connect(copy_path))
    outcomes: dict[str, str] = {}

    for row in rows:
        event_id = row["event_id"]
        digest = row["digest"]
        if digest in journal_set and event_id in copy_ids:
            # Already converted (idempotent resume); leave the row untouched.
            outcomes[event_id] = journal.get(digest) or OUTCOME_SKIPPED
            continue
        if event_id not in copy_ids:
            # Half-written / missing result: restore the source row and redo it.
            _insert_row(copy_path, row)
            copy_ids.add(event_id)
        outcome = _convert_row(copy_path, row, config, store)
        outcomes[event_id] = outcome
        if digest not in journal_set:
            _append_journal(copy_dir, digest, outcome)
            journal_set.add(digest)
    return outcomes


def _assert_consumable(copy_path: str, copy_dir, rows: list) -> None:
    """Reject source rows the frozen copy cannot account for.

    A source row missing from the copy is legitimate only when the journal has
    already recorded its digest -- a half-written / crashed row to redo.  Any
    other source row absent from the copy means the source changed after the
    snapshot, i.e. the copy no longer conserves the source.
    """
    copy_ids = _copy_event_ids(copy_path)
    journal = _load_journal(copy_dir)
    for row in rows:
        if row["event_id"] not in copy_ids and row["digest"] not in journal:
            raise _fail("conservation_violation")


def convert(source_dir, copy_dir, engine_factory=None, dry_run: bool = False) -> dict:
    """Snapshot the source into ``copy_dir`` and classify every legacy row.

    ``dry_run`` performs only the snapshot, manifest and conservation check; the
    per-row classification statistics are computed without writing any turns
    content (and without a journal).
    """
    source_path = _db_path(source_dir)
    stats = snapshot(source_dir, copy_dir)
    copy_path = _db_path(copy_dir)

    # Refuse to mix an old converter's copy with the current code.
    existing = _load_manifest(copy_dir)
    if existing is not None and existing.get("converterVersion") != CONVERTER_VERSION:
        raise _fail("manifest_version_drift")

    try:
        rows = _read_source_rows(source_path)
    except PreflightError:
        raise _fail("source_not_readable") from None

    # Refuse post-snapshot source drift before writing anything to the copy.
    _assert_consumable(copy_path, copy_dir, rows)

    manifest = _build_manifest(rows, dry_run)
    _write_manifest(copy_dir, manifest)

    outcomes: dict[str, str] = {}
    if not dry_run:
        _ensure_copy_schema(copy_path)
        outcomes = _classify(
            copy_path, rows, copy_dir, _config_from(engine_factory))
    else:
        outcomes = _dry_run_outcomes(rows)

    report = verify_conservation(source_dir, copy_dir)
    return {
        "converterVersion": CONVERTER_VERSION,
        "dry_run": bool(dry_run),
        "network_calls": 0,
        "manifest": manifest,
        "copy_rows": stats,
        "outcomes": _summarize_outcomes(outcomes),
        "conservation": report,
    }


def _dry_run_outcomes(rows: list) -> dict:
    """Classification statistics only -- nothing is written."""
    outcomes: dict[str, str] = {}
    for row in rows:
        if row["role"] == "assistant":
            outcomes[row["event_id"]] = OUTCOME_ARCHIVED
        elif row["role"] == "user" and row["status"] == "done":
            outcomes[row["event_id"]] = OUTCOME_PENDING
        else:
            outcomes[row["event_id"]] = OUTCOME_SKIPPED
    return outcomes


def _summarize_outcomes(outcomes: dict) -> dict:
    summary = {name: 0 for name in _OUTCOMES}
    for outcome in outcomes.values():
        summary[outcome] = summary.get(outcome, 0) + 1
    summary["total"] = len(outcomes)
    return summary


# ---------------------------------------------------------------------------
# 5. reverify
# ---------------------------------------------------------------------------
def _safe_kind(error: Exception) -> str:
    candidate = error.kind if isinstance(error, quality.QualityError) else None
    if candidate is None:
        candidate = type(error).__name__
    if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_]{1,64}", candidate):
        return candidate
    return "internal_error"


def _store_kind(error: Exception) -> str:
    """Sanitized ``error_kind`` for a vector-store failure.

    Quality errors keep their stable kind; any other exception (an SDK/transport
    failure, whose text may leak provider detail) collapses to ``store_error``,
    which :func:`reverify` will retry on a later pass.
    """
    if isinstance(error, quality.QualityError):
        return _safe_kind(error)
    return "store_error"


def _pending_user_rows(copy_path: str) -> list:
    """Rows a ``reverify`` pass should (re)validate.

    Pending rows awaiting first validation, plus rows whose only failure was a
    transient vector-store error (``store_error``) so a later pass can recover
    them.  Terminal ``needs_review`` reasons are never retried.  The persisted
    ``plan`` (if any) is returned so a retry reuses it instead of re-extracting.
    """
    placeholders = ",".join("?" for _ in _RETRYABLE_ERROR_KINDS)
    conn = _connect(copy_path)
    try:
        return conn.execute(
            "SELECT event_id,payload,plan FROM turns "
            "WHERE forgotten=0 AND (status='pending' "
            f"OR (status='needs_review' AND error_kind IN ({placeholders})))",
            _RETRYABLE_ERROR_KINDS).fetchall()
    finally:
        conn.close()


def _load_persisted_plan(raw):
    """Parse a persisted ``plan`` column.  ``None`` when absent; ``False`` when
    present but corrupt (so a retry fails closed instead of re-extracting)."""
    if raw is None or raw == "":
        return None
    try:
        plan = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    return plan if isinstance(plan, dict) else False


def _row_is_forgotten(copy_path: str, event_id: str, forget_store, user_id: str, text) -> bool:
    """True when the row is flagged forgotten or a tombstone matches it now."""
    conn = _connect(copy_path)
    try:
        row = conn.execute("SELECT forgotten FROM turns WHERE event_id=?",
                           (event_id,)).fetchone()
    finally:
        conn.close()
    if row is not None and int(row[0] or 0) == 1:
        return True
    return forget_store.match(user_id, event_id, text) is not None


def _mark_forgotten(copy_path: str, event_id: str) -> None:
    _write_columns(copy_path, event_id, {
        "status": "forgotten", "forgotten": 1, "validation_status": None, "error_kind": None})


def _delete_effects(engine, ids) -> bool:
    """Best-effort compensation: delete vector effects just written for a row
    that a forget committed to mid-flight.  Returns False when the engine
    exposes no usable delete capability (caller must then fail closed)."""
    memory = getattr(engine, "memory", None)
    delete = getattr(memory, "delete", None)
    if not callable(delete):
        return False
    ok = True
    for memory_id in ids:
        if not isinstance(memory_id, str) or not memory_id:
            ok = False
            continue
        try:
            delete(memory_id)
        except Exception:  # noqa: BLE001 - any delete failure is not a success
            ok = False
    return ok


def _persist_plan(copy_path: str, event_id: str, plan: dict) -> None:
    """Durably persist a validated plan BEFORE any vector effect (F004)."""
    _write_columns(copy_path, event_id, {
        "plan": json.dumps(plan, ensure_ascii=False),
        "validation_status": plan.get("validation_status"),
        "extraction_version": plan.get("extraction_version"),
        "quality": json.dumps(plan.get("quality") or {}, ensure_ascii=False),
    }, require={"forgotten": 0})


def _write_receipt(copy_path: str, event_id: str, *, status: str,
                   validation_status, plan: dict, error_kind, stored_ids,
                   require=None) -> None:
    # A receipt never overwrites a row a forget has since tombstoned: the
    # ``forgotten=0`` guard makes the settlement fence race-proof.
    if require is None:
        require = {"forgotten": 0}
    _write_columns(copy_path, event_id, {
        "status": status,
        "validation_status": validation_status,
        "error_kind": error_kind,
        "extraction_version": plan.get("extraction_version"),
        "quality": json.dumps(plan.get("quality") or {}, ensure_ascii=False),
        "plan": json.dumps(plan, ensure_ascii=False),
        "stored_ids": json.dumps(stored_ids, ensure_ascii=False),
    }, require=require)


def _reverify_one(copy_path: str, engine, turn, config: quality.QualityConfig,
                  forget_store, persisted_plan) -> str:
    if persisted_plan is None:
        try:
            plan = engine.prepare(turn)
        except Exception as error:  # noqa: BLE001 - sanitized into a stable kind
            _write_columns(copy_path, turn.event_id, {
                "status": "needs_review", "validation_status": "needs_review",
                "error_kind": _safe_kind(error)})
            return "errors"
        if not isinstance(plan, dict):
            _write_columns(copy_path, turn.event_id, {
                "status": "needs_review", "validation_status": "needs_review",
                "error_kind": "invalid_plan"})
            return "errors"
    else:
        # A persisted plan is reused verbatim (F004); it is never replaced by a
        # fresh extraction, so a tampered/drifted plan fails closed below.
        plan = persisted_plan

    status = plan.get("validation_status")
    if status in ("needs_review", "rejected"):
        _write_receipt(
            copy_path, turn.event_id, status="needs_review",
            validation_status="needs_review", plan=plan,
            error_kind=plan.get("error_kind") or "needs_review",
            stored_ids={"stored": [], "reused": []})
        return "needs_review"

    try:
        facts = quality.validate_plan(turn, plan, config)
    except Exception as error:  # noqa: BLE001 - sanitized into a stable kind
        _write_receipt(
            copy_path, turn.event_id, status="needs_review",
            validation_status="needs_review", plan=plan,
            error_kind=_safe_kind(error), stored_ids={"stored": [], "reused": []})
        return "needs_review"

    if status in ("no_facts", "assistant_archived"):
        _write_receipt(
            copy_path, turn.event_id, status="done", validation_status=status,
            plan=plan, error_kind=None, stored_ids={"stored": [], "reused": []})
        return status

    if status != "validated":
        _write_receipt(
            copy_path, turn.event_id, status="needs_review",
            validation_status="needs_review", plan=plan,
            error_kind="invalid_plan", stored_ids={"stored": [], "reused": []})
        return "needs_review"

    # Privacy fence A: a forget committed before/while the plan was prepared
    # must stop the store from ever starting.
    if _row_is_forgotten(copy_path, turn.event_id, forget_store, turn.user_id, turn.text):
        _mark_forgotten(copy_path, turn.event_id)
        return "forgotten"

    # F004: persist the validated plan BEFORE the vector effect so a crash or a
    # later store failure is recovered from the *same* plan (zero re-extraction).
    _persist_plan(copy_path, turn.event_id, plan)

    try:
        result = engine.store(turn, plan)
    except Exception as error:  # noqa: BLE001 - sanitized into a stable kind
        # A forget committed while the store was in flight: never validated.
        if _row_is_forgotten(copy_path, turn.event_id, forget_store, turn.user_id, turn.text):
            _mark_forgotten(copy_path, turn.event_id)
            return "forgotten"
        _write_receipt(
            copy_path, turn.event_id, status="needs_review",
            validation_status="needs_review", plan=plan,
            error_kind=_store_kind(error), stored_ids={"stored": [], "reused": []})
        return "errors"

    # Privacy fence B: a forget committed around the store must never be
    # recorded as validated.  Compensate the effects just written; when deletion
    # is impossible the row is held for review, never validated.
    if _row_is_forgotten(copy_path, turn.event_id, forget_store, turn.user_id, turn.text):
        stored = result.get("stored") if isinstance(result, dict) else None
        ids = [mid for mid in (stored or []) if isinstance(mid, str) and mid]
        deleted = _delete_effects(engine, ids)
        _mark_forgotten(copy_path, turn.event_id)
        return "forgotten" if deleted else "needs_review"

    if not isinstance(result, dict) or not result.get("ok"):
        _write_receipt(
            copy_path, turn.event_id, status="needs_review",
            validation_status="needs_review", plan=plan,
            error_kind="store_incomplete", stored_ids={"stored": [], "reused": []})
        return "needs_review"

    stored = list(result.get("stored") or [])
    reused = list(result.get("reused") or [])
    if len(stored) + len(reused) != len(facts):
        _write_receipt(
            copy_path, turn.event_id, status="needs_review",
            validation_status="needs_review", plan=plan,
            error_kind="store_incomplete", stored_ids={"stored": [], "reused": []})
        return "needs_review"

    # Privacy fence C: the settlement UPDATE carries a ``forgotten=0`` guard and
    # we re-read to confirm it landed.  A forget that raced in after the guard
    # leaves the row forgotten -> never validated.
    _write_receipt(
        copy_path, turn.event_id, status="done", validation_status="validated",
        plan=plan, error_kind=None, stored_ids={"stored": stored, "reused": reused},
        require={"forgotten": 0})
    if _row_is_forgotten(copy_path, turn.event_id, forget_store, turn.user_id, turn.text):
        _delete_effects(engine, stored)
        _mark_forgotten(copy_path, turn.event_id)
        return "forgotten"
    return "validated"


def reverify(copy_dir, engine) -> dict:
    """Re-validate every ``status='pending'`` user row in the copy.

    ``engine`` is supplied by the caller (a ``Mem0Engine`` with an injected
    memory/evaluator, or a test double).  Credential-like or otherwise
    unverifiable rows are written back as ``needs_review`` with a sanitized
    ``error_kind``; the original payload/text is never dropped.  A row whose
    store already failed is retried from its persisted plan (no re-extraction),
    and a forget committed at any point in the pipeline suppresses the row.
    """
    from . import lifecycle  # lazy: keeps the read-only CLI import light
    from .service import Turn

    copy_path = _db_path(copy_dir)
    _ensure_copy_schema(copy_path)
    config = getattr(engine, "quality", None)
    if not isinstance(config, quality.QualityConfig):
        config = quality.QualityConfig()
    forget_store = lifecycle.ForgetStore(lambda: _connect(copy_path))

    counts = {"validated": 0, "needs_review": 0, "no_facts": 0,
              "assistant_archived": 0, "errors": 0, "forgotten": 0}
    for event_id, payload, plan_json in _pending_user_rows(copy_path):
        try:
            turn = Turn.model_validate_json(payload)
        except Exception:  # noqa: BLE001 - malformed persisted payload
            _write_columns(copy_path, event_id, {
                "status": "needs_review", "validation_status": "needs_review",
                "error_kind": "invalid_payload"})
            counts["errors"] += 1
            continue
        if turn.event_id != event_id or turn.role != "user":
            _write_columns(copy_path, event_id, {
                "status": "needs_review", "validation_status": "needs_review",
                "error_kind": "invalid_payload"})
            counts["errors"] += 1
            continue
        persisted = _load_persisted_plan(plan_json)
        if persisted is False:
            # A previously-persisted but corrupt plan fails closed; it is never
            # silently replaced by a fresh extraction or a new request id.
            _write_columns(copy_path, event_id, {
                "status": "needs_review", "validation_status": "needs_review",
                "error_kind": "invalid_plan"}, require={"forgotten": 0})
            counts["needs_review"] += 1
            continue
        outcome = _reverify_one(copy_path, engine, turn, config, forget_store, persisted)
        counts[outcome] = counts.get(outcome, 0) + 1
    return counts


# ---------------------------------------------------------------------------
# 6. verify_conservation
# ---------------------------------------------------------------------------
def _conservation_rows(path: str, *, readonly: bool) -> dict:
    """Read every row as ``{event_id: {payload,digest,status,created_at,forgotten}}``.

    ``readonly=True`` opens the database with the preflight read-only snapshot
    (URI ``mode=ro`` + ``PRAGMA query_only``) so the source is never opened for
    writing; the copy side uses a plain connection.
    """
    if readonly:
        conn = migration_preflight._open_readonly(path)
    else:
        conn = _connect(path)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(turns)")}
        forgotten = "forgotten" if "forgotten" in columns else "0"
        select = "event_id,payload,digest,status,created_at," + forgotten
        rows = {}
        for event_id, payload, digest, status, created_at, forgotten_flag in conn.execute(
                "SELECT " + select + " FROM turns"):
            rows[event_id] = {
                "payload": payload, "digest": digest, "status": status,
                "created_at": created_at, "forgotten": int(forgotten_flag or 0),
            }
        return rows
    finally:
        if readonly:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
        conn.close()


def _payload_digest(payload) -> str:
    """Re-derive the stored digest from the stored payload (canonical JSON)."""
    try:
        obj = json.loads(payload)
    except (json.JSONDecodeError, TypeError, ValueError):
        raise _fail("conservation_violation") from None
    if not isinstance(obj, dict):
        raise _fail("conservation_violation")
    return migration_preflight._canonical_digest(obj)


def _tombstones_consistent(copy_path: str, copy_rows: dict):
    """Every tombstoned event must be marked forgotten in the copy.

    ``None`` when the copy's tombstone table cannot be read; ``True`` when there
    is no tombstone table at all (a pure legacy snapshot).
    """
    conn = _connect(copy_path)
    try:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if "tombstones" not in tables:
            return True
        tombstones = [row[0] for row in conn.execute("SELECT event_id FROM tombstones")]
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    for event_id in tombstones:
        row = copy_rows.get(event_id)
        if row is not None and not row["forgotten"]:
            return False
    return True


def _manifest_provenance_ok(copy_dir, source_rows: dict) -> bool:
    """The copy's manifest (if any) must still fingerprint this source."""
    manifest = _load_manifest(copy_dir)
    if manifest is None:
        return True
    if manifest.get("converterVersion") != CONVERTER_VERSION:
        return False
    recorded = manifest.get("source_digest_set_hash")
    return isinstance(recorded, str) and recorded == _digest_set_hash(
        row["digest"] for row in source_rows.values())


def verify_conservation(source_dir, copy_dir) -> dict:
    """Assert the copy conserves the immutable source, field by field.

    Every source ``event_id`` must survive with an identical ``payload``, a
    ``digest`` that re-derives from that payload, an identical ``created_at``
    and a status reached only through the trusted migration whitelist.  The
    ``event_id`` sets must be equal (nothing added, dropped or duplicated), the
    copy's forgotten flags must agree with its tombstones, and any manifest
    provenance must still fingerprint this source.  The source is opened
    read-only; the returned report is redacted and any mismatch raises
    :class:`MigrationError`.
    """
    source_path = _validated_source(source_dir)
    copy_path = _db_path(copy_dir)

    try:
        source_rows = _conservation_rows(source_path, readonly=True)
    except PreflightError:
        raise _fail("source_not_readable") from None
    copy_rows = _conservation_rows(copy_path, readonly=False)

    added = set(copy_rows) - set(source_rows)
    missing = set(source_rows) - set(copy_rows)
    mismatches = 0
    for event_id, srow in source_rows.items():
        crow = copy_rows.get(event_id)
        if crow is None:
            continue
        if srow["payload"] != crow["payload"]:
            mismatches += 1
            continue
        try:
            if _payload_digest(srow["payload"]) != srow["digest"]:
                mismatches += 1
                continue
            if _payload_digest(crow["payload"]) != crow["digest"]:
                mismatches += 1
                continue
        except MigrationError:
            mismatches += 1
            continue
        if srow["created_at"] != crow["created_at"]:
            mismatches += 1
            continue
        allowed = _ALLOWED_MIGRATED_STATUS.get(srow["status"])
        if allowed is None or crow["status"] not in allowed:
            mismatches += 1
            continue
        if srow["forgotten"] and not crow["forgotten"]:
            mismatches += 1
            continue

    if _tombstones_consistent(copy_path, copy_rows) is False:
        mismatches += 1
    if not _manifest_provenance_ok(copy_dir, source_rows):
        mismatches += 1

    matches = not added and not missing and mismatches == 0
    report = {
        "source_rows": len(source_rows),
        "copy_rows": len(copy_rows),
        "digests_match": matches,
        "added_rows": len(added),
        "missing_rows": len(missing),
        "field_mismatches": mismatches,
    }
    if not matches:
        raise _fail("conservation_violation")
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _default_engine(copy_dir):
    # Only reached behind the explicit ``--allow-real-engine`` opt-in in
    # ``main``; the library API never calls this.
    from .service import Mem0Engine  # local production engine on the private copy

    return Mem0Engine(copy_dir)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m services.memory.migration",
        description="Versioned private-copy migration converter for legacy memory databases.",
    )
    parser.add_argument("--source", required=True,
                        help="absolute path to the source state directory")
    parser.add_argument("--copy", required=True,
                        help="absolute path to the private copy directory")
    parser.add_argument("--dry-run", action="store_true",
                        help="snapshot, manifest and classify without writing turns")
    parser.add_argument("--reverify", action="store_true",
                        help="after conversion, re-validate pending rows with the local engine")
    parser.add_argument("--allow-real-engine", action="store_true",
                        help="explicitly opt in to building the real local engine for --reverify")
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    # Fail closed: --reverify must never implicitly build the real local engine.
    if args.reverify and not args.allow_real_engine:
        sys.stderr.write(
            "migration blocked: --reverify requires --allow-real-engine\n")
        return 2
    try:
        report = convert(args.source, args.copy, dry_run=args.dry_run)
        if args.reverify and not args.dry_run:
            report["reverify"] = reverify(args.copy, _default_engine(args.copy))
    except MigrationError as error:
        sys.stderr.write("migration blocked: %s\n" % error)
        return 2
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
