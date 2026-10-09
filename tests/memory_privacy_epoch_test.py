"""Tests for the S04 privacy epoch (remediation 2026-10-09 §6-1).

Every fixture is a private, synthetic temp directory. No host data, real
models, SDK memory stores or services are touched: the production state
directory ``~/.local/state/personal-ai-os/mem0`` is never read or written, no
network/evaluator call is made, and every epoch file under test is created by
these tests. The boundary tests construct a ``MemoryService`` over a tmp state
dir with an injected fake engine — exactly how the service tests already work.
"""
from __future__ import annotations

import hashlib
import json
import fcntl
import multiprocessing
import os
import sqlite3
import stat
import tempfile
import unittest
import time
from pathlib import Path
from unittest.mock import Mock, patch

from services.memory import lifecycle, privacy_epoch, quality
from services.memory.privacy_epoch import (
    EPOCH_UNKNOWN, PrivacyEpochError, bump_epoch, filter_by_epoch, get_epoch)
from services.memory.service import MemoryService, Search, Turn

REPO_ROOT = Path(__file__).resolve().parents[1]
import sys
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

USER = "user-a"


def digest_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def epoch_file(state_dir: Path, user_id: str = USER) -> Path:
    return state_dir / "privacy-epochs" / (user_id + ".json")


def concurrent_reset(state, start, results, delay=True):
    """A real process, delayed after its read to reproduce the old race."""
    original = privacy_epoch._read_current

    def delayed_read(*args, **kwargs):
        value = original(*args, **kwargs)
        if delay:
            time.sleep(0.2)
        return value

    try:
        results.put(("ready", os.getpid()))
        if not start.wait(5):
            raise RuntimeError("start timeout")
        with patch.object(privacy_epoch, "_read_current", delayed_read), \
                patch.object(privacy_epoch, "_LOCK_TIMEOUT_SECONDS", 0.8):
            results.put(("ok", bump_epoch(state, USER)))
    except PrivacyEpochError as exc:
        results.put(("error", exc.code))


class FakeMemory:
    """Minimal vector-store double: no candidates, add records calls."""

    def __init__(self):
        self.search_calls = 0
        self.add_calls = 0

    def search(self, *args, **kwargs):
        self.search_calls += 1
        return {"results": []}

    def get_all(self, *args, **kwargs):
        return {"results": []}

    def add(self, messages, **kwargs):
        self.add_calls += 1
        return {"results": [{"id": "m1", "memory": messages[0]["content"]}]}


class FakeEvaluator:
    def __init__(self):
        self.calls = 0

    def evaluate(self, state, questions):
        self.calls += 1
        answers = {qid: {"type": "noul", "noul": 0.99} for qid in questions}
        return {"answers": answers}


def make_service(tmp: str, engine=None) -> MemoryService:
    root = Path(tmp) / "state"
    if engine is None:
        from services.memory.service import Mem0Engine
        engine = Mem0Engine(memory=FakeMemory(), evaluator=FakeEvaluator())
    return MemoryService(root, engine)


def enqueue_user_turn(service: MemoryService, event_id: str, text: str,
                      user_id: str = USER) -> None:
    service.enqueue(Turn(event_id=event_id, user_id=user_id, role="user",
                         text=text, source="wechat"))


