import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from fastapi.testclient import TestClient
from services.memory.service import Mem0Engine, MemoryService, Search, Turn, create_app


class FakeEngine:
    version = "test"
    embedding_model = "test-local"
    def __init__(self):
        self.items = []
        self.fail = False
    def add(self, turn):
        if self.fail:
            raise RuntimeError("provider-token-must-not-be-logged")
        self.items.append(turn)
    def search(self, query):
        return [{"id": t.event_id, "memory": t.text} for t in self.items if t.user_id == query.user_id][:query.limit]


class ServiceTests(unittest.TestCase):
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
        return {"event_id": "one", "user_id": "alice", "role": "user", "text": "我喜欢用中文回复", **kwargs}
    def post(self, **kwargs):
        return self.client.post("/v1/turns", headers=self.headers, json=self.payload(**kwargs))
    def test_health_no_secrets(self):
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertNotIn(self.service.token, health.text)
    def test_auth_required(self):
        self.assertEqual(self.client.post("/v1/turns", json=self.payload()).status_code, 401)
        self.assertEqual(self.client.post("/v1/search", json={"user_id": "alice", "query": "偏好"}).status_code, 401)
    def test_idempotent_and_conflict(self):
        self.assertEqual(self.post().status_code, 202)
        self.assertTrue(self.post().json()["replay"])
        self.assertEqual(self.post(text="different").status_code, 409)
        self.service.process_one()
        self.assertEqual(len(self.engine.items), 1)
    def test_cross_user_isolation(self):
        self.post()
        self.post(event_id="two", user_id="bob", text="Bob private preference")
        self.service.process_one()
        self.service.process_one()
        response = self.client.post("/v1/search", headers=self.headers, json={"user_id": "alice", "query": "偏好"})
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
        self.engine.fail = True
        self.assertFalse(self.service.process_one())
        self.assertEqual(self.service.health()["ingestion"]["retrying"], 1)
        with self.service.connect() as db:
            kind = db.execute("SELECT error_kind FROM turns").fetchone()[0]
            self.assertEqual(kind, "RuntimeError")
            db.execute("UPDATE turns SET retry_at=0")
        self.engine.fail = False
        self.assertTrue(self.service.process_one())
    def test_parallel_duplicate_ingestion(self):
        turn = Turn(**self.payload())
        failures = []
        def enqueue():
            try: self.service.enqueue(turn)
            except Exception as error: failures.append(error)
        threads = [threading.Thread(target=enqueue) for _ in range(10)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(failures, [])
        self.assertEqual(self.service.health()["ingestion"]["pending"], 1)
    def test_bad_schema_and_limits(self):
        for changes in [{"role": "system"}, {"text": ""}, {"text": 12}, {"text": "x" * 100_001}]:
            self.assertEqual(self.post(**changes).status_code, 422)
        self.assertEqual(self.client.post("/v1/search", headers=self.headers, json={"user_id": "alice", "query": "q", "limit": 999}).status_code, 422)
    def test_private_permissions(self):
        for file in [self.service.db_file, self.service.token_file]:
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_real_engine_contract_skips_assistant_facts_and_filters_search(self):
        engine = Mem0Engine.__new__(Mem0Engine)
        engine.memory = Mock()
        engine.memory.search.return_value = {"results": [{"id": "fact", "memory": "中文偏好"}]}
        engine.add(Turn(**self.payload(role="assistant")))
        engine.memory.add.assert_not_called()
        engine.add(Turn(**self.payload()))
        self.assertEqual(engine.memory.add.call_args.kwargs["user_id"], "alice")
        result = engine.search(Search(user_id="alice", query="偏好", limit=3))
        engine.memory.search.assert_called_once_with("偏好", filters={"user_id": "alice"}, top_k=3)
        self.assertEqual(result[0]["memory"], "中文偏好")

    def test_search_provider_error_is_redacted(self):
        self.engine.search = Mock(side_effect=RuntimeError("private-provider-credential"))
        response = self.client.post("/v1/search", headers=self.headers, json={"user_id": "alice", "query": "偏好"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private-provider-credential", response.text)


if __name__ == "__main__":
    unittest.main()
