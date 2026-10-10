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
import tempfile
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
    """In-memory turn rows; ``scrub`` keeps the digest and clears *every*
    content copy this layer owns (``payload`` and ``plan``)."""

    ERASED = {"purged": True}  # the marker a scrubbed content field is left as

    def __init__(self, records):
        self.rows = {}
        for event_id, record in records.items():
            row = SimpleNamespace(
                event_id=event_id, digest=record["digest"],
                payload=record.get("payload"),
                plan=record.get("plan", {"facts": [{"quote": "plan-quote"}]}),
                purged=False)
            # Authoritative-identity fields are exposed only when a record
            # supplies them, so a test controls exactly what the boundary fence
            # can see (an absent field is skipped, like a store that omits it).
            for extra in ("user_id", "source_hash", "vector_ids"):
                if extra in record:
                    setattr(row, extra, record[extra])
            self.rows[event_id] = row
        self.get_calls = []
        self.scrub_calls = []

    def get(self, event_id):
        self.get_calls.append(event_id)
        return self.rows[event_id]

    def scrub(self, event_id):
        self.scrub_calls.append(event_id)
        row = self.rows[event_id]
        row.payload = self.ERASED  # content erased, marker left behind
        row.plan = self.ERASED     # the plan/quote copy is erased too
        row.purged = True          # digest deliberately untouched
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


# --- 14. content erasure must be proven, not merely flagged (I02-R2 PG-F001) --
class ContentVerificationTests(unittest.TestCase):
    def _plan(self):
        return purge.plan_purge(
            [receipt("e1", "u1", "digest-e1", "sh-e1", ["v1"])],
            [tombstone("u1", "e1", "sh-e1")], event_request("u1", "e1"))

    def test_marking_without_scrubbing_content_is_not_verified(self):
        # A scrub that sets the flag but leaves the payload/plan intact must not
        # verify: the ``purged`` flag alone never proves the content is gone.
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1",
                                  "payload": {"text": "secret"},
                                  "plan": {"facts": [{"quote": "secret"}]}}})

        def mark_only(event_id):
            turns.rows[event_id].purged = True  # flag set, content kept

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete, mark_only,
                                vectors.exists, turns.get)
        self.assertEqual(ctx.exception.code, "verify-failed")
        self.assertIn("content_present", ctx.exception.detail)
        self.assertEqual(turns.rows["e1"].payload, {"text": "secret"})

    def test_payload_cleared_but_plan_quote_residual_fails(self):
        # Clearing only the payload leaves the plan/quote copy behind -> fail.
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1",
                                  "payload": {"text": "secret"},
                                  "plan": {"facts": [{"quote": "secret-quote"}]}}})

        def clear_payload_only(event_id):
            row = turns.rows[event_id]
            row.payload = {"purged": True}
            row.purged = True  # plan deliberately left intact

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete, clear_payload_only,
                                vectors.exists, turns.get)
        self.assertEqual(ctx.exception.code, "verify-failed")
        self.assertIn("content_present", ctx.exception.detail)
        self.assertIn("plan", ctx.exception.detail)

    def test_scrub_without_persistent_effect_fails_verification(self):
        # A scrub that reports success but changes nothing must not verify.
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1",
                                  "payload": {"text": "secret"}}})
        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete,
                                lambda event_id: None, vectors.exists, turns.get)
        self.assertEqual(ctx.exception.code, "verify-failed")

    def test_turn_without_content_fields_is_unverifiable(self):
        # A read surface exposing only purged/digest cannot support an erasure
        # claim: the outcome is unverifiable, never ``verified=True``.
        vectors = FakeVectors(["v1"])
        flag_only = SimpleNamespace(purged=True, digest="digest-e1")
        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete,
                                lambda event_id: None, lambda vector_id: False,
                                lambda event_id: flag_only)
        self.assertEqual(ctx.exception.code, "unverifiable")


