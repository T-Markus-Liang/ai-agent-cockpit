"""Read-only shadow projection of a converted memory database against its source.

This is the memory-side sibling of ``control-plane/shadow-projection.mjs`` (D67):
the migration story the P5/P6 readiness map lays out -- frozen-writes consistent
snapshot -> versioned conversion -> **shadow** -> whitelist canary/drain ->
naming batch 2 -> rollback freeze points -- crosses its rehearsal step here for
the *memory library*, the single most data-critical store in the migration chain.
The converted copy and its ORIGINAL source are run through the SAME set of
READ-ONLY projections and the two results are compared, leaving a re-verifiable
report: a dress rehearsal before any canary ever runs.

The report shape is aligned field-by-field with the Node module so the two are
cross-language comparable::

    { version, kind:'memory',
      projections: [ { name, status, legacyDigest, convertedDigest, match, detail? } ],
      allMatch, reportDigest, generatedAt }

HARD BOUNDARIES (same spirit as ``migration.py`` and
``shadow-projection.mjs``)

* Both databases are opened **read-only** (SQLite URI ``mode=ro&immutable=1``);
  the source is never opened for writing, never ``chmod``-ed, never backed up
  and no ``-wal``/``-shm``/``-journal`` sidecar is ever created next to it.
* PURE over the two files a caller points it at. The production state directory
  ``~/.local/state/personal-ai-os/`` (and ``~/.wechat-acp/``) is never read or
  written, no network/model/WeChat call is made, no environment is read, and no
  ``MemoryService`` is constructed. The clock is injected via ``now``.
* OBSERVABLE SEMANTICS, NOT BYTES: a projection distils the ``turns`` table to a
  canonical, ORDER-INDEPENDENT summary -- histograms, counts, digest sets and
  numeric aggregates -- and the comparison is the sha256 of that canonical
  summary (mirroring the Node ``stable()``/``digestOf()`` convention).
* NEVER FABRICATE A MATCH: a projection is reported as matching only when the
  two canonical digests are equal; a projection that throws is reported
  ``status:'failed'`` with ``match:false`` (never silently dropped, never
  allowed to abort the rest of the batch).
* Fail-closed: a missing file, a file that is not a SQLite database, or a
  database without a usable ``turns`` table raises :class:`ShadowProjectionError`
  before any projection runs.

Dependencies: the standard library only (``sqlite3``, ``hashlib``, ``json``).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

# Report schema version understood by this module.  Deliberately the same string
# as ``control-plane/shadow-projection.mjs`` so a report of either kind is
# recognised by the same tooling; ``kind`` tells the two apart.
SHADOW_PROJECTION_VERSION = "shadow-projection-v1"

# The one store kind this module understands.
KIND = "memory"

# Upper bound (characters) on each side's canonical summary in a ``detail``.
DETAIL_LIMIT = 2000

# Baseline columns a memory ``turns`` table always has; without them we cannot
# project and refuse the database (fail-closed).
_BASELINE_COLUMNS = ("event_id", "payload", "digest", "status", "created_at")

# Marker for a value that is not present (a NULL column, or a column the legacy
# schema simply lacks -- the two are the same observable from a projection).
_ABSENT = "(absent)"

# Bucket for a payload that cannot be parsed as a JSON object.
_UNPARSEABLE = "unparseable"


class ShadowProjectionError(Exception):
    """A redacted shadow-projection failure.  Never carries raw record content."""

    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.name = "ShadowProjectionError"
        self.code = code


# ---------------------------------------------------------------------------
# stable serialisation / digests (mirrors state-converter.mjs stable()/digestOf)
# ---------------------------------------------------------------------------
def _scalar(value) -> str:
    """JSON scalar text in the same shape as JS ``JSON.stringify``.

    JS numbers carry no int/float distinction, so an integral float prints
    without a trailing ``.0`` (``1.0`` -> ``"1"``); ``NaN``/``Infinity`` print
    ``null``.  Strings use ``ensure_ascii=False`` to match JS's non-escaping of
    non-ASCII text.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return "null"
        if value == int(value):
            return str(int(value))
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _stable(value) -> str:
    """Canonical, key-sorted serialisation -- the digest口径 shared with Node.

    Objects sort their keys recursively; arrays keep their order (projections
    themselves are order-independent).  This is the same algorithm as the Node
    ``stable()`` so the two languages agree on a digest for the same value.
    """
    if isinstance(value, list):
        return "[" + ",".join(_stable(item) for item in value) + "]"
    if isinstance(value, tuple):
        return "[" + ",".join(_stable(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(key), ensure_ascii=False) + ":" + _stable(value[key])
            for key in sorted(value)
        ) + "}"
    return _scalar(value)


