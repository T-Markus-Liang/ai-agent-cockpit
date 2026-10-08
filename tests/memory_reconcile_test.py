"""Tests for the cross-event correction / conflict reducer.

Every fixture is a small, synthetic, in-process list of receipt dicts.  Nothing
touches a database, the network, the clock, real models or the production state
directory: :mod:`services.memory.reconcile` is pure, so these tests are too.
"""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from services.memory.reconcile import ReconcileError, reconcile  # noqa: E402

SLOT = "user:nickname"


def receipt(event_id, text="", created_at=0.0, user_id="u1", **extra):
    """Build a minimal valid receipt; ``extra`` adds source/slot/supersedes/..."""
    item = {"event_id": event_id, "user_id": user_id, "text": text, "created_at": created_at}
    item.update(extra)
    return item


class ReconcileBasicsTest(unittest.TestCase):
    def test_latest_wins_in_shared_slot(self):
        # 小明 -> 小刚: same user, same slot, two facts.  Newest is current.
        old = receipt("e1", text="我叫小明", created_at=100.0, slot=SLOT, source="wechat")
        new = receipt("e2", text="我叫小刚", created_at=200.0, slot=SLOT, source="wechat")

        out = reconcile([old, new])

        self.assertEqual(len(out["current"]), 1)
        self.assertEqual(len(out["superseded"]), 1)
        self.assertEqual(out["conflicts"], [])

        current = out["current"][0]
        self.assertEqual(current["event_id"], "e2")
        self.assertEqual(current["text"], "我叫小刚")
        self.assertEqual(current["version"], 2)
        self.assertIsNone(current["superseded_by"])
        self.assertEqual(current["chain"], ["e1", "e2"])
        # Provenance survives.
        self.assertEqual(current["source"], "wechat")
        self.assertEqual(current["slot"], SLOT)
        self.assertEqual(current["created_at"], 200.0)

        superseded = out["superseded"][0]
        self.assertEqual(superseded["event_id"], "e1")
        self.assertEqual(superseded["version"], 1)
        self.assertEqual(superseded["superseded_by"], "e2")
        self.assertEqual(superseded["chain"], ["e1", "e2"])

    def test_three_step_chain_links_each_to_its_successor(self):
        # A -> B -> C: A's and B's successors are B and C respectively.
        out = reconcile([
            receipt("e1", text="v1", created_at=1.0, slot=SLOT),
            receipt("e2", text="v2", created_at=2.0, slot=SLOT),
            receipt("e3", text="v3", created_at=3.0, slot=SLOT),
        ])
        superseded = {item["event_id"]: item for item in out["superseded"]}
        self.assertEqual(sorted(superseded), ["e1", "e2"])
        self.assertEqual(superseded["e1"]["superseded_by"], "e2")
        self.assertEqual(superseded["e2"]["superseded_by"], "e3")
        self.assertEqual(out["current"][0]["event_id"], "e3")
        self.assertEqual(out["current"][0]["chain"], ["e1", "e2", "e3"])

    def test_slotless_receipts_never_supersede_each_other(self):
        # No slot -> each receipt defaults to its own event_id as its slot, so
        # two unrelated facts both stay current.
        out = reconcile([
            receipt("e1", text="likes tea", created_at=100.0),
            receipt("e2", text="has a cat", created_at=200.0),
        ])
        self.assertEqual({item["event_id"] for item in out["current"]}, {"e1", "e2"})
        self.assertEqual(out["superseded"], [])
        self.assertEqual(out["conflicts"], [])
        for item in out["current"]:
            self.assertEqual(item["version"], 1)
            self.assertIsNone(item["superseded_by"])
            self.assertEqual(item["chain"], [item["event_id"]])

    def test_cross_user_namespaces_are_isolated(self):
        # Same slot string, different users: never supersede across users.
        out = reconcile([
            receipt("a1", user_id="alice", text="我叫小明", created_at=100.0, slot=SLOT),
            receipt("b1", user_id="bob", text="我叫小红", created_at=200.0, slot=SLOT),
        ])
        self.assertEqual({item["event_id"] for item in out["current"]}, {"a1", "b1"})
        self.assertEqual(out["superseded"], [])
        self.assertEqual(out["conflicts"], [])