# --- 15. digest drift is refused before any effect (I02-R2 PG-F002) ----------
class PreflightDriftTests(unittest.TestCase):
    def test_digest_drift_before_execution_rejects_with_zero_effects(self):
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "digest-e1",
                                  "payload": {"text": "secret"}}})
        turns.rows["e1"].digest = "digest-NEW"  # drifted since planning
        plan = purge.plan_purge([receipt("e1", "u1", "digest-e1", "sh-e1", ["v1"])],
                                [tombstone("u1", "e1", "sh-e1")],
                                event_request("u1", "e1"))

        with self.assertRaises(PurgeError) as ctx:
            execute(plan, vectors, turns)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.drifted, ["e1"])
        self.assertEqual(error.completed, [])
        # Zero effects: no vector delete, no scrub, content untouched.
        self.assertEqual(vectors.delete_calls, [])
        self.assertEqual(turns.scrub_calls, [])
        self.assertEqual(turns.rows["e1"].payload, {"text": "secret"})
        self.assertFalse(turns.rows["e1"].purged)

    def test_second_target_drift_erases_first_and_rejects_second(self):
        rows = [receipt("e1", "u1", "d1", "sh", ["v1"]),
                receipt("e2", "u1", "d2", "sh", ["v2"])]
        plan = purge.plan_purge(rows, [tombstone("u1", "e1", "sh")],
                                fact_request("u1", "sh"))
        self.assertEqual(plan["tombstones_required"], ())

        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})
        turns.rows["e2"].digest = "d2-DRIFTED"  # the later target drifted

        with self.assertRaises(PurgeError) as ctx:
            execute(plan, vectors, turns)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.completed, ["e1"])   # first erase stands, truthfully
        self.assertEqual(error.drifted, ["e2"])      # second refused, zero effects
        # First target erased...
        self.assertNotIn("v1", vectors.present)
        self.assertEqual(turns.scrub_calls, ["e1"])
        self.assertTrue(turns.rows["e1"].purged)
        # ...second target untouched: no delete, no scrub, content intact.
        self.assertIn("v2", vectors.present)
        self.assertNotIn("v2", vectors.delete_calls)
        self.assertFalse(turns.rows["e2"].purged)
        self.assertEqual(turns.rows["e2"].payload, {"text": "two"})

    def test_first_target_drift_still_erases_confirmable_sibling(self):
        # The WHOLE batch is checked before any effect, so a drifted first
        # target is refused just as early as a drifted later one.
        rows = [receipt("e1", "u1", "d1", "sh", ["v1"]),
                receipt("e2", "u1", "d2", "sh", ["v2"])]
        plan = purge.plan_purge(rows, [tombstone("u1", "e1", "sh")],
                                fact_request("u1", "sh"))
        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})
        turns.rows["e1"].digest = "d1-DRIFTED"

        with self.assertRaises(PurgeError) as ctx:
            execute(plan, vectors, turns)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.drifted, ["e1"])
        self.assertEqual(error.completed, ["e2"])
        self.assertEqual(vectors.delete_calls, ["v2"])
        self.assertEqual(turns.scrub_calls, ["e2"])
        self.assertFalse(turns.rows["e1"].purged)
        self.assertEqual(turns.rows["e1"].payload, {"text": "one"})


# --- 16. content stays erased after reopening the store ---------------------
class _SqliteTurns:
    """A sqlite-backed turn store a test can close and re-open (payload/plan)."""

    def __init__(self, path, records):
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            "CREATE TABLE turns(event_id TEXT PRIMARY KEY, user_id TEXT, digest TEXT,"
            " source_hash TEXT, vector_ids TEXT, payload TEXT, plan TEXT,"
            " purged INTEGER NOT NULL DEFAULT 0)")
        for event_id, record in records.items():
            self.conn.execute(
                "INSERT INTO turns(event_id,user_id,digest,source_hash,vector_ids,"
                "payload,plan,purged) VALUES(?,?,?,?,?,?,?,0)",
                (event_id, record.get("user_id"), record["digest"],
                 record.get("source_hash"), json.dumps(record.get("vector_ids")),
                 json.dumps(record.get("payload")), json.dumps(record.get("plan"))))
        self.conn.commit()

    def raw(self, event_id):
        return self.conn.execute(
            "SELECT digest,payload,plan,purged FROM turns WHERE event_id=?",
            (event_id,)).fetchone()

    def get(self, event_id):
        user_id, digest, source_hash, vector_ids, payload, plan, purged = (
            self.conn.execute(
                "SELECT user_id,digest,source_hash,vector_ids,payload,plan,purged"
                " FROM turns WHERE event_id=?", (event_id,)).fetchone())
        row = SimpleNamespace(event_id=event_id, digest=digest,
                              payload=json.loads(payload), plan=json.loads(plan),
                              purged=bool(purged))
        # Expose identity fields only when the record supplies them, so this fake
        # mirrors a real surface that may or may not carry them.
        if user_id is not None:
            row.user_id = user_id
        if source_hash is not None:
            row.source_hash = source_hash
        if vector_ids is not None:
            row.vector_ids = json.loads(vector_ids)
        return row

    def scrub(self, event_id):
        marker = json.dumps({"purged": True})
        self.conn.execute("UPDATE turns SET payload=?,plan=?,purged=1 WHERE event_id=?",
                          (marker, marker, event_id))
        self.conn.commit()

    def reopen(self):
        self.conn.close()
        self.conn = sqlite3.connect(self.path)


