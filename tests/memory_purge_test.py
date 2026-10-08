"""Synthetic tests for the permanent-erasure planner/executor (``purge``).

Every fixture is a pure in-memory fake: no SDK, no DB, no network, no real
vector store. The only real collaborator is ``lifecycle.ForgetStore`` in the
revival-protection test, and even there the SQLite database is an in-memory one
built entirely from synthetic data.

The contract under test (V36 — "forget" vs "confirm delete", no old-summary
revival): a purge requires a prior tombstone, erases vector entries through an
injected callback, scrubs the turn payload while preserving its digest, leaves
tombstones intact so replay cannot resurrect the erased source, and never
touches the vendor-owned archive.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import sqlite3
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory import lifecycle, purge  # noqa: E402
from services.memory.purge import PurgeError  # noqa: E402


# --- synthetic builders -----------------------------------------------------
def receipt(event_id, user_id, digest, source_hash, vector_ids, has_archive=False):
    return {"event_id": event_id, "user_id": user_id, "digest": digest,
            "source_hash": source_hash, "vector_ids": list(vector_ids),
            "has_archive": has_archive}


def tombstone(user_id, event_id, source_hash, quote_hashes=None):
    return {"user_id": user_id, "event_id": event_id, "source_hash": source_hash,
            "quote_hashes": list(quote_hashes or [])}


def event_request(user_id, event_id):
    return {"user_id": user_id, "selector": {"event_id": event_id}, "mode": "event"}


def fact_request(user_id, source_hash):
    return {"user_id": user_id, "selector": {"source_hash": source_hash}, "mode": "fact"}


# --- injected-callback fakes (no SDK, no DB) --------------------------------
class FakeVectors:
    """In-memory stand-in for the vector store's delete/exists surface."""

    def __init__(self, ids=None, *, fail_on=None, force_exists=False):
        self.present = set(ids or ())
        self.fail_on = set(fail_on or ())
        # When True, ``exists`` always answers True so a test can force a
        # post-erase verification failure deterministically.
        self.force_exists = force_exists
        self.delete_calls = []
        self.exists_calls = []

    def delete(self, vector_id):
        self.delete_calls.append(vector_id)
        if vector_id in self.fail_on:
            raise RuntimeError("synthetic vector delete failure")
        self.present.discard(vector_id)

    def exists(self, vector_id):
        self.exists_calls.append(vector_id)
        if self.force_exists:
            return True
        return vector_id in self.present


class FakeTurns:
    """In-memory turn rows; ``scrub`` keeps the digest and clears the payload."""

    def __init__(self, records):
        self.rows = {
            event_id: SimpleNamespace(event_id=event_id, digest=record["digest"],
                                      payload=record["payload"], purged=False)
            for event_id, record in records.items()
        }
        self.get_calls = []
        self.scrub_calls = []

    def get(self, event_id):
        self.get_calls.append(event_id)
        return self.rows[event_id]

    def scrub(self, event_id):
        self.scrub_calls.append(event_id)
        row = self.rows[event_id]
        row.payload = {"purged": True}  # content erased, marker left behind
        row.purged = True               # digest deliberately untouched
        return row


def execute(plan, vectors, turns):
    return purge.execute_purge(plan, vectors.delete, turns.scrub,
                               vectors.exists, turns.get)