# ---------------------------------------------------------------------------
# epoch state: round trip, monotonic bump, atomic write
# ---------------------------------------------------------------------------
class EpochStateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name) / "state"

    def test_absent_user_is_epoch_zero_known(self):
        self.assertEqual(get_epoch(self.state, USER), 0)

    def test_bump_then_get_round_trip(self):
        self.assertEqual(bump_epoch(self.state, USER), 1)
        self.assertEqual(get_epoch(self.state, USER), 1)
        self.assertEqual(bump_epoch(self.state, USER), 2)
        self.assertEqual(get_epoch(self.state, USER), 2)

    def test_bump_is_monotonic_and_strictly_increasing(self):
        values = [bump_epoch(self.state, USER) for _ in range(5)]
        self.assertEqual(values, [1, 2, 3, 4, 5])
        self.assertEqual(len(set(values)), 5)

    def test_users_are_isolated(self):
        bump_epoch(self.state, USER)
        bump_epoch(self.state, USER)
        self.assertEqual(get_epoch(self.state, USER), 2)
        self.assertEqual(get_epoch(self.state, "user-b"), 0)
        self.assertEqual(bump_epoch(self.state, "user-b"), 1)
        self.assertEqual(get_epoch(self.state, USER), 2)

    def test_atomic_write_shape_and_modes(self):
        bump_epoch(self.state, USER)
        epoch_dir = self.state / "privacy-epochs"
        self.assertTrue(epoch_dir.is_dir())
        self.assertEqual(epoch_dir.stat().st_mode & 0o777, 0o700)
        target = epoch_file(self.state)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        # No tmp residue is left behind by the atomic write.
        self.assertEqual(sorted(p.name for p in epoch_dir.iterdir()),
                         [USER + ".json", USER + ".lock"])
        self.assertEqual((epoch_dir / (USER + ".lock")).stat().st_mode & 0o777, 0o600)
        doc = json.loads(target.read_text())
        self.assertEqual(set(doc), {"version", "user_id", "epoch", "updated_at"})
        self.assertEqual(doc["user_id"], USER)
        self.assertEqual(doc["epoch"], 1)

    def test_bump_does_not_delete_or_modify_native_history(self):
        service = make_service(self._tmp.name)
        enqueue_user_turn(service, "evt-1", "我喜欢手冲咖啡。")
        db_file = service.db_file
        before = digest_file(db_file)
        bump_epoch(service.state_dir, USER)
        self.assertEqual(digest_file(db_file), before)
        # The raw receipt is still readable, untouched.
        with service.connect() as db:
            row = db.execute("SELECT payload,status FROM turns WHERE event_id=?",
                             ("evt-1",)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(json.loads(row[0])["text"], "我喜欢手冲咖啡。")

    def test_invalid_user_id_fails_closed(self):
        for bad in ("", "a/b", "..", "x" * 201, "../escape", "a\\b", None, 7):
            self.assertEqual(get_epoch(self.state, bad), EPOCH_UNKNOWN, bad)
            with self.assertRaises(PrivacyEpochError):
                bump_epoch(self.state, bad)

    def test_invalid_state_dir_fails_closed(self):
        self.assertEqual(get_epoch(None, USER), EPOCH_UNKNOWN)
        self.assertEqual(get_epoch(12345, USER), EPOCH_UNKNOWN)

    def test_two_concurrent_process_resets_are_unique_and_never_roll_back(self):
        for _ in range(5):
            bump_epoch(self.state, USER)
        ctx = multiprocessing.get_context("spawn")
        start, results = ctx.Event(), ctx.Queue()
        workers = [ctx.Process(target=concurrent_reset,
                               args=(self.state, start, results)) for _ in range(2)]
        try:
            for worker in workers:
                worker.start()
            self.assertEqual([results.get(timeout=10)[0] for _ in workers],
                             ["ready", "ready"])
            start.set()
            replies = [results.get(timeout=10) for _ in workers]
            for worker in workers:
                worker.join(5)
                self.assertEqual(worker.exitcode, 0)
            self.assertEqual(sorted(replies), [("ok", 6), ("ok", 7)])
            self.assertEqual(get_epoch(self.state, USER), 7)
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                    worker.join(5)
            results.close()
            results.join_thread()

    def test_lock_contention_in_another_process_times_out_without_reset(self):
        bump_epoch(self.state, USER)
        before = epoch_file(self.state).read_bytes()
        ctx = multiprocessing.get_context("spawn")
        start, results = ctx.Event(), ctx.Queue()
        with (self.state / "privacy-epochs" / (USER + ".lock")).open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            worker = ctx.Process(target=concurrent_reset,
                                 args=(self.state, start, results, False))
            worker.start()
            try:
                self.assertEqual(results.get(timeout=10)[0], "ready")
                start.set()
                self.assertEqual(results.get(timeout=10), ("error", "epoch-lock-timeout"))
                worker.join(5)
                self.assertEqual(worker.exitcode, 0)
                self.assertEqual(epoch_file(self.state).read_bytes(), before)
            finally:
                if worker.is_alive():
                    worker.terminate()
                    worker.join(5)
                results.close()
                results.join_thread()
        self.assertEqual(bump_epoch(self.state, USER), 2)


# ---------------------------------------------------------------------------
# corrupt / tampered state -> EPOCH_UNKNOWN; bump refuses over corruption
# ---------------------------------------------------------------------------
class EpochCorruptionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name) / "state"
        bump_epoch(self.state, USER)

    def _corrupt(self):
        epoch_file(self.state).write_bytes(b"this is not json {")

    def test_garbage_file_is_unknown_not_zero_not_old_value(self):
        self.assertEqual(get_epoch(self.state, USER), 1)
        self._corrupt()
        epoch = get_epoch(self.state, USER)
        self.assertEqual(epoch, EPOCH_UNKNOWN)
        self.assertNotEqual(epoch, 0)
        self.assertNotEqual(epoch, 1)

    def test_tampered_documents_are_unknown(self):
        cases = [
            {"version": 1, "user_id": USER, "epoch": 5, "updated_at": 1.0, "extra": 1},
            {"version": 2, "user_id": USER, "epoch": 1, "updated_at": 1.0},
            {"version": 1, "user_id": "someone-else", "epoch": 1, "updated_at": 1.0},
            {"version": 1, "user_id": USER, "epoch": -3, "updated_at": 1.0},
            {"version": 1, "user_id": USER, "epoch": True, "updated_at": 1.0},
            {"version": 1, "user_id": USER, "epoch": "3", "updated_at": 1.0},
            ["not", "a", "dict"],
            b"\xff\xfe\x00binary",
        ]
        for doc in cases:
            raw = doc if isinstance(doc, bytes) else json.dumps(doc).encode()
            epoch_file(self.state).write_bytes(raw)
            self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN, doc)

    def test_unreadable_state_is_unknown(self):
        epoch_file(self.state).chmod(0o000)
        try:
            self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
        finally:
            epoch_file(self.state).chmod(0o600)

    def test_bump_refuses_over_corrupt_state_and_leaves_file_untouched(self):
        self._corrupt()
        with self.assertRaises(PrivacyEpochError) as ctx:
            bump_epoch(self.state, USER)
        self.assertEqual(ctx.exception.code, "epoch-state-corrupt")
        self.assertEqual(epoch_file(self.state).read_bytes(), b"this is not json {")

    def test_bump_after_operator_reconcile_works_again(self):
        self._corrupt()
        with self.assertRaises(PrivacyEpochError):
            bump_epoch(self.state, USER)
        # Operator removes the corrupt file; the reset entry works again and
        # does not resurrect any old value.
        epoch_file(self.state).unlink()
        self.assertEqual(bump_epoch(self.state, USER), 1)

    def test_unsafe_file_types_links_modes_and_owner_are_refused(self):
        target = epoch_file(self.state)
        before = target.read_bytes()
        victim = self.state / "victim"
        victim.write_bytes(before)
        for kind in ("symlink", "dangling", "fifo", "directory", "hardlink", "mode"):
            with self.subTest(kind=kind):
                target.unlink()
                if kind == "symlink":
                    target.symlink_to(victim)
                elif kind == "dangling":
                    target.symlink_to(self.state / "missing")
                elif kind == "fifo":
                    os.mkfifo(target, 0o600)
                elif kind == "directory":
                    target.mkdir(mode=0o700)
                elif kind == "hardlink":
                    os.link(victim, target)
                else:
                    target.write_bytes(before)
                    target.chmod(0o644)
                self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
                with self.assertRaises(PrivacyEpochError):
                    bump_epoch(self.state, USER)
                if kind == "directory":
                    target.rmdir()
                else:
                    target.unlink()
                target.write_bytes(before)
                target.chmod(0o600)
                self.assertEqual(victim.read_bytes(), before)
        with patch.object(privacy_epoch.os, "geteuid", return_value=os.geteuid() + 1):
            self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
            with self.assertRaises(PrivacyEpochError):
                bump_epoch(self.state, USER)

    def test_unsafe_directories_and_lock_do_not_get_repaired(self):
        directory = epoch_file(self.state).parent
        directory.chmod(0o755)
        with self.assertRaises(PrivacyEpochError):
            bump_epoch(self.state, USER)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
        self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
        directory.chmod(0o700)
        lock = directory / (USER + ".lock")
        lock.unlink()
        lock.symlink_to(epoch_file(self.state))
        before = epoch_file(self.state).read_bytes()
        with self.assertRaises(PrivacyEpochError):
            bump_epoch(self.state, USER)
        self.assertEqual(epoch_file(self.state).read_bytes(), before)

    def test_state_and_epoch_directory_symlinks_are_refused(self):
        for location in (self.state, epoch_file(self.state).parent):
            with self.subTest(location=location.name):
                real = location.with_name(location.name + "-real")
                location.rename(real)
                location.symlink_to(real, target_is_directory=True)
                try:
                    self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
                    with self.assertRaises(PrivacyEpochError):
                        bump_epoch(self.state, USER)
                finally:
                    location.unlink()
                    real.rename(location)

    def test_oversized_and_nonfinite_state_is_not_reset(self):
        for raw in (b" " * (privacy_epoch._MAX_FILE_BYTES + 1),
                    b"[" * 1500 + b"0" + b"]" * 1500,
                    b'{"version":1,"user_id":"user-a","epoch":99,"epoch":1,"updated_at":1}',
                    json.dumps({"version": 1, "user_id": USER, "epoch": 1,
                                "updated_at": float("nan")}).encode()):
            epoch_file(self.state).write_bytes(raw)
            self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
            with self.assertRaises(PrivacyEpochError):
                bump_epoch(self.state, USER)
            self.assertEqual(epoch_file(self.state).read_bytes(), raw)

    def test_write_fsync_and_replace_failures_preserve_state_and_release_lock(self):
        for method in ("open", "fsync", "replace"):
            before = epoch_file(self.state).read_bytes()
            original = getattr(privacy_epoch.os, method)

            def fail(*args, **kwargs):
                if method != "open" or str(args[0]).endswith(".tmp"):
                    raise OSError("synthetic failure")
                return original(*args, **kwargs)

            with self.subTest(method=method), patch.object(privacy_epoch.os, method, fail):
                with self.assertRaises(PrivacyEpochError):
                    bump_epoch(self.state, USER)
            self.assertEqual(epoch_file(self.state).read_bytes(), before)
            self.assertFalse(list(epoch_file(self.state).parent.glob("*.tmp")))
            current = get_epoch(self.state, USER)
            self.assertEqual(bump_epoch(self.state, USER), current + 1)

    def test_directory_fsync_failure_never_rolls_back_a_committed_epoch(self):
        original = privacy_epoch.os.fsync
        calls = []

        def fail_directory(fd):
            calls.append(fd)
            if len(calls) == 2:
                raise OSError("synthetic directory sync failure")
            return original(fd)

        with patch.object(privacy_epoch.os, "fsync", fail_directory):
            with self.assertRaises(PrivacyEpochError):
                bump_epoch(self.state, USER)
        self.assertEqual(get_epoch(self.state, USER), 2)
        self.assertEqual(bump_epoch(self.state, USER), 3)