def _fingerprint(value) -> str:
    return hashlib.sha256(_stable(value).encode("utf-8")).hexdigest()


def _digest_of(value) -> str:
    """A projection digest in the same ``sha256:<hex>`` shape the stores use."""
    return "sha256:" + _fingerprint(value)


def _bounded(text: str) -> str:
    if len(text) > DETAIL_LIMIT:
        return "%s…(truncated %d chars)" % (text[:DETAIL_LIMIT], len(text) - DETAIL_LIMIT)
    return text


def _reason(error: Exception) -> str:
    message = str(error) or type(error).__name__
    return message[:300]


# ---------------------------------------------------------------------------
# read-only loading (the only file IO this module performs)
# ---------------------------------------------------------------------------
def _open_readonly(path: str) -> sqlite3.Connection:
    """Open ``path`` read-only and never writable.

    Uses the SQLite URI form ``mode=ro&immutable=1`` the contract specifies:
    ``mode=ro`` refuses any write, and ``immutable=1`` tells SQLite the file
    cannot change (it is a frozen copy or its untouched original), which skips
    locking and guarantees no sidecar is created.  A missing file, a non-SQLite
    file and an unreadable file all fail closed with a redacted code.
    """
    try:
        conn = sqlite3.connect(path, uri=True, timeout=5)
    except (sqlite3.Error, ValueError, UnicodeError):
        raise ShadowProjectionError("not-a-database", "database is not readable") from None
    conn.isolation_level = None
    try:
        conn.execute("PRAGMA query_only=ON")
    except sqlite3.DatabaseError:
        conn.close()
        raise ShadowProjectionError("not-a-database", "database is not readable") from None
    return conn


def _load_rows(database) -> list:
    """Read every ``turns`` row read-only into a list of dicts (fail-closed).

    Missing quality columns (``validation_status``/``extraction_version``/
    ``forgotten``) are read as their absent value (``None`` / ``0``); a legacy
    0.2.2-shaped database and its converted copy both present ``(absent)`` for a
    column the conversion simply left unset, so the two are comparable.
    """
    try:
        raw = os.fspath(database)
    except TypeError:
        raise ShadowProjectionError("invalid-path", "database path is not a valid path") from None
    if isinstance(raw, bytes):
        try:
            raw = os.fsdecode(raw)
        except (UnicodeDecodeError, ValueError):
            raise ShadowProjectionError("invalid-path", "database path is not a valid path") from None
    if not isinstance(raw, str) or not raw:
        raise ShadowProjectionError("invalid-path", "database path is not a valid path")

    abs_path = os.path.abspath(raw)
    if not os.path.isfile(abs_path):
        raise ShadowProjectionError("missing-db", "database file not found")

    uri = Path(abs_path).as_uri() + "?mode=ro&immutable=1"
    conn = _open_readonly(uri)
    try:
        try:
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.DatabaseError:
            raise ShadowProjectionError("not-a-database", "database is not readable") from None
        if "turns" not in tables:
            raise ShadowProjectionError("missing-turns", "database has no turns table")

        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(turns)")}
        except sqlite3.DatabaseError:
            raise ShadowProjectionError("not-a-database", "database is not readable") from None
        if any(name not in columns for name in _BASELINE_COLUMNS):
            raise ShadowProjectionError("missing-columns", "turns table lacks baseline columns")

        select = ", ".join((
            "event_id", "payload", "digest", "status", "created_at",
            "validation_status" if "validation_status" in columns else "NULL",
            "extraction_version" if "extraction_version" in columns else "NULL",
            "forgotten" if "forgotten" in columns else "0",
        ))
        try:
            cursor = conn.execute("SELECT " + select + " FROM turns")
            rows = []
            for event_id, payload, digest, status, created_at, vs, ev, forgotten in cursor:
                rows.append({
                    "event_id": event_id,
                    "payload": payload,
                    "digest": digest,
                    "status": status,
                    "created_at": created_at,
                    "validation_status": vs,
                    "extraction_version": ev,
                    "forgotten": int(forgotten or 0),
                })
        except sqlite3.DatabaseError:
            raise ShadowProjectionError("not-a-database", "database is not readable") from None
        return rows
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# projection helpers
# ---------------------------------------------------------------------------
def _label(value) -> str:
    return _ABSENT if value is None else str(value)