class ReconcileExplicitSupersedesTest(unittest.TestCase):
    def test_valid_explicit_supersedes_records_the_chain(self):
        # e3 explicitly corrects e1 (skipping e2); the target is superseded by e3.
        out = reconcile([
            receipt("e1", text="old", created_at=100.0, slot=SLOT),
            receipt("e2", text="middle", created_at=200.0, slot=SLOT),
            receipt("e3", text="new", created_at=300.0, slot=SLOT, supersedes="e1"),
        ])
        by_id = {item["event_id"]: item for item in out["superseded"] + out["current"]}
        self.assertEqual(by_id["e1"]["superseded_by"], "e3")
        self.assertEqual(by_id["e2"]["superseded_by"], "e3")
        self.assertEqual(out["current"][0]["event_id"], "e3")
        self.assertEqual(out["conflicts"], [])

    def test_missing_supersede_target_is_a_conflict(self):
        out = reconcile([
            receipt("e1", text="kept", created_at=100.0, slot=SLOT),
            receipt("e2", text="correction", created_at=200.0, slot=SLOT, supersedes="missing"),
        ])
        self.assertEqual([c["event_id"] for c in out["conflicts"]], ["e2"])
        self.assertEqual(out["conflicts"][0]["reason"], "supersede-target-invalid")
        # The would-be target is untouched and remains current.
        self.assertEqual([i["event_id"] for i in out["current"]], ["e1"])
        self.assertIsNone(out["current"][0]["superseded_by"])
        self.assertEqual(out["superseded"], [])

    def test_cross_user_supersede_target_is_a_conflict(self):
        out = reconcile([
            receipt("a1", user_id="alice", text="alice fact", created_at=100.0, slot=SLOT),
            receipt("b1", user_id="bob", text="bob correction", created_at=200.0,
                    slot=SLOT, supersedes="a1"),
        ])
        self.assertEqual([c["event_id"] for c in out["conflicts"]], ["b1"])
        self.assertEqual(out["conflicts"][0]["reason"], "supersede-target-invalid")
        # Alice's fact is unaffected.
        self.assertEqual([i["event_id"] for i in out["current"]], ["a1"])
        self.assertIsNone(out["current"][0]["superseded_by"])

    def test_cross_slot_supersede_target_is_a_conflict(self):
        out = reconcile([
            receipt("e1", text="nickname", created_at=100.0, slot=SLOT),
            receipt("e2", text="bio correction", created_at=200.0,
                    slot="user:bio", supersedes="e1"),
        ])
        self.assertEqual([c["event_id"] for c in out["conflicts"]], ["e2"])
        self.assertEqual(out["conflicts"][0]["reason"], "supersede-target-invalid")
        self.assertEqual({i["event_id"] for i in out["current"]}, {"e1"})
        self.assertIsNone(out["current"][0]["superseded_by"])


class ReconcileConflictTest(unittest.TestCase):
    def test_same_timestamp_conflict_has_no_current(self):
        out = reconcile([
            receipt("e1", text="小明", created_at=100.0, slot=SLOT, source="wechat"),
            receipt("e2", text="小刚", created_at=100.0, slot=SLOT, source="imessage"),
        ])
        self.assertEqual(out["current"], [])
        self.assertEqual(out["superseded"], [])
        self.assertEqual(sorted(c["event_id"] for c in out["conflicts"]), ["e1", "e2"])
        for conflict in out["conflicts"]:
            self.assertEqual(conflict["reason"], "same-timestamp-conflict")
            # Provenance is preserved even for an unresolved fact.
            self.assertEqual(conflict["created_at"], 100.0)
            self.assertEqual(conflict["slot"], SLOT)

    def test_a_tie_does_not_leak_into_a_neighbouring_slot(self):
        # A tie in one slot must not disturb an unrelated, well-ordered slot.
        out = reconcile([
            receipt("t1", text="a", created_at=50.0, slot="user:bio"),
            receipt("t2", text="b", created_at=50.0, slot="user:bio"),
            receipt("n1", text="old", created_at=100.0, slot=SLOT),
            receipt("n2", text="new", created_at=200.0, slot=SLOT),
        ])
        self.assertEqual(sorted(c["event_id"] for c in out["conflicts"]), ["t1", "t2"])
        self.assertEqual([i["event_id"] for i in out["current"]], ["n2"])
        self.assertEqual([i["event_id"] for i in out["superseded"]], ["n1"])


class ReconcileForgottenTest(unittest.TestCase):
    def test_forgotten_receipts_are_skipped_entirely(self):
        out = reconcile([
            receipt("e1", text="forgotten", created_at=100.0, slot=SLOT, forgotten=1),
            receipt("e2", text="kept", created_at=200.0, slot=SLOT, forgotten=0),
        ])
        everything = out["current"] + out["superseded"] + out["conflicts"]
        self.assertNotIn("e1", {item["event_id"] for item in everything})
        self.assertEqual([i["event_id"] for i in out["current"]], ["e2"])
        self.assertEqual(out["superseded"], [])

    def test_bool_forgotten_is_respected(self):
        out = reconcile([
            receipt("e1", text="forgotten", created_at=100.0, slot=SLOT, forgotten=True),
            receipt("e2", text="kept", created_at=200.0, slot=SLOT),
        ])
        self.assertEqual([i["event_id"] for i in out["current"]], ["e2"])
        self.assertEqual([i["event_id"] for i in out["superseded"]], [])