class ReopenTests(unittest.TestCase):
    def test_content_stays_erased_after_reopen_and_replay_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _SqliteTurns(str(Path(tmp) / "turns.sqlite"),
                                 {"e1": {"digest": "digest-e1",
                                         "payload": {"text": "secret"},
                                         "plan": {"facts": [{"quote": "secret"}]}}})
            self.addCleanup(store.conn.close)
            plan = purge.plan_purge([receipt("e1", "u1", "digest-e1", "sh-e1", ["v1"])],
                                    [tombstone("u1", "e1", "sh-e1")],
                                    event_request("u1", "e1"))
            vectors = FakeVectors(["v1"])
            first = purge.execute_purge(plan, vectors.delete, store.scrub,
                                        vectors.exists, store.get)
            self.assertEqual(first, {"purged": ["e1"], "already_purged": [],
                                     "verified": True})

            # Close and re-open the durable store: plaintext gone, digest kept.
            store.reopen()
            digest, payload, plan_json, purged = store.raw("e1")
            self.assertEqual(digest, "digest-e1")
            self.assertTrue(purged)
            self.assertNotIn("secret", payload)
            self.assertNotIn("secret", plan_json)
            self.assertEqual(json.loads(payload), {"purged": True})
            self.assertEqual(json.loads(plan_json), {"purged": True})

            # A replay after reopening reports already_purged, re-deleting nothing.
            second = purge.execute_purge(plan, vectors.delete, store.scrub,
                                         vectors.exists, store.get)
            self.assertEqual(second["already_purged"], ["e1"])
            self.assertEqual(second["purged"], [])
            self.assertTrue(second["verified"])


# --- 17. the rework's new error codes are part of the contract --------------
class PurgeErrorCodeTests(unittest.TestCase):
    def test_new_codes_are_recognized(self):
        for code in ("drifted-target", "unverifiable"):
            self.assertIn(code, purge.PURGE_ERROR_CODES)
            error = PurgeError(code, completed=["a"], drifted=["b"])
            self.assertEqual(error.completed, ["a"])
            self.assertEqual(error.drifted, ["b"])
        with self.assertRaises(ValueError):
            PurgeError("not-a-real-code")

    def test_error_carries_per_target_statuses(self):
        error = PurgeError("drifted-target", statuses={"a": "refused-drift"})
        self.assertEqual(error.statuses, {"a": "refused-drift"})
        self.assertEqual(PurgeError("drifted-target").statuses, {})