def _histogram(values) -> dict:
    """An order-independent histogram of ``values`` (keys normalised to strings)."""
    out: dict[str, int] = {}
    for value in values:
        key = _label(value)
        out[key] = out.get(key, 0) + 1
    return out


def _user_key(payload) -> str:
    """The ``user_id`` of a turn payload, ``(absent)`` when unset, ``unparseable``
    when the payload is not a JSON object."""
    if not isinstance(payload, str):
        return _UNPARSEABLE
    try:
        obj = json.loads(payload)
    except (json.JSONDecodeError, TypeError, ValueError):
        return _UNPARSEABLE
    if not isinstance(obj, dict):
        return _UNPARSEABLE
    user_id = obj.get("user_id")
    return _ABSENT if user_id is None else str(user_id)


# ---------------------------------------------------------------------------
# built-in projections (``turns`` table semantics, read-only)
# ---------------------------------------------------------------------------
def _project_status_histogram(rows) -> dict:
    return _histogram([row["status"] for row in rows])


def _project_validation_status_histogram(rows) -> dict:
    return _histogram([row["validation_status"] for row in rows])


def _project_forgotten_count(rows) -> int:
    return sum(1 for row in rows if row["forgotten"])


def _project_extraction_version_histogram(rows) -> dict:
    return _histogram([row["extraction_version"] for row in rows])


def _project_events_per_user(rows) -> dict:
    return _histogram([_user_key(row["payload"]) for row in rows])


def _project_created_at_bounds(rows) -> dict:
    values = [
        row["created_at"] for row in rows
        if isinstance(row["created_at"], (int, float))
        and not isinstance(row["created_at"], bool)
        and math.isfinite(row["created_at"])
    ]
    if not values:
        return {"count": 0, "min": None, "max": None}
    return {"count": len(values), "min": min(values), "max": max(values)}


def _project_digest_set(rows) -> list:
    return sorted({_label(row["digest"]) for row in rows})


# The built-in projection set.  The seam a caller may override is
# ``run_shadow_projection(..., projections=[...])``.
_BUILTIN = (
    ("statusHistogram", _project_status_histogram),
    ("validationStatusHistogram", _project_validation_status_histogram),
    ("forgottenCount", _project_forgotten_count),
    ("extractionVersionHistogram", _project_extraction_version_histogram),
    ("eventsPerUser", _project_events_per_user),
    ("createdAtBounds", _project_created_at_bounds),
    ("digestSet", _project_digest_set),
)

#: Names of the built-in projections, in report order.
PROJECTION_NAMES = tuple(name for name, _ in _BUILTIN)


# ---------------------------------------------------------------------------
# input normalisation / projection resolution
# ---------------------------------------------------------------------------
def _resolve_clock(now):
    """Epoch-milliseconds from an injected clock (callable or number)."""
    if now is None:
        return int(time.time() * 1000)
    value = now() if callable(now) else now
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ShadowProjectionError(
            "invalid-config", "now must yield a finite epoch-millisecond number")
    return value


