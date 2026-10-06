"""Loopback, authenticated Mem0 OSS service with durable ingestion receipts.

No cloud Mem0 account is used. Chinese/English embeddings run locally. The
configured extraction LLM is the existing loopback Kimi shim (remote inference).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib.metadata
import json
import os
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


class Mem0Engine:
    def __init__(self, state_dir: Path):
        from mem0 import Memory
        from mem0.llms.openai import OpenAILLM

        class KimiExtractionLLM(OpenAILLM):
            def generate_response(self, messages, response_format=None, tools=None, tool_choice="auto", **kwargs):
                # Kimi coding API constrains sampling differently in thinking and
                # non-thinking modes. Fact extraction needs bounded JSON, not CoT.
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
                return super().generate_response(messages, response_format, tools, tool_choice, **kwargs)

        self.version = importlib.metadata.version("mem0ai")
        self.embedding_model = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
        self.lock = threading.RLock()
        self.memory = Memory.from_config({
            "llm": {"provider": "openai", "config": {
                "model": os.environ.get("MEMORY_LLM_MODEL", "kimi-k3"),
                "openai_base_url": os.environ.get("MEMORY_LLM_URL", "http://127.0.0.1:4323/v1"),
                "api_key": "loopback-shim",
                "temperature": 0.6,
                "top_p": 0.95,
                "max_tokens": 1500,
            }},
            "embedder": {"provider": "fastembed", "config": {"model": self.embedding_model}},
            "vector_store": {"provider": "qdrant", "config": {
                "collection_name": "personal_ai_os",
                "path": str(state_dir / "vectors"),
                "embedding_model_dims": 384,
            }},
            "history_db_path": str(state_dir / "history.sqlite"),
            "custom_instructions": (
                "Extract durable user preferences, goals, project decisions and factual details "
                "ONLY from the user's own statements. Preserve Chinese facts in Chinese. "
                "Do not invent information or memorize assistant guesses, API keys, tokens or passwords. "
                "New user corrections supersede old facts. Follow the required extraction schema."
            ),
        })
        self.memory.llm = KimiExtractionLLM(self.memory.llm.config)
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

    def add(self, turn: Turn):
        # Assistant messages remain in the local conversation archive; do not
        # convert hallucinated assistant claims into authoritative long-term facts.
        if turn.role != "user":
            return
        self.memory.add([{"role": "user", "content": turn.text}],
                        user_id=turn.user_id,
                        metadata={"event_id": turn.event_id, "source": turn.source})

    def search(self, query: Search):
        found = self.memory.search(query.query, filters={"user_id": query.user_id}, top_k=query.limit)
        entries = found.get("results", []) if isinstance(found, dict) else found
        return [{"id": row["id"], "memory": row["memory"], "score": row.get("score")}
                for row in entries if isinstance(row, dict) and isinstance(row.get("memory"), str)]


class MemoryService:
    def __init__(self, state_dir: Path, engine):
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
        self.processing_lock = threading.Lock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS turns(
                event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0, error_kind TEXT, created_at REAL NOT NULL)""")
        self.db_file.chmod(0o600)

    def connect(self):
        return sqlite3.connect(self.db_file, timeout=5)

    def enqueue(self, turn: Turn):
        payload = json.dumps(turn.model_dump(), sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(payload.encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT digest,status FROM turns WHERE event_id=?", (turn.event_id,)).fetchone()
            if previous:
                if previous[0] != digest:
                    raise HTTPException(409, "event_id already used for different content")
                return {"accepted": True, "replay": True, "status": previous[1]}
            db.execute("INSERT INTO turns(event_id,payload,digest,created_at) VALUES(?,?,?,?)",
                       (turn.event_id, payload, digest, time.time()))
        return {"accepted": True, "replay": False, "status": "pending"}

    def process_one(self):
        # A single ingestion owner; errors are retried durably after restart.
        with self.processing_lock:
            with self.connect() as db:
                row = db.execute("SELECT event_id,payload,attempts FROM turns WHERE status='pending' AND retry_at<=? ORDER BY created_at LIMIT 1", (time.time(),)).fetchone()
            if not row:
                return False
            event_id, payload, attempts = row
            try:
                self.engine.add(Turn.model_validate_json(payload))
            except Exception as error:
                # Never persist provider error text: it can contain secrets/URLs.
                with self.connect() as db:
                    db.execute("UPDATE turns SET attempts=?,retry_at=?,error_kind=? WHERE event_id=?",
                               (attempts + 1, time.time() + min(300, 2 ** min(attempts + 1, 8)), type(error).__name__, event_id))
                return False
            with self.connect() as db:
                db.execute("UPDATE turns SET status='done',error_kind=NULL WHERE event_id=?", (event_id,))
            return True

    def health(self):
        with self.connect() as db:
            counts = dict(db.execute("SELECT status,count(*) FROM turns GROUP BY status"))
            retries = db.execute("SELECT count(*) FROM turns WHERE status='pending' AND attempts>0").fetchone()[0]
        return {"status": "ok", "service": "personal-ai-os-mem0", "engine": "mem0-oss",
                "version": self.engine.version, "embedding_model": self.engine.embedding_model,
                "storage": "local-qdrant+sqlite", "ingestion": {"pending": counts.get("pending", 0), "done": counts.get("done", 0), "retrying": retries}}


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

    @app.post("/v1/search")
    def search(query: Search, authorization: str | None = Header(default=None)):
        authorize(authorization)
        try:
            return {"results": app.state.memory.engine.search(query)}
        except Exception:
            raise HTTPException(503, "memory retrieval temporarily unavailable") from None

    return app


app = create_app()
