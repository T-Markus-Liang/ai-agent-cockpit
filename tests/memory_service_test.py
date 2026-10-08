import hashlib
import json
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

from fastapi.testclient import TestClient
from services.memory import lifecycle, quality
from services.memory.service import Mem0Engine, MemoryService, Search, Turn, create_app

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_quality_fixture():
    return json.loads((FIXTURES / "memory-quality.json").read_text())


def digest_of(text):
    return hashlib.sha256(text.encode()).hexdigest()


def noul(probability=0.99):
    return {"type": "noul", "noul": probability}


def semantic_evidence(fact_count, no_durable=False, probability=0.99):
    evidence = {}
    for index in range(fact_count):
        evidence[f"faithful_{index}"] = noul(probability)
        evidence[f"relevance_{index}"] = noul(probability)
    if fact_count:
        evidence["retains_all_details"] = noul(probability)
    if no_durable:
        evidence["no_durable_facts"] = noul(probability)
    return evidence


def plan_dict(turn, status, facts=(), error_kind=None):
    fact_dicts = [dict(f) for f in facts]
    return {
        "event_id": turn.event_id, "user_id": turn.user_id, "role": turn.role,
        "source": turn.source, "extraction_version": "extraction-v2",
        "extraction_mode": "extractor_proposals",
        "validation_status": status, "source_digest": digest_of(turn.text),
        "text_chars": len(turn.text), "facts": fact_dicts,
        "error_kind": error_kind,
        "quality": {"semantic": semantic_evidence(len(fact_dicts), status == "no_facts"),
                    "fact_count": len(fact_dicts),
                    "no_durable_facts": status == "no_facts"},
    }


def extractor_for(pairs, no_durable=False, calls=None):
    def extract(text):
        if calls is not None:
            calls.append(text)
        return {"facts": [{"fact": fact, "source_quote": quote} for fact, quote in pairs],
                "no_durable_facts": no_durable}
    return extract


def make_config(**overrides):
    base = dict(max_text_chars=200, max_facts=5, semantic_threshold=0.90, max_attempts=3)
    base.update(overrides)
    return quality.QualityConfig(**base)


class FakeMem0:
    """In-memory stand-in for the Mem0 SDK; makes ZERO model calls."""

    def __init__(self):
        self.rows = []
        self.fail_add = False

    def add(self, messages, *, user_id=None, metadata=None, infer=False):
        if self.fail_add:
            raise RuntimeError("provider-credential-must-not-be-persisted")
        results = []
        for message in messages:
            memory_id = f"mem-{len(self.rows)}"
            row = {"id": memory_id, "memory": message["content"], "user_id": user_id,
                   "metadata": dict(metadata or {})}
            self.rows.append(row)
            results.append({"id": memory_id, "memory": message["content"], "event": "ADD"})
        return {"results": results}

    def get_all(self, *, filters=None, top_k=20):
        filters = filters or {}
        found = []
        for row in self.rows:
            if row["user_id"] != filters.get("user_id"):
                continue
            metadata = row["metadata"]
            if filters.get("event_id") and metadata.get("event_id") != filters["event_id"]:
                continue
            if filters.get("span_key") and metadata.get("span_key") != filters["span_key"]:
                continue
            found.append({"id": row["id"], "memory": row["memory"], "metadata": dict(metadata)})
            if len(found) >= top_k:
                break
        return {"results": found}

    def search(self, query, *, filters=None, top_k=20):
        filters = filters or {}
        found = [{"id": row["id"], "memory": row["memory"], "score": 1.0,
                  "metadata": dict(row["metadata"])}
                 for row in self.rows if row["user_id"] == filters.get("user_id")]
        return {"results": found[:top_k]}


class BadBindMem0(FakeMem0):
    def add(self, messages, *, user_id=None, metadata=None, infer=False):
        # Store returns a model rewrite instead of the original quote.
        return {"results": [{"id": "bound", "memory": "a model rewrite"}]}


class FakeEvaluator:
    def __init__(self, answers=None, error=None):
        self.answers = answers
        self.error = error
        self.calls = []

    def evaluate(self, state, questions):
        self.calls.append({"state": state, "questions": questions})
        if self.error is not None:
            raise self.error
        if callable(self.answers):
            return {"answers": self.answers(dict(questions))}
        if self.answers is None:
            return {"answers": {qid: noul() for qid in questions}}
        return {"answers": self.answers}


class FakeEngine:
    version = "test"
    embedding_model = "test-local"

    def __init__(self, config=None):
        self.quality = config or make_config()
        self.prepared = []
        self.store_calls = []
        self.rows = []
        self.prepare_hook = None
        self.store_hook = None
        self.search_hook = None

    def prepare(self, turn):
        self.prepared.append(turn.event_id)
        if self.prepare_hook is not None:
            return self.prepare_hook(turn)
        if turn.role != "user":
            return plan_dict(turn, "assistant_archived")
        return plan_dict(turn, "validated", [
            {"fact": "candidate", "quote": turn.text, "start": 0, "end": len(turn.text)}])

    def store(self, turn, plan):
        self.store_calls.append((turn.event_id, plan.get("validation_status")))
        if self.store_hook is not None:
            return self.store_hook(turn, plan)
        if plan.get("validation_status") != "validated":
            return {"ok": True, "stored": [], "reused": [],
                    "validation_status": plan.get("validation_status")}
        stored = []
        for fact in plan["facts"]:
            memory_id = f"mem-{len(self.rows)}"
            self.rows.append({"id": memory_id, "user_id": turn.user_id,
                              "event_id": turn.event_id, "memory": fact["quote"],
                              "validation_status": "validated"})
            stored.append(memory_id)
        return {"ok": True, "stored": stored, "reused": [], "validation_status": "validated"}

    def add(self, turn):
        plan = self.prepare(turn)
        return self.store(turn, plan)

    def search(self, query):
        if self.search_hook is not None:
            return self.search_hook(query)
        return [{"id": row["id"], "memory": row["memory"], "score": 1.0}
                for row in self.rows
                if row["user_id"] == query.user_id
                and row["validation_status"] == "validated"][:query.limit]


