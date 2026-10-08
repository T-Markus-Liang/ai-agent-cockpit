"""Durable, server-scoped forgetting (tombstones) for the memory service.

This module owns the authenticated operator forget contract and its durable
SQLite state. Forgetting is NOT permanent deletion: it records a user-scoped
tombstone (event id, full-source hash and validated quote/span hashes) so that
an already-forgotten event, or an archive replay of the same source under a new
event id, is never re-extracted, trusted or recalled again. Raw archived
payloads and vector rows are deliberately left in place; permanent purge and
local archive/outbox coordination remain out of scope.

There is no semantic model in this path. The trusted local connector/operator
supplies ``{request_id, user_id, event_ids}`` and every target must already
exist and be owned by ``user_id`` or the whole request is rejected (redacted
404) with no state change.
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

from . import quality

MAX_FORGET_EVENTS = 200


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def sentence_hashes(text: str) -> set:
    if not isinstance(text, str):
        return set()
    return {sha256_text(quote) for _, _, quote in quality.source_spans(text)}


class ForgetRequest(BaseModel):
    """Exact operator schema: ``{request_id, user_id, event_ids}``."""

    model_config = ConfigDict(extra="forbid")

    request_id: StrictStr = Field(min_length=1, max_length=200)
    user_id: StrictStr = Field(min_length=1, max_length=200)
    event_ids: list[StrictStr] = Field(min_length=1, max_length=MAX_FORGET_EVENTS)

    @field_validator("request_id", "user_id")
    @classmethod
    def _nonblank(cls, value: str) -> str:
        # A whitespace-only id is not a real identifier; reject it up front.
        if not value.strip():
            raise ValueError("blank identifier")
        return value

    @field_validator("event_ids")
    @classmethod
    def _valid_ids(cls, value: list) -> list:
        if any(not item.strip() or len(item) > 200 for item in value):
            raise ValueError("invalid event id")
        if len(set(value)) != len(value):
            raise ValueError("duplicate event ids")
        return value


class ControlsQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: StrictStr = Field(min_length=1, max_length=200)

    @field_validator("user_id")
    @classmethod
    def _nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("blank identifier")
        return value


class ForgetError(Exception):
    """A safe, redacted forget failure mapped to an HTTP status by the service."""

    def __init__(self, kind: str, status_code: int, detail: str | None = None):
        self.kind = kind
        self.status_code = status_code
        self.detail = detail or (
            "unknown target" if status_code == 404 else "forget request conflict")
        super().__init__(kind)


def ensure_schema(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS tombstones(
        user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        quote_hashes TEXT NOT NULL,
        request_id TEXT,
        created_at REAL NOT NULL,
        PRIMARY KEY(user_id, event_id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS forget_requests(
        request_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        event_ids TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at REAL NOT NULL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS user_epochs(
        user_id TEXT PRIMARY KEY,
        memory_epoch INTEGER NOT NULL DEFAULT 0)""")


def _body_hash(request: ForgetRequest) -> str:
    canonical = json.dumps(
        {"user_id": request.user_id, "event_ids": sorted(request.event_ids)},
        sort_keys=True, ensure_ascii=False)
    return sha256_text(canonical)


def _loads(raw, fallback):
    try:
        value = json.loads(raw) if raw else fallback
    except (json.JSONDecodeError, TypeError, ValueError):
        return fallback
    return value


