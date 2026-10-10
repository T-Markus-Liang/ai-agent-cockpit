"""Local, read-only outbound inventory + secret screen for memory records
(0.3.0 S04, remediation §6-3).

Before ANY legacy record is re-validated through the advisory evaluator (the
"旧记录外呼"), this module answers three questions locally, without touching
the network:

1. WHAT would leave the machine? An inventory of the record categories
   (tables/fields), split strictly between USER data and ASSISTANT data.
   Assistant turns are archived locally and never sent to the evaluator, so
   they are counted separately with an explicit zero outbound. Only
   ``forgotten=0`` user receipts are candidates; forgotten/tombstoned rows are
   excluded from outbound forever.
2. WHERE would it go? The destination provider (default: the local jev-eval
   wrapper, which forwards to the configured remote Jev service — the wrapper
   holds the credentials, never this module).
3. HOW MUCH may go? Suggested call ceilings derived from the quality config
   (text/facts bounds and the per-turn batch count of the prepare pipeline).

Only a sealed, standalone rollback-format snapshot is accepted: WAL-format
headers and any WAL/SHM/journal sidecar are refused, even if the WAL was lost
when copying the main file. A verified private copy is opened with the SQLite
URI ``mode=ro&immutable=1``: the source is never opened for writing, never
chmod-ed, never backed up, and no ``-wal``/``-shm``/``-journal`` sidecar is
created next to it. The inventory contains COUNTS, field names and digests
only — never raw text, ``event_id`` or ``user_id``.

:func:`secret_screen` scans a constructed outbound payload (string, mapping or
nested lists) for secret-like SHAPES and returns the list of hit categories
only — never the secret body. :func:`build_outbound_dry_run` renders one
record in either outbound mode and produces a report entry:

* ``'full_user_text'`` — the honest status quo: the evaluator state carries
  the COMPLETE turn text (``quality.selection_state``/``completeness_state``/
  ``no_facts_state`` all put the full ``user_text`` into the payload).
* ``'minimal_quote'`` — the reduced path: only the approved minimal quotes
  (validated spans) would be sent; a record with no approved quotes is held.

Both modes are screened, and both report ``send_authorized: False`` and
``network_calls: 0``. THIS MODULE CONTAINS NO REAL CALLER AND NO TRANSPORT:
there is deliberately no send entry point in this batch. A report entry is a
local advisory artifact; sending requires an explicit, separately approved
caller. Historical record counts (e.g. the 113 receipts / 43 user entries
mentioned in earlier migration handoffs) are RUNTIME inventory results only —
they are never baked into code constants.

Example inventory structure::

    {
      "version": "outbound-inventory-v1",
      "database": {"path_kind": "memory-ingest-sqlite", "tables": ["turns", ...],
                   "opens": "mode=ro&immutable=1"},
      "provider": {"name": "jev-eval-wrapper", "via": "...",
                   "credentials": "held by wrapper config, never by this module"},
      "user_data": {"total": <int>, "by_status": {...}, "by_validation_status": {...},
                    "outbound_candidates": <int>, "forgotten_excluded": <int>,
                    "fields_full_user_text": ["user_text", "candidate.quote", "questions"],
                    "fields_minimal_quote": ["approved_quote"]},
      "assistant_data": {"total": <int>, "by_status": {...},
                         "outbound_candidates": 0,
                         "handling": "archived locally, never sent to the evaluator"},
      "suggested_call_cap": {"per_record_batches": 2, "max_text_chars": <int>,
                             "max_facts": <int>,
                             "total_batches_upper_bound": <candidates * per_record>},
      "screen": {"tool": "secret_screen",
                 "advice": "build_outbound_dry_run per record before any call"}
    }

Example dry-run report entry::

    {
      "mode": "full_user_text" | "minimal_quote",
      "fields": ["user_text", ...],           # field NAMES only, no content
      "field_sizes": {"user_text_chars": <int>, "quote_chars_total": <int>},
      "screen_hits": ["email_address", ...],  # categories only, never the secret
      "screen_clear": <bool>,
      "would_send_full_user_text": <bool>,
      "network_calls": 0,
      "recommendation": "hold_needs_review" | "screen_clear",
      "send_authorized": False,
      "reason": None | "no_approved_quote" | "screen_hits"
    }

Dependencies: the standard library only (``json``, ``re``, ``sqlite3``).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import stat
import tempfile
import shutil
from contextlib import contextmanager
from pathlib import Path

from . import quality

INVENTORY_VERSION = "outbound-inventory-v1"

#: Destination provider for the advisory evaluator, as wired in
#: ``Mem0Engine`` (``quality.JevEvaluator``). The wrapper shell reads its
#: credentials from its own config; this module never sees a key.
DEFAULT_PROVIDER = {
    "name": "jev-eval-wrapper",
    "via": "local jev-eval wrapper -> configured remote Jev service",
    "credentials": "held by wrapper config, never by this module",
}

#: The fixed question templates are outbound too, but they carry no record
#: content; they are listed for completeness in full mode.
QUESTION_FIELDS = ("questions",)

#: Field names that would leave in each outbound mode (names only, never
#: content). Mirrors what ``quality.selection_state``/``completeness_state``/
#: ``no_facts_state`` put into the evaluator state.
FIELDS_FULL_USER_TEXT = ("user_text", "candidate.quote", "selected.quote", "questions")
FIELDS_MINIMAL_QUOTE = ("approved_quote", "questions")

_MODES = ("full_user_text", "minimal_quote")

# ---------------------------------------------------------------------------
# secret screen
# ---------------------------------------------------------------------------
# Heuristic secret-like SHAPES for outbound payloads. Same spirit as
# ``quality._CREDENTIAL_PATTERNS`` but broader (this screens what would LEAVE,
# not only credentials): tokens, assignments, long base64, emails, phones and
# filesystem paths. These are heuristic shapes, not a secret-detector
# guarantee; ``quality.contains_credential`` still runs first in the pipeline.
def _make_screen():
    specs = (
        ("private_key_block", 0,
         r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
        ("token_shape", re.IGNORECASE,
         r"\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{10,}\b"
         r"|\bAKIA[0-9A-Z]{16}\b"
         r"|\bgh[pousr]_[A-Za-z0-9]{20,}\b"
         r"|\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\b"
         r"|\bbearer\s+[A-Za-z0-9._\-]{12,}"),
        ("secret_assignment", re.IGNORECASE,
         r"(?:密码|密钥|口令|令牌)\s*(?:是|为|[:：=])\s*\S+"
         r"|\b(api[_\- ]?key|apikey|secret|password|passwd|token|bearer|"
         r"credential|access[_\- ]?token|auth[_\- ]?token)\b\s*[:=]\s*\S+"),
        ("long_base64", 0, r"\b[A-Za-z0-9+/]{32,}={0,2}\b"),
        ("email_address", 0,
         r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
        ("phone_number", 0, r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"),
        ("filesystem_path", 0,
         r"(?:~/(?:[^\s'\"，。；]|\\.)+)"
         r"|(?<![\w])/(?:Users|home|var|etc|opt|private|tmp|usr)/(?:[^\s'\"，。；]|\\.)+"
         r"|(?<![\w])\.{1,2}/(?:[^\s'\"，。；]|\\.)+"),
    )
    return tuple((category, re.compile(pattern, flags))
                 for category, flags, pattern in specs)


_SCREEN = _make_screen()


class InventoryError(Exception):
    """A redacted inventory failure. Never carries raw record content."""

    def __init__(self, code: str, message: str = ""):
        self.code = code
        super().__init__(message or code)


def _iter_strings(payload):
    if isinstance(payload, str):
        yield payload
    elif isinstance(payload, dict):
        for value in payload.values():
            yield from _iter_strings(value)
    elif isinstance(payload, (list, tuple)):
        for item in payload:
            yield from _iter_strings(item)


def secret_screen(payload) -> list:
    """Scan an outbound payload and return the sorted list of hit categories.

    ``payload`` may be a string, mapping or nested structure; every string in
    it is scanned. Only category NAMES are returned — the secret body is never
    copied into the result. A normal prose text (Chinese or English) must not
    hit any category; hits are heuristic and mean "hold for needs-review",
    never "this is certainly a secret".
    """
    hits = set()
    for text in _iter_strings(payload):
        if not isinstance(text, str) or not text:
            continue
        for category, pattern in _SCREEN:
            if pattern.search(text):
                hits.add(category)
    return sorted(hits)


# ---------------------------------------------------------------------------
# read-only inventory
# ---------------------------------------------------------------------------
def _no_sidecars(path: Path):
    # lexists also rejects dangling links, directories and empty sidecars.
    if any(os.path.lexists(str(path) + suffix)
           for suffix in ("-wal", "-shm", "-journal")):
        raise InventoryError("unsafe-snapshot", "database has sidecar risk")


def _signature(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns,
            st.st_mode, st.st_uid, st.st_nlink)


def _standalone_header(header: bytes, size: int):
    if len(header) != 100 or header[:16] != b"SQLite format 3\x00":
        raise InventoryError("not-a-database")
    # Bytes 18/19 remain 2 in a copied WAL main file, even without its WAL.
    if header[18:20] != b"\x01\x01":
        raise InventoryError("unsafe-snapshot", "WAL-format database is not standalone")
    page_size = int.from_bytes(header[16:18], "big")
    page_size = 65536 if page_size == 1 else page_size
    pages = int.from_bytes(header[28:32], "big")
    if (page_size < 512 or page_size > 65536 or page_size & (page_size - 1)
            or not pages or pages * page_size != size
            or header[24:28] != header[92:96]):
        raise InventoryError("unsafe-snapshot", "snapshot header is not synchronized")


@contextmanager
def _open_readonly(path: str):
    """Validate a sealed snapshot before SQLite sees a private copy.

    The caller must supply an offline, checkpointed snapshot switched to
    journal_mode=DELETE and sealed without write bits. We never checkpoint or
    repair it. Metadata/sidecars are rechecked around copying; the subsequent
    SQLite reader cannot be redirected to a changed source pathname.
    """
    abs_path = Path(path).absolute()
    fd = None
    try:
        _no_sidecars(abs_path)
        fd = os.open(abs_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                or before.st_nlink != 1 or before.st_mode & 0o222):
            raise InventoryError("unsafe-snapshot", "snapshot must be owned and sealed")
        with os.fdopen(fd, "rb", closefd=False) as source:
            _standalone_header(source.read(100), before.st_size)
            source.seek(0)
            with tempfile.TemporaryDirectory(prefix="memory-inventory-") as tmp:
                snapshot = Path(tmp) / "snapshot.sqlite"
                with snapshot.open("xb") as target:
                    shutil.copyfileobj(source, target)
                _no_sidecars(abs_path)
                after = os.stat(abs_path, follow_symlinks=False)
                if (_signature(before) != _signature(os.fstat(fd))
                        or _signature(before) != _signature(after)
                        or snapshot.stat().st_size != before.st_size):
                    raise InventoryError("unsafe-snapshot", "snapshot changed during copy")
                snapshot.chmod(0o400)
                uri = snapshot.as_uri() + "?mode=ro&immutable=1"
                conn = sqlite3.connect(uri, uri=True, timeout=5)
                try:
                    conn.execute("PRAGMA query_only=ON")
                    if conn.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                        raise InventoryError("not-a-database")
                    yield conn
                finally:
                    conn.close()
    except FileNotFoundError:
        raise InventoryError("missing-db", "database file not found") from None
    except (sqlite3.Error, OSError, ValueError, UnicodeError):
        raise InventoryError("not-a-database", "database is not readable") from None
    finally:
        if fd is not None:
            os.close(fd)


def _role_of(payload) -> str:
    """The ``role`` of a turn payload; ``unknown`` when unparseable."""
    try:
        obj = json.loads(payload) if payload else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return "unknown"
    if not isinstance(obj, dict):
        return "unknown"
    role = obj.get("role")
    return role if role in ("user", "assistant") else "unknown"


def inventory_outbound(database, *, config: quality.QualityConfig | None = None,
                       provider: dict | None = None) -> dict:
    """Build the local outbound inventory for one memory ``ingest.sqlite``.

    Requires a sealed standalone snapshot; a validated private copy is opened
    ``mode=ro&immutable=1``. Source sidecars are never created and the source
    is never writable here. Counts are runtime values — historical
    totals from earlier handoffs are NOT constants and must be re-derived by
    running this against the actual database before any outbound decision.

    :param database: path to the (private-copy) ingestion SQLite database.
    :param config: quality config for the suggested call ceilings
        (defaults to ``QualityConfig.from_env()``).
    :param provider: optional override for the destination provider dict.
    :returns: the inventory structure documented in the module docstring.
    :raises InventoryError: fail-closed on a missing/invalid database or an
        unusable ``turns`` table.
    """
    cfg = config if config is not None else quality.QualityConfig.from_env()
    prov = dict(DEFAULT_PROVIDER)
    if provider:
        if not isinstance(provider, dict):
            raise InventoryError("invalid-provider", "provider must be a mapping")
        prov.update(provider)
    try:
        raw = os.fspath(database)
    except TypeError:
        raise InventoryError("invalid-path", "database path is not a valid path") from None
    with _open_readonly(raw) as conn:
        try:
            tables = sorted(row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"))
        except sqlite3.DatabaseError:
            raise InventoryError("not-a-database", "database is not readable") from None
        if "turns" not in tables:
            raise InventoryError("missing-turns", "database has no turns table")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(turns)")}
        if "payload" not in columns or "status" not in columns:
            raise InventoryError("missing-columns", "turns table lacks payload/status")
        forgotten_col = "forgotten" if "forgotten" in columns else "0"
        select = "payload,status," + forgotten_col
        rows = conn.execute("SELECT " + select + " FROM turns").fetchall()

    user_status: dict = {}
    user_validation: dict = {}
    assistant_status: dict = {}
    user_total = assistant_total = unknown_total = 0
    candidates = forgotten_excluded = 0
    for payload, status, forgotten in rows:
        forgotten = int(forgotten or 0)
        role = _role_of(payload)
        if role == "user":
            user_total += 1
            user_status[status] = user_status.get(status, 0) + 1
            if forgotten:
                forgotten_excluded += 1
            elif status in ("pending", "done"):
                # ``done`` legacy receipts are re-queued to pending by the
                # converter before re-validation; both are outbound candidates.
                candidates += 1
        elif role == "assistant":
            assistant_total += 1
            assistant_status[status] = assistant_status.get(status, 0) + 1
        else:
            unknown_total += 1

    # The per-turn prepare pipeline issues at most two bounded evaluator
    # batches (selection, then completeness-or-no-facts); proposals path adds
    # one semantic batch. Suggest the source-span bound; it is a ceiling, not
    # a promise, and mirrors the engine contract.
    per_record_batches = 2
    return {
        "version": INVENTORY_VERSION,
        "database": {"path_kind": "memory-ingest-sqlite", "tables": tables,
                     "opens": "mode=ro&immutable=1", "turns_rows": len(rows)},
        "provider": prov,
        "user_data": {
            "total": user_total,
            "by_status": dict(sorted(user_status.items())),
            "outbound_candidates": candidates,
            "forgotten_excluded": forgotten_excluded,
            "unparseable_excluded": unknown_total,
            "fields_full_user_text": list(FIELDS_FULL_USER_TEXT),
            "fields_minimal_quote": list(FIELDS_MINIMAL_QUOTE),
            "handling": "candidates may be re-validated through the screened evaluator only",
        },
        "assistant_data": {
            "total": assistant_total,
            "by_status": dict(sorted(assistant_status.items())),
            "outbound_candidates": 0,
            "handling": "archived locally, never sent to the evaluator",
        },
        "suggested_call_cap": {
            "per_record_batches": per_record_batches,
            "max_text_chars": cfg.max_text_chars,
            "max_facts": cfg.max_facts,
            "jev_timeout_seconds": cfg.jev_timeout,
            "total_batches_upper_bound": candidates * per_record_batches,
        },
        "screen": {"tool": "secret_screen",
                   "advice": "run build_outbound_dry_run per record before any call"},
    }


# ---------------------------------------------------------------------------
# per-record dry run
# ---------------------------------------------------------------------------
def build_outbound_dry_run(record: dict, mode: str) -> dict:
    """Screen one outbound candidate locally and produce a report entry.

    ``record`` describes ONE candidate without exposing it in the report:
    ``{"text": <full turn text>, "quotes": [<approved minimal quotes>]}``.
    The report contains field names, sizes, screen CATEGORIES and a
    recommendation — never the record content, and never the secret body.

    ``mode`` selects the payload shape that WOULD be sent:

    * ``'full_user_text'`` — the honest status quo: the complete turn text is
      part of the evaluator state (plus span quotes and fixed questions).
    * ``'minimal_quote'`` — the reduced path: only the approved minimal
      quotes would be sent; a record without approved quotes is held
      (``reason: no_approved_quote``).

    Both modes return ``send_authorized: False`` and ``network_calls: 0``.
    This function performs NO network call and has NO transport: a real send
    entry point deliberately does not exist in this batch.
    """
    if mode not in _MODES:
        raise InventoryError("invalid-mode", "mode must be one of %s" % (", ".join(_MODES)))
    if not isinstance(record, dict):
        raise InventoryError("invalid-record", "record must be a mapping")
    text = record.get("text")
    text = text if isinstance(text, str) else ""
    quotes = record.get("quotes") or []
    if not isinstance(quotes, (list, tuple)):
        raise InventoryError("invalid-record", "record quotes must be a list")
    quotes = [q for q in quotes if isinstance(q, str) and q]

    if mode == "full_user_text":
        payload = {"user_text": text, "quotes": quotes}
        fields = list(FIELDS_FULL_USER_TEXT)
        would_send_full = True
    else:
        payload = {"quotes": quotes}
        fields = list(FIELDS_MINIMAL_QUOTE)
        would_send_full = False
    hits = secret_screen(payload)
    if mode == "minimal_quote" and not quotes:
        # There is nothing approved to send under a minimal-quote scope.
        recommendation, reason = "hold_needs_review", "no_approved_quote"
    elif hits:
        recommendation, reason = "hold_needs_review", "screen_hits"
    else:
        recommendation, reason = "screen_clear", None
    return {
        "mode": mode,
        "fields": fields,
        "field_sizes": {"user_text_chars": len(text),
                        "quote_chars_total": sum(len(q) for q in quotes),
                        "quote_count": len(quotes)},
        "screen_hits": hits,
        "screen_clear": not hits,
        "would_send_full_user_text": would_send_full,
        "network_calls": 0,
        "recommendation": recommendation,
        "send_authorized": False,
        "reason": reason,
    }