class ServiceTests(unittest.TestCase):
    def test_corrupt_no_facts_plan_does_not_silently_complete(self):
        self.post()
        turn = Turn(**self.payload())
        prepared = plan_dict(turn, "no_facts")
        prepared["quality"]["semantic"] = {}
        self.service._save_plan(turn.event_id, prepared)
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.service.status(turn.event_id, turn.user_id)["status"], "pending")

    def test_user_turn_cannot_be_relabelled_as_assistant(self):
        self.post()
        turn = Turn(**self.payload())
        self.service._save_plan(turn.event_id, plan_dict(turn, "assistant_archived"))
        self.assertFalse(self.service.process_one())
        self.assertFalse(self.service.status(turn.event_id, turn.user_id)["trusted"])

    def test_empty_ids_do_not_promote_done(self):
        self.post()
        self.engine.store_hook = lambda turn, plan: {"ok": True, "stored": [""], "reused": []}
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.service.status("one", "alice")["status"], "pending")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="personal-ai-os-memory-test-")
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine()
        self.service = MemoryService(self.root, self.engine)
        self.client = TestClient(create_app(self.service, run_worker=False))
        self.client.__enter__()
        self.headers = {"Authorization": "Bearer " + self.service.token}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def payload(self, **kwargs):
        return {"event_id": "one", "user_id": "alice", "role": "user",
                "text": "我喜欢用中文回复", **kwargs}

    def test_selected_processing_does_not_consume_another_pending_receipt(self):
        self.service.enqueue(Turn(event_id="unrelated", user_id="alice", role="user", text="unrelated queued input"))
        self.service.enqueue(Turn(event_id="migration", user_id="alice", role="user", text="selected input"))
        self.assertTrue(self.service.process_one(event_id="migration"))
        self.assertEqual(self.service.status("migration", "alice")["status"], "done")
        self.assertEqual(self.service.status("unrelated", "alice")["status"], "pending")
        self.assertFalse(self.service.process_one(event_id="' OR 1=1 --"))
        self.assertEqual(self.service.status("unrelated", "alice")["status"], "pending")

    def test_bad_selected_processing_is_rejected_before_receipt_effects(self):
        self.service.enqueue(Turn(event_id="one", user_id="alice", role="user", text="synthetic queued input"))
        for selector in ("", "  ", 1, [], "x" * 201):
            with self.assertRaises(quality.QualityError):
                self.service.process_one(event_id=selector)
        self.assertEqual(self.service.status("one", "alice")["status"], "pending")

    def post(self, **kwargs):
        return self.client.post("/v1/turns", headers=self.headers, json=self.payload(**kwargs))

    def clear_retry(self, service=None):
        with (service or self.service).connect() as db:
            db.execute("UPDATE turns SET retry_at=0")

    def test_health_no_secrets_or_raw_content(self):
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertNotIn(self.service.token, health.text)
        body = health.json()
        self.assertIn("needs_review", body["ingestion"])
        self.assertIn("validated", body["quality"])
        self.assertIn("legacy_unverified", body["quality"])

    def test_auth_required(self):
        self.assertEqual(self.client.post("/v1/turns", json=self.payload()).status_code, 401)
        self.assertEqual(self.client.post("/v1/search",
                         json={"user_id": "alice", "query": "偏好"}).status_code, 401)
        self.assertEqual(self.client.post("/v1/status",
                         json={"event_id": "one", "user_id": "alice"}).status_code, 401)

    def test_idempotent_and_conflict(self):
        first = self.post()
        self.assertEqual(first.status_code, 202)
        body = first.json()
        self.assertTrue(body["accepted"])
        self.assertFalse(body["replay"])
        self.assertEqual(body["processing"], "queued")
        self.assertIsNone(body["validation_status"])
        self.assertTrue(self.post().json()["replay"])
        self.assertEqual(self.post(text="different").status_code, 409)
        self.assertTrue(self.service.process_one())
        self.assertEqual(len(self.engine.rows), 1)
        with self.service.connect() as db:
            row = db.execute("SELECT status,validation_status FROM turns").fetchone()
            self.assertEqual(row[0], "done")
            self.assertEqual(row[1], "validated")

    def test_cross_user_isolation(self):
        self.post()
        self.post(event_id="two", user_id="bob", text="Bob private preference")
        self.service.process_one()
        self.service.process_one()
        response = self.client.post("/v1/search", headers=self.headers,
                                    json={"user_id": "alice", "query": "偏好"})
        self.assertEqual(len(response.json()["results"]), 1)
        self.assertNotIn("Bob", response.text)

    def test_restart_preserves_pending_receipts(self):
        self.post()
        restarted = MemoryService(self.root, self.engine)
        self.assertEqual(restarted.health()["ingestion"]["pending"], 1)
        self.assertTrue(restarted.process_one())
        self.assertEqual(restarted.health()["ingestion"]["done"], 1)
        self.assertEqual(restarted.token, self.service.token)

    def test_provider_failure_durable_redacted_retry(self):
        self.post()
        self.engine.store_hook = lambda turn, plan: (_ for _ in ()).throw(
            RuntimeError("provider-token-must-not-be-logged"))
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.service.health()["ingestion"]["retrying"], 1)
        with self.service.connect() as db:
            row = db.execute(
                "SELECT error_kind,plan,quality,stored_ids,payload FROM turns").fetchone()
            self.assertEqual(row[0], "RuntimeError")
            self.assertNotIn("provider-token", " ".join(str(value) for value in row))
        self.clear_retry()
        self.engine.store_hook = None
        self.assertTrue(self.service.process_one())
        self.assertEqual(self.service.health()["ingestion"]["done"], 1)

    def test_parallel_duplicate_ingestion(self):
        turn = Turn(**self.payload())
        failures = []

        def enqueue():
            try:
                self.service.enqueue(turn)
            except Exception as error:  # noqa: BLE001
                failures.append(error)
        threads = [threading.Thread(target=enqueue) for _ in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        self.assertEqual(self.service.health()["ingestion"]["pending"], 1)

    def test_bad_schema_and_limits(self):
        for changes in [{"role": "system"}, {"text": ""}, {"text": 12}, {"text": "x" * 100_001}]:
            self.assertEqual(self.post(**changes).status_code, 422)
        self.assertEqual(self.client.post("/v1/search", headers=self.headers,
                         json={"user_id": "alice", "query": "q", "limit": 999}).status_code, 422)

    def test_private_permissions(self):
        for file in [self.service.db_file, self.service.token_file]:
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_real_engine_contract_skips_assistant_facts_and_filters_search(self):
        memory = FakeMem0()
        engine = Mem0Engine(memory=memory, extractor=extractor_for([("candidate", "中文偏好")]),
                            evaluator=FakeEvaluator(), quality_config=make_config(), version="test")
        assistant = Turn(**self.payload(role="assistant", text="我猜用户的名字是小星。"))
        engine.add(assistant)
        self.assertEqual(memory.rows, [])
        user = Turn(**self.payload(text="中文偏好"))
        result = engine.add(user)
        self.assertTrue(result["ok"])
        self.assertEqual(len(memory.rows), 1)
        self.assertEqual(memory.rows[0]["memory"], "中文偏好")
        found = engine.search(Search(user_id="alice", query="偏好", limit=3))
        self.assertEqual(found[0]["memory"], "中文偏好")

    def test_partial_vector_write_leaves_pending_receipt_not_recallable(self):
        def partial(turn, plan):
            # A real fake-vector effect happens, then the store crashes.
            self.engine.rows.append({"id": "ghost", "user_id": turn.user_id,
                                     "event_id": turn.event_id,
                                     "memory": plan["facts"][0]["quote"],
                                     "validation_status": "validated"})
            raise RuntimeError("crash after partial vector write")
        self.engine.store_hook = partial
        self.post()
        self.assertFalse(self.service.process_one())
        self.assertEqual(len(self.engine.rows), 1)  # vector effect really happened
        with self.service.connect() as db:
            row = db.execute("SELECT status,validation_status,stored_ids FROM turns").fetchone()
        self.assertEqual(row[0], "pending")
        # Plan status may read validated, but the receipt is not done yet.
        self.assertIn(row[2] or "[]", ("[]", None))
        response = self.client.post("/v1/search", headers=self.headers,
                                    json={"user_id": "alice", "query": "喜欢"})
        self.assertEqual(response.json()["results"], [])

    def test_needs_review_receipt_not_recallable_even_with_validated_vector_row(self):
        self.engine.prepare_hook = lambda turn: plan_dict(turn, "needs_review", [], "credential_like")
        self.post()
        self.assertTrue(self.service.process_one())
        self.engine.rows.append({"id": "sneaky", "user_id": "alice", "event_id": "one",
                                 "memory": "喜欢用中文回复", "validation_status": "validated"})
        response = self.client.post("/v1/search", headers=self.headers,
                                    json={"user_id": "alice", "query": "喜欢"})
        self.assertEqual(response.json()["results"], [])

    def test_cross_user_and_restart_receipts_not_recallable(self):
        self.post()
        self.service.process_one()
        alice_id = self.engine.rows[0]["id"]
        # The vector store leaks every candidate regardless of user.
        self.engine.search_hook = lambda query: [
            {"id": row["id"], "memory": row["memory"], "score": 1.0} for row in self.engine.rows]
        bob = self.client.post("/v1/search", headers=self.headers,
                               json={"user_id": "bob", "query": "喜欢"})
        self.assertEqual(bob.json()["results"], [])
        restarted = MemoryService(self.root, self.engine)
        alice = restarted.search(Search(user_id="alice", query="喜欢", limit=5))
        self.assertEqual([row["id"] for row in alice], [alice_id])

    def test_store_result_count_mismatch_not_promoted(self):
        self.engine.store_hook = lambda turn, plan: {
            "ok": True, "stored": [], "reused": [], "validation_status": "validated"}
        self.post()
        self.assertFalse(self.service.process_one())
        with self.service.connect() as db:
            row = db.execute("SELECT status,error_kind FROM turns").fetchone()
        self.assertEqual(row[0], "pending")
        self.assertEqual(row[1], "store_incomplete")
        self.assertEqual(self.engine.rows, [])

    def test_corrupt_payload_reaches_bounded_needs_review(self):
        with self.service.connect() as db:
            db.execute("INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)",
                       ("bad", "{not valid json", "x", "pending", time.time()))
        for _ in range(self.service.max_attempts):
            self.service.process_one()
            self.clear_retry()
        with self.service.connect() as db:
            row = db.execute("SELECT status,error_kind,validation_status,payload FROM turns "
                             "WHERE event_id='bad'").fetchone()
        self.assertEqual(row[0], "needs_review")
        self.assertEqual(row[1], "invalid_payload")
        self.assertEqual(row[2], "needs_review")
        self.assertEqual(row[3], "{not valid json")  # retained, not overwritten
        # Unrelated ingestion still proceeds.
        self.post(event_id="good", text="中文偏好")
        self.assertTrue(self.service.process_one())
        self.assertEqual(self.service.health()["ingestion"]["done"], 1)

    def test_corrupt_plan_reaches_bounded_needs_review_without_effect(self):
        self.post()
        with self.service.connect() as db:
            db.execute("UPDATE turns SET plan='{broken' WHERE event_id='one'")
        for _ in range(self.service.max_attempts):
            self.service.process_one()
            self.clear_retry()
        with self.service.connect() as db:
            row = db.execute("SELECT status,error_kind,validation_status,plan FROM turns "
                             "WHERE event_id='one'").fetchone()
        self.assertEqual(row[0], "needs_review")
        self.assertEqual(row[1], "invalid_plan")
        self.assertEqual(row[2], "needs_review")
        self.assertEqual(row[3], "{broken")
        self.assertEqual(self.engine.rows, [])

    def test_search_provider_error_is_redacted(self):
        self.engine.search = Mock(side_effect=RuntimeError("private-provider-credential"))
        response = self.client.post("/v1/search", headers=self.headers,
                                    json={"user_id": "alice", "query": "偏好"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private-provider-credential", response.text)

    def test_status_reports_quality_and_redacts_content(self):
        self.post()
        self.service.process_one()
        response = self.client.post("/v1/status", headers=self.headers,
                                    json={"event_id": "one", "user_id": "alice"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["processing"], "processed")
        self.assertEqual(body["validation_status"], "validated")
        self.assertTrue(body["trusted"])
        self.assertEqual(body["stored_count"], 1)
        self.assertNotIn("我喜欢", response.text)
        self.assertNotIn(self.service.token, response.text)

    def test_status_auth_and_user_isolation(self):
        self.post()
        self.service.process_one()
        self.assertEqual(self.client.post("/v1/status", headers=self.headers,
                         json={"event_id": "one", "user_id": "bob"}).status_code, 404)
        self.assertEqual(self.client.post("/v1/status", headers=self.headers,
                         json={"event_id": "missing", "user_id": "alice"}).status_code, 404)
        self.assertEqual(self.client.post("/v1/status", headers=self.headers,
                         json={"event_id": "one", "user_id": "alice"}).status_code, 200)

    def test_max_attempts_needs_review_and_restart(self):
        self.engine.prepare_hook = lambda turn: (_ for _ in ()).throw(
            quality.QualityError("semantic_unavailable"))
        self.post()
        for _ in range(3):
            self.service.process_one()
            self.clear_retry()
        with self.service.connect() as db:
            row = db.execute("SELECT status,attempts,validation_status,error_kind FROM turns").fetchone()
        self.assertEqual(row[0], "needs_review")
        self.assertEqual(row[1], 3)
        self.assertEqual(row[2], "needs_review")
        self.assertEqual(row[3], "semantic_unavailable")
        restarted = MemoryService(self.root, self.engine)
        self.assertEqual(restarted.health()["ingestion"]["needs_review"], 1)
        self.assertEqual(restarted.health()["quality"]["needs_review"], 1)
        self.assertFalse(restarted.process_one())

    def test_preparation_persists_before_effect_and_store_retry_idempotence(self):
        tmp = tempfile.TemporaryDirectory(prefix="personal-ai-os-memory-prep-")
        root = Path(tmp.name)
        calls = []
        memory = FakeMem0()
        engine = Mem0Engine(memory=memory, extractor=extractor_for([("candidate", "remember this")], calls=calls),
                            evaluator=FakeEvaluator(), quality_config=make_config(), version="test")
        service = MemoryService(root, engine)
        service.enqueue(Turn(event_id="e1", user_id="alice", role="user", text="remember this"))
        original_store = engine.store

        def flaky(turn, plan):
            raise RuntimeError("transient store failure")
        engine.store = flaky
        self.assertFalse(service.process_one())
        with service.connect() as db:
            row = db.execute("SELECT status,plan,validation_status FROM turns WHERE event_id='e1'").fetchone()
        self.assertEqual(row[0], "pending")
        self.assertIsNotNone(row[1])
        self.assertEqual(row[2], "validated")
        self.assertEqual(calls, ["remember this"])
        engine.store = original_store
        self.clear_retry(service)
        restarted = MemoryService(root, engine)
        self.assertTrue(restarted.process_one())
        # Preparation is reused from the persisted plan: no second extraction.
        self.assertEqual(calls, ["remember this"])
        self.assertEqual(len(memory.rows), 1)
        with restarted.connect() as db:
            self.assertEqual(db.execute("SELECT status FROM turns").fetchone()[0], "done")
        tmp.cleanup()

    def test_legacy_migration_unverified(self):
        tmp = tempfile.TemporaryDirectory(prefix="personal-ai-os-memory-legacy-")
        root = Path(tmp.name)
        payload = json.dumps({"event_id": "legacy", "user_id": "alice", "role": "user",
                              "text": "old preference", "source": "wechat"},
                             sort_keys=True, ensure_ascii=False)
        with sqlite3.connect(root / "ingest.sqlite") as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE turns(
                event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0, error_kind TEXT, created_at REAL NOT NULL)""")
            db.execute("INSERT INTO turns(event_id,payload,digest,status,created_at) VALUES(?,?,?,?,?)",
                       ("legacy", payload, digest_of(payload), "done", time.time()))
        engine = FakeEngine()
        service = MemoryService(root, engine)
        with service.connect() as db:
            row = db.execute("SELECT status,validation_status,payload FROM turns").fetchone()
        self.assertEqual(row[0], "done")
        self.assertEqual(row[1], "legacy_unverified")
        self.assertEqual(json.loads(row[2])["text"], "old preference")
        self.assertEqual(service.health()["quality"]["legacy_unverified"], 1)
        # Legacy rows are never trusted recall results.
        self.assertEqual(engine.search(Search(user_id="alice", query="old", limit=5)), [])
        tmp.cleanup()


class ForgetTests(unittest.TestCase):
    def test_duplicate_done_status_and_existing_id_replay_obey_forget(self):
        self.post(event_id="orig")
        self.service.process_one()
        self.post(event_id="duplicate")
        self.service.process_one()
        self.assertEqual(self.forget(event_ids=["orig"]).status_code, 200)
        status = self.service.status("duplicate", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])
        replay = self.post(event_id="duplicate")
        self.assertEqual(replay.json()["status"], "forgotten")
        self.assertFalse(self.service.process_one())

    """Server-scope durable forgetting: tombstones, races, idempotency."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="personal-ai-os-memory-forget-")
        self.root = Path(self.tmp.name)
        self.engine = FakeEngine()
        self.service = MemoryService(self.root, self.engine)
        self.client = TestClient(create_app(self.service, run_worker=False))
        self.client.__enter__()
        self.headers = {"Authorization": "Bearer " + self.service.token}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def payload(self, **kwargs):
        return {"event_id": "one", "user_id": "alice", "role": "user",
                "text": "My name is Rowan.", **kwargs}

    def post(self, **kwargs):
        return self.client.post("/v1/turns", headers=self.headers, json=self.payload(**kwargs))

    def forget(self, request_id="req-1", user_id="alice", event_ids=None):
        return self.client.post("/v1/forget", headers=self.headers, json={
            "request_id": request_id, "user_id": user_id,
            "event_ids": event_ids if event_ids is not None else ["one"]})

    # ---- auth / schema ---------------------------------------------------
    def test_forget_and_controls_auth_required(self):
        self.assertEqual(self.client.post(
            "/v1/forget", json={"request_id": "r", "user_id": "alice", "event_ids": ["one"]}
        ).status_code, 401)
        self.assertEqual(self.client.post(
            "/v1/forget", headers={"Authorization": "Bearer wrong"},
            json={"request_id": "r", "user_id": "alice", "event_ids": ["one"]}).status_code, 401)
        self.assertEqual(self.client.post("/v1/controls", json={"user_id": "alice"}).status_code, 401)

    def test_forget_schema_rejects_bad_ids_and_shape(self):
        bad = [
            {"request_id": "r", "user_id": "alice", "event_ids": []},
            {"request_id": "r", "user_id": "alice", "event_ids": ["one", "one"]},
            {"request_id": "r", "user_id": "alice", "event_ids": [""]},
            {"request_id": "r", "user_id": "alice", "event_ids": [1]},
            {"request_id": "r", "user_id": "alice", "event_ids": ["e" * 201]},
            {"request_id": "r", "user_id": "alice",
             "event_ids": ["e{}".format(i) for i in range(201)]},
            {"request_id": "r", "user_id": "alice"},
            {"request_id": "r", "user_id": "alice", "event_ids": ["one"], "extra": 1},
            {"request_id": "", "user_id": "alice", "event_ids": ["one"]},
        ]
        for body in bad:
            self.assertEqual(self.client.post("/v1/forget", headers=self.headers,
                                              json=body).status_code, 422, body)

    # ---- target verification / atomicity ---------------------------------
    def test_forget_unknown_or_other_user_target_is_redacted_and_atomic(self):
        self.post(event_id="one")
        self.post(event_id="two", user_id="bob", text="Bob private preference")
        self.service.process_one()
        self.service.process_one()
        response = self.forget(event_ids=["one", "missing"])
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("missing", response.text)
        # Nothing changed: no tombstone, no epoch, alice's event still trusted.
        self.assertEqual(self.service.forget_store.epoch("alice"), 0)
        self.assertEqual(self.service.controls("alice")["tombstones"], [])
        self.assertTrue(self.service.status("one", "alice")["trusted"])
        # Alice cannot forget Bob's event.
        self.assertEqual(self.forget(user_id="alice", event_ids=["two"]).status_code, 404)
        self.assertTrue(self.service.status("two", "bob")["trusted"])

    # ---- done / pending forget ------------------------------------------
    def test_forget_done_event_is_durable_and_untrusted(self):
        self.post()
        self.assertTrue(self.service.process_one())
        self.assertEqual(len(self.engine.rows), 1)
        self.assertTrue(self.service.status("one", "alice")["trusted"])
        response = self.forget()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["accepted"])
        self.assertEqual(body["status"], "forgotten")
        self.assertEqual(body["scope"], "server-source")
        self.assertFalse(body["local_archive_handled"])
        self.assertEqual(body["forgotten_event_ids"], ["one"])
        self.assertEqual(body["tombstones"][0]["event_id"], "one")
        self.assertEqual(len(body["tombstones"][0]["source_hash"]), 64)
        self.assertNotIn("My name", response.text)
        status = self.service.status("one", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])
        self.assertTrue(status["forgotten"])
        self.assertEqual(self.client.get("/health").json()["ingestion"]["forgotten"], 1)

    def test_forget_pending_event_suppresses_before_prepare(self):
        self.post(event_id="one")
        self.assertEqual(self.forget().status_code, 200)
        self.assertFalse(self.service.process_one())  # nothing left to process
        self.assertEqual(self.engine.prepared, [])
        self.assertEqual(self.engine.store_calls, [])
        self.assertEqual(self.service.status("one", "alice")["status"], "forgotten")

    # ---- replay suppression ---------------------------------------------
    def test_archive_replay_same_source_new_id_suppressed(self):
        self.post(event_id="orig")
        self.assertTrue(self.service.process_one())
        self.assertEqual(self.forget(event_ids=["orig"]).status_code, 200)
        posted = self.post(event_id="replay")
        # Admission suppresses a new-id replay before any background processing.
        self.assertEqual(posted.json()["status"], "forgotten")
        self.assertFalse(self.service.process_one())
        # No second extraction/prepare for the replay.
        self.assertEqual(self.engine.prepared, ["orig"])
        status = self.service.status("replay", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])

    def test_archive_replay_sentence_hashes_new_id_suppressed(self):
        text = "My name is Rowan.\nMy project budget is 1234 CNY."
        self.post(event_id="orig", text=text)
        # Forget while pending: quote hashes come from deterministic sentence spans.
        self.assertEqual(self.forget(event_ids=["orig"]).status_code, 200)
        replay = "My name is Rowan. My project budget is 1234 CNY."
        posted = self.post(event_id="replay", text=replay)
        self.assertEqual(posted.json()["status"], "forgotten")
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.engine.prepared, [])
        self.assertEqual(self.service.status("replay", "alice")["status"], "forgotten")

    def test_replayed_forgotten_event_returns_forgotten_without_reextracting(self):
        self.post(event_id="orig")
        self.assertTrue(self.service.process_one())
        self.forget(event_ids=["orig"])
        # Capture the work already done by the single original processing run.
        prepared_before = len(self.engine.prepared)
        store_before = len(self.engine.store_calls)
        replay = self.post(event_id="orig")
        self.assertEqual(replay.status_code, 202)
        self.assertTrue(replay.json()["accepted"])
        self.assertEqual(replay.json()["status"], "forgotten")
        self.assertFalse(self.service.process_one())
        # The replay adds ZERO new preparation and ZERO new store calls.
        self.assertEqual(len(self.engine.prepared), prepared_before)
        self.assertEqual(len(self.engine.store_calls), store_before)

    # ---- item: ANY forgotten sentence holds the whole turn --------------
    def test_single_forgotten_sentence_replay_suppressed(self):
        text = "My name is Rowan.\nMy project budget is 1234 CNY."
        self.post(event_id="orig", text=text)
        self.assertEqual(self.forget(event_ids=["orig"]).status_code, 200)
        posted = self.post(event_id="replay", text="My name is Rowan.")
        self.assertEqual(posted.json()["status"], "forgotten")
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.engine.prepared, [])
        self.assertEqual(self.engine.store_calls, [])
        status = self.service.status("replay", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])

    def test_forgotten_plus_fresh_sentence_replay_suppressed(self):
        text = "My name is Rowan.\nMy project budget is 1234 CNY."
        self.post(event_id="orig", text=text)
        self.assertEqual(self.forget(event_ids=["orig"]).status_code, 200)
        posted = self.post(event_id="replay", text="My name is Rowan. I prefer green tea.")
        self.assertEqual(posted.json()["status"], "forgotten")
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.engine.prepared, [])
        self.assertEqual(self.engine.store_calls, [])
        self.assertEqual(self.service.status("replay", "alice")["status"], "forgotten")

    def test_single_forgotten_sentence_replay_no_prepare_evaluator_store(self):
        tmp = tempfile.TemporaryDirectory(prefix="personal-ai-os-memory-replay-real-")
        root = Path(tmp.name)
        evaluator = FakeEvaluator()
        engine = Mem0Engine(memory=FakeMem0(), evaluator=evaluator,
                            quality_config=make_config(), version="test")
        service = MemoryService(root, engine)
        client = TestClient(create_app(service, run_worker=False))
        client.__enter__()
        try:
            headers = {"Authorization": "Bearer " + service.token}
            base = {"user_id": "alice", "role": "user"}
            client.post("/v1/turns", headers=headers, json=dict(
                base, event_id="orig",
                text="My name is Rowan.\nMy project budget is 1234 CNY."))
            client.post("/v1/forget", headers=headers, json={
                "request_id": "r", "user_id": "alice", "event_ids": ["orig"]})
            posted = client.post("/v1/turns", headers=headers, json=dict(
                base, event_id="replay", text="My name is Rowan."))
            self.assertEqual(posted.json()["status"], "forgotten")
            self.assertFalse(service.process_one())
            self.assertEqual(evaluator.calls, [])
            self.assertEqual(engine.memory.rows, [])
            status = client.post("/v1/status", headers=headers, json={
                "event_id": "replay", "user_id": "alice"}).json()
            self.assertEqual(status["status"], "forgotten")
        finally:
            client.__exit__(None, None, None)
            tmp.cleanup()

    # ---- admission returns forgotten before processing ------------------
    def test_new_replay_admission_returns_forgotten_before_processing(self):
        self.post(event_id="orig")
        self.assertTrue(self.service.process_one())
        self.assertEqual(self.forget(event_ids=["orig"]).status_code, 200)
        self.engine.prepared.clear()
        self.engine.store_calls.clear()
        posted = self.post(event_id="replay")
        self.assertEqual(posted.status_code, 202)
        body = posted.json()
        self.assertTrue(body["accepted"])
        self.assertEqual(body["status"], "forgotten")
        self.assertEqual(body["processing"], "forgotten")
        self.assertTrue(body["forgotten"])
        # No background processing is required or possible.
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.engine.prepared, [])
        self.assertEqual(self.engine.store_calls, [])
        status = self.service.status("replay", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])

    def test_forgotten_event_id_different_payload_still_conflicts(self):
        self.post(event_id="one")
        self.assertEqual(self.forget().status_code, 200)
        self.assertEqual(self.post(event_id="one", text="different payload").status_code, 409)

    # ---- isolation / idempotency / epoch --------------------------------
    def test_forget_does_not_cross_users(self):
        text = "I prefer Chinese replies"
        self.post(event_id="a", user_id="alice", text=text)
        self.post(event_id="b", user_id="bob", text=text)
        self.service.process_one()
        self.service.process_one()
        self.assertEqual(self.forget(user_id="alice", event_ids=["a"]).status_code, 200)
        self.assertFalse(self.service.status("a", "alice")["trusted"])
        self.assertTrue(self.service.status("b", "bob")["trusted"])
        found = self.client.post("/v1/search", headers=self.headers,
                                 json={"user_id": "bob", "query": "prefer"})
        self.assertEqual(len(found.json()["results"]), 1)
        bob_controls = self.client.post("/v1/controls", headers=self.headers,
                                        json={"user_id": "bob"}).json()
        self.assertEqual(bob_controls["tombstones"], [])

    def test_forget_idempotent_replay_and_conflict(self):
        self.post(event_id="one")
        self.post(event_id="two")
        self.service.process_one()
        self.service.process_one()
        body = {"request_id": "r", "user_id": "alice", "event_ids": ["one", "two"]}
        first = self.client.post("/v1/forget", headers=self.headers, json=body)
        self.assertEqual(first.status_code, 200)
        second = self.client.post("/v1/forget", headers=self.headers, json=body)
        self.assertEqual(second.json(), first.json())
        # Reordered ids are the same request body (canonicalized).
        reordered = dict(body, event_ids=["two", "one"])
        self.assertEqual(self.client.post("/v1/forget", headers=self.headers,
                                          json=reordered).json(), first.json())
        changed = dict(body, event_ids=["one"])
        self.assertEqual(self.client.post("/v1/forget", headers=self.headers,
                                          json=changed).status_code, 409)
        other_user = dict(body, user_id="bob")
        self.assertEqual(self.client.post("/v1/forget", headers=self.headers,
                                          json=other_user).status_code, 409)

    def test_memory_epoch_advances_once_per_new_op_not_per_retry(self):
        self.post(event_id="one")
        self.post(event_id="two")
        self.service.process_one()
        self.service.process_one()
        first = self.forget(request_id="r1", event_ids=["one"]).json()
        self.assertEqual(first["memory_epoch"], 1)
        retry = self.forget(request_id="r1", event_ids=["one"]).json()
        self.assertEqual(retry["memory_epoch"], 1)
        second = self.forget(request_id="r2", event_ids=["two"]).json()
        self.assertEqual(second["memory_epoch"], 2)

    # ---- vectors / restart ----------------------------------------------
    def test_recalled_forgotten_vector_is_excluded(self):
        self.post()
        self.assertTrue(self.service.process_one())
        vector_id = self.engine.rows[0]["id"]
        self.forget()
        self.assertIn(vector_id, [row["id"] for row in self.engine.rows])
        found = self.client.post("/v1/search", headers=self.headers,
                                 json={"user_id": "alice", "query": "Rowan"})
        self.assertEqual(found.json()["results"], [])

    def test_restarted_service_obeys_tombstones(self):
        self.post(event_id="orig")
        self.forget(event_ids=["orig"])
        # A pending archive replay that predates admission-time suppression:
        # insert the same source under a new id directly, then restart.
        turn = Turn(event_id="replay", user_id="alice", role="user", text=self.payload()["text"])
        payload = json.dumps(turn.model_dump(), sort_keys=True, ensure_ascii=False)
        with self.service.connect() as db:
            db.execute("INSERT INTO turns(event_id,payload,digest,created_at) VALUES(?,?,?,?)",
                       ("replay", payload, hashlib.sha256(payload.encode()).hexdigest(), time.time()))
        restarted = MemoryService(self.root, self.engine)
        self.assertTrue(restarted.process_one())  # admission suppresses it
        self.assertEqual(self.engine.prepared, [])
        self.assertEqual(restarted.status("replay", "alice")["status"], "forgotten")

    def test_stale_plan_and_finalization_never_unforget(self):
        self.post(event_id="one")
        self.forget()
        turn = Turn(**self.payload(event_id="one"))
        plan = plan_dict(turn, "validated", [
            {"fact": turn.text, "quote": turn.text, "start": 0, "end": len(turn.text)}])
        self.service._save_plan("one", plan)
        self.service._finish("one", "done", plan, ["stale"], [])
        self.service._fail("one", 0, RuntimeError("stale failure"))
        status = self.service.status("one", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])
        self.assertEqual(status["stored_count"], 0)
        with self.service.connect() as db:
            self.assertEqual(
                db.execute("SELECT forgotten FROM turns WHERE event_id='one'").fetchone()[0], 1)
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.engine.store_calls, [])

    # ---- races -----------------------------------------------------------
    def test_forget_during_prepare_commits_without_waiting_for_lock(self):
        entered, release = threading.Event(), threading.Event()

        def prepare_hook(turn):
            entered.set()
            release.wait(timeout=5)
            return plan_dict(turn, "validated", [
                {"fact": turn.text, "quote": turn.text, "start": 0, "end": len(turn.text)}])

        self.engine.prepare_hook = prepare_hook
        self.post(event_id="race")
        processed = {}
        worker = threading.Thread(target=lambda: processed.update(
            value=self.service.process_one()))
        worker.start()
        self.assertTrue(entered.wait(timeout=5))
        response = self.forget(user_id="alice", event_ids=["race"])
        self.assertEqual(response.status_code, 200)
        release.set()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(processed["value"])
        self.assertEqual(self.engine.store_calls, [])
        status = self.service.status("race", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])

    def test_forget_during_store_race_writes_tombstone_and_excludes_vector(self):
        entered, release = threading.Event(), threading.Event()
        engine = self.engine

        def store_hook(turn, plan):
            entered.set()
            release.wait(timeout=5)
            engine.rows.append({"id": "physical", "user_id": turn.user_id,
                                "event_id": turn.event_id, "memory": plan["facts"][0]["quote"],
                                "validation_status": "validated"})
            return {"ok": True, "stored": ["physical"], "reused": [],
                    "validation_status": "validated"}

        self.engine.store_hook = store_hook
        self.post(event_id="race")
        processed = {}
        worker = threading.Thread(target=lambda: processed.update(
            value=self.service.process_one()))
        worker.start()
        self.assertTrue(entered.wait(timeout=5))
        self.assertEqual(self.forget(user_id="alice", event_ids=["race"]).status_code, 200)
        release.set()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(processed["value"])
        # The vector effect physically happened, but it is never trusted/recalled.
        self.assertIn("physical", [row["id"] for row in self.engine.rows])
        status = self.service.status("race", "alice")
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])
        found = self.client.post("/v1/search", headers=self.headers,
                                 json={"user_id": "alice", "query": "Rowan"})
        self.assertEqual(found.json()["results"], [])

    # ---- controls --------------------------------------------------------
    def test_controls_expose_only_safe_hashes_and_epoch(self):
        self.post()
        self.service.process_one()
        self.forget()
        response = self.client.post("/v1/controls", headers=self.headers,
                                    json={"user_id": "alice"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("My name", response.text)
        self.assertNotIn(self.service.token, response.text)
        body = response.json()
        self.assertEqual(body["user_id"], "alice")
        self.assertEqual(body["memory_epoch"], 1)
        self.assertEqual(body["forgotten_event_ids"], ["one"])
        self.assertFalse(body["local_archive_handled"])
        tombstone = body["tombstones"][0]
        self.assertEqual(tombstone["event_id"], "one")
        self.assertEqual(len(tombstone["source_hash"]), 64)
        self.assertTrue(all(len(h) == 64 for h in tombstone["quote_hashes"]))
        empty = self.client.post("/v1/controls", headers=self.headers,
                                 json={"user_id": "nobody"}).json()
        self.assertEqual(empty["tombstones"], [])
        self.assertEqual(empty["memory_epoch"], 0)
        self.assertEqual(self.client.post("/v1/controls", headers=self.headers,
                         json={"user_id": "alice", "extra": 1}).status_code, 422)

    def test_health_and_status_distinguish_forgotten(self):
        self.post()
        self.assertTrue(self.service.process_one())
        before = self.client.get("/health").json()
        self.assertEqual(before["ingestion"]["done"], 1)
        self.assertEqual(before["ingestion"]["forgotten"], 0)
        self.forget()
        after = self.client.get("/health").json()
        self.assertEqual(after["ingestion"]["done"], 0)
        self.assertEqual(after["ingestion"]["forgotten"], 1)
        status = self.client.post("/v1/status", headers=self.headers,
                                  json={"event_id": "one", "user_id": "alice"}).json()
        self.assertEqual(status["status"], "forgotten")
        self.assertFalse(status["trusted"])
        self.assertTrue(status["forgotten"])
        self.assertEqual(status["memory_epoch"], 1)


class QualityUnitTests(unittest.TestCase):
    def test_chinese_credentials_rejected_before_remote_inference(self):
        for text in ["我的密码是synthetic-only", "API密钥：synthetic-only", "ghp_" + "x" * 24]:
            extractor, evaluator = Mock(), FakeEvaluator()
            engine = Mem0Engine(memory=FakeMem0(), extractor=extractor, evaluator=evaluator,
                                quality_config=make_config(), version="test")
            plan = engine.prepare(Turn(event_id="credential-check", user_id="alice", role="user", text=text))
            self.assertEqual(plan["validation_status"], "needs_review")
            extractor.assert_not_called()
            self.assertEqual(evaluator.calls, [])

    def test_relevance_rubric_explicitly_includes_identity_and_project_facts(self):
        facts = [quality.ValidatedFact("name", "My name is Rowan.", 0, 17)]
        question = quality.build_semantic_questions(facts, False)["relevance_0"]["instructions"]
        self.assertIn("names and project budgets", question)
        self.assertIn("hypothetical examples", question)
        # The default source-span eligibility rubric carries the same signals.
        eligible = quality.build_selection_questions([(0, 17, "My name is Rowan.")])
        rubric = eligible["eligible_0"]["instructions"]
        self.assertIn("preference", rubric)
        self.assertIn("project fact", rubric)
        self.assertIn("budgets", rubric)
        self.assertIn("hypothetical examples", rubric)
        self.assertIn("credentials", rubric)
        self.assertIn("remember", rubric)

    def test_real_noul_contract_is_accepted(self):
        questions = {"q": {"type": "noul", "instructions": "semantic completeness"}}
        result = quality.run_semantic_check(
            FakeEvaluator(answers={"q": {"type": "noul", "noul": 0.99}}), {}, questions, 0.90)
        self.assertEqual(result["q"]["noul"], 0.99)

    def test_parse_extraction_rejects_bad_schema(self):
        bad = [None, 12, "not json", {}, {"facts": []},
               {"facts": [], "no_durable_facts": "yes"},
               {"facts": [], "no_durable_facts": False, "extra": 1},
               {"facts": "no", "no_durable_facts": False},
               {"facts": [{"fact": "x"}], "no_durable_facts": False},
               {"facts": [{"fact": 1, "source_quote": "x"}], "no_durable_facts": False},
               {"facts": [{"fact": "x", "source_quote": "x", "extra": 1}], "no_durable_facts": False},
               {"facts": [{"fact": "x", "source_quote": "   "}], "no_durable_facts": False}]
        for raw in bad:
            with self.assertRaises(quality.QualityError):
                quality.parse_extraction(raw)

    def test_verbatim_quote_and_offsets(self):
        text = "我喜欢用中文回复，名字是Rowan。"
        parsed = quality.parse_extraction(
            {"facts": [{"fact": "名字 Rowan", "source_quote": "Rowan"}], "no_durable_facts": False})
        facts, no_durable = quality.validate_extraction(parsed, text, make_config())
        self.assertFalse(no_durable)
        self.assertEqual(text.index("Rowan"), facts[0].start)
        self.assertEqual(text[facts[0].start:facts[0].end], "Rowan")

    def test_missing_quote_rejected(self):
        parsed = {"facts": [{"fact": "x", "source_quote": "not present"}], "no_durable_facts": False}
        with self.assertRaises(quality.QualityError) as ctx:
            quality.validate_extraction(parsed, "some other text", make_config())
        self.assertEqual(ctx.exception.kind, "quote_not_found")

    def test_credential_patterns(self):
        secrets = [
            "sk-abcdefghijklmnop",
            "apikey_1a2b3c4d5e6f7g8h",
            "apikey_abcd-efgh_ijkl",
            "password: hunter2",
            "auth_token = abcdefghijklmno",
            "Bearer abcdefghijklmno",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
            "-----BEGIN RSA PRIVATE KEY-----",
        ]
        for secret in secrets:
            self.assertTrue(quality.contains_credential(secret), secret)
        self.assertFalse(quality.contains_credential("我喜欢用中文回复"))

    def test_normalized_fact_secret_rejected_before_evaluator(self):
        text = "please remember the key_value_pair setting"
        evaluator = FakeEvaluator()
        engine = Mem0Engine(memory=FakeMem0(),
                            extractor=extractor_for([("apikey_1a2b3c4d5e6f7g8h", "key_value_pair")]),
                            evaluator=evaluator, quality_config=make_config(), version="test")
        turn = Turn(event_id="evt", user_id="alice", role="user", text=text)
        with self.assertRaises(quality.QualityError) as ctx:
            engine.prepare(turn)
        self.assertEqual(ctx.exception.kind, "credential_like")
        self.assertEqual(evaluator.calls, [])

    def test_bounds_facts_rejected(self):
        parsed = {"facts": [{"fact": "a", "source_quote": "ab"}, {"fact": "b", "source_quote": "ab"}],
                  "no_durable_facts": False}
        with self.assertRaises(quality.QualityError) as ctx:
            quality.validate_extraction(parsed, "ab", make_config(max_facts=1))
        self.assertEqual(ctx.exception.kind, "bounds_exceeded")

    def test_semantic_answers_schema(self):
        questions = {"q": {"type": "noul", "instructions": "x"}}
        with self.assertRaises(quality.EvaluatorError):
            quality.run_semantic_check(FakeEvaluator(answers={}), {}, questions, 0.90)
        ok = quality.run_semantic_check(FakeEvaluator(answers={"q": noul(0.99)}), {}, questions, 0.90)
        self.assertEqual(ok["q"], {"type": "noul", "noul": 0.99})

    def test_noul_contract_negatives_fail_closed(self):
        questions = {"q": {"type": "noul", "instructions": "x"}}
        invalid = [
            True,
            {"answer": True, "confidence": 0.99},
            {"type": "boolean", "noul": 0.99},
            {"type": "noul", "answer": True},
            {"noul": 0.99},
            {"type": "noul"},
            {"type": "noul", "noul": True},
            {"type": "noul", "noul": "0.99"},
            {"type": "noul", "noul": None},
            {"type": "noul", "noul": float("nan")},
            {"type": "noul", "noul": float("inf")},
            {"type": "noul", "noul": 1.5},
            {"type": "noul", "noul": -0.1},
        ]
        for entry in invalid:
            with self.assertRaises(quality.EvaluatorError, msg=repr(entry)):
                quality.run_semantic_check(FakeEvaluator(answers={"q": entry}), {}, questions, 0.90)

    def test_noul_low_probability_is_not_affirmed(self):
        questions = {"q": {"type": "noul", "instructions": "x"}}
        with self.assertRaises(quality.EvaluatorError) as ctx:
            quality.run_semantic_check(FakeEvaluator(answers={"q": noul(0.01)}), {}, questions, 0.90)
        self.assertEqual(ctx.exception.kind, "semantic_not_affirmed")

    def test_noul_all_expected_ids_required(self):
        questions = {"a": {"type": "noul", "instructions": "x"},
                     "b": {"type": "noul", "instructions": "y"}}
        with self.assertRaises(quality.EvaluatorError) as ctx:
            quality.run_semantic_check(FakeEvaluator(answers={"a": noul()}), {}, questions, 0.90)
        self.assertEqual(ctx.exception.kind, "semantic_missing")


class EngineTests(unittest.TestCase):
    def test_prepared_plan_cannot_move_between_users(self):
        engine = self.engine(extractor_for([("preference", "中文偏好")]))
        turn = self.turn("中文偏好")
        prepared = engine.prepare(turn)
        other = turn.model_copy(update={"user_id": "bob"})
        self.assertFalse(engine.store(other, prepared)["ok"])
        self.assertEqual(engine.memory.rows, [])

    def test_prepared_quote_cannot_be_changed_after_validation(self):
        engine = self.engine(extractor_for([("preference", "中文偏好")]))
        turn = self.turn("中文偏好")
        prepared = engine.prepare(turn)
        prepared["facts"][0]["quote"] = "invented-source"
        self.assertFalse(engine.store(turn, prepared)["ok"])
        self.assertEqual(engine.memory.rows, [])

    def turn(self, text, role="user", **kwargs):
        return Turn(event_id=kwargs.get("event_id", "evt"), user_id="alice", role=role, text=text)

    def engine(self, extractor, evaluator=None, memory=None, config=None):
        return Mem0Engine(memory=memory or FakeMem0(), extractor=extractor,
                          evaluator=evaluator or FakeEvaluator(),
                          quality_config=config or make_config(), version="test")

    def test_object_number_negation_loss_rejected(self):
        fixture = load_quality_fixture()
        for case in fixture["cases"]:
            if case["role"] != "user":
                continue
            text = case["text"]
            if "badExtraction" in case:
                engine = self.engine(extractor_for([("candidate", case["badExtraction"])]))
                with self.assertRaises(quality.QualityError) as ctx:
                    engine.prepare(self.turn(text))
                self.assertEqual(ctx.exception.kind, "quote_not_found")
            if "requiredSourceValues" in case:
                pairs = [("candidate", value) for value in case["requiredSourceValues"]]
                engine = self.engine(extractor_for(pairs))
                plan = engine.prepare(self.turn(text))
                self.assertEqual(plan["validation_status"], "validated")
                for fact, value in zip(plan["facts"], case["requiredSourceValues"]):
                    self.assertEqual(fact["quote"], value)
                    self.assertEqual(text[fact["start"]:fact["end"]], value)

    def test_number_and_name_preserved_in_trusted_content(self):
        text = "My name is Rowan. My project budget is 1234 CNY."
        quotes = ["My name is Rowan.", "My project budget is 1234 CNY."]
        memory = FakeMem0()
        evaluator = FakeEvaluator()
        engine = self.engine(extractor_for([("candidate", q) for q in quotes]),
                             evaluator=evaluator, memory=memory)
        turn = self.turn(text)
        plan = engine.prepare(turn)
        self.assertEqual(plan["validation_status"], "validated")
        result = engine.store(turn, plan)
        self.assertTrue(result["ok"])
        stored = [row["memory"] for row in memory.rows]
        self.assertEqual(stored, quotes)
        self.assertIn("Rowan", stored[0])
        self.assertIn("1234", stored[1])
        self.assertIn("retains_all_details", evaluator.calls[0]["questions"])
        self.assertNotIn("key", evaluator.calls[0]["state"])

    def test_hallucinated_or_assistant_not_stored(self):
        memory = FakeMem0()
        engine = self.engine(extractor_for([("candidate", "The user's name is 小星")]), memory=memory)
        with self.assertRaises(quality.QualityError):
            engine.prepare(self.turn("我猜用户的名字是小星。"))
        self.assertEqual(memory.rows, [])
        assistant = engine.prepare(self.turn("我猜用户的名字是小星。", role="assistant"))
        self.assertEqual(assistant["validation_status"], "assistant_archived")
        engine.store(self.turn("我猜用户的名字是小星。", role="assistant"), assistant)
        self.assertEqual(memory.rows, [])

    def test_no_durable_confirmed_vs_unconfirmed(self):
        confirmed = self.engine(extractor_for([], no_durable=True),
                                evaluator=FakeEvaluator())
        plan = confirmed.prepare(self.turn("今天天气不错"))
        self.assertEqual(plan["validation_status"], "no_facts")
        self.assertEqual(confirmed.store(self.turn("今天天气不错"), plan)["stored"], [])
        unconfirmed = self.engine(
            extractor_for([], no_durable=True),
            evaluator=FakeEvaluator(answers=lambda qs: {
                qid: noul(0.01 if qid == "no_durable_facts" else 0.99) for qid in qs}))
        with self.assertRaises(quality.EvaluatorError):
            unconfirmed.prepare(self.turn("今天天气不错"))

    def test_malformed_and_empty_extraction(self):
        for raw, kind in [("", "empty_extraction"), ("garbage", "malformed_extraction")]:
            engine = self.engine(lambda text, raw=raw: raw)
            with self.assertRaises(quality.QualityError) as ctx:
                engine.prepare(self.turn("我喜欢用中文回复"))
            self.assertEqual(ctx.exception.kind, kind)
        empty = {"facts": [], "no_durable_facts": False}
        with self.assertRaises(quality.QualityError) as ctx:
            self.engine(lambda text: empty).prepare(self.turn("我喜欢用中文回复"))
        self.assertEqual(ctx.exception.kind, "empty_extraction")

    def test_jev_unavailable_malformed_ambiguous(self):
        text = "I prefer Chinese replies"
        cases = [
            (FakeEvaluator(error=quality.EvaluatorError("jev_unavailable")), "jev_unavailable"),
            (FakeEvaluator(answers={}), "semantic_malformed"),
            (FakeEvaluator(answers=lambda qs: {qid: noul(0.5) for qid in qs}),
             "semantic_ambiguous"),
            (FakeEvaluator(answers=lambda qs: {qid: noul() for qid in list(qs)[:-1]}),
             "semantic_missing"),
        ]
        for evaluator, kind in cases:
            engine = self.engine(extractor_for([("candidate", text)]), evaluator=evaluator)
            with self.assertRaises(quality.QualityError) as ctx:
                engine.prepare(self.turn(text))
            self.assertEqual(ctx.exception.kind, kind)

    def test_bounds_retained_without_truncation(self):
        calls = []
        engine = self.engine(extractor_for([("candidate", "x")], calls=calls),
                             config=make_config(max_text_chars=20))
        text = "x" * 30
        plan = engine.prepare(self.turn(text))
        self.assertEqual(plan["validation_status"], "needs_review")
        self.assertEqual(plan["error_kind"], "bounds_exceeded")
        self.assertEqual(plan["text_chars"], 30)
        self.assertEqual(plan["facts"], [])
        self.assertEqual(calls, [])
        self.assertEqual(engine.store(self.turn(text), plan)["stored"], [])

    def test_fact_bound_retained_without_truncation(self):
        text = "abcdef"
        engine = self.engine(extractor_for([("a", "ab"), ("b", "cd"), ("c", "ef")]),
                             config=make_config(max_facts=2))
        plan = engine.prepare(self.turn(text))
        self.assertEqual(plan["validation_status"], "needs_review")
        self.assertEqual(plan["error_kind"], "bounds_exceeded")

    def test_store_idempotent_reuse(self):
        memory = FakeMem0()
        engine = self.engine(extractor_for([("candidate", "中文偏好")]), memory=memory)
        turn = self.turn("中文偏好")
        plan = engine.prepare(turn)
        first = engine.store(turn, plan)
        second = engine.store(turn, plan)
        self.assertTrue(first["ok"])
        self.assertEqual(second["stored"], [])
        self.assertEqual(len(second["reused"]), 1)
        self.assertEqual(len(memory.rows), 1)

    def test_store_rejects_partial_or_mismatched_plan(self):
        memory = FakeMem0()
        engine = self.engine(extractor_for([("candidate", "中文偏好")]), memory=memory)
        turn = self.turn("中文偏好")
        self.assertFalse(engine.store(turn, None)["ok"])
        self.assertEqual(engine.store(turn, plan_dict(turn, "validated", []))["reason"], "partial_plan")
        wrong = engine.prepare(turn)
        wrong["event_id"] = "other"
        self.assertEqual(engine.store(turn, wrong)["reason"], "invalid_plan")
        bad = Mem0Engine(memory=BadBindMem0(), extractor=extractor_for([("candidate", "中文偏好")]),
                         evaluator=FakeEvaluator(), quality_config=make_config(), version="test")
        bound_turn = self.turn("中文偏好")
        plan = bad.prepare(bound_turn)
        result = bad.store(bound_turn, plan)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "store_binding_failed")

    def test_default_prepare_is_source_selection_without_extractor(self):
        evaluator = FakeEvaluator()
        engine = Mem0Engine(memory=FakeMem0(), evaluator=evaluator,
                            quality_config=make_config(), version="test")
        self.assertIsNone(engine.extractor)
        self.assertEqual(engine.extraction_mode, "source_span_selection")
        turn = self.turn("My name is Rowan. My project budget is 1234 CNY.")
        plan = engine.prepare(turn)
        self.assertEqual(plan["validation_status"], "validated")
        self.assertEqual(plan["extraction_mode"], "source_span_selection")
        self.assertEqual([f["quote"] for f in plan["facts"]],
                         ["My name is Rowan.", "My project budget is 1234 CNY."])
        # Trusted content is the original span; no rewrite.
        for fact in plan["facts"]:
            self.assertEqual(fact["fact"], fact["quote"])
            self.assertEqual(turn.text[fact["start"]:fact["end"]], fact["quote"])
        # One candidate batch + one completeness batch: no generative call.
        self.assertEqual(len(evaluator.calls), 2)
        self.assertNotIn("faithful_0", evaluator.calls[0]["questions"])
        self.assertIn("retains_all_details", evaluator.calls[1]["questions"])
        stored = engine.store(turn, plan)
        self.assertTrue(stored["ok"])
        self.assertEqual([row["memory"] for row in engine.memory.rows],
                         ["My name is Rowan.", "My project budget is 1234 CNY."])

    def test_injected_extractor_remains_contract_adapter(self):
        evaluator = FakeEvaluator()
        engine = Mem0Engine(memory=FakeMem0(), extractor=extractor_for([("normalized", "中文偏好")]),
                            evaluator=evaluator, quality_config=make_config(), version="test")
        self.assertEqual(engine.extraction_mode, "extractor_proposals")
        plan = engine.prepare(self.turn("中文偏好"))
        self.assertEqual(plan["validation_status"], "validated")
        # A rewritten injected proposal still needs a faithfulness check.
        self.assertIn("faithful_0", evaluator.calls[0]["questions"])

    def test_no_subprocess_key_args_and_malformed_output(self):
        captured = {}

        def runner(command, input_text, timeout):
            captured["command"] = list(command)
            captured["input"] = input_text
            captured["timeout"] = timeout
            return subprocess.CompletedProcess(command, 0,
                                               stdout='{"answers": {"q": {"type": "noul", "noul": 0.99}}, "model": "jev-1.13.0"}',
                                               stderr="")

        evaluator = quality.JevEvaluator(command=["/Users/markus/.local/bin/jev-eval"], runner=runner)
        out = evaluator.evaluate({"user_text": "hello"}, {"q": {"type": "noul", "instructions": "x"}})
        self.assertEqual(out["answers"]["q"]["noul"], 0.99)
        self.assertEqual(captured["command"], ["/Users/markus/.local/bin/jev-eval"])
        self.assertLessEqual(captured["timeout"], 45)
        parsed = json.loads(captured["input"])
        self.assertNotIn("key", json.dumps(parsed).lower())
        self.assertEqual(parsed["state"], {"user_text": "hello"})

        def bad_runner(command, input_text, timeout):
            return subprocess.CompletedProcess(command, 0, stdout="not json", stderr="")
        with self.assertRaises(quality.EvaluatorError) as ctx:
            quality.JevEvaluator(command=["/bin/true"], runner=bad_runner).evaluate({}, {"q": {}})
        self.assertEqual(ctx.exception.kind, "jev_malformed")

        def fail_runner(command, input_text, timeout):
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="boom")
        with self.assertRaises(quality.EvaluatorError) as ctx:
            quality.JevEvaluator(command=["/bin/false"], runner=fail_runner).evaluate({}, {"q": {}})
        self.assertEqual(ctx.exception.kind, "jev_failed")