# ---------------------------------------------------------------------------
# pure era filter for internal-session rebuilds
# ---------------------------------------------------------------------------
class FilterByEpochTests(unittest.TestCase):
    def test_keeps_only_records_of_the_requested_era(self):
        records = [{"epoch": 2, "text": "b"}, {"epoch": 1, "text": "a"},
                   {"epoch": 0, "text": "zero"}, {"text": "unmarked"},
                   {"epoch": None, "text": "null"}, {"epoch": True, "text": "bool"}]
        kept = filter_by_epoch(records, 2)
        self.assertEqual(kept, [{"epoch": 2, "text": "b"}])

    def test_unknown_epoch_yields_nothing(self):
        records = [{"epoch": EPOCH_UNKNOWN}, {"epoch": 3}]
        self.assertEqual(filter_by_epoch(records, EPOCH_UNKNOWN), [])
        self.assertEqual(filter_by_epoch(records, -2), [])

    def test_non_dict_records_read_an_epoch_attribute(self):
        class Rec:
            def __init__(self, epoch):
                self.epoch = epoch
        a, b, c = Rec(1), Rec(3), Rec("3")
        self.assertEqual(filter_by_epoch([a, b, c], 3), [b])

    def test_input_records_are_returned_as_is(self):
        record = {"epoch": 1, "payload": object()}
        kept = filter_by_epoch([record], 1)
        self.assertIs(kept[0], record)


