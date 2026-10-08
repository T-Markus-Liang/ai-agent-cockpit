"""Loopback, authenticated Mem0 OSS service with durable ingestion receipts.

No cloud Mem0 account is used. Chinese/English embeddings run locally. The
default trusted-memory preparation is deterministic ORIGINAL sentence/paragraph
selection with a bounded Noul (Jev) eligibility/completeness check; it makes
ZERO generative extraction calls. Kimi remains the main chat model and Mem0
remains the vector store. The dormant loopback LLM config is only needed for the
SDK to initialize, and ``infer=False`` performs no LLM calls.

An explicitly injected extractor is a small test/contract adapter for
malformed-proposal and legacy-plan negative tests; there is no default Kimi
fallback path. Trusted facts are validated ORIGINAL span quotes (fact == quote),
never model rewrites. Preparation (``Mem0Engine.prepare``) and storage
(``Mem0Engine.store``) are separate: the prepared, versioned plan is persisted
before any vector effect, so a crash or store failure can be retried
idempotently from the same spans.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib.metadata
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

os.environ.setdefault("MEM0_TELEMETRY", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, StrictStr

from . import lifecycle, quality

DEFAULT_STATE_DIR = Path.home() / ".local/state/personal-ai-os/mem0"


class Turn(BaseModel):
    event_id: StrictStr = Field(min_length=1, max_length=200)
    user_id: StrictStr = Field(min_length=1, max_length=200)
    role: Literal["user", "assistant"]
    text: StrictStr = Field(min_length=1, max_length=100_000)
    source: StrictStr = Field(default="wechat", max_length=100)


class Search(BaseModel):
    user_id: StrictStr = Field(min_length=1, max_length=200)
    query: StrictStr = Field(min_length=1, max_length=8000)
    limit: int = Field(default=5, ge=1, le=10)


class StatusQuery(BaseModel):
    event_id: StrictStr = Field(min_length=1, max_length=200)
    user_id: StrictStr = Field(min_length=1, max_length=200)


class Mem0Engine:
    def __init__(self, state_dir: Path | None = None, *, memory=None, extractor=None,
                 evaluator=None, quality_config: quality.QualityConfig | None = None,
                 version: str | None = None):
        self.quality = quality_config or quality.QualityConfig.from_env()
        self.evaluator = evaluator if evaluator is not None else quality.JevEvaluator(
            timeout=self.quality.jev_timeout)
        self.embedding_model = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
        self.lock = threading.RLock()
        if memory is not None:
            self.memory = memory
            self.version = version or "injected"
        else:
            self._init_memory(state_dir)
            self.version = version or importlib.metadata.version("mem0ai")
        # ``extractor is None`` is the production default: deterministic source
        # spans + Noul selection. An injected extractor is a test/contract
        # adapter for malformed-proposal and legacy-plan negative tests only.
        self.extractor = extractor
        self.extraction_mode = (
            quality.EXTRACTION_MODE_EXTRACTOR if extractor is not None
            else quality.EXTRACTION_MODE_SOURCE_SPANS)

    def _init_memory(self, state_dir: Path):
        from mem0 import Memory

        # Dormant loopback LLM config: the Mem0 SDK needs a configured LLM to
        # initialize, but every default store uses infer=False, so no LLM call
        # is ever made. This is not a generative extraction path.
        self.memory = Memory.from_config({
            "llm": {"provider": "openai", "config": {
                "model": os.environ.get("MEMORY_LLM_MODEL", "kimi-k3"),
                "openai_base_url": os.environ.get("MEMORY_LLM_URL", "http://127.0.0.1:4323/v1"),
                "api_key": "loopback-shim",
            }},
            "embedder": {"provider": "fastembed", "config": {"model": self.embedding_model}},
            "vector_store": {"provider": "qdrant", "config": {
                "collection_name": "personal_ai_os",
                "path": str(state_dir / "vectors"),
                "embedding_model_dims": 384,
            }},
            "history_db_path": str(state_dir / "history.sqlite"),
        })

        class LockedStore:
            def __init__(self, store, lock):
                self.store, self.lock = store, lock

            def __getattr__(self, name):
                attribute = getattr(self.store, name)
                if not callable(attribute):
                    return attribute

                def call(*args, **kwargs):
                    with self.lock:
                        return attribute(*args, **kwargs)
                return call
        # Serialize short local storage operations, not the remote LLM call.
        # Recall must remain available while another turn is being extracted.
        self.memory.vector_store = LockedStore(self.memory.vector_store, self.lock)
        if getattr(self.memory, "entity_store", None) is not None:
            self.memory._entity_store = LockedStore(self.memory.entity_store, self.lock)

    # ---- preparation ------------------------------------------------------
    def _plan(self, turn: Turn, status: str, facts, error_kind=None, semantic=None) -> dict:
        return {
            "event_id": turn.event_id,
            "user_id": turn.user_id,
            "role": turn.role,
            "source": turn.source,
            "extraction_version": self.quality.extraction_version,
            "extraction_mode": self.extraction_mode,
            "validation_status": status,
            "source_digest": hashlib.sha256(turn.text.encode()).hexdigest(),
            "text_chars": len(turn.text),
            "facts": [fact.to_dict() for fact in facts],
            "error_kind": error_kind,
            "quality": {
                "semantic": semantic or {},
                "fact_count": len(facts),
                "no_durable_facts": status == "no_facts",
            },
        }

    def prepare(self, turn: Turn) -> dict:
        """Return a validated, versioned plan. No vector effects occur here."""
        if turn.role != "user":
            # Assistant turns are archived by the caller but never trusted facts.
            return self._plan(turn, "assistant_archived", [])
        text = turn.text
        # Reject obvious credentials BEFORE any evaluator sees them.
        if quality.contains_credential(text):
            return self._plan(turn, "needs_review", [], error_kind="credential_like")
        # Oversized input is retained as needs_review, never silently truncated.
        if len(text) > self.quality.max_text_chars:
            return self._plan(turn, "needs_review", [], error_kind="bounds_exceeded")
        if self.extractor is not None:
            return self._prepare_from_proposals(turn)
        return self._prepare_from_source_spans(turn)

    def _prepare_from_proposals(self, turn: Turn) -> dict:
        """Injected-extractor contract adapter (legacy/rewritten proposals).

        Kept for malformed-proposal and legacy-plan negative tests. This is the
        only path that requires a faithfulness check, because a proposal may
        differ from its source quote. There is no default fallback here.
        """
        text = turn.text
        parsed = quality.parse_extraction(self.extractor(text))
        # Bound the fact count too; oversized extraction is retained, not truncated.
        if len(parsed["facts"]) > self.quality.max_facts:
            return self._plan(turn, "needs_review", [], error_kind="bounds_exceeded")
        facts, no_durable = quality.validate_extraction(parsed, text, self.quality)
        questions = quality.build_semantic_questions(facts, no_durable)
        state = quality.semantic_state(text, facts, no_durable)
        semantic = quality.run_semantic_check(
            self.evaluator, state, questions, self.quality.semantic_threshold)
        if no_durable:
            return self._plan(turn, "no_facts", [], semantic=semantic)
        return self._plan(turn, "validated", facts, semantic=semantic)

    def _prepare_from_source_spans(self, turn: Turn) -> dict:
        """Deterministic default: select original spans with bounded Noul checks.

        One candidate batch (eligibility per span) and, only when needed, one
        completeness/no-facts batch: at most two bounded evaluator calls. A
        selected fact is the ORIGINAL complete span (fact == quote); no
        rewriting and no faithfulness question are involved.
        """
        text = turn.text
        spans = quality.source_spans(text)
        threshold = self.quality.semantic_threshold
        # Bound the candidate count; excess input is retained, never truncated.
        if len(spans) > self.quality.max_facts:
            return self._plan(turn, "needs_review", [], error_kind="bounds_exceeded")
        selected: list = []
        relevance: dict = {}
        if spans:
            questions = quality.build_selection_questions(spans)
            state = quality.selection_state(text, spans)
            evidence, selected_ids = quality.run_selection_check(
                self.evaluator, state, questions, threshold)
            chosen = set(selected_ids)
            for index, span in enumerate(spans):
                answer_id = f"eligible_{index}"
                if answer_id in chosen:
                    selected.append(span)
                    relevance[f"relevance_{len(selected) - 1}"] = evidence[answer_id]
        if not selected:
            # An empty selection requires an affirmative no-durable-facts answer.
            question = quality.build_no_facts_question()
            evidence, affirmed = quality.run_selection_check(
                self.evaluator, quality.no_facts_state(text), question, threshold)
            if not affirmed:
                raise quality.EvaluatorError("semantic_not_affirmed")
            return self._plan(turn, "no_facts", [], semantic=evidence)
        question = quality.build_completeness_question()
        completeness, affirmed = quality.run_selection_check(
            self.evaluator, quality.completeness_state(text, selected), question, threshold)
        if not affirmed:
            raise quality.EvaluatorError("semantic_not_affirmed")
        facts = [
            quality.ValidatedFact(fact=span[2], quote=span[2], start=span[0], end=span[1])
            for span in selected
        ]
        semantic = dict(relevance)
        semantic.update(completeness)
        return self._plan(turn, "validated", facts, semantic=semantic)

    # ---- storage ----------------------------------------------------------
    def _stored_id(self, result, quote: str):
        rows = result.get("results") if isinstance(result, dict) else result
        if not isinstance(rows, list) or not rows:
            return None
        row = rows[0]
        if not isinstance(row, dict):
            return None
        memory_id = row.get("id")
        if not isinstance(memory_id, str) or not memory_id:
            return None
        if row.get("memory") != quote:
            return None
        return memory_id

    def _lookup_span(self, turn: Turn, plan: dict, fact: dict):
        span_key = f"{plan['source_digest']}:{fact['start']}:{fact['end']}"
        found = self.memory.get_all(
            filters={"user_id": turn.user_id, "event_id": turn.event_id, "span_key": span_key},
            top_k=5,
        )
        rows = found.get("results") if isinstance(found, dict) else found
        if not isinstance(rows, list):
            return None
        for row in rows:
            if not isinstance(row, dict):
                continue
            metadata = row.get("metadata") or {}
            # A metadata flag alone is insufficient: re-check the full binding
            # (quote, event, digest, version, offsets) before reusing a record.
            if metadata.get("span_key") != span_key:
                continue
            if metadata.get("validation_status") != "validated":
                continue
            if metadata.get("event_id") != turn.event_id:
                continue
            if metadata.get("source_digest") != plan.get("source_digest"):
                continue
            if metadata.get("extraction_version") != plan.get("extraction_version"):
                continue
            if metadata.get("source_start") != fact["start"] or metadata.get("source_end") != fact["end"]:
                continue
            if row.get("memory") != fact["quote"]:
                continue
            memory_id = row.get("id")
            return memory_id if isinstance(memory_id, str) and memory_id else None
        return None

    @staticmethod
    def _valid_ids(ids) -> bool:
        if not isinstance(ids, list):
            return False
        if any(not isinstance(memory_id, str) or not memory_id for memory_id in ids):
            return False
        return len(set(ids)) == len(ids)

    def store(self, turn: Turn, plan: dict) -> dict:
        """Persist only the validated original quotes, idempotently via Mem0.

        The ENTIRE plan is revalidated against the current turn (identity,
        digest, version, spans and semantic evidence) before any vector effect.
        """
        if not isinstance(plan, dict):
            return {"ok": False, "reason": "missing_plan", "stored": [], "reused": []}
        status = plan.get("validation_status")
        if status in ("assistant_archived", "no_facts"):
            if plan.get("event_id") != turn.event_id or plan.get("user_id") != turn.user_id:
                return {"ok": False, "reason": "invalid_plan", "stored": [], "reused": []}
            return {"ok": True, "stored": [], "reused": [], "validation_status": status}
        try:
            facts = quality.validate_plan(turn, plan, self.quality)
        except quality.QualityError as error:
            return {"ok": False, "reason": error.kind, "stored": [], "reused": []}
        stored, reused = [], []
        for fact in facts:
            existing = self._lookup_span(turn, plan, fact.to_dict())  # // ponytail: reuse Mem0 span records on retry, no second vector store
            if existing:
                reused.append(existing)
                continue
            span_key = f"{plan['source_digest']}:{fact.start}:{fact.end}"
            metadata = {
                "event_id": turn.event_id,
                "source": turn.source,
                "source_digest": plan["source_digest"],
                "source_start": fact.start,
                "source_end": fact.end,
                "span_key": span_key,
                "extraction_version": plan["extraction_version"],
                "validation_status": "validated",
            }
            result = self.memory.add(
                [{"role": "user", "content": fact.quote}],
                user_id=turn.user_id,
                metadata=metadata,
                infer=False,
            )
            memory_id = self._stored_id(result, fact.quote)
            if memory_id is None:
                return {"ok": False, "reason": "store_binding_failed", "stored": stored, "reused": reused}
            stored.append(memory_id)
        if (len(stored) + len(reused) != len(facts)
                or not self._valid_ids(stored) or not self._valid_ids(reused)):
            return {"ok": False, "reason": "store_incomplete", "stored": stored, "reused": reused}
        return {"ok": True, "stored": stored, "reused": reused, "count": len(facts),
                "validation_status": "validated"}

    def add(self, turn: Turn):
        """Compatibility/convenience wrapper over prepare+store, not a second algorithm."""
        plan = self.prepare(turn)
        if plan.get("validation_status") == "validated":
            return self.store(turn, plan)
        return {"ok": True, "stored": [], "reused": [],
                "validation_status": plan.get("validation_status")}

    # ---- recall -----------------------------------------------------------
    def search(self, query: Search):
        found = self.memory.search(query.query, filters={"user_id": query.user_id}, top_k=query.limit)
        entries = found.get("results", []) if isinstance(found, dict) else found
        results = []
        for row in entries:
            if not isinstance(row, dict):
                continue
            metadata = row.get("metadata") or {}
            # Only source-backed, validated quotes are recallable. Legacy, pending
            # or needs_review receipts never return here.
            if metadata.get("validation_status") != "validated":
                continue
            memory = row.get("memory")
            if not isinstance(memory, str):
                continue
            results.append({"id": row.get("id"), "memory": memory, "score": row.get("score")})
        return results


class MemoryService:
    def __init__(self, state_dir: Path, engine, *, max_attempts: int | None = None):
        self.state_dir = state_dir
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        state_dir.chmod(0o700)
        self.token_file = state_dir / "api-token"
        if not self.token_file.exists():
            with self.token_file.open("x") as handle:
                handle.write(secrets.token_urlsafe(32))
        self.token_file.chmod(0o600)
        self.token = self.token_file.read_text().strip()
        if not self.token:
            raise RuntimeError("memory API token is empty")
        self.db_file = state_dir / "ingest.sqlite"
        self.engine = engine
        configured = max_attempts if max_attempts is not None else getattr(
            getattr(engine, "quality", None), "max_attempts", quality.DEFAULT_MAX_ATTEMPTS)
        self.max_attempts = max(1, min(quality.MAX_ATTEMPTS_CEILING, int(configured)))
        self.processing_lock = threading.Lock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS turns(
                event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0, error_kind TEXT, created_at REAL NOT NULL)""")
            self._migrate(db)
            lifecycle.ensure_schema(db)
        self.db_file.chmod(0o600)
        self.forget_store = lifecycle.ForgetStore(self.connect)

    def connect(self):
        return sqlite3.connect(self.db_file, timeout=5)

    def _migrate(self, db):
        columns = {row[1] for row in db.execute("PRAGMA table_info(turns)")}
        additions = (
            ("plan", "TEXT"),
            ("validation_status", "TEXT"),
            ("extraction_version", "TEXT"),
            ("quality", "TEXT"),
            ("stored_ids", "TEXT"),
            ("forgotten", "INTEGER NOT NULL DEFAULT 0"),
        )
        for name, ddl in additions:
            if name not in columns:
                db.execute(f"ALTER TABLE turns ADD COLUMN {name} {ddl}")
        # Old done rows predate provenance; classify them explicitly, never as
        # accepted. Done rows from an older extraction version must not be
        # silently trusted as the current version either.
        current_version = getattr(getattr(self.engine, "quality", None), "extraction_version",
                                  quality.EXTRACTION_VERSION)
        db.execute("UPDATE turns SET validation_status='legacy_unverified' "
                   "WHERE status='done' AND validation_status IS NULL")
        db.execute("UPDATE turns SET validation_status='legacy_unverified' "
                   "WHERE status='done' AND validation_status='validated' "
                   "AND (extraction_version IS NULL OR extraction_version<>?)",
                   (current_version,))

    def enqueue(self, turn: Turn):
        payload = json.dumps(turn.model_dump(), sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(payload.encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT digest,status,validation_status,forgotten FROM turns WHERE event_id=?",
                (turn.event_id,)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise HTTPException(409, "event_id already used for different content")
                matched = self.forget_store.match(turn.user_id, turn.event_id, turn.text, db=db)
                if matched is not None:
                    self.forget_store.record_suppressed(turn.user_id, turn.event_id, turn.text, matched, db=db)
                forgotten = bool(previous[3]) or matched is not None
                status = "forgotten" if forgotten else previous[1]
                return {"accepted": True, "replay": True, "status": status,
                        "processing": self._processing(status, forgotten),
                        "validation_status": previous[2], "forgotten": forgotten}
            # Atomic tombstone admission on the SAME writer connection: a NEW
            # archive replay of forgotten source is suppressed before any
            # background processing and needs no second writer (which would
            # self-deadlock while this BEGIN IMMEDIATE holds the lock).
            matched = self.forget_store.match(turn.user_id, turn.event_id, turn.text, db=db)
            if matched is not None:
                db.execute("INSERT INTO turns(event_id,payload,digest,created_at) VALUES(?,?,?,?)",
                           (turn.event_id, payload, digest, time.time()))
                self.forget_store.record_suppressed(
                    turn.user_id, turn.event_id, turn.text, matched, db=db)
                return {"accepted": True, "replay": True, "status": "forgotten",
                        "processing": "forgotten", "validation_status": None,
                        "forgotten": True}
            db.execute("INSERT INTO turns(event_id,payload,digest,created_at) VALUES(?,?,?,?)",
                       (turn.event_id, payload, digest, time.time()))
        return {"accepted": True, "replay": False, "status": "pending",
                "processing": "queued", "validation_status": None, "forgotten": False}

    @staticmethod
    def _processing(status: str, forgotten: bool = False) -> str:
        if forgotten or status == "forgotten":
            return "forgotten"
        if status == "done":
            return "processed"
        if status == "needs_review":
            return "needs_review"
        return "queued"

    def _save_plan(self, event_id: str, plan: dict):
        with self.connect() as db:
            db.execute(
                "UPDATE turns SET plan=?,validation_status=?,extraction_version=?,quality=? "
                "WHERE event_id=? AND forgotten=0",
                (json.dumps(plan, ensure_ascii=False), plan.get("validation_status"),
                 plan.get("extraction_version"), json.dumps(plan.get("quality") or {}, ensure_ascii=False),
                 event_id))

    def _finish(self, event_id: str, status: str, plan: dict, stored_ids=None, reused=None):
        error_kind = plan.get("error_kind") if status == "needs_review" else None
        with self.connect() as db:
            db.execute(
                "UPDATE turns SET status=?,error_kind=?,validation_status=?,extraction_version=?,"
                "quality=?,plan=?,stored_ids=? WHERE event_id=? AND forgotten=0",
                (status, error_kind, plan.get("validation_status"), plan.get("extraction_version"),
                 json.dumps(plan.get("quality") or {}, ensure_ascii=False),
                 json.dumps(plan, ensure_ascii=False),
                 json.dumps({"stored": stored_ids or [], "reused": reused or []}), event_id))

    @classmethod
    def _safe_kind(cls, error: Exception) -> str:
        """Reduce any error to a finite, sanitized token (never provider text)."""
        if isinstance(error, quality.QualityError):
            candidate = error.kind
        else:
            candidate = type(error).__name__
        if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_]{1,64}", candidate):
            return candidate
        return "internal_error"

    def _fail(self, event_id: str, attempts: int, error: Exception) -> bool:
        """Record a bounded retry. Returns True when the receipt is now terminal."""
        # Never persist provider error text: it can contain secrets/URLs.
        kind = self._safe_kind(error)
        attempts += 1
        terminal = attempts >= self.max_attempts
        status = "needs_review" if terminal else "pending"
        retry_at = 0.0 if terminal else time.time() + min(300, 2 ** min(attempts, 8))
        with self.connect() as db:
            if terminal:
                db.execute("UPDATE turns SET status=?,attempts=?,retry_at=?,error_kind=?,"
                           "validation_status='needs_review' WHERE event_id=? AND forgotten=0",
                           (status, attempts, retry_at, kind, event_id))
            else:
                db.execute("UPDATE turns SET status=?,attempts=?,retry_at=?,error_kind=? "
                           "WHERE event_id=? AND forgotten=0",
                           (status, attempts, retry_at, kind, event_id))
        return terminal

    def process_one(self, *, event_id: str | None = None):
        # A single ingestion owner; errors are retried durably after restart.
        # Parse/validation failures are captured here so a corrupt payload or
        # plan cannot kill the background worker or stop unrelated ingestion.
        # A trusted copy-migration coordinator can select one admitted receipt;
        # the normal worker still owns scheduling and uses the default queue.
        if event_id is not None and (not isinstance(event_id, str) or not event_id.strip() or len(event_id) > 200):
            raise quality.QualityError("invalid_event_selector")
        with self.processing_lock:
            with self.connect() as db:
                selector = "" if event_id is None else " AND event_id=?"
                params = (time.time(),) if event_id is None else (time.time(), event_id)
                row = db.execute(
                    "SELECT event_id,payload,attempts,plan FROM turns "
                    "WHERE status='pending' AND retry_at<=? AND forgotten=0 "
                    + selector + " ORDER BY created_at LIMIT 1", params).fetchone()
            if not row:
                return False
            event_id, payload, attempts, plan_json = row
            try:
                turn = Turn.model_validate_json(payload)
            except Exception:  # noqa: BLE001 - malformed persisted payload
                return self._fail(event_id, attempts, quality.QualityError("invalid_payload"))
            # Admission: a tombstoned event, or an archive replay of forgotten
            # source, is suppressed before any preparation or vector effect.
            if self._suppress_if_forgotten(event_id, turn):
                return True
            if plan_json:
                # Preparation already persisted: reuse the same quotes instead of
                # re-inferring, which keeps retries idempotent across restarts.
                try:
                    plan = json.loads(plan_json)
                except (json.JSONDecodeError, TypeError, ValueError):
                    return self._fail(event_id, attempts, quality.QualityError("invalid_plan"))
                if not isinstance(plan, dict):
                    return self._fail(event_id, attempts, quality.QualityError("invalid_plan"))
            else:
                try:
                    plan = self.engine.prepare(turn)
                except Exception as error:
                    return self._fail(event_id, attempts, error)
                if not isinstance(plan, dict):
                    return self._fail(event_id, attempts, quality.QualityError("invalid_plan"))
                # Forget may have committed while preparation was in flight.
                if self._suppress_if_forgotten(event_id, turn):
                    return True
                self._save_plan(event_id, plan)
            status = plan.get("validation_status")
            if status in ("needs_review", "rejected"):
                self._finish(event_id, "needs_review", plan)
                return True
            if status in ("no_facts", "assistant_archived"):
                try:
                    quality.validate_plan(turn, plan, getattr(self.engine, "quality", None) or quality.QualityConfig())
                except quality.QualityError as error:
                    return self._fail(event_id, attempts, error)
                self._finish(event_id, "done", plan)
                return True
            if status != "validated":
                return self._fail(event_id, attempts, quality.QualityError("invalid_plan"))
            # Re-check immediately before the vector effect.
            if self._suppress_if_forgotten(event_id, turn):
                return True
            try:
                result = self.engine.store(turn, plan)
            except Exception as error:
                return self._fail(event_id, attempts, error)
            # Final settlement re-check: a raced vector write may exist
            # physically, but it is never promoted to a trusted/done receipt.
            if self._suppress_if_forgotten(event_id, turn):
                return True
            if not isinstance(result, dict) or not result.get("ok"):
                return self._fail(event_id, attempts, quality.QualityError("store_incomplete"))
            planned = len(plan.get("facts") or [])
            stored_ids = result.get("stored") or []
            reused_ids = result.get("reused") or []
            if not isinstance(stored_ids, list) or not isinstance(reused_ids, list):
                return self._fail(event_id, attempts, quality.QualityError("store_incomplete"))
            if (planned == 0 or len(stored_ids) + len(reused_ids) != planned
                    or not Mem0Engine._valid_ids(stored_ids + reused_ids)):
                return self._fail(event_id, attempts, quality.QualityError("store_incomplete"))
            self._finish(event_id, "done", plan, stored_ids, reused_ids)
            return True

    def _suppress_if_forgotten(self, event_id: str, turn: Turn) -> bool:
        """Return True (and durably suppress) when ``turn`` is tombstoned.

        Called at admission, after prepare, before the vector effect and at
        final settlement. Suppression never reuses a stale plan and never
        re-extracts; it records a replay tombstone for the new event id.
        """
        matched = self.forget_store.match(turn.user_id, event_id, turn.text)
        with self.connect() as db:
            row = db.execute("SELECT forgotten FROM turns WHERE event_id=?",
                             (event_id,)).fetchone()
        already = bool(row[0]) if row else False
        if matched is None and not already:
            return False
        if matched is not None:
            self.forget_store.record_suppressed(turn.user_id, event_id, turn.text, matched)
        else:
            with self.connect() as db:
                db.execute("UPDATE turns SET forgotten=1 WHERE event_id=?", (event_id,))
        return True

    def _trusted_receipts(self, user_id: str) -> dict:
        """Map vector IDs to validated receipts owned by ``user_id``.

        A receipt only counts when it is terminal ``done`` with a ``validated``
        plan that still passes full plan revalidation. Pending, needs_review,
        legacy and other users' receipts are excluded.
        """
        config = getattr(self.engine, "quality", None) or quality.QualityConfig()
        receipts = {}
        with self.connect() as db:
            rows = db.execute(
                "SELECT event_id,payload,plan,stored_ids FROM turns "
                "WHERE status='done' AND validation_status='validated' "
                "AND forgotten=0").fetchall()
        for event_id, payload, plan_json, stored_json in rows:
            try:
                payload_obj = json.loads(payload)
                plan = json.loads(plan_json) if plan_json else None
                stored = json.loads(stored_json) if stored_json else {}
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            if not isinstance(payload_obj, dict) or payload_obj.get("user_id") != user_id:
                continue
            if not isinstance(plan, dict):
                continue
            try:
                turn = Turn(**payload_obj)
                if turn.event_id != event_id:
                    continue
                facts = quality.validate_plan(turn, plan, config)
            except Exception:  # noqa: BLE001 - never trust a malformed receipt
                continue
            if not isinstance(stored, dict):
                continue
            stored_ids, reused_ids = stored.get("stored"), stored.get("reused")
            if not isinstance(stored_ids, list) or not isinstance(reused_ids, list):
                continue
            ids = stored_ids + reused_ids
            if len(ids) != len(facts) or not Mem0Engine._valid_ids(ids):
                continue
            # A duplicate source that was done (under another id) BEFORE a forget
            # must stop being trusted: consult current tombstones/hash matches,
            # not just this row's own ``forgotten`` flag.
            if self.forget_store.match(user_id, event_id, turn.text) is not None:
                continue
            for memory_id in ids:
                if isinstance(memory_id, str) and memory_id:
                    receipts[memory_id] = facts
        return receipts

    def search(self, query: Search):
        """Source-backed recall: vector candidates must match a final receipt."""
        epoch_before = self.forget_store.epoch(query.user_id)
        candidates = self.engine.search(query)
        if isinstance(candidates, dict):
            candidates = candidates.get("results", [])
        if not isinstance(candidates, list):
            return []
        receipts = self._trusted_receipts(query.user_id)
        results = []
        for row in candidates:
            if not isinstance(row, dict):
                continue
            memory_id = row.get("id")
            memory = row.get("memory")
            if not isinstance(memory_id, str) or not isinstance(memory, str):
                continue
            facts = receipts.get(memory_id)
            if facts is None:
                continue
            # Persisted original quote binding must match the vector content.
            if not any(fact.quote == memory for fact in facts):
                continue
            results.append({"id": memory_id, "memory": memory, "score": row.get("score")})
        # End-of-search epoch recheck: a forget committed while vectors/receipts
        # were being read must drop this now-stale result set.
        if self.forget_store.epoch(query.user_id) != epoch_before:
            return []
        return results

    def status(self, event_id: str, user_id: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT payload,status,attempts,validation_status,extraction_version,quality,"
                "error_kind,created_at,stored_ids,plan,forgotten FROM turns WHERE event_id=?",
                (event_id,)).fetchone()
        if not row:
            raise HTTPException(404, "unknown event")
        try:
            payload = json.loads(row[0])
        except (json.JSONDecodeError, TypeError, ValueError):
            raise HTTPException(404, "unknown event") from None
        if not isinstance(payload, dict) or payload.get("user_id") != user_id:
            # Do not reveal that another user's event exists.
            raise HTTPException(404, "unknown event")
        quality_info = json.loads(row[5]) if row[5] else {}
        stored = json.loads(row[8]) if row[8] else {"stored": [], "reused": []}
        try:
            plan_info = json.loads(row[9]) if row[9] else {}
        except (json.JSONDecodeError, TypeError, ValueError):
            plan_info = {}
        if not isinstance(plan_info, dict):
            plan_info = {}
        forgotten = bool(row[10]) or self.forget_store.match(user_id, event_id, payload.get("text")) is not None
        extraction_mode = plan_info.get("extraction_mode") or getattr(
            self.engine, "extraction_mode", None)
        reported_status = "forgotten" if forgotten else row[1]
        return {
            "event_id": event_id,
            "user_id": user_id,
            "status": reported_status,
            "processing": self._processing(reported_status, forgotten),
            "attempts": row[2],
            "validation_status": row[3],
            "extraction_version": row[4],
            "extraction_mode": extraction_mode,
            "quality": quality_info,
            "error_kind": row[6],
            "created_at": row[7],
            "stored_count": len(stored.get("stored", []) or []),
            "reused_count": len(stored.get("reused", []) or []),
            "forgotten": forgotten,
            "memory_epoch": self.forget_store.epoch(user_id),
            "trusted": (not forgotten) and row[3] == "validated" and row[1] == "done",
        }

    def health(self):
        with self.connect() as db:
            counts = dict(db.execute(
                "SELECT status,count(*) FROM turns WHERE forgotten=0 GROUP BY status"))
            quality_counts = dict(db.execute(
                "SELECT validation_status,count(*) FROM turns WHERE validation_status IS NOT NULL "
                "AND forgotten=0 GROUP BY validation_status"))
            retries = db.execute(
                "SELECT count(*) FROM turns WHERE status='pending' AND attempts>0 "
                "AND forgotten=0").fetchone()[0]
            forgotten = self.forget_store.forgotten_count()
        return {
            "status": "ok", "service": "personal-ai-os-mem0", "engine": "mem0-oss",
            "version": self.engine.version, "embedding_model": self.engine.embedding_model,
            "storage": "local-qdrant+sqlite",
            "extraction": {
                "mode": getattr(self.engine, "extraction_mode",
                                quality.EXTRACTION_MODE_SOURCE_SPANS),
                "version": getattr(getattr(self.engine, "quality", None), "extraction_version",
                                   quality.EXTRACTION_VERSION),
            },
            "ingestion": {
                "pending": counts.get("pending", 0),
                "done": counts.get("done", 0),
                "retrying": retries,
                "needs_review": counts.get("needs_review", 0),
                "forgotten": forgotten,
            },
            "quality": {
                "validated": quality_counts.get("validated", 0),
                "no_facts": quality_counts.get("no_facts", 0),
                "assistant_archived": quality_counts.get("assistant_archived", 0),
                "legacy_unverified": quality_counts.get("legacy_unverified", 0),
                "needs_review": quality_counts.get("needs_review", 0),
            },
            "max_attempts": self.max_attempts,
        }

    # ---- forgetting (server scope) ---------------------------------------
    def forget(self, request: lifecycle.ForgetRequest) -> dict:
        """Authenticated operator forget: durable tombstones, atomic all-or-nothing."""
        return self.forget_store.forget(request)

    def controls(self, user_id: str) -> dict:
        """Safe tombstone/epoch view for the future local-context coordinator."""
        return self.forget_store.controls(user_id)


def create_app(service=None, *, run_worker=True):
    @asynccontextmanager
    async def lifespan(app):
        if service is None:
            root = Path(os.environ.get("MEM0_STATE_DIR", str(DEFAULT_STATE_DIR)))
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            root.chmod(0o700)
            app.state.memory = MemoryService(root, Mem0Engine(root))
        else:
            app.state.memory = service

        async def worker():
            while True:
                await asyncio.to_thread(app.state.memory.process_one)
                await asyncio.sleep(0.2)
        task = asyncio.create_task(worker()) if run_worker else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    app = FastAPI(title="Personal AI OS — Mem0 OSS", lifespan=lifespan)

    def authorize(authorization):
        expected = "Bearer " + app.state.memory.token
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(401, "memory API authentication required")

    @app.get("/health")
    def health():
        return app.state.memory.health()

    @app.post("/v1/turns", status_code=202)
    def turns(turn: Turn, authorization: str | None = Header(default=None)):
        authorize(authorization)
        return app.state.memory.enqueue(turn)

    @app.post("/v1/status")
    def status(query: StatusQuery, authorization: str | None = Header(default=None)):
        authorize(authorization)
        return app.state.memory.status(query.event_id, query.user_id)

    @app.post("/v1/search")
    def search(query: Search, authorization: str | None = Header(default=None)):
        authorize(authorization)
        try:
            return {"results": app.state.memory.search(query)}
        except Exception:
            raise HTTPException(503, "memory retrieval temporarily unavailable") from None

    @app.post("/v1/forget")
    def forget(request: lifecycle.ForgetRequest, authorization: str | None = Header(default=None)):
        authorize(authorization)
        try:
            return app.state.memory.forget(request)
        except lifecycle.ForgetError as error:
            raise HTTPException(error.status_code, error.detail) from None

    @app.post("/v1/controls")
    def controls(query: lifecycle.ControlsQuery, authorization: str | None = Header(default=None)):
        authorize(authorization)
        return app.state.memory.controls(query.user_id)

    return app


app = create_app()