# --- 1. happy path ----------------------------------------------------------
class HappyPathTests(unittest.TestCase):
    def test_tombstoned_event_plans_and_purges_end_to_end(self):
        rows = [receipt("e1", "u1", "digest-e1", "sh-e1", ["v1", "v2"])]
        tombs = [tombstone("u1", "e1", "sh-e1")]
        plan = purge.plan_purge(rows, tombs, event_request("u1", "e1"))

        self.assertFalse(plan["empty"])
        self.assertEqual(plan["mode"], "event")
        self.assertEqual(plan["tombstones_required"], ())
        self.assertEqual(plan["targets"][0]["event_id"], "e1")
        self.assertEqual(plan["targets"][0]["digest"], "digest-e1")
        self.assertEqual(plan["targets"][0]["vector_ids"], ("v1", "v2"))
        self.assertEqual(plan["verification"]["source_hashes"], ("sh-e1",))

        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "digest-e1", "payload": {"text": "secret"}}})
        result = execute(plan, vectors, turns)

        self.assertEqual(result, {"purged": ["e1"], "already_purged": [], "verified": True})
        self.assertEqual(set(vectors.delete_calls), {"v1", "v2"})
        self.assertEqual(vectors.present, set())
        self.assertEqual(turns.scrub_calls, ["e1"])
        self.assertTrue(turns.rows["e1"].purged)
        self.assertNotIn("text", turns.rows["e1"].payload)


# --- 2. tombstone required --------------------------------------------------
class TombstoneGateTests(unittest.TestCase):
    def test_missing_tombstone_blocks_with_zero_side_effects(self):
        rows = [receipt("e1", "u1", "digest-e1", "sh-e1", ["v1"])]
        plan = purge.plan_purge(rows, [], event_request("u1", "e1"))

        self.assertEqual(plan["tombstones_required"],
                         ({"event_id": "e1", "source_hash": "sh-e1"},))

        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1", "payload": {"text": "secret"}}})
        with self.assertRaises(PurgeError) as ctx:
            execute(plan, vectors, turns)
        self.assertEqual(ctx.exception.code, "tombstone-required")
        # Zero side effects: no callback was even consulted.
        self.assertEqual(vectors.delete_calls, [])
        self.assertEqual(vectors.exists_calls, [])
        self.assertEqual(turns.scrub_calls, [])
        self.assertEqual(turns.get_calls, [])

    def test_tombstone_required_lists_only_unsatisfied_targets(self):
        rows = [receipt("e1", "u1", "d1", "sh", ["v1"]),
                receipt("e2", "u1", "d2", "sh2", ["v2"])]
        # One same-source tombstone satisfies e1 (source_hash match) but not e2.
        tombs = [tombstone("u1", "e1", "sh")]
        plan = purge.plan_purge(rows, tombs, fact_request("u1", "sh"))
        self.assertEqual([t["event_id"] for t in plan["targets"]], ["e1"])
        self.assertEqual(plan["tombstones_required"], ())

        plan_both = purge.plan_purge(rows, [], event_request("u1", "e2"))
        self.assertEqual(plan_both["tombstones_required"],
                         ({"event_id": "e2", "source_hash": "sh2"},))


# --- 3. cross-user isolation ------------------------------------------------
class CrossUserTests(unittest.TestCase):
    def test_other_users_receipt_is_never_a_target(self):
        rows = [receipt("e1", "u2", "digest-e1", "sh-e1", ["v1"])]
        plan = purge.plan_purge(rows, [], event_request("u1", "e1"))
        self.assertTrue(plan["empty"])
        self.assertEqual(plan["targets"], ())
        self.assertEqual(plan["tombstones_required"], ())

    def test_other_users_tombstone_does_not_satisfy(self):
        rows = [receipt("e1", "u1", "digest-e1", "sh-e1", ["v1"])]
        # A tombstone belonging to u2 must not satisfy u1's target.
        tombs = [tombstone("u2", "e1", "sh-e1")]
        plan = purge.plan_purge(rows, tombs, event_request("u1", "e1"))
        self.assertEqual(plan["tombstones_required"],
                         ({"event_id": "e1", "source_hash": "sh-e1"},))