# ---------------------------------------------------------------------------
# boundary wiring: recall hold, async worker re-check, no native deletion
# ---------------------------------------------------------------------------
class RecallBoundaryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.memory = FakeMemory()
        self.service = make_service(self._tmp.name)
        self.service.engine.memory = self.memory

    def test_search_with_unknown_epoch_raises_and_never_queries_vectors(self):
        enqueue_user_turn(self.service, "evt-1", "我喜欢手冲咖啡。")
        bump_epoch(self.service.state_dir, USER)
        epoch_file(self.service.state_dir).write_bytes(b"broken")
        with self.assertRaises(PrivacyEpochError):
            self.service.search(Search(user_id=USER, query="咖啡"))
        self.assertEqual(self.memory.search_calls, 0)

    def test_search_with_known_epoch_reads_normally(self):
        enqueue_user_turn(self.service, "evt-1", "我喜欢手冲咖啡。")
        result = self.service.search(Search(user_id=USER, query="咖啡"))
        self.assertEqual(result, {"results": [], "conflicts": []})
        self.assertEqual(self.memory.search_calls, 1)

    def test_search_drops_results_when_reset_commits_mid_read(self):
        enqueue_user_turn(self.service, "evt-1", "我喜欢手冲咖啡。")
        original = self.memory.search

        def racing_search(*args, **kwargs):
            bump_epoch(self.service.state_dir, USER)  # reset mid-recall
            return original(*args, **kwargs)

        self.memory.search = racing_search
        result = self.service.search(Search(user_id=USER, query="咖啡"))
        self.assertEqual(result, {"results": [], "conflicts": []})

    def test_search_drops_results_when_state_becomes_unreadable_mid_read(self):
        enqueue_user_turn(self.service, "evt-1", "我喜欢手冲咖啡。")
        bump_epoch(self.service.state_dir, USER)
        original = self.memory.search

        def corrupting_search(*args, **kwargs):
            epoch_file(self.service.state_dir).write_bytes(b"broken")
            return original(*args, **kwargs)

        self.memory.search = corrupting_search
        result = self.service.search(Search(user_id=USER, query="咖啡"))
        self.assertEqual(result, {"results": [], "conflicts": []})


class WorkerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _terminal_receipt(self, service, event_id):
        for _ in range(service.max_attempts):
            # Force immediate retry eligibility; the worker's backoff is a
            # scheduling detail, not part of the boundary semantics under test.
            with service.connect() as db:
                db.execute("UPDATE turns SET retry_at=0 WHERE event_id=?", (event_id,))
            service.process_one()
        with service.connect() as db:
            return db.execute(
                "SELECT status,validation_status,error_kind,payload FROM turns "
                "WHERE event_id=?", (event_id,)).fetchone()

    def test_unknown_epoch_holds_worker_before_prepare_settles_needs_review(self):
        service = make_service(self._tmp.name)
        enqueue_user_turn(service, "evt-1", "我喜欢手冲咖啡。")
        bump_epoch(service.state_dir, USER)
        epoch_file(service.state_dir, USER).write_bytes(b"broken")
        row = self._terminal_receipt(service, "evt-1")
        status, validation_status, error_kind, payload = row
        self.assertEqual((status, validation_status), ("needs_review", "needs_review"))
        self.assertEqual(error_kind, "privacy_epoch_unknown")
        # The original text is retained, never dropped.
        self.assertEqual(json.loads(payload)["text"], "我喜欢手冲咖啡。")
        # No vector effect and no evaluator call happened.
        self.assertEqual(service.engine.memory.add_calls, 0)
        self.assertEqual(service.engine.evaluator.calls, 0)

    def test_reset_mid_flight_discards_batch_and_settles_needs_review(self):
        engine_holder = {}

        class RacingEngine:
            quality = quality.QualityConfig()
            extraction_mode = "source_span_selection"

            def __init__(self):
                self.prepared = 0
                self.stored = 0
                self.version = "racing"

            def prepare(self, turn):
                self.prepared += 1
                # Privacy reset commits while preparation is in flight.
                bump_epoch(service.state_dir, turn.user_id)
                return {"event_id": turn.event_id, "user_id": turn.user_id,
                        "role": turn.role, "source": turn.source,
                        "extraction_version": "extraction-v2",
                        "extraction_mode": "source_span_selection",
                        "validation_status": "validated",
                        "source_digest": hashlib.sha256(turn.text.encode()).hexdigest(),
                        "text_chars": len(turn.text),
                        "facts": [{"fact": turn.text, "quote": turn.text,
                                   "start": 0, "end": len(turn.text)}],
                        "error_kind": None,
                        "quality": {"semantic": {}, "fact_count": 1,
                                    "no_durable_facts": False}}

            def store(self, turn, plan):
                self.stored += 1
                return {"ok": True, "stored": ["m1"], "reused": []}

        engine = RacingEngine()
        engine_holder["engine"] = engine
        service = make_service(self._tmp.name, engine=engine)
        enqueue_user_turn(service, "evt-1", "我喜欢手冲咖啡。")
        row = self._terminal_receipt(service, "evt-1")
        status, validation_status, error_kind, _ = row
        # The batch is discarded at the delivery boundary: terminal
        # needs_review. The plan itself passed quality validation, so the
        # validation_status stays honest ('validated'); the hold reason is
        # recorded in error_kind. The receipt is never promoted to done.
        self.assertEqual(status, "needs_review")
        self.assertEqual(validation_status, "validated")
        self.assertEqual(error_kind, "privacy_epoch_changed")
        # The in-flight batch was discarded at the delivery boundary: prepared
        # once, never stored. The worker was not killed; it settled honestly.
        self.assertEqual(engine.prepared, 1)
        self.assertEqual(engine.stored, 0)

    def test_stable_epoch_worker_path_is_unchanged(self):
        service = make_service(self._tmp.name)
        enqueue_user_turn(service, "evt-1", "我喜欢手冲咖啡。")
        service.process_one()
        row = self._terminal_receipt(service, "evt-1")
        status, _, _, _ = row
        self.assertEqual(status, "done")

    def test_assistant_turns_are_not_held_by_the_epoch_gate(self):
        service = make_service(self._tmp.name)
        bump_epoch(service.state_dir, USER)
        epoch_file(service.state_dir, USER).write_bytes(b"broken")
        service.enqueue(Turn(event_id="evt-a", user_id=USER, role="assistant",
                             text="助手回复归档。", source="wechat"))
        service.process_one()
        with service.connect() as db:
            row = db.execute("SELECT status,validation_status FROM turns "
                             "WHERE event_id='evt-a'").fetchone()
        self.assertEqual(row, ("done", "assistant_archived"))


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# engine-level privacy gates (explicit seams, wired by the production assembly)
# ---------------------------------------------------------------------------
class EngineGateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name) / "state"

    def _engine(self, **gates):
        from services.memory.service import Mem0Engine
        evaluator = FakeEvaluator()
        engine = Mem0Engine(memory=FakeMemory(), evaluator=evaluator,
                            epoch_reader=gates.get("epoch_reader"),
                            outbound_screen=gates.get("outbound_screen"))
        return engine, evaluator

    def test_injected_engine_without_wiring_has_no_gate(self):
        engine, evaluator = self._engine()
        plan = engine.prepare(Turn(event_id="e", user_id=USER, role="user",
                                   text="正常中文句子。", source="wechat"))
        self.assertEqual(plan["validation_status"], "validated")
        self.assertGreater(evaluator.calls, 0)

    def test_unknown_epoch_holds_before_any_evaluator_call(self):
        engine, evaluator = self._engine(
            epoch_reader=lambda uid: privacy_epoch.EPOCH_UNKNOWN)
        plan = engine.prepare(Turn(event_id="e", user_id=USER, role="user",
                                   text="正常中文句子。", source="wechat"))
        self.assertEqual(plan["validation_status"], "needs_review")
        self.assertEqual(plan["error_kind"], "privacy_epoch_unknown")
        self.assertEqual(evaluator.calls, 0)

    def test_outbound_screen_hit_holds_and_nothing_is_sent(self):
        engine, evaluator = self._engine(
            outbound_screen=lambda text: ["email_address"])
        plan = engine.prepare(Turn(event_id="e", user_id=USER, role="user",
                                   text="正常中文句子。", source="wechat"))
        self.assertEqual(plan["validation_status"], "needs_review")
        self.assertEqual(plan["error_kind"], "outbound_screen_hit")
        self.assertEqual(evaluator.calls, 0)

    def test_clear_screen_and_known_epoch_prepare_normally(self):
        from services.memory import outbound_inventory
        engine, evaluator = self._engine(
            epoch_reader=lambda uid: 0,
            outbound_screen=outbound_inventory.secret_screen)
        plan = engine.prepare(Turn(event_id="e", user_id=USER, role="user",
                                   text="我喜欢手冲咖啡。", source="wechat"))
        self.assertEqual(plan["validation_status"], "validated")
        self.assertGreater(evaluator.calls, 0)

    def test_assistant_turns_bypass_the_engine_gate(self):
        engine, _ = self._engine(
            epoch_reader=lambda uid: privacy_epoch.EPOCH_UNKNOWN,
            outbound_screen=lambda text: ["token_shape"])
        plan = engine.prepare(Turn(event_id="e", user_id=USER, role="assistant",
                                   text="助手回复归档。", source="wechat"))
        self.assertEqual(plan["validation_status"], "assistant_archived")