# --- 18. identity is re-fenced at each effect boundary (I02-R3 PG-F002) -------
class EffectBoundaryFenceTests(unittest.TestCase):
    """PG-F002 r3: a target's identity is re-read and re-compared to the plan
    *immediately before every* delete/scrub, not merely once up front. A single
    synchronous scan cannot prove the check-to-effect window is closed, because a
    sibling target's own effect can let a concurrent writer change a later target
    in between."""

    def _two_target_plan(self):
        rows = [receipt("e1", "u1", "d1", "sh", ["v1"]),
                receipt("e2", "u1", "d2", "sh", ["v2"])]
        return purge.plan_purge(rows, [tombstone("u1", "e1", "sh")],
                                fact_request("u1", "sh"))

    def test_sibling_effect_drift_keeps_second_target_untouched(self):
        # The audit's exact interleaving: both digests match at preflight; during
        # target 1's delete callback another writer rewrites target 2's digest and
        # payload. Target 2 must still keep zero scrub and zero delete.
        plan = self._two_target_plan()
        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})

        def delete_with_concurrent_writer(vector_id):
            vectors.delete(vector_id)
            if vector_id == "v1":
                turns.rows["e2"].digest = "d2-NEW"
                turns.rows["e2"].payload = {"text": "brand-new-secret"}

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(plan, delete_with_concurrent_writer, turns.scrub,
                                vectors.exists, turns.get)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.completed, ["e1"])
        self.assertEqual(error.drifted, ["e2"])
        self.assertEqual(error.statuses, {"e1": "completed", "e2": "refused-drift"})
        self.assertEqual(error.detail, "pre_effect_identity_drift")
        # Target 1 was erased truthfully...
        self.assertNotIn("v1", vectors.present)
        self.assertTrue(turns.rows["e1"].purged)
        # ...target 2 kept zero effects: its vector is NOT deleted and its NEW
        # content is NOT scrubbed.
        self.assertEqual(vectors.delete_calls, ["v1"])
        self.assertIn("v2", vectors.present)
        self.assertFalse(turns.rows["e2"].purged)
        self.assertEqual(turns.rows["e2"].payload, {"text": "brand-new-secret"})

    def test_commit_between_preflight_and_first_effect_is_refused(self):
        # A commit that lands after the preflight read but before the target's
        # boundary read is caught by the boundary re-check.
        plan = purge.plan_purge([receipt("e1", "u1", "d1", "sh", ["v1"])],
                                [tombstone("u1", "e1", "sh")],
                                event_request("u1", "e1"))
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})
        calls = {"n": 0}
        real_get = turns.get

        def get_with_concurrent_commit(event_id):
            calls["n"] += 1
            if calls["n"] == 2:  # after preflight, right at the boundary read
                turns.rows[event_id].digest = "d1-NEW"
                turns.rows[event_id].payload = {"text": "new-secret"}
            return real_get(event_id)

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(plan, vectors.delete, turns.scrub, vectors.exists,
                                get_with_concurrent_commit)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.statuses, {"e1": "refused-drift"})
        self.assertEqual(error.detail, "pre_effect_identity_drift")
        # Zero effects: the new content is neither deleted nor scrubbed.
        self.assertEqual(vectors.delete_calls, [])
        self.assertEqual(turns.scrub_calls, [])
        self.assertFalse(turns.rows["e1"].purged)
        self.assertEqual(turns.rows["e1"].payload, {"text": "new-secret"})

    def test_drift_before_current_vector_delete_stops_remaining_effects(self):
        # Drift injected right before the current vector's delete: the remaining
        # vector is left in place, the turn is NOT scrubbed, and the partial
        # dispatch is reported honestly (not as a completed target).
        plan = purge.plan_purge([receipt("e1", "u1", "d1", "sh", ["v1a", "v1b"])],
                                [tombstone("u1", "e1", "sh")],
                                event_request("u1", "e1"))
        vectors = FakeVectors(["v1a", "v1b"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})

        def delete_then_write(vector_id):
            vectors.delete(vector_id)
            if vector_id == "v1a":
                turns.rows["e1"].digest = "d1-NEW"
                turns.rows["e1"].payload = {"text": "rewritten"}

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(plan, delete_then_write, turns.scrub,
                                vectors.exists, turns.get)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.drifted, ["e1"])
        self.assertEqual(error.statuses, {"e1": "unknown"})
        # v1b was NOT deleted (the turn changed under it) and content NOT scrubbed.
        self.assertEqual(vectors.delete_calls, ["v1a"])
        self.assertIn("v1b", vectors.present)
        self.assertEqual(turns.scrub_calls, [])
        self.assertFalse(turns.rows["e1"].purged)
        self.assertEqual(turns.rows["e1"].payload, {"text": "rewritten"})

    def test_withdrawn_approval_between_targets_refuses_the_second(self):
        plan = self._two_target_plan()
        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})

        def approval(user_id, event_id, source_hash):
            # Approval is revoked the moment the first target has been erased.
            return not (event_id == "e2" and turns.rows["e1"].purged)

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(plan, vectors.delete, turns.scrub, vectors.exists,
                                turns.get, guard_approval=approval)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.completed, ["e1"])
        self.assertEqual(error.drifted, ["e2"])
        self.assertEqual(error.statuses, {"e1": "completed", "e2": "refused-drift"})
        self.assertEqual(vectors.delete_calls, ["v1"])
        self.assertFalse(turns.rows["e2"].purged)
        self.assertEqual(turns.rows["e2"].payload, {"text": "two"})

    def test_non_drifted_batch_still_erases_every_target(self):
        # Over-refusal guard: with no drift both targets erase as before.
        plan = self._two_target_plan()
        vectors = FakeVectors(["v1", "v2"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})
        result = purge.execute_purge(plan, vectors.delete, turns.scrub,
                                     vectors.exists, turns.get)
        self.assertEqual(result, {"purged": ["e1", "e2"], "already_purged": [],
                                  "verified": True})
        self.assertEqual(vectors.present, set())
        self.assertEqual(turns.scrub_calls, ["e1", "e2"])