# --- 4. partial failure -----------------------------------------------------
class PartialFailureTests(unittest.TestCase):
    def test_second_vector_delete_failure_reports_completed_and_failed(self):
        rows = [receipt("e1", "u1", "d1", "sh", ["v1"]),
                receipt("e2", "u1", "d2", "sh", ["v2"])]
        tombs = [tombstone("u1", "e1", "sh")]  # source_hash "sh" satisfies both
        plan = purge.plan_purge(rows, tombs, fact_request("u1", "sh"))
        self.assertEqual(plan["tombstones_required"], ())

        vectors = FakeVectors(["v1", "v2"], fail_on={"v2"})
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})
        with self.assertRaises(PurgeError) as ctx:
            execute(plan, vectors, turns)

        error = ctx.exception
        self.assertEqual(error.code, "purge-incomplete")
        self.assertEqual(error.completed, ["e1"])
        self.assertEqual(error.failed, ["e2"])
        # The first target's erase is recorded truthfully, not rolled back.
        self.assertEqual(vectors.delete_calls, ["v1", "v2"])
        self.assertNotIn("v1", vectors.present)
        self.assertEqual(turns.scrub_calls, ["e1"])
        self.assertTrue(turns.rows["e1"].purged)
        self.assertFalse(turns.rows["e2"].purged)


# --- 5. post-erase verification ---------------------------------------------
class VerificationTests(unittest.TestCase):
    def _plan(self):
        rows = [receipt("e1", "u1", "digest-e1", "sh-e1", ["v1"])]
        return purge.plan_purge(rows, [tombstone("u1", "e1", "sh-e1")],
                                event_request("u1", "e1"))

    def test_vector_still_present_fails_verification(self):
        vectors = FakeVectors(["v1"], force_exists=True)
        turns = FakeTurns({"e1": {"digest": "digest-e1", "payload": {"text": "secret"}}})
        with self.assertRaises(PurgeError) as ctx:
            execute(self._plan(), vectors, turns)
        self.assertEqual(ctx.exception.code, "verify-failed")

    def test_digest_change_is_detected(self):
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1", "payload": {"text": "secret"}}})
        original = turns.scrub

        def scrubbing_badly(event_id):
            original(event_id)
            turns.rows[event_id].digest = "tampered"
        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete, scrubbing_badly,
                                vectors.exists, turns.get)
        self.assertEqual(ctx.exception.code, "verify-failed")


# --- 6. digest preservation -------------------------------------------------
class DigestPreservationTests(unittest.TestCase):
    def test_scrub_clears_payload_but_keeps_digest(self):
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1",
                                  "payload": {"text": "keep-me-secret"}}})
        before = turns.rows["e1"].digest
        plan = purge.plan_purge(
            [receipt("e1", "u1", before, "sh-e1", ["v1"])],
            [tombstone("u1", "e1", "sh-e1")], event_request("u1", "e1"))

        execute(plan, vectors, turns)
        self.assertEqual(turns.rows["e1"].digest, before)
        self.assertNotIn("keep-me-secret", json.dumps(turns.rows["e1"].payload))
        self.assertTrue(turns.rows["e1"].payload["purged"])


# --- 7. idempotency ---------------------------------------------------------
class IdempotencyTests(unittest.TestCase):
    def test_replay_reports_already_purged_without_redeleting(self):
        plan = purge.plan_purge(
            [receipt("e1", "u1", "d1", "sh", ["v1", "v2"])],
            [tombstone("u1", "e1", "sh")], event_request("u1", "e1"))
        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})

        first = execute(plan, vectors, turns)
        self.assertEqual(first["purged"], ["e1"])
        deletes_after_first = list(vectors.delete_calls)

        second = execute(plan, vectors, turns)
        self.assertEqual(second["purged"], [])
        self.assertEqual(second["already_purged"], ["e1"])
        self.assertTrue(second["verified"])
        # No second physical delete, and no second scrub.
        self.assertEqual(vectors.delete_calls, deletes_after_first)
        self.assertEqual(turns.scrub_calls, ["e1"])


