"""Tests for PE-F003: privacy-epoch binding across the full data lifecycle.

Era semantics under test:

* plans carry the epoch they were prepared under (``privacy_epoch``);
* persisted-plan retries re-verify the binding and settle ``needs_review``
  when the era has moved on (no replay, no silent delete);
* store settles ``needs_review`` (never ``done``) when a reset lands while
  the vector effect is in flight;
* done receipts carry their write-time epoch and recall only surfaces records
  of the CURRENT era: after a reset, prior-era facts are unrecallable;
* vector metadata carries the write-time epoch.

Every fixture is synthetic (tmp dirs + fake memory/evaluator); the production
state directory is never touched.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from services.memory import privacy_epoch
from services.memory.privacy_epoch import EPOCH_UNKNOWN, bump_epoch, get_epoch
from services.memory.service import Mem0Engine, MemoryService, Search, Turn

REPO_ROOT = Path(__file__).resolve().parents[1]
import sys
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

USER = "user-a"


class FakeMemory:
    """Records adds with metadata; search/get_all over the recorded rows."""

    def __init__(self):
        self.rows = []
        self.add_calls = 0

    def add(self, messages, **kwargs):
        self.add_calls += 1
        user_id = kwargs.get("user_id")
        metadata = dict(kwargs.get("metadata") or {})
        results = []
        for message in messages:
            memory_id = f"m{len(self.rows)}"
            self.rows.append({"id": memory_id, "memory": message["content"],
                              "user_id": user_id, "metadata": metadata})
            results.append({"id": memory_id, "memory": message["content"]})
        return {"results": results}

    def search(self, *args, **kwargs):
        filters = kwargs.get("filters") or {}
        return {"results": [
            {"id": row["id"], "memory": row["memory"], "score": 1.0,
             "metadata": dict(row["metadata"])}
            for row in self.rows if row["user_id"] == filters.get("user_id")]}

    def get_all(self, *args, **kwargs):
        filters = kwargs.get("filters") or {}
        return {"results": [
            {"id": row["id"], "memory": row["memory"], "metadata": dict(row["metadata"])}
            for row in self.rows
            if row["user_id"] == filters.get("user_id")
            and (not filters.get("event_id")
                 or row["metadata"].get("event_id") == filters["event_id"])]}


class FakeEvaluator:
    def __init__(self):
        self.calls = 0

    def evaluate(self, state, questions):
        self.calls += 1
        return {"answers": {qid: {"type": "noul", "noul": 0.99} for qid in questions}}


def make_service(tmp: str, memory: FakeMemory) -> MemoryService:
    root = Path(tmp) / "state"
    engine = Mem0Engine(memory=memory, evaluator=FakeEvaluator())
    return MemoryService(root, engine)


def user_turn(event_id: str, text: str) -> Turn:
    return Turn(event_id=event_id, user_id=USER, role="user", text=text,
                source="wechat")


def run_to_done(service: MemoryService, turn: Turn) -> None:
    service.enqueue(turn)
    assert service.process_one() is True
    status = service.status(turn.event_id, turn.user_id)
    assert status["status"] == "done", status


class EraRecallIsolationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.memory = FakeMemory()
        self.service = make_service(self._tmp.name, self.memory)

    def test_prior_era_facts_are_unrecallable_after_reset(self):
        run_to_done(self.service, user_turn("evt-1", "我喜欢手冲咖啡。"))
        self.assertEqual(len(self.service.search(
            Search(user_id=USER, query="咖啡"))["results"]), 1)

        bump_epoch(self.service.state_dir, USER)
        self.assertEqual(get_epoch(self.service.state_dir, USER), 1)

        # Era-0 vectors still physically exist, but recall must surface nothing.
        self.assertEqual(self.service.search(
            Search(user_id=USER, query="咖啡"))["results"], [])
        self.assertEqual(self.service.search(
            Search(user_id=USER, query="咖啡"))["conflicts"], [])

    def test_current_era_facts_recall_normally(self):
        run_to_done(self.service, user_turn("evt-1", "我喜欢手冲咖啡。"))
        bump_epoch(self.service.state_dir, USER)
        run_to_done(self.service, user_turn("evt-2", "今天天气很好。"))

        hits = self.service.search(Search(user_id=USER, query="天气"))["results"]
        self.assertEqual([h["memory"] for h in hits], ["今天天气很好。"])
        # The era-0 fact stays unreachable even when the dumb fake returns all
        # rows: recall filtering must exclude prior-era records by ID.
        hits = self.service.search(Search(user_id=USER, query="咖啡"))["results"]
        self.assertEqual([h["id"] for h in hits], ["m1"])

    def test_unknown_epoch_holds_recall(self):
        run_to_done(self.service, user_turn("evt-1", "我喜欢手冲咖啡。"))
        # Establish the user, then simulate state loss: an established user
        # whose epoch file vanishes reads as EPOCH_UNKNOWN, and recall holds.
        bump_epoch(self.service.state_dir, USER)
        (self.service.state_dir / "privacy-epochs" / (USER + ".json")).unlink()
        self.assertEqual(get_epoch(self.service.state_dir, USER), EPOCH_UNKNOWN)
        with self.assertRaises(privacy_epoch.PrivacyEpochError):
            self.service.search(Search(user_id=USER, query="咖啡"))


class PlanEraBindingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.memory = FakeMemory()
        self.service = make_service(self._tmp.name, self.memory)

    def _pending_with_plan(self, turn: Turn, plan: dict) -> None:
        self.service.enqueue(turn)
        self.service._save_plan(turn.event_id, plan)

    def test_persisted_plan_from_prior_era_settles_needs_review_on_retry(self):
        turn = user_turn("evt-1", "我喜欢手冲咖啡。")
        # Persist a plan as if prepared in era 0 (the normal stamp), then move
        # the era on before the worker retries the event.
        plan = self.service.engine.prepare(turn)
        plan["privacy_epoch"] = 0
        self._pending_with_plan(turn, plan)
        bump_epoch(self.service.state_dir, USER)

        self.assertTrue(self.service.process_one())
        status = self.service.status(turn.event_id, turn.user_id)
        self.assertEqual(status["status"], "needs_review")
        self.assertEqual(status["error_kind"], "privacy_epoch_changed")
        # No vector effect may have happened.
        self.assertEqual(self.memory.rows, [])
        self.assertEqual(self.memory.add_calls, 0)

    def test_unstamped_persisted_plan_cannot_be_proven_and_holds(self):
        turn = user_turn("evt-1", "我喜欢手冲咖啡。")
        plan = self.service.engine.prepare(turn)
        plan.pop("privacy_epoch", None)  # legacy, unstamped
        self._pending_with_plan(turn, plan)

        self.assertTrue(self.service.process_one())
        status = self.service.status(turn.event_id, turn.user_id)
        self.assertEqual(status["status"], "needs_review")
        self.assertEqual(status["error_kind"], "privacy_epoch_changed")
        self.assertEqual(self.memory.add_calls, 0)

    def test_persisted_plan_current_era_retries_normally(self):
        turn = user_turn("evt-1", "我喜欢手冲咖啡。")
        plan = self.service.engine.prepare(turn)
        plan["privacy_epoch"] = 0
        self._pending_with_plan(turn, plan)

        self.assertTrue(self.service.process_one())
        status = self.service.status(turn.event_id, turn.user_id)
        self.assertEqual(status["status"], "done")
        self.assertEqual(self.memory.add_calls, 1)


class StoreSettlementEraTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.memory = FakeMemory()
        self.service = make_service(self._tmp.name, self.memory)

    def test_reset_during_store_settles_needs_review_not_done(self):
        turn = user_turn("evt-1", "我喜欢手冲咖啡。")
        self.service.enqueue(turn)
        original_store = self.service.engine.store

        def racing_store(store_turn, store_plan):
            result = original_store(store_turn, store_plan)
            bump_epoch(self.service.state_dir, store_turn.user_id)
            return result

        self.service.engine.store = racing_store
        self.assertTrue(self.service.process_one())
        status = self.service.status(turn.event_id, turn.user_id)
        self.assertEqual(status["status"], "needs_review")
        self.assertEqual(status["error_kind"], "privacy_epoch_changed")
        # The raced vector exists physically but is never promoted to a
        # trusted/done receipt, so it is never recalled.
        self.assertEqual(len(self.memory.rows), 1)
        self.assertEqual(self.service.search(
            Search(user_id=USER, query="咖啡"))["results"], [])


class VectorMetadataEraTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.memory = FakeMemory()
        self.service = make_service(self._tmp.name, self.memory)

    def test_vector_metadata_carries_write_time_epoch(self):
        run_to_done(self.service, user_turn("evt-1", "我喜欢手冲咖啡。"))
        self.assertEqual(self.memory.rows[0]["metadata"]["privacy_epoch"], 0)

        bump_epoch(self.service.state_dir, USER)
        run_to_done(self.service, user_turn("evt-2", "今天天气很好。"))
        epochs = [row["metadata"]["privacy_epoch"] for row in self.memory.rows]
        self.assertEqual(epochs, [0, 1])


if __name__ == "__main__":
    unittest.main()