def _resolve_projections(projections):
    if projections is None:
        return _BUILTIN
    if not isinstance(projections, (list, tuple)) or len(projections) == 0:
        raise ShadowProjectionError(
            "invalid-config", "projections must be a non-empty list of callables")
    specs = []
    for index, fn in enumerate(projections):
        if not callable(fn):
            raise ShadowProjectionError(
                "invalid-config", "projections[%d] must be a callable" % index)
        name = getattr(fn, "displayName", None) or getattr(fn, "__name__", "") or (
            "projection-%d" % index)
        specs.append((name, fn))
    return specs


def _iso(clock_ms) -> str:
    """ISO-8601 with milliseconds and a ``Z`` suffix, matching JS ``toISOString``."""
    dt = datetime.fromtimestamp(clock_ms / 1000.0, tz=timezone.utc)
    return "%s.%03dZ" % (dt.strftime("%Y-%m-%dT%H:%M:%S"), dt.microsecond // 1000)


# ---------------------------------------------------------------------------
# run one projection on both sides and compare their canonical digests
# ---------------------------------------------------------------------------
def _run_one(spec, legacy_rows, converted_rows, clock_ms) -> dict:
    name, fn = spec
    evaluated = []
    for side, rows in (("legacy", legacy_rows), ("converted", converted_rows)):
        try:
            evaluated.append((side, fn(rows)))
        except Exception as error:  # noqa: BLE001 - isolated: reported, not raised
            return {
                "name": name,
                "status": "failed",
                "legacyDigest": None,
                "convertedDigest": None,
                "match": False,
                "detail": {"side": side, "error": _reason(error)},
            }
    (_, legacy_value), (_, converted_value) = evaluated
    legacy_digest = _digest_of(legacy_value)
    converted_digest = _digest_of(converted_value)
    match = legacy_digest == converted_digest
    projection = {
        "name": name,
        "status": "ok",
        "legacyDigest": legacy_digest,
        "convertedDigest": converted_digest,
        "match": match,
    }
    if not match:
        projection["detail"] = {
            "legacy": _bounded(_stable(legacy_value)),
            "converted": _bounded(_stable(converted_value)),
        }
    return projection


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def run_shadow_projection(legacy_db, converted_db, *, now=None, projections=None) -> dict:
    """Run the shadow projection of a converted memory copy against its source.

    :param legacy_db: path to the original ``ingest.sqlite`` (opened read-only).
    :param converted_db: path to the converted copy (opened read-only).
    :param now: injected clock; a callable returning epoch-milliseconds or a
        number.  Defaults to ``time.time() * 1000``.  Fix it for a byte-stable
        ``reportDigest``.
    :param projections: optional list of callables ``fn(rows) -> value`` that
        REPLACES the built-in set (the seam a deployment batch can use for real
        projections; also how the throwing-projection isolation is exercised).
    :returns: ``{version, kind, projections, allMatch, reportDigest, generatedAt}``.
    :raises ShadowProjectionError: fail-closed on a missing/invalid database, an
        unusable ``turns`` table, or an invalid ``now``/``projections`` argument.
    """
    clock_ms = _resolve_clock(now)
    specs = _resolve_projections(projections)
    # Fail-closed BEFORE any projection: both sides must load.
    legacy_rows = _load_rows(legacy_db)
    converted_rows = _load_rows(converted_db)

    results = [_run_one(spec, legacy_rows, converted_rows, clock_ms) for spec in specs]
    all_match = len(results) > 0 and all(
        entry["status"] == "ok" and entry["match"] is True for entry in results)

    body = {
        "version": SHADOW_PROJECTION_VERSION,
        "kind": KIND,
        "projections": results,
        "allMatch": all_match,
    }
    report = dict(body)
    report["reportDigest"] = _digest_of(body)
    report["generatedAt"] = _iso(clock_ms)
    return report