# --- 8. empty selection -----------------------------------------------------
class EmptyPlanTests(unittest.TestCase):
    def test_no_match_is_reported_empty_and_executes_as_skipped(self):
        plan = purge.plan_purge([], [], event_request("u1", "e1"))
        self.assertTrue(plan["empty"])
        self.assertEqual(plan["targets"], ())
        self.assertEqual(plan["archive_refs"], ())
        self.assertEqual(plan["verification"]["source_hashes"], ())

        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})
        result = execute(plan, vectors, turns)
        self.assertEqual(result, {"purged": [], "already_purged": [], "skipped": True})
        self.assertEqual(vectors.delete_calls, [])
        self.assertEqual(turns.scrub_calls, [])
        self.assertEqual(turns.get_calls, [])


# --- 9. revival protection --------------------------------------------------
class RevivalProtectionTests(unittest.TestCase):
    def test_purge_leaves_tombstone_that_blocks_source_revival(self):
        text = "我喜欢喝茶，请记住这一点。"
        source_hash = hashlib.sha256(text.encode()).hexdigest()

        # The purge plan references a tombstone but carries no way to delete it,
        # and execute_purge only receives vector/turn callbacks (verified below).
        plan = purge.plan_purge(
            [receipt("e1", "u1", "digest-e1", source_hash, ["v1"])],
            [tombstone("u1", "e1", source_hash, sorted(lifecycle.sentence_hashes(text)))],
            event_request("u1", "e1"))
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1", "payload": {"text": text}}})
        execute(plan, vectors, turns)
        # Physical vector is gone and the turn is scrubbed...
        self.assertEqual(vectors.present, set())
        self.assertTrue(turns.rows["e1"].purged)

        # ...but the REAL lifecycle tombstone store still holds the tombstone,
        # and it intercepts a replay of the same source under a brand-new id.
        # This is exactly the "no old-summary revival" checkpoint: the prior
        # soft forget survives the permanent erase and re-suppresses the replay.
        conn = sqlite3.connect(":memory:")
        self.addCleanup(conn.close)
        lifecycle.ensure_schema(conn)
        conn.execute(
            "INSERT INTO tombstones(user_id,event_id,source_hash,quote_hashes,"
            "request_id,created_at) VALUES(?,?,?,?,?,?)",
            ("u1", "e1", source_hash,
             json.dumps(sorted(lifecycle.sentence_hashes(text))), "req-1", time.time()))
        conn.commit()
        store = lifecycle.ForgetStore(lambda: conn)

        matched = store.match("u1", "replayed-under-new-id", text)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["source_hash"], source_hash)
        # The original event id still matches on the event_id branch too.
        self.assertIsNotNone(store.match("u1", "e1", text))

    def test_tombstone_deletion_is_not_part_of_the_execution_surface(self):
        params = set(inspect.signature(purge.execute_purge).parameters)
        self.assertFalse(any("tombstone" in name for name in params))


# --- 10. archive is referenced, never executed ------------------------------
class ArchiveReferenceTests(unittest.TestCase):
    def test_archive_refs_are_referenced_but_never_executed(self):
        plan = purge.plan_purge(
            [receipt("e1", "u1", "d1", "sh", ["v1"], has_archive=True)],
            [tombstone("u1", "e1", "sh")], event_request("u1", "e1"))
        self.assertEqual(plan["archive_refs"], ("e1",))

        # There is no archive callback on the execution surface at all, so the
        # vendor-owned archive cannot be touched by the execution stage.
        params = set(inspect.signature(purge.execute_purge).parameters)
        self.assertFalse(any("archive" in name for name in params))

        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})
        result = execute(plan, vectors, turns)
        # The erase completed while the archive reference stayed inert.
        self.assertTrue(result["verified"])
        self.assertEqual(result["purged"], ["e1"])