# --- 19. atomic conditional effects narrow the window ------------------------
class ConditionalEffectTests(unittest.TestCase):
    """When the store can enforce the precondition in its own critical section,
    the conditional callbacks are used so the check and the effect are one step."""

    def _plan(self):
        return purge.plan_purge([receipt("e1", "u1", "d1", "sh", ["v1"])],
                                [tombstone("u1", "e1", "sh")],
                                event_request("u1", "e1"))

    def test_conditional_effects_receive_the_approved_digest(self):
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})
        delete_seen = []
        scrub_seen = []

        def cond_delete(vector_id, expected_digest):
            delete_seen.append((vector_id, expected_digest))
            vectors.delete(vector_id)
            return True

        def cond_scrub(event_id, expected_digest):
            scrub_seen.append((event_id, expected_digest))
            turns.scrub(event_id)
            return True

        result = purge.execute_purge(self._plan(), vectors.delete, turns.scrub,
                                     vectors.exists, turns.get,
                                     delete_vector_if=cond_delete,
                                     scrub_turn_if=cond_scrub)
        self.assertTrue(result["verified"])
        self.assertEqual(result["purged"], ["e1"])
        self.assertEqual(delete_seen, [("v1", "d1")])
        self.assertEqual(scrub_seen, [("e1", "d1")])

    def test_conditional_delete_precondition_failure_refuses_with_zero_effects(self):
        # The store's conditional delete affects 0 rows (the digest changed under
        # it): the effect is refused cleanly, with no delete and no scrub.
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "secret"}}})

        def refuse(vector_id, expected_digest):
            return False

        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete, turns.scrub,
                                vectors.exists, turns.get,
                                delete_vector_if=refuse)
        error = ctx.exception
        self.assertEqual(error.code, "drifted-target")
        self.assertEqual(error.statuses, {"e1": "refused-drift"})
        self.assertEqual(vectors.delete_calls, [])
        self.assertEqual(turns.scrub_calls, [])
        self.assertEqual(turns.rows["e1"].payload, {"text": "secret"})


# --- 20. drift beyond the digest: source / owner / vector binding ------------
class IdentityFieldDriftTests(unittest.TestCase):
    def _plan(self):
        return purge.plan_purge([receipt("e1", "u1", "d1", "sh", ["v1"])],
                                [tombstone("u1", "e1", "sh")],
                                event_request("u1", "e1"))

    def _refuse(self, record):
        vectors = FakeVectors(["v1"])
        turns = FakeTurns({"e1": record})
        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(self._plan(), vectors.delete, turns.scrub,
                                vectors.exists, turns.get)
        self.assertEqual(ctx.exception.code, "drifted-target")
        self.assertEqual(ctx.exception.statuses, {"e1": "refused-drift"})
        # Zero effects for the refused target.
        self.assertEqual(vectors.delete_calls, [])
        self.assertEqual(turns.scrub_calls, [])
        self.assertFalse(turns.rows["e1"].purged)
        return turns

    def test_source_hash_drift_is_refused(self):
        self._refuse({"digest": "d1", "source_hash": "sh-CHANGED",
                      "payload": {"text": "secret"}})

    def test_vector_binding_drift_is_refused(self):
        self._refuse({"digest": "d1", "vector_ids": ["v-OTHER"],
                      "payload": {"text": "secret"}})

    def test_owner_change_is_refused(self):
        self._refuse({"digest": "d1", "user_id": "u2", "payload": {"text": "secret"}})