class SourceSelectionTests(unittest.TestCase):
    def engine(self, answers=None, config=None):
        return Mem0Engine(memory=FakeMem0(), evaluator=FakeEvaluator(answers=answers),
                          quality_config=config or make_config(), version="test")

    def turn(self, text):
        return Turn(event_id="source-selection", user_id="alice", role="user", text=text)

    def test_complete_sentences_keep_decimals_and_unicode_offsets(self):
        text = "  我的昵称是小柚。My project budget is 1234.50 CNY.\n不要叫我小柚，以后叫小林。"
        spans = quality.source_spans(text)
        self.assertEqual(len(spans), 3)
        self.assertIn("1234.50 CNY", spans[1][2])
        self.assertIn("不要叫我小柚，以后叫小林", spans[2][2])
        for start, end, quote in spans:
            self.assertEqual(text[start:end], quote)

    def test_greeting_is_excluded_but_whole_name_and_budget_statements_stored(self):
        def answers(questions):
            return {key: {"type": "noul", "noul": 0.02 if key == "eligible_0" else 0.99}
                    for key in questions}
        engine = self.engine(answers)
        turn = self.turn("Hi there! My name is Rowan. My project budget is 1234.50 CNY.")
        plan = engine.prepare(turn)
        self.assertEqual([row["quote"] for row in plan["facts"]],
                         ["My name is Rowan.", "My project budget is 1234.50 CNY."])
        self.assertTrue(engine.store(turn, plan)["ok"])
        self.assertEqual(len(engine.memory.rows), 2)
        self.assertEqual(len(engine.evaluator.calls), 2)
        self.assertFalse(any(key.startswith("faithful_") for call in engine.evaluator.calls
                             for key in call["questions"]))

    def test_uncertain_candidate_holds_entire_input(self):
        engine = self.engine(lambda questions: {key: {"type": "noul", "noul": 0.5}
                                                for key in questions})
        with self.assertRaises(quality.EvaluatorError):
            engine.prepare(self.turn("My name is Rowan."))
        self.assertEqual(engine.memory.rows, [])

    def test_source_candidate_bound_does_not_truncate_or_call_remote(self):
        engine = self.engine(config=make_config(max_facts=1))
        plan = engine.prepare(self.turn("My name is Rowan. My project budget is 1234 CNY."))
        self.assertEqual(plan["validation_status"], "needs_review")
        self.assertEqual(engine.evaluator.calls, [])

    def test_empty_selection_requires_a_separate_no_facts_judgment(self):
        def answers(questions):
            return {key: {"type": "noul", "noul": 0.99 if key == "no_durable_facts" else 0.02}
                    for key in questions}
        engine = self.engine(answers)
        plan = engine.prepare(self.turn("Hi there!"))
        self.assertEqual(plan["validation_status"], "no_facts")
        self.assertEqual(len(engine.evaluator.calls), 2)
        self.assertEqual(engine.memory.rows, [])


class RecallTests(unittest.TestCase):
    def test_source_backed_recall_excludes_pending_review_legacy(self):
        memory = FakeMem0()
        # A legacy/unvalidated record and a needs_review record already in the store.
        memory.rows.append({"id": "legacy", "user_id": "alice", "memory": "old unverified fact",
                            "metadata": {}})
        memory.rows.append({"id": "review", "user_id": "alice", "memory": "needs review candidate",
                            "metadata": {"validation_status": "needs_review"}})
        engine = Mem0Engine(memory=memory, extractor=extractor_for([("candidate", "I prefer Chinese replies")]),
                            evaluator=FakeEvaluator(), quality_config=make_config(), version="test")
        turn = Turn(event_id="e1", user_id="alice", role="user", text="I prefer Chinese replies")
        engine.store(turn, engine.prepare(turn))
        # A pending receipt has no vector record at all and is therefore absent.
        results = engine.search(Search(user_id="alice", query="prefer", limit=10))
        ids = {row["id"] for row in results}
        self.assertEqual(len(ids), 1)
        self.assertNotIn("legacy", ids)
        self.assertNotIn("review", ids)


if __name__ == "__main__":
    unittest.main()
