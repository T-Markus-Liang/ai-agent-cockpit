"""Bounded real Jev + Mem0 source-selection probe, isolated from production data."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Allow three synthetic source-selection probes")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required; this probe makes real model requests")

    from services.memory.quality import JevEvaluator
    from services.memory.service import Mem0Engine, MemoryService, Search, Turn

    class ObservedEvaluator(JevEvaluator):
        def __init__(self):
            super().__init__()
            self.observations = []

        def evaluate(self, state, questions):
            result = super().evaluate(state, questions)
            self.observations.append({"model": result.get("model"), "usage": result.get("usage"),
                                      "questions": len(questions), "answers": result.get("answers"),
                                      "candidates": state.get("candidates")})
            return result

    fixture = json.loads((ROOT / "tests/fixtures/memory-quality.json").read_text())
    selected = [case for case in fixture["cases"]
                if case["id"] in ("nickname-object-loss", "english-name-and-number", "negative-preference")]
    directory = Path(tempfile.mkdtemp(prefix="personal-ai-os-memory-quality-live-"))
    directory.chmod(0o700)
    evaluator = ObservedEvaluator()
    engine = Mem0Engine(directory, evaluator=evaluator)
    service = MemoryService(directory, engine)
    preparation_attempts = 0
    generative_calls = 0

    def forbid_generation(*_args, **_kwargs):
        nonlocal generative_calls
        generative_calls += 1
        raise RuntimeError("generative extraction is forbidden in source-selection probe")

    engine.memory.llm.generate_response = forbid_generation
    reports = []
    try:
        for case in selected:
            identity = f"synthetic-quality-{uuid.uuid4()}"
            turn = Turn(event_id=f"{identity}:seed", user_id=identity, role="user", text=case["text"],
                        source="isolated-quality-canary")
            service.enqueue(turn)
            preparation_attempts += 1
            service.process_one()
            receipt = service.status(turn.event_id, turn.user_id)
            results = service.search(Search(user_id=identity, query=case["text"], limit=10))
            retained = all(value in "\n".join(row["memory"] for row in results)
                           for value in case["requiredSourceValues"])
            with service.connect() as db:
                saved = db.execute("SELECT plan FROM turns WHERE event_id=?", (turn.event_id,)).fetchone()[0]
            plan = json.loads(saved) if saved else {}
            spans_match = bool(plan.get("facts")) and all(
                turn.text[fact["start"]:fact["end"]] == fact["quote"] for fact in plan["facts"])
            passed = receipt["trusted"] and retained and spans_match
            reports.append({"case": case["id"], "status": "pass" if passed else "fail",
                            "receipt": receipt["status"], "validation": receipt["validation_status"],
                            "criticalValuesRetained": retained, "sourceSpansMatch": spans_match,
                            "errorKind": receipt["error_kind"]})
        ok = len(reports) == 3 and all(row["status"] == "pass" for row in reports)
        print(json.dumps({"type": "IsolatedMemoryQualityLiveReport", "ok": ok, "cases": reports,
                          "preparationAttempts": preparation_attempts,
                          "generativeExtractionCalls": generative_calls,
                          "jevObservations": evaluator.observations,
                          "productionWrites": 0, "wechatMessagesSent": 0,
                          "nativeSessionsResumed": 0, "artifactDirectory": str(directory),
                          "scope": "source-backed storage/recall; not yet actual WeChat or correction/forget lifecycle"},
                         ensure_ascii=False))
        return 0 if ok else 1
    finally:
        client = getattr(engine.memory.vector_store, "client", None)
        if client is not None:
            client.close()


if __name__ == "__main__":
    raise SystemExit(main())