# --- 21. async commit / connection reopen interleaving -----------------------
class AsyncCommitInterleavingTests(unittest.TestCase):
    """A separate connection commits new content between the preflight read and a
    later target's effect, simulating an asynchronous submit."""

    def test_committed_change_between_preflight_and_effect_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "turns.sqlite")
            store = _SqliteTurns(path, {
                "e1": {"user_id": "u1", "digest": "d1", "source_hash": "sh",
                       "vector_ids": ["v1"], "payload": {"text": "one"},
                       "plan": {"facts": [{"quote": "one"}]}},
                "e2": {"user_id": "u1", "digest": "d2", "source_hash": "sh",
                       "vector_ids": ["v2"], "payload": {"text": "two"},
                       "plan": {"facts": [{"quote": "two"}]}},
            })
            self.addCleanup(store.conn.close)
            plan = purge.plan_purge(
                [receipt("e1", "u1", "d1", "sh", ["v1"]),
                 receipt("e2", "u1", "d2", "sh", ["v2"])],
                [tombstone("u1", "e1", "sh")], fact_request("u1", "sh"))
            self.assertEqual(plan["tombstones_required"], ())

            def delete_and_commit_elsewhere(vector_id):
                if vector_id == "v1":
                    other = sqlite3.connect(path)
                    other.execute(
                        "UPDATE turns SET digest=?,payload=? WHERE event_id=?",
                        ("d2-NEW", json.dumps({"text": "brand-new-secret"}), "e2"))
                    other.commit()
                    other.close()

            with self.assertRaises(PurgeError) as ctx:
                purge.execute_purge(plan, delete_and_commit_elsewhere, store.scrub,
                                    lambda vector_id: False, store.get)
            error = ctx.exception
            self.assertEqual(error.code, "drifted-target")
            self.assertEqual(error.completed, ["e1"])
            self.assertEqual(error.drifted, ["e2"])
            self.assertEqual(error.statuses, {"e1": "completed", "e2": "refused-drift"})

            # e1's erase is durable; e2's brand-new content survives untouched.
            digest, payload, _plan_json, purged = store.raw("e2")
            self.assertEqual(digest, "d2-NEW")
            self.assertIn("brand-new-secret", payload)
            self.assertFalse(purged)
            self.assertTrue(store.raw("e1")[3])

            # Re-open the store: e1 stays erased (digest kept), e2 keeps its text.
            store.reopen()
            self.assertEqual(store.raw("e1")[0], "d1")
            self.assertNotIn("one", store.raw("e1")[1])
            self.assertIn("brand-new-secret", store.raw("e2")[1])
            self.assertEqual(store.raw("e2")[0], "d2-NEW")

    def test_connection_reopen_without_drift_still_erases(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "turns.sqlite")
            store = _SqliteTurns(path, {
                "e1": {"user_id": "u1", "digest": "d1", "source_hash": "sh",
                       "vector_ids": ["v1"], "payload": {"text": "secret"},
                       "plan": {"facts": [{"quote": "secret"}]}},
            })
            self.addCleanup(store.conn.close)
            store.reopen()  # a fresh connection: the identity must still match
            plan = purge.plan_purge([receipt("e1", "u1", "d1", "sh", ["v1"])],
                                    [tombstone("u1", "e1", "sh")],
                                    event_request("u1", "e1"))
            result = purge.execute_purge(plan, lambda vector_id: None, store.scrub,
                                         lambda vector_id: False, store.get)
            self.assertTrue(result["verified"])
            self.assertEqual(result["purged"], ["e1"])
            self.assertNotIn("secret", store.raw("e1")[1])
            self.assertEqual(store.raw("e1")[0], "d1")


# --- 22. per-target status is explicit on a partial batch --------------------
class PerTargetStatusTests(unittest.TestCase):
    def test_statuses_map_every_target_on_a_mid_batch_failure(self):
        plan = purge.plan_purge(
            [receipt("e1", "u1", "d1", "sh", ["v1"]),
             receipt("e2", "u1", "d2", "sh", ["v2"])],
            [tombstone("u1", "e1", "sh")], fact_request("u1", "sh"))
        vectors = FakeVectors(["v1", "v2"], fail_on={"v2"})
        turns = FakeTurns({"e1": {"digest": "d1", "payload": {"text": "one"}},
                           "e2": {"digest": "d2", "payload": {"text": "two"}}})
        with self.assertRaises(PurgeError) as ctx:
            purge.execute_purge(plan, vectors.delete, turns.scrub,
                                vectors.exists, turns.get)
        error = ctx.exception
        self.assertEqual(error.code, "purge-incomplete")
        self.assertEqual(error.statuses, {"e1": "completed", "e2": "failed"})
        self.assertEqual(error.completed, ["e1"])
        self.assertEqual(error.failed, ["e2"])


if __name__ == "__main__":
    unittest.main()