class ReconcileDeterminismTest(unittest.TestCase):
    def _fixture(self):
        return [
            receipt("e1", text="old", created_at=100.0, slot=SLOT, source="wechat"),
            receipt("e2", text="new", created_at=200.0, slot=SLOT, source="imessage"),
            receipt("e3", text="other", created_at=100.0, slot="user:bio"),
            receipt("e4", user_id="bob", text="bob", created_at=150.0, slot=SLOT),
            receipt("e5", text="tie-a", created_at=300.0, slot="user:tie"),
            receipt("e6", text="tie-b", created_at=300.0, slot="user:tie"),
        ]

    def test_output_is_independent_of_input_order(self):
        forward = self._fixture()
        backward = list(reversed(forward))
        shuffled = [forward[i] for i in (3, 0, 5, 2, 4, 1)]
        self.assertEqual(reconcile(forward), reconcile(backward))
        self.assertEqual(reconcile(forward), reconcile(shuffled))

    def test_repeated_calls_are_deeply_equal(self):
        data = self._fixture()
        self.assertEqual(reconcile(data), reconcile(data))

    def test_reingesting_the_output_is_idempotent(self):
        # Feeding a resolved group's current + superseded values back in is a
        # no-op: the reducer is a pure function of the receipt set, so the
        # annotated values reproduce themselves exactly (conflicts are excluded
        # because their ``reason`` is not a receipt field).
        first = reconcile([
            receipt("e1", text="我叫小明", created_at=100.0, slot=SLOT, source="wechat"),
            receipt("e2", text="我叫小刚", created_at=200.0, slot=SLOT, source="wechat"),
        ])
        again = reconcile(first["current"] + first["superseded"])
        self.assertEqual(again, first)
        self.assertEqual(len(again["current"]), 1)
        self.assertEqual(len(again["superseded"]), 1)

    def test_reconciling_current_alone_yields_a_single_version(self):
        out = reconcile([
            receipt("e1", text="old", created_at=100.0, slot=SLOT),
            receipt("e2", text="new", created_at=200.0, slot=SLOT),
        ])
        current = out["current"][0]
        solo = reconcile([current])
        self.assertEqual(len(solo["current"]), 1)
        self.assertEqual(solo["current"][0]["event_id"], current["event_id"])
        self.assertEqual(solo["current"][0]["version"], 1)
        self.assertIsNone(solo["current"][0]["superseded_by"])
        self.assertEqual(solo["superseded"], [])


class ReconcileNoSilentOverwriteTest(unittest.TestCase):
    def test_superseded_value_is_kept_with_full_provenance(self):
        old = receipt("e1", text="我叫小明", created_at=100.0, slot=SLOT, source="wechat")
        new = receipt("e2", text="我叫小刚", created_at=200.0, slot=SLOT, source="wechat")

        out = reconcile([old, new])

        # The old value is not deleted; only its "current" flag moved.
        self.assertNotIn("e1", {i["event_id"] for i in out["current"]})
        superseded = out["superseded"][0]
        self.assertEqual(superseded["event_id"], "e1")
        self.assertEqual(superseded["text"], "我叫小明")
        self.assertEqual(superseded["source"], "wechat")
        self.assertEqual(superseded["slot"], SLOT)
        self.assertEqual(superseded["created_at"], 100.0)
        self.assertEqual(superseded["superseded_by"], "e2")
        self.assertIn("e1", superseded["chain"])
        self.assertIn("e2", superseded["chain"])

    def test_input_receipts_are_not_mutated(self):
        old = receipt("e1", text="old", created_at=100.0, slot=SLOT)
        new = receipt("e2", text="new", created_at=200.0, slot=SLOT)
        snapshot = copy.deepcopy([old, new])
        reconcile([old, new])
        self.assertEqual([old, new], snapshot)


class ReconcileValidationTest(unittest.TestCase):
    def _assert_invalid(self, *receipts):
        with self.assertRaises(ReconcileError) as ctx:
            reconcile(list(receipts))
        self.assertEqual(ctx.exception.code, "invalid-receipt")

    def test_missing_event_id_is_invalid(self):
        self._assert_invalid({"user_id": "u1", "text": "x", "created_at": 1.0})

    def test_empty_user_id_is_invalid(self):
        self._assert_invalid(receipt("e1", user_id="", text="x"))

    def test_non_numeric_created_at_is_invalid(self):
        self._assert_invalid(receipt("e1", text="x", created_at="yesterday"))

    def test_non_finite_created_at_is_invalid(self):
        self._assert_invalid(receipt("e1", text="x", created_at=float("nan")))
        self._assert_invalid(receipt("e1", text="x", created_at=float("inf")))

    def test_non_string_text_is_invalid(self):
        self._assert_invalid(receipt("e1", text=123))

    def test_non_mapping_receipt_is_invalid(self):
        self._assert_invalid("not-a-receipt")

    def test_duplicate_event_id_is_invalid(self):
        self._assert_invalid(
            receipt("e1", text="a", created_at=1.0, slot=SLOT),
            receipt("e1", text="b", created_at=2.0, slot=SLOT),
        )


class ReconcileEdgeTest(unittest.TestCase):
    def test_empty_input_yields_empty_output(self):
        self.assertEqual(reconcile([]), {"current": [], "superseded": [], "conflicts": []})

    def test_empty_string_slot_defaults_to_event_id(self):
        # An empty slot is "no slot": the two receipts do not collide.
        out = reconcile([
            receipt("e1", text="a", created_at=100.0, slot=""),
            receipt("e2", text="b", created_at=200.0, slot=""),
        ])
        self.assertEqual({i["event_id"] for i in out["current"]}, {"e1", "e2"})


if __name__ == "__main__":
    unittest.main()