class ForgetStore:
    """Durable tombstone/epoch/idempotency state on the ingestion SQLite DB."""

    def __init__(self, connect):
        self._connect = connect

    # ---- atomic forget ---------------------------------------------------
    def forget(self, request: ForgetRequest) -> dict:
        body_hash = _body_hash(request)
        with self._connect() as db:
            # Control writes are durable before returning to the operator.
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute(
                "SELECT user_id,body_hash,result FROM forget_requests WHERE request_id=?",
                (request.request_id,)).fetchone()
            if prior is not None:
                if prior[0] != request.user_id or prior[1] != body_hash:
                    raise ForgetError("request_conflict", 409)
                # Same request id and body: identical stored result, no new epoch.
                # A corrupt/missing stored response must fail closed, never be
                # silently treated as an empty ``{}`` success.
                return self._idempotent_result(prior[2])
            # Verify EVERY target before writing anything (all-or-nothing).
            tombstones = []
            for event_id in request.event_ids:
                row = db.execute("SELECT payload FROM turns WHERE event_id=?",
                                 (event_id,)).fetchone()
                payload = _loads(row[0], None) if row else None
                if not isinstance(payload, dict) or payload.get("user_id") != request.user_id:
                    raise ForgetError("unknown_target", 404)
                text = payload.get("text")
                if not isinstance(text, str):
                    raise ForgetError("unknown_target", 404)
                tombstones.append({
                    "event_id": event_id,
                    "source_hash": sha256_text(text),
                    "quote_hashes": self._quote_hashes(db, event_id, text),
                })
            now = time.time()
            for tombstone in tombstones:
                db.execute(
                    "INSERT OR IGNORE INTO tombstones(user_id,event_id,source_hash,"
                    "quote_hashes,request_id,created_at) VALUES(?,?,?,?,?,?)",
                    (request.user_id, tombstone["event_id"], tombstone["source_hash"],
                     json.dumps(tombstone["quote_hashes"]), request.request_id, now))
                db.execute("UPDATE turns SET forgotten=1 WHERE event_id=?",
                           (tombstone["event_id"],))
            db.execute(
                "INSERT INTO user_epochs(user_id,memory_epoch) VALUES(?,1) "
                "ON CONFLICT(user_id) DO UPDATE SET memory_epoch=memory_epoch+1",
                (request.user_id,))
            epoch = db.execute("SELECT memory_epoch FROM user_epochs WHERE user_id=?",
                               (request.user_id,)).fetchone()[0]
            result = {
                "accepted": True,
                "status": "forgotten",
                "scope": "server-source",
                "user_id": request.user_id,
                "memory_epoch": epoch,
                "forgotten_event_ids": list(request.event_ids),
                "tombstones": tombstones,
                "local_archive_handled": False,
            }
            db.execute(
                "INSERT INTO forget_requests(request_id,user_id,body_hash,event_ids,result,"
                "created_at) VALUES(?,?,?,?,?,?)",
                (request.request_id, request.user_id, body_hash,
                 json.dumps(list(request.event_ids)), json.dumps(result), now))
        return result

    @staticmethod
    def _idempotent_result(raw) -> dict:
        """Strictly load a stored forget response; fail closed on corruption."""
        try:
            value = json.loads(raw) if raw else None
        except (json.JSONDecodeError, TypeError, ValueError):
            value = None
        required = ("accepted", "status", "user_id", "forgotten_event_ids", "tombstones")
        if (not isinstance(value, dict) or any(key not in value for key in required)
                or value.get("accepted") is not True or value.get("status") != "forgotten"
                or type(value.get("memory_epoch")) is not int or value["memory_epoch"] < 1
                or not isinstance(value.get("forgotten_event_ids"), list)
                or not isinstance(value.get("tombstones"), list)):
            raise ForgetError("corrupt_result", 500, "forget state unavailable")
        return value

    def _quote_hashes(self, db, event_id: str, text: str) -> list:
        row = db.execute("SELECT plan FROM turns WHERE event_id=?", (event_id,)).fetchone()
        plan = _loads(row[0], None) if row else None
        quotes = []
        if isinstance(plan, dict) and isinstance(plan.get("facts"), list):
            for entry in plan["facts"]:
                if not isinstance(entry, dict):
                    continue
                quote = entry.get("quote")
                # Only hash a plan quote that is verbatim in the target original.
                # A tampered/partial plan quote never mints a tombstone hash.
                if isinstance(quote, str) and quote and quote in text:
                    quotes.append(quote)
        if not quotes:
            # No trustworthy plan quotes: derive complete original source spans.
            quotes = [quote for _, _, quote in quality.source_spans(text)]
        # A legacy proposal may quote only a name/number. Also suppress its
        # complete original sentence, so replay under a new ID cannot expand
        # that fragment back into a trusted preference.
        complete = [span for _, _, span in quality.source_spans(text)
                    if any(quote in span for quote in quotes)]
        return sorted({sha256_text(quote) for quote in quotes + complete if quote})

    # ---- matching / suppression -----------------------------------------
    def match(self, user_id: str, event_id: str, text: str, db=None) -> Optional[dict]:
        if not isinstance(user_id, str) or not isinstance(event_id, str):
            return None
        rows = self._tombstones(user_id, db=db)
        for t_event, source_hash, quote_hashes in rows:
            if t_event == event_id:
                return {"event_id": t_event, "source_hash": source_hash,
                        "quote_hashes": quote_hashes}
        source_hash = sha256_text(text) if isinstance(text, str) else None
        hashes = sentence_hashes(text)
        for t_event, t_source, t_quotes in rows:
            if source_hash is not None and t_source == source_hash:
                return {"event_id": t_event, "source_hash": t_source,
                        "quote_hashes": t_quotes}
        for t_event, t_source, t_quotes in rows:
            # ANY complete original forgotten sentence hash matching holds the
            # ENTIRE turn. This conservatively prevents resurrecting one
            # forgotten sentence under a new id, or a mixed forgotten+fresh
            # archive record, as a silently trusted partial.
            if hashes and (hashes & set(t_quotes)):
                return {"event_id": t_event, "source_hash": t_source,
                        "quote_hashes": t_quotes}
        return None

    def _tombstones(self, user_id: str, db=None) -> list:
        query = ("SELECT event_id,source_hash,quote_hashes FROM tombstones "
                 "WHERE user_id=? ORDER BY created_at,event_id")
        if db is not None:
            rows = db.execute(query, (user_id,)).fetchall()
        else:
            with self._connect() as own:
                rows = own.execute(query, (user_id,)).fetchall()
        result = []
        for event_id, source_hash, quote_json in rows:
            quotes = _loads(quote_json, [])
            if not isinstance(quotes, list):
                quotes = []
            result.append((event_id, source_hash, [q for q in quotes if isinstance(q, str)]))
        return result

    def record_suppressed(self, user_id: str, event_id: str, text: str,
                          matched: Optional[dict] = None, db=None) -> None:
        """Durably record a replay/suppressed event without re-extracting.

        When ``db`` is supplied it must already be inside an open write
        transaction; reusing it avoids opening a second writer (self-deadlock).
        """
        if matched is None:
            matched = {"source_hash": sha256_text(text) if isinstance(text, str) else "",
                       "quote_hashes": sorted(sentence_hashes(text))}

        def write(conn) -> None:
            conn.execute(
                "INSERT OR IGNORE INTO tombstones(user_id,event_id,source_hash,"
                "quote_hashes,request_id,created_at) VALUES(?,?,?,?,?,?)",
                (user_id, event_id, matched["source_hash"],
                 json.dumps(matched["quote_hashes"]), "archive-replay", time.time()))
            conn.execute("UPDATE turns SET forgotten=1 WHERE event_id=?", (event_id,))

        if db is not None:
            write(db)
            return
        with self._connect() as own:
            own.execute("BEGIN IMMEDIATE")
            write(own)

    # ---- safe operator views --------------------------------------------
    def epoch(self, user_id: str) -> int:
        with self._connect() as db:
            row = db.execute("SELECT memory_epoch FROM user_epochs WHERE user_id=?",
                             (user_id,)).fetchone()
        return row[0] if row else 0

    def forgotten_count(self) -> int:
        with self._connect() as db:
            return db.execute("SELECT count(*) FROM turns WHERE forgotten=1").fetchone()[0]

    def controls(self, user_id: str) -> dict:
        tombstones = []
        for event_id, source_hash, quote_hashes in self._tombstones(user_id):
            tombstones.append({"event_id": event_id, "source_hash": source_hash,
                               "quote_hashes": quote_hashes})
        return {
            "user_id": user_id,
            "memory_epoch": self.epoch(user_id),
            "forgotten_event_ids": [t["event_id"] for t in tombstones],
            "tombstones": tombstones,
            "local_archive_handled": False,
        }
