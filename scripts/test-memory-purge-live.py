"""Real-SDK isolation evidence for permanent erasure (purge) — throwaway temp dirs only.

This probe drives the frozen ``services.memory.purge`` planner/executor against
a REAL Mem0 OSS SDK 2.2.1 instance backed by local Qdrant and local fastembed
384-dim embeddings, inside a 0700 ``tempfile.mkdtemp`` directory. Nothing here
touches production state (``~/.local/state/personal-ai-os/mem0/``), and no
generative model API is called: the only model is the local embedding model,
loaded offline via ``HF_HUB_OFFLINE=1``.

It produces physical, per-assertion evidence that a confirmed delete:

* removes the vector entry from the real Qdrant store (``Memory.delete``),
* scrubs BOTH layer-owned content copies (``payload`` and ``plan``, the latter
  echoing ``facts[*].quote``) to the agreed marker while preserving the
  original ``digest`` — and re-reads them through ``turn_get`` so the erase is
  ``verified`` rather than merely flagged (r2 ``_CONTENT_FIELDS`` contract),
* is idempotent (a replay reports ``already_purged`` without re-deleting),
* never resurrects the erased source — the durable ``ForgetStore`` tombstone
  still intercepts a same-text replay through all three match levels
  (event id / source hash / sentence hash), while a genuinely fresh fact is
  not blocked.

Structure mirrors ``scripts/test-memory-quality-live.py``: an isolated
UUID namespace, a single JSON report on stdout, exit 0 only when every check
passes. Facts are synthetic Chinese preferences, stored through the real
``Mem0Engine`` source-span path (zero generative extraction calls).
"""
from __future__ import annotations

import os

# Offline embedding + telemetry off BEFORE mem0 is imported anywhere below.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("MEM0_TELEMETRY", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import hashlib  # noqa: E402
import json  # noqa: E402
import sqlite3  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import uuid  # noqa: E402
from pathlib import Path  # noqa: E402
from types import SimpleNamespace  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.memory import lifecycle, purge  # noqa: E402
from services.memory.service import Mem0Engine, Search, Turn  # noqa: E402

# Three synthetic, fully distinct Chinese facts. The first is the purge target.
FACTS = (
    {"key": "fruit", "text": "我喜欢的水果是苹果。", "query": "我喜欢什么水果"},
    {"key": "swim", "text": "我每周三晚上都去游泳。", "query": "我什么时候去游泳"},
    {"key": "home", "text": "我的家乡在杭州。", "query": "我的家乡在哪里"},
)
# A brand-new sentence that was never forgotten; it must NOT be tombstoned.
FRESH_TEXT = "我最近在学弹吉他。"
ZERO_EMBEDDING_FAKE_NOTE = "local fastembed only"


class AffirmEvaluator:
    """Affirm every eligibility/completeness question WITHOUT any model call.

    This is the deterministic source-span path used in production: selection
    and completeness are judged, but the stored fact is the ORIGINAL sentence.
    It exists only so the probe needs no Jev/generative endpoint; it makes zero
    network calls and records its call count as evidence.
    """

    def __init__(self):
        self.calls = 0

    def evaluate(self, state, questions):
        self.calls += 1
        return {"answers": {qid: {"type": "noul", "noul": 0.99} for qid in questions}}