# --- 11. request validation -------------------------------------------------
class InvalidRequestTests(unittest.TestCase):
    def setUp(self):
        self.rows = [receipt("e1", "u1", "d1", "sh", ["v1"])]
        self.tombs = [tombstone("u1", "e1", "sh")]

    def _reject(self, rows=None, tombs=None, request=None):
        with self.assertRaises(PurgeError) as ctx:
            purge.plan_purge(self.rows if rows is None else rows,
                             self.tombs if tombs is None else tombs, request)
        self.assertEqual(ctx.exception.code, "invalid-request")

    def test_bad_mode_is_rejected(self):
        self._reject(request={"user_id": "u1", "selector": {"event_id": "e1"},
                              "mode": "user"})
        self._reject(request={"user_id": "u1", "selector": {"event_id": "e1"},
                              "mode": "bogus"})

    def test_bad_selector_is_rejected(self):
        self._reject(request={"user_id": "u1", "selector": {}, "mode": "event"})
        self._reject(request={"user_id": "u1", "selector": {"event_id": ""},
                              "mode": "event"})
        self._reject(request={"user_id": "u1",
                              "selector": {"event_id": "e1", "source_hash": "sh"},
                              "mode": "event"})
        self._reject(request={"user_id": "u1", "selector": {"unknown": "x"},
                              "mode": "event"})
        self._reject(request={"user_id": "u1", "selector": "e1", "mode": "event"})

    def test_mode_selector_mismatch_is_rejected(self):
        self._reject(request={"user_id": "u1", "selector": {"event_id": "e1"},
                              "mode": "fact"})
        self._reject(request={"user_id": "u1", "selector": {"source_hash": "sh"},
                              "mode": "event"})

    def test_missing_request_fields_are_rejected(self):
        self._reject(request={"user_id": "u1", "selector": {"event_id": "e1"}})
        self._reject(request={"selector": {"event_id": "e1"}, "mode": "event"})
        self._reject(request="not-a-dict")

    def test_malformed_receipt_is_rejected(self):
        self._reject(rows=[{"event_id": "e1", "user_id": "u1"}])
        self._reject(rows=[receipt("e1", "u1", "d1", "sh", "v1")])  # vector_ids str
        self._reject(rows=[receipt("e1", "u1", "d1", "sh", ["v1", "v1"])])  # dup id
        bad = receipt("e1", "u1", "d1", "sh", ["v1"])
        bad["extra"] = 1
        self._reject(rows=[bad])
        self._reject(rows="not-a-list")

    def test_malformed_tombstone_is_rejected(self):
        self._reject(tombs=[{"user_id": "u1", "event_id": "e1"}])
        self._reject(tombs=[tombstone("u1", "e1", "sh", [1, 2])])
        self._reject(tombs="not-a-list")


# --- 12. fact mode matches every receipt sharing a source -------------------
class FactModeTests(unittest.TestCase):
    def test_fact_mode_targets_all_receipts_with_same_source(self):
        rows = [receipt("e1", "u1", "d1", "sh", ["v1"]),
                receipt("e2", "u1", "d2", "sh", ["v2"]),
                receipt("e3", "u1", "d3", "other", ["v3"])]
        plan = purge.plan_purge(rows, [tombstone("u1", "e1", "sh")],
                                fact_request("u1", "sh"))
        self.assertEqual([t["event_id"] for t in plan["targets"]], ["e1", "e2"])
        self.assertEqual(plan["tombstones_required"], ())
        self.assertEqual(plan["verification"]["source_hashes"], ("sh",))


# --- 13. plan is a frozen value ---------------------------------------------
class FrozenPlanTests(unittest.TestCase):
    def test_plan_and_nested_targets_cannot_be_mutated(self):
        plan = purge.plan_purge(
            [receipt("e1", "u1", "d1", "sh", ["v1"])],
            [tombstone("u1", "e1", "sh")], event_request("u1", "e1"))
        with self.assertRaises(TypeError):
            plan["mode"] = "fact"  # type: ignore[index]
        with self.assertRaises(TypeError):
            plan["targets"][0]["digest"] = "x"  # type: ignore[index]
        with self.assertRaises(TypeError):
            plan.update({"empty": True})


if __name__ == "__main__":
    unittest.main()