class ProductionWiringTests(unittest.TestCase):
    def test_create_app_lifespan_wires_privacy_gates_on_the_real_engine(self):
        from services.memory import outbound_inventory
        from services.memory.service import create_app
        from fastapi.testclient import TestClient

        with tempfile.TemporaryDirectory() as tmp:
            import os
            previous = os.environ.get("MEM0_STATE_DIR")
            os.environ["MEM0_STATE_DIR"] = tmp
            try:
                app = create_app(run_worker=False)
                with TestClient(app) as client:
                    engine = client.app.state.memory.engine
                    self.assertIsNotNone(engine._epoch_reader)
                    self.assertIs(engine._outbound_screen,
                                  outbound_inventory.secret_screen)
                    # The wired reader consults the real state dir.
                    self.assertEqual(engine._epoch_reader(USER), 0)
                    bump_epoch(Path(tmp), USER)
                    self.assertEqual(engine._epoch_reader(USER), 1)
            finally:
                if previous is None:
                    os.environ.pop("MEM0_STATE_DIR", None)
                else:
                    os.environ["MEM0_STATE_DIR"] = previous


class MarkerEstablishedUserTests(unittest.TestCase):
    """PE-F002: distinguish "never initialized" from "established but lost".

    A durable marker under <state_dir>/privacy-markers/ records that a user
    was initialized. Once established, ANY loss of the epoch state — file
    deletion, parent-directory deletion, corruption, tampering or permission
    denial — must fail closed to EPOCH_UNKNOWN, never silently back to 0.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name) / "state"

    def marker_file(self, user_id: str = USER) -> Path:
        return self.state / "privacy-markers" / (user_id + ".marker")

    def test_never_initialized_user_is_zero_and_not_established(self):
        self.assertEqual(get_epoch(self.state, USER), 0)
        self.assertFalse(privacy_epoch.is_user_established(self.state, USER))

    def test_initialize_user_establishes_at_epoch_zero(self):
        self.assertEqual(privacy_epoch.initialize_user(self.state, USER), 0)
        self.assertEqual(get_epoch(self.state, USER), 0)
        self.assertTrue(privacy_epoch.is_user_established(self.state, USER))
        self.assertTrue(self.marker_file().exists())
        self.assertTrue(epoch_file(self.state).exists())

    def test_initialize_is_idempotent_for_same_user(self):
        privacy_epoch.initialize_user(self.state, USER)
        self.assertEqual(privacy_epoch.initialize_user(self.state, USER), 0)
        self.assertEqual(get_epoch(self.state, USER), 0)

    def test_established_user_losing_file_is_unknown_not_zero(self):
        privacy_epoch.initialize_user(self.state, USER)
        epoch_file(self.state).unlink()
        epoch = get_epoch(self.state, USER)
        self.assertEqual(epoch, EPOCH_UNKNOWN)
        self.assertNotEqual(epoch, 0)

    def test_bumped_user_losing_file_is_unknown_not_zero(self):
        self.assertEqual(bump_epoch(self.state, USER), 1)
        epoch_file(self.state).unlink()
        self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)

    def test_established_user_losing_epoch_directory_is_unknown(self):
        bump_epoch(self.state, USER)
        marker_before = digest_file(self.marker_file())
        import shutil
        shutil.rmtree(self.state / "privacy-epochs")
        # The marker is a SIBLING of privacy-epochs and must survive its loss.
        self.assertTrue(self.marker_file().exists())
        self.assertEqual(digest_file(self.marker_file()), marker_before)
        self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
        self.assertTrue(privacy_epoch.is_user_established(self.state, USER))

    def test_bump_ensures_marker_exists(self):
        bump_epoch(self.state, USER)
        self.assertTrue(self.marker_file().exists())
        self.assertEqual(get_epoch(self.state, USER), 1)

    def test_valid_file_with_missing_marker_returns_epoch_and_self_heals(self):
        bump_epoch(self.state, USER)
        self.marker_file().unlink()
        self.assertEqual(get_epoch(self.state, USER), 1)
        self.assertTrue(self.marker_file().exists())

    def test_established_user_permission_denial_is_unknown(self):
        bump_epoch(self.state, USER)
        epoch_file(self.state).chmod(0o000)
        try:
            self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)
        finally:
            epoch_file(self.state).chmod(0o600)

    def test_established_user_corrupt_file_is_unknown(self):
        bump_epoch(self.state, USER)
        epoch_file(self.state).write_bytes(b"garbage{")
        self.assertEqual(get_epoch(self.state, USER), EPOCH_UNKNOWN)

    def test_marker_permissions_are_private(self):
        privacy_epoch.initialize_user(self.state, USER)
        marker_dir = self.state / "privacy-markers"
        self.assertEqual(stat.S_IMODE(marker_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.marker_file().stat().st_mode), 0o600)

    def test_concurrent_bumps_stay_unique_with_marker(self):
        ctx = multiprocessing.get_context("spawn")
        manager = ctx.Manager()
        start = manager.Event()
        results = manager.Queue()
        procs = [ctx.Process(target=concurrent_reset,
                             args=(str(self.state), start, results, False))
                 for _ in range(2)]
        for p in procs:
            p.start()
        for _ in procs:
            self.assertEqual(results.get(timeout=10)[0], "ready")
        start.set()
        replies = [results.get(timeout=10) for _ in procs]
        for p in procs:
            p.join(10)
        # Same single-writer semantics as the pre-marker era: one winner.
        self.assertEqual(sorted(replies), [("ok", 1), ("ok", 2)])
        self.assertEqual(get_epoch(self.state, USER), 2)
        self.assertTrue(privacy_epoch.is_user_established(self.state, USER))