def main():
    directory = Path(tempfile.mkdtemp(prefix="personal-ai-os-memory-purge-live-"))
    directory.chmod(0o700)
    user_id = f"synthetic-purge-{uuid.uuid4()}"
    db_path = directory / "purge-turns.sqlite"

    checks = []

    def record(name, ok, evidence):
        checks.append({"name": name, "status": "pass" if ok else "fail", "evidence": evidence})
        return bool(ok)

    evaluator = AffirmEvaluator()
    engine = Mem0Engine(directory, evaluator=evaluator)
    connect = lambda: sqlite3.connect(db_path, timeout=5)  # noqa: E731 - tiny factory

    # ---- throwaway turns ledger (payload / digest / purged / forgotten) ----
    with connect() as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS turns("
            "event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT, "
            "digest TEXT NOT NULL, plan TEXT, purged INTEGER NOT NULL DEFAULT 0, "
            "forgotten INTEGER NOT NULL DEFAULT 0)")
        lifecycle.ensure_schema(db)
    forget_store = lifecycle.ForgetStore(connect)
    db_path.chmod(0o600)

    events = {}
    stored_ids = {}
    plans = {}
    seeded_payload = {}
    seeded_plan = {}
    try:
        # ---- 1. store three real facts (real embedding + real Qdrant write) --
        for fact in FACTS:
            event_id = f"{user_id}:{fact['key']}"
            turn = Turn(event_id=event_id, user_id=user_id, role="user",
                        text=fact["text"], source="isolated-purge-canary")
            plan = engine.prepare(turn)
            result = engine.store(turn, plan)
            events[fact["key"]] = event_id
            plans[event_id] = plan
            stored_ids[event_id] = list(result.get("stored") or []) + list(result.get("reused") or [])
            if plan.get("validation_status") != "validated" or not result.get("ok"):
                record(f"store:{fact['key']}", False,
                       {"validation_status": plan.get("validation_status"), "store": result})
                raise SystemExit(finish(checks, directory, user_id, evaluator, engine))
            # Ledger row: digest is the plan source digest. The payload and the
            # plan are the two layer-owned content copies (plan echoes
            # facts[*].quote) that a purge must prove erased.
            seeded_payload[event_id] = json.dumps(turn.model_dump(), sort_keys=True, ensure_ascii=False)
            seeded_plan[event_id] = json.dumps(plan, ensure_ascii=False)
            with connect() as db:
                db.execute(
                    "INSERT INTO turns(event_id,user_id,payload,digest,plan) VALUES(?,?,?,?,?)",
                    (event_id, user_id, seeded_payload[event_id],
                     plan["source_digest"], seeded_plan[event_id]))
        record("store_three_facts", all(len(v) == 1 for v in stored_ids.values()),
               {k: stored_ids[v] for k, v in events.items()})

        def vector_count():
            rows = engine.memory.get_all(filters={"user_id": user_id}, top_k=100)
            return len(rows.get("results", []) if isinstance(rows, dict) else rows)

        def recalled(query):
            return engine.search(Search(user_id=user_id, query=query, limit=10))

        count_after_store = vector_count()
        record("vector_count_after_store", count_after_store == 3,
               {"count": count_after_store})

        # ---- 2. recall BEFORE purge is real semantic retrieval -------------
        target_key = "fruit"
        target_event = events[target_key]
        others = [events[k] for k in ("swim", "home")]
        before = recalled(FACTS[0]["query"])
        before_memories = [row["memory"] for row in before]
        record("recall_before_purge", FACTS[0]["text"] in before_memories,
               {"query": FACTS[0]["query"], "memories": before_memories,
                "topHit": before[0]["memory"] if before else None,
                "topScore": round(before[0]["score"], 4) if before and before[0]["score"] is not None else None})

        # ---- 3. durable tombstone via the REAL ForgetStore ------------------
        forget_result = forget_store.forget(lifecycle.ForgetRequest(
            request_id=f"req-{uuid.uuid4()}", user_id=user_id, event_ids=[target_event]))
        controls = forget_store.controls(user_id)
        tombstone = controls["tombstones"][0]
        record("tombstone_created",
               forget_result["status"] == "forgotten" and controls["memory_epoch"] == 1
               and tombstone["event_id"] == target_event
               and len(tombstone["source_hash"]) == 64 and len(tombstone["quote_hashes"]) >= 1,
               {"memory_epoch": controls["memory_epoch"], "event_id": tombstone["event_id"],
                "source_hash": tombstone["source_hash"],
                "quote_hash_count": len(tombstone["quote_hashes"])})

        # ---- 4. plan_purge selects exactly the tombstoned target -----------
        receipts = []
        for fact in FACTS:
            event_id = events[fact["key"]]
            receipts.append({
                "event_id": event_id, "user_id": user_id,
                "digest": plans[event_id]["source_digest"],
                "source_hash": hashlib.sha256(fact["text"].encode()).hexdigest(),
                "vector_ids": stored_ids[event_id], "has_archive": False})
        # purge expects tombstones with an explicit user_id (controls omits it).
        purge_tombstones = [{**t, "user_id": user_id} for t in controls["tombstones"]]
        plan = purge.plan_purge(receipts, purge_tombstones,
                                {"user_id": user_id, "selector": {"event_id": target_event},
                                 "mode": "event"})
        record("plan_purge_targets_only_target",
               (not plan["empty"] and len(plan["targets"]) == 1
                and plan["targets"][0]["event_id"] == target_event
                and list(plan["tombstones_required"]) == []
                and sorted(plan["targets"][0]["vector_ids"]) == sorted(stored_ids[target_event])),
               {"targets": [t["event_id"] for t in plan["targets"]],
                "tombstones_required": list(plan["tombstones_required"]),
                "vector_ids": list(plan["targets"][0]["vector_ids"])})

        # ---- 5. execute_purge through REAL SDK callbacks -------------------
        def delete_vector(vector_id):
            return engine.memory.delete(vector_id)  # real Mem0 SDK delete()

        def scrub_turn(event_id):
            # r2 contract: erase BOTH layer-owned content copies (payload + plan),
            # preserving the digest; the plan copy echoes facts[*].quote.
            with connect() as db:
                db.execute("UPDATE turns SET payload=?, plan=?, purged=1 WHERE event_id=?",
                           (purge.ERASURE_MARKER, purge.ERASURE_MARKER, event_id))

        def vector_exists(vector_id):
            return engine.memory.vector_store.get(vector_id=vector_id) is not None

        def turn_get(event_id):
            # r2 contract: expose purged/digest AND both content copies (payload,
            # plan), or execute_purge reports the erase unverifiable.
            with connect() as db:
                row = db.execute(
                    "SELECT purged,digest,payload,plan FROM turns WHERE event_id=?",
                    (event_id,)).fetchone()
            return SimpleNamespace(purged=bool(row[0]), digest=row[1],
                                   payload=row[2], plan=row[3])

        result = purge.execute_purge(plan, delete_vector, scrub_turn, vector_exists, turn_get)
        record("purge_executed",
               result.get("purged") == [target_event] and result.get("verified") is True,
               {"purged": list(result.get("purged", [])), "verified": result.get("verified")})

        # ---- 6. physical deletion + scrubbed-but-auditable turn ------------
        count_after_purge = vector_count()
        record("vector_count_after_purge", count_after_purge == 2,
               {"before": count_after_store, "after": count_after_purge})

        current = turn_get(target_event)
        payload_erased = purge._is_erased(current.payload)
        plan_erased = purge._is_erased(current.plan)
        digest_preserved = current.digest == plans[target_event]["source_digest"]
        # The pre-purge turn really carried the fact content in BOTH copies, so
        # "erased" below is not vacuously true of an already-empty column.
        content_was_present = (FACTS[0]["text"] in seeded_payload[target_event]
                               and FACTS[0]["text"] in seeded_plan[target_event])
        record("turn_scrubbed_digest_preserved",
               current.purged and payload_erased and plan_erased and digest_preserved
               and content_was_present,
               {"purged": current.purged, "payload": current.payload,
                "plan": current.plan, "payloadErased": payload_erased,
                "planErased": plan_erased, "digestPreserved": digest_preserved,
                "contentWasPresentBefore": content_was_present})
        untouched = [turn_get(e) for e in others]
        record("non_target_turns_untouched", all(not t.purged for t in untouched),
               {"purged": [t.purged for t in untouched]})

        # ---- 7. real semantic search no longer returns the erased fact -----
        after = recalled(FACTS[0]["query"])
        after_memories = [row["memory"] for row in after]
        record("recall_after_purge_excludes_erased",
               FACTS[0]["text"] not in after_memories,
               {"query": FACTS[0]["query"], "memories": after_memories})
        record("other_facts_still_recalled",
               all(f["text"] in after_memories for f in FACTS[1:]),
               {"expected": [f["text"] for f in FACTS[1:]], "memories": after_memories})

        # ---- 8. SDK delete contract: a missing vector raises ValueError ----
        try:
            engine.memory.delete(stored_ids[target_event][0])
            missing_raised = False
        except ValueError:
            missing_raised = True
        record("sdk_delete_missing_vector_raises", missing_raised,
               {"raised": "ValueError"})

        # ---- 9. idempotent purge: replay reports already_purged ------------
        replay = purge.execute_purge(plan, delete_vector, scrub_turn, vector_exists, turn_get)
        record("repeated_purge_is_idempotent",
               replay.get("already_purged") == [target_event] and replay.get("purged") == []
               and replay.get("verified") is True,
               {"already_purged": list(replay.get("already_purged", [])),
                "purged": list(replay.get("purged", []))})

        # ---- 10. tombstone intercepts same-text replay (all three levels) --
        match_event = forget_store.match(user_id, target_event, FACTS[0]["text"])
        match_source = forget_store.match(user_id, f"replay-{uuid.uuid4()}", FACTS[0]["text"])
        match_sentence = forget_store.match(
            user_id, f"mixed-{uuid.uuid4()}", FACTS[0]["text"] + FRESH_TEXT)
        record("tombstone_blocks_replay",
               match_event is not None and match_source is not None and match_sentence is not None,
               {"by_event_id": match_event is not None,
                "by_source_hash": match_source is not None,
                "by_sentence_hash": match_sentence is not None,
                "tombstone_event_id": tombstone["event_id"]})
        fresh = forget_store.match(user_id, f"fresh-{uuid.uuid4()}", FRESH_TEXT)
        record("fresh_fact_not_blocked", fresh is None,
               {"fresh_text": FRESH_TEXT, "matched": fresh is not None})

        # ---- 11. the plan never touches tombstones (no revival) ------------
        record("tombstone_survives_purge",
               len(forget_store.controls(user_id)["tombstones"]) == 1,
               {"tombstones": len(forget_store.controls(user_id)["tombstones"])})

        return finish(checks, directory, user_id, evaluator, engine)
    finally:
        client = getattr(engine.memory.vector_store, "client", None)
        if client is not None and hasattr(client, "close"):
            client.close()


def finish(checks, directory, user_id, evaluator, engine):
    ok = bool(checks) and all(check["status"] == "pass" for check in checks)
    for check in checks:
        print(f"{check['status'].upper():4} {check['name']}: "
              f"{json.dumps(check['evidence'], ensure_ascii=False)}")
    print(json.dumps({
        "type": "IsolatedMemoryPurgeLiveReport",
        "ok": ok,
        "engineVersion": getattr(engine, "version", None),
        "embeddingModel": getattr(engine, "embedding_model", None),
        "embeddingNote": ZERO_EMBEDDING_FAKE_NOTE,
        "generativeModelCalls": 0,
        "evaluatorCalls": evaluator.calls,
        "namespace": user_id,
        "artifactDirectory": str(directory),
        "artifactMode": oct(directory.stat().st_mode & 0o777),
        "checks": checks,
        "productionWrites": 0,
        "productionStateDirTouched": False,
        "wechatMessagesSent": 0,
        "nativeSessionsResumed": 0,
        "scope": "real Mem0 SDK delete + local Qdrant + local fastembed; "
                 "permanent-erasure planning/execution evidence in an isolated namespace",
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
