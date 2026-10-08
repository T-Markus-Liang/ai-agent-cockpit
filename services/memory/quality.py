"""Deterministic quality gate for trusted memory preparation.

The default trusted-memory pipeline selects ORIGINAL user sentences/paragraphs
with a bounded Noul (Jev) eligibility query; it never asks a generative model to
produce JSON facts. Kimi stays the main chat model and Mem0 stays the vector
store. This module owns everything that decides whether a user turn may become a
trusted vector fact:

* deterministic ``source_spans`` sentence/paragraph segmentation with exact
  original Unicode offsets (decimals are never split),
* bounded candidate/text limits that retain oversized input as needs_review,
* obvious credential-pattern rejection (before any evaluator sees the text),
* advisory eligibility/completeness checking through an injectable evaluator
  (default: the local ``jev-eval`` wrapper) with the real typed
  ``{"type": "noul", "noul": p}`` output contract.

An explicitly injected extractor is a small test/contract adapter for
legacy/rewritten proposals; there is no default Kimi fallback. The trusted
vector content is always the ORIGINAL SPAN (fact == quote), never a model
rewrite, so names, numbers and polarity are preserved.

Semantic answers are advisory policy signals, not truth and not authorization
for side effects. Every failure funnels into a bounded retry and then a terminal
``needs_review`` receipt (see ``service.py``).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, Tuple

EXTRACTION_VERSION = "extraction-v2"
EXTRACTION_MODE_SOURCE_SPANS = "source_span_selection"
EXTRACTION_MODE_EXTRACTOR = "extractor_proposals"
DEFAULT_MAX_TEXT_CHARS = 8000
DEFAULT_MAX_FACTS = 20
DEFAULT_SEMANTIC_THRESHOLD = 0.90
DEFAULT_EXCLUDE_THRESHOLD = 0.10
DEFAULT_MAX_ATTEMPTS = 3
MAX_ATTEMPTS_CEILING = 5
DEFAULT_JEV_EVAL_BIN = "/Users/markus/.local/bin/jev-eval"

# Sentence terminators and separators used by the deterministic source-span
# segmenter. Chinese 。！？, English !?, a period that is followed by whitespace
# or end-of-text, and newlines all end a span. Commas stay inside the span so
# name/language/negation relations survive verbatim.
_SPAN_TERMINATORS = "。！？!?"
_SPAN_NEWLINES = "\n\r"
_SPAN_WHITESPACE = " \t\n\r\f\v"

# Obvious credential shapes. Rejected before remote inference so secrets never
# leave the process, and again on any model-produced quote or normalized fact.
# These are heuristic shapes, not a secret-detector guarantee.
_CREDENTIAL_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{10,}\b"),
    re.compile(r"\bapikey[_-][A-Za-z0-9_\-]{8,}\b", re.I),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"(?:密码|密钥|口令|令牌)\s*(?:是|为|[:：=])\s*\S+"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(
        r"(?i)\b(api[_\- ]?key|apikey|secret|password|passwd|token|bearer|credential|"
        r"access[_\- ]?token|auth[_\- ]?token)\b\s*[:=]\s*\S+"
    ),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}"),
)


class QualityError(Exception):
    """A quality/validation failure.

    ``kind`` is a stable, sanitized token safe to persist in SQLite (it never
    contains provider text, URLs or credentials).
    """

    def __init__(self, kind: str, message: str = ""):
        self.kind = kind
        super().__init__(message or kind)


class EvaluatorError(QualityError):
    """The advisory evaluator was unavailable or returned invalid output."""


@dataclass(frozen=True)
class QualityConfig:
    max_text_chars: int = DEFAULT_MAX_TEXT_CHARS
    max_facts: int = DEFAULT_MAX_FACTS
    semantic_threshold: float = DEFAULT_SEMANTIC_THRESHOLD
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    extraction_version: str = EXTRACTION_VERSION
    jev_eval_bin: str = DEFAULT_JEV_EVAL_BIN
    jev_timeout: float = 45.0

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "QualityConfig":
        env = os.environ if env is None else env

        def _int(name: str, default: int, low: int, high: int) -> int:
            try:
                value = int(env.get(name, default))
            except (TypeError, ValueError):
                return default
            return max(low, min(high, value))

        return cls(
            max_text_chars=_int("MEMORY_MAX_TEXT_CHARS", DEFAULT_MAX_TEXT_CHARS, 1, 100_000),
            max_facts=_int("MEMORY_MAX_FACTS", DEFAULT_MAX_FACTS, 1, 100),
            max_attempts=_int("MEMORY_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, MAX_ATTEMPTS_CEILING),
            jev_eval_bin=env.get("JEV_EVAL_BIN", DEFAULT_JEV_EVAL_BIN),
        )


@dataclass
class ValidatedFact:
    fact: str
    quote: str
    start: int
    end: int

    def to_dict(self) -> dict:
        return {"fact": self.fact, "quote": self.quote, "start": self.start, "end": self.end}


def contains_credential(text: str) -> bool:
    """Return True when the text obviously contains a credential."""
    if not isinstance(text, str):
        return False
    return any(pattern.search(text) for pattern in _CREDENTIAL_PATTERNS)


def source_spans(text: str) -> List[Tuple[int, int, str]]:
    """Split ``text`` into complete, trimmed sentences/paragraphs.

    Returns ``(start, end, quote)`` triples where ``quote == text[start:end]``
    exactly. Splits on Chinese ``。！？``, English ``!?``, a period that is
    followed by whitespace or end-of-text (so ``1234.50`` stays intact), and
    newlines. Commas never split a span, preserving name/language/negation
    relations. Leading/trailing whitespace is trimmed from each span and the
    original Unicode offsets are preserved.
    """
    spans: List[Tuple[int, int, str]] = []
    if not isinstance(text, str) or not text:
        return spans
    length = len(text)

    def emit(raw_start: int, raw_end: int) -> None:
        start, end = raw_start, raw_end
        while start < end and text[start] in _SPAN_WHITESPACE:
            start += 1
        while end > start and text[end - 1] in _SPAN_WHITESPACE:
            end -= 1
        if end > start:
            spans.append((start, end, text[start:end]))

    index = 0
    span_start = 0
    while index < length:
        char = text[index]
        boundary_end = None
        if char in _SPAN_TERMINATORS:
            end = index + 1
            while end < length and text[end] in _SPAN_TERMINATORS:
                end += 1
            boundary_end = end
        elif char == "." and (index + 1 >= length or text[index + 1].isspace()):
            boundary_end = index + 1
        elif char in _SPAN_NEWLINES:
            boundary_end = index
        if boundary_end is None:
            index += 1
            continue
        emit(span_start, boundary_end)
        index = boundary_end
        while index < length and text[index] in _SPAN_WHITESPACE:
            index += 1
        span_start = index
    emit(span_start, length)
    return spans


EXTRACTION_KEYS = frozenset({"facts", "no_durable_facts"})
FACT_KEYS = frozenset({"fact", "source_quote"})


def parse_extraction(raw: Any) -> dict:
    """Parse and strict-validate the extraction envelope schema.

    Raises ``QualityError('malformed_extraction')`` for anything that is not
    exactly ``{facts:[{fact,source_quote}], no_durable_facts:bool}``. Extra keys
    at either level are rejected, never silently normalized away.
    """
    if isinstance(raw, str):
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
        if not cleaned.strip():
            raise QualityError("empty_extraction")
        try:
            raw = json.loads(cleaned)
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            raise QualityError("malformed_extraction", str(error)) from error
    if not isinstance(raw, dict):
        raise QualityError("malformed_extraction")
    if set(raw.keys()) != EXTRACTION_KEYS:
        raise QualityError("malformed_extraction")
    if not isinstance(raw["no_durable_facts"], bool):
        raise QualityError("malformed_extraction")
    facts = raw["facts"]
    if not isinstance(facts, list):
        raise QualityError("malformed_extraction")
    normalized = []
    for entry in facts:
        if not isinstance(entry, dict) or set(entry.keys()) != FACT_KEYS:
            raise QualityError("malformed_extraction")
        fact = entry["fact"]
        quote = entry["source_quote"]
        if not isinstance(fact, str) or not fact.strip():
            raise QualityError("malformed_extraction")
        if not isinstance(quote, str) or not quote.strip():
            raise QualityError("malformed_extraction")
        normalized.append({"fact": fact, "source_quote": quote})
    return {"facts": normalized, "no_durable_facts": raw["no_durable_facts"]}


def validate_extraction(parsed: dict, text: str, config: QualityConfig) -> Tuple[List[ValidatedFact], bool]:
    """Validate provenance against the ORIGINAL text and return validated facts.

    Enforces the exact-span contract: each quote must be a verbatim substring of
    the user text. Raises ``QualityError`` for credential-like quotes, missing
    quotes, or a schema-consistent extraction that has no facts.
    """
    no_durable = bool(parsed["no_durable_facts"])
    entries = parsed["facts"]
    if no_durable and entries:
        raise QualityError("malformed_extraction")
    if len(entries) > config.max_facts:
        raise QualityError("bounds_exceeded")
    facts: List[ValidatedFact] = []
    seen: set = set()
    for entry in entries:
        quote = entry["source_quote"]
        fact_text = entry["fact"]
        # Reject credentials in either the quote OR the normalized fact before
        # any advisory inference sees them.
        if contains_credential(quote) or contains_credential(fact_text):
            raise QualityError("credential_like")
        start = text.find(quote)
        if start < 0:
            raise QualityError("quote_not_found")
        end = start + len(quote)
        if text[start:end] != quote or end <= start:
            raise QualityError("span_mismatch")
        key = (start, end, quote)
        if key in seen:
            continue
        seen.add(key)
        facts.append(ValidatedFact(fact=fact_text, quote=quote, start=start, end=end))
    if not no_durable and not facts:
        raise QualityError("empty_extraction")
    return facts, no_durable


def build_semantic_questions(facts: Sequence[ValidatedFact], no_durable: bool) -> dict:
    """Build a narrow batch of Noul questions for the advisory evaluator.

    Every candidate gets its own faithfulness and relevance question, each
    explicitly tied to that candidate's own quote (which also appears in the
    evaluator state under ``candidates[i]["quote"]``). Relevance is advisory
    only and never authorizes an action.
    """
    questions: dict = {}
    for index, fact in enumerate(facts):
        questions[f"faithful_{index}"] = {
            "type": "noul",
            "instructions": (
                "Does this candidate statement faithfully reflect ONLY the user's own text, "
                "without inventing or altering names, numbers, negation, or corrections? "
                f"Candidate: {fact.fact!r}"
            ),
        }
        questions[f"relevance_{index}"] = {
            "type": "noul",
            "instructions": (
                "Does this quote explicitly state a user identity detail, preference, goal, "
                "project decision or project fact? User-stated names and project budgets are "
                "eligible even without the words 'remember' and even if they can change later. "
                "Exclude greetings, momentary weather, questions, hypothetical examples, "
                "assistant guesses and credentials. Judge the quoted statement in user_text, "
                "not whether remembering it feels useful or authorizes an action. "
                f"Candidate quote: {fact.quote!r}"
            ),
        }
    if facts:
        questions["retains_all_details"] = {
            "type": "noul",
            "instructions": (
                "Do the selected source quotes collectively retain ALL important durable details "
                "of the user's original text, including names, numbers, negation, and corrections? "
                "Answer no if any important durable detail is missing."
            ),
        }
    if no_durable:
        questions["no_durable_facts"] = {
            "type": "noul",
            "instructions": (
                "Does the user's original text contain no durable facts, preferences, goals, or "
                "decisions worth remembering?"
            ),
        }
    return questions


# The only answer shape the real jev-eval wrapper emits per question is
# ``{"type": "noul", "noul": <probability>}``. Anything else (bare booleans,
# ``{answer: ..., confidence: ...}`` gateway forms, unknown types, non-finite
# or out-of-range probabilities) fails closed.
NOUL_TYPE = "noul"


def parse_noul_entry(entry: Any) -> float:
    """Strictly parse one typed Noul answer into a finite probability in [0, 1]."""
    if not isinstance(entry, dict):
        raise EvaluatorError("semantic_malformed")
    if entry.get("type") != NOUL_TYPE:
        raise EvaluatorError("semantic_malformed")
    if "noul" not in entry:
        raise EvaluatorError("semantic_malformed")
    value = entry["noul"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvaluatorError("semantic_malformed")
    probability = float(value)
    if not math.isfinite(probability) or probability < 0.0 or probability > 1.0:
        raise EvaluatorError("semantic_out_of_range")
    return probability


def classify_noul(probability: float, threshold: float) -> str:
    """Map a Noul probability to ``affirmed``/``ambiguous``/``not_affirmed``."""
    if probability >= threshold:
        return "affirmed"
    if probability >= 0.5:
        return "ambiguous"
    return "not_affirmed"


def classify_selection(probability: float, threshold: float) -> str:
    """Map a Noul probability to ``selected``/``ambiguous``/``excluded``.

    ``>= threshold`` selects, ``<= DEFAULT_EXCLUDE_THRESHOLD`` excludes, and the
    intermediate band is ambiguous. Ambiguous candidates are held (bounded
    retry), never silently discarded.
    """
    if probability >= threshold:
        return "selected"
    if probability <= DEFAULT_EXCLUDE_THRESHOLD:
        return "excluded"
    return "ambiguous"


_ELIGIBILITY_RUBRIC = (
    "Does this candidate sentence state something about the user themselves that is "
    "durable: an identity or name, a preference, a goal, a project decision, or a "
    "project fact (user-stated explicit budgets and numbers included)? No explicit "
    "word 'remember' is required. Answer low for greetings, momentary weather, "
    "questions, hypothetical examples, assistant guesses and credentials. The "
    "statement must be user-stated and must not contain credentials. Judge only this "
    "sentence, not whether remembering it feels useful or authorizes an action. "
)


def build_selection_questions(spans: Sequence[Tuple[int, int, str]]) -> dict:
    """One narrow eligibility Noul question per original candidate span."""
    questions: dict = {}
    for index, span in enumerate(spans):
        quote = span[2]
        questions[f"eligible_{index}"] = {
            "type": "noul",
            "instructions": f"{_ELIGIBILITY_RUBRIC}Candidate sentence: {quote!r}",
        }
    return questions


def build_completeness_question() -> dict:
    return {
        "retains_all_details": {
            "type": "noul",
            "instructions": (
                "Do the selected source sentences collectively retain ALL important durable "
                "details of the user's original text, including names, numbers, budgets, "
                "negation and corrections? Answer low if any important durable detail is missing."
            ),
        }
    }


def build_no_facts_question() -> dict:
    return {
        "no_durable_facts": {
            "type": "noul",
            "instructions": (
                "Does the user's original text contain no durable identity, name, preference, "
                "goal, project decision or project fact worth remembering?"
            ),
        }
    }


def selection_state(text: str, spans: Sequence[Tuple[int, int, str]]) -> dict:
    """Evaluator state for the candidate batch (no credentials; caller checks)."""
    return {
        "user_text": text,
        "candidates": [
            {"index": index, "quote": span[2], "start": span[0], "end": span[1]}
            for index, span in enumerate(spans)
        ],
    }


def completeness_state(text: str, selected: Sequence[Tuple[int, int, str]]) -> dict:
    return {"user_text": text, "selected": [span[2] for span in selected]}


def no_facts_state(text: str) -> dict:
    return {"user_text": text}


def evaluate_selection_answers(answers: Any, question_ids: Sequence[str], threshold: float):
    """Validate typed Noul answers; return ``(evidence, selected_ids)``.

    Every expected ID must be present and well formed. A candidate in the
    ambiguous band raises ``EvaluatorError('semantic_ambiguous')`` so the whole
    input is held, not partially accepted.
    """
    if not isinstance(answers, dict) or not answers:
        raise EvaluatorError("semantic_malformed")
    evidence: dict = {}
    selected: List[str] = []
    for question_id in question_ids:
        if question_id not in answers:
            raise EvaluatorError("semantic_missing")
        probability = parse_noul_entry(answers[question_id])
        verdict = classify_selection(probability, threshold)
        if verdict == "ambiguous":
            raise EvaluatorError("semantic_ambiguous")
        evidence[question_id] = {"type": NOUL_TYPE, "noul": probability}
        if verdict == "selected":
            selected.append(question_id)
    return evidence, selected


def run_selection_check(evaluator: Any, state: dict, questions: dict, threshold: float):
    """Invoke the advisory evaluator and validate its typed Noul answers."""
    if not questions:
        raise QualityError("semantic_no_questions")
    try:
        response = evaluator.evaluate(state, questions)
    except EvaluatorError:
        raise
    except subprocess.TimeoutExpired as error:
        raise EvaluatorError("jev_timeout") from error
    except Exception as error:  # noqa: BLE001 - sanitized into a stable kind
        raise EvaluatorError("jev_unavailable") from error
    answers = response.get("answers") if isinstance(response, dict) else None
    return evaluate_selection_answers(answers, list(questions), threshold)


def validate_selection_evidence(semantic: Any, fact_count: int, no_durable: bool, threshold: float) -> dict:
    """Re-check persisted source-span evidence is current-schema and affirmed."""
    if not isinstance(semantic, dict):
        raise EvaluatorError("semantic_malformed")
    if no_durable:
        expected = {"no_durable_facts"}
    else:
        expected = {f"relevance_{index}" for index in range(fact_count)} | {"retains_all_details"}
    if expected - set(semantic):
        raise EvaluatorError("semantic_missing")
    if set(semantic) - expected:
        raise EvaluatorError("semantic_malformed")
    for key in expected:
        probability = parse_noul_entry(semantic[key])
        if probability < threshold:
            raise EvaluatorError("semantic_not_affirmed")
    return semantic


def evaluate_noul_answers(answers: Any, question_ids: Sequence[str], threshold: float) -> dict:
    """Validate all expected typed Noul answers, returning advisory evidence.

    Extra answer IDs are tolerated (je v may echo metadata) but every expected
    question ID must be present and well formed. Missing answers fail closed.
    """
    if not isinstance(answers, dict) or not answers:
        raise EvaluatorError("semantic_malformed")
    details = {}
    for question_id in question_ids:
        if question_id not in answers:
            raise EvaluatorError("semantic_missing")
        probability = parse_noul_entry(answers[question_id])
        verdict = classify_noul(probability, threshold)
        if verdict == "ambiguous":
            raise EvaluatorError("semantic_ambiguous")
        if verdict == "not_affirmed":
            raise EvaluatorError("semantic_not_affirmed")
        details[question_id] = {"type": NOUL_TYPE, "noul": probability}
    return details


def validate_semantic_evidence(semantic: Any, facts: Sequence[ValidatedFact], no_durable: bool,
                               threshold: float) -> dict:
    """Re-check persisted semantic evidence is the current schema and complete."""
    if not isinstance(semantic, dict):
        raise EvaluatorError("semantic_malformed")
    expected = set(build_semantic_questions(facts, no_durable))
    present = set(semantic)
    if expected - present:
        raise EvaluatorError("semantic_missing")
    if present - expected:
        raise EvaluatorError("semantic_malformed")
    return evaluate_noul_answers(semantic, list(build_semantic_questions(facts, no_durable)), threshold)


def run_semantic_check(evaluator: Any, state: dict, questions: dict, threshold: float) -> dict:
    """Invoke the advisory evaluator and validate its typed Noul answers.

    Returns per-question ``{id: {"type": "noul", "noul": p}}`` advisory evidence
    on success. Missing, empty, malformed, ambiguous, low-probability, non-finite
    or out-of-range answers raise ``EvaluatorError``/``QualityError`` (both are
    bounded-retry signals).
    """
    if not questions:
        raise QualityError("semantic_no_questions")
    try:
        response = evaluator.evaluate(state, questions)
    except EvaluatorError:
        raise
    except subprocess.TimeoutExpired as error:
        raise EvaluatorError("jev_timeout") from error
    except Exception as error:  # noqa: BLE001 - sanitized into a stable kind
        raise EvaluatorError("jev_unavailable") from error
    answers = response.get("answers") if isinstance(response, dict) else None
    return evaluate_noul_answers(answers, list(questions), threshold)


def _default_runner(command: Sequence[str], input_text: str, timeout: float):
    return subprocess.run(
        list(command),
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


class JevEvaluator:
    """Default advisory evaluator that shells out to the local jev-eval wrapper.

    Credentials are read by the wrapper from its own config file, never passed
    in argv, the request body, or the prompt. ``runner`` is injectable so tests
    can exercise the contract without spawning a process or key lookup.
    """

    def __init__(
        self,
        command: Optional[Sequence[str]] = None,
        *,
        timeout: float = 45.0,
        runner: Optional[Callable[[Sequence[str], str, float], Any]] = None,
    ):
        self.command = list(command) if command else [DEFAULT_JEV_EVAL_BIN]
        self.timeout = timeout
        self.runner = runner or _default_runner

    def evaluate(self, state: dict, questions: dict) -> dict:
        request = json.dumps({"state": state, "questions": questions}, ensure_ascii=False)
        try:
            result = self.runner(self.command, request, self.timeout)
        except Exception as error:  # noqa: BLE001
            raise EvaluatorError("jev_unavailable") from error
        if getattr(result, "returncode", 1) != 0:
            raise EvaluatorError("jev_failed")
        try:
            parsed = json.loads(getattr(result, "stdout", "") or "")
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            raise EvaluatorError("jev_malformed") from error
        if not isinstance(parsed, dict):
            raise EvaluatorError("jev_malformed")
        return parsed


def semantic_state(text: str, facts: Sequence[ValidatedFact], no_durable: bool) -> dict:
    """Build the evaluator state; contains no credentials and no API keys."""
    return {
        "user_text": text,
        "no_durable_facts": no_durable,
        "candidates": [fact.to_dict() for fact in facts],
    }


def validate_plan(turn: Any, plan: Any, config: QualityConfig) -> List[ValidatedFact]:
    """Revalidate a prepared plan against the CURRENT turn before any effect.

    The whole plan must match the turn identity and current config, every fact
    must be a verbatim span of the original text, contain no credentials, and
    carry complete, current-schema semantic evidence. Any mismatch raises
    ``QualityError`` so callers can refuse without touching the vector store.
    """
    if not isinstance(plan, dict):
        raise QualityError("missing_plan")
    if plan.get("event_id") != turn.event_id:
        raise QualityError("invalid_plan")
    if plan.get("user_id") != turn.user_id:
        raise QualityError("invalid_plan")
    if plan.get("role") != turn.role:
        raise QualityError("invalid_plan")
    if plan.get("source") != turn.source:
        raise QualityError("invalid_plan")
    if plan.get("source_digest") != hashlib.sha256(turn.text.encode()).hexdigest():
        raise QualityError("invalid_plan")
    if plan.get("text_chars") != len(turn.text):
        raise QualityError("invalid_plan")
    if plan.get("extraction_version") != config.extraction_version:
        raise QualityError("invalid_plan")
    mode = plan.get("extraction_mode")
    if mode not in (EXTRACTION_MODE_SOURCE_SPANS, EXTRACTION_MODE_EXTRACTOR):
        raise QualityError("invalid_plan")
    status = plan.get("validation_status")
    if status == "assistant_archived":
        if turn.role != "assistant" or plan.get("facts") != []:
            raise QualityError("invalid_plan")
        return []
    if turn.role != "user" or len(turn.text) > config.max_text_chars:
        raise QualityError("invalid_plan")
    if contains_credential(turn.text):
        raise QualityError("credential_like")
    if status == "no_facts":
        block = plan.get("quality")
        if (plan.get("facts") != [] or not isinstance(block, dict)
                or type(block.get("fact_count")) is not int or block["fact_count"] != 0
                or block.get("no_durable_facts") is not True):
            raise QualityError("invalid_plan")
        if mode == EXTRACTION_MODE_SOURCE_SPANS:
            validate_selection_evidence(block.get("semantic"), 0, True, config.semantic_threshold)
        else:
            validate_semantic_evidence(block.get("semantic"), [], True, config.semantic_threshold)
        return []
    if status != "validated":
        raise QualityError("invalid_plan")
    raw_facts = plan.get("facts")
    if not isinstance(raw_facts, list) or not raw_facts:
        raise QualityError("partial_plan")
    if len(raw_facts) > config.max_facts:
        raise QualityError("invalid_plan")
    facts: List[ValidatedFact] = []
    for entry in raw_facts:
        if not isinstance(entry, dict):
            raise QualityError("invalid_plan")
        fact_text = entry.get("fact")
        quote = entry.get("quote")
        start = entry.get("start")
        end = entry.get("end")
        if not isinstance(quote, str) or not quote:
            raise QualityError("invalid_plan")
        if not isinstance(fact_text, str) or not fact_text.strip():
            raise QualityError("invalid_plan")
        if isinstance(start, bool) or not isinstance(start, int):
            raise QualityError("invalid_plan")
        if isinstance(end, bool) or not isinstance(end, int):
            raise QualityError("invalid_plan")
        if start < 0 or end <= start or end > len(turn.text):
            raise QualityError("invalid_plan")
        if turn.text[start:end] != quote:
            raise QualityError("invalid_plan")
        if mode == EXTRACTION_MODE_SOURCE_SPANS and fact_text != quote:
            # The default pipeline never rewrites; fact is the original span.
            raise QualityError("invalid_plan")
        if contains_credential(quote) or contains_credential(fact_text):
            raise QualityError("credential_like")
        facts.append(ValidatedFact(fact=fact_text, quote=quote, start=start, end=end))
    quality_block = plan.get("quality")
    if not isinstance(quality_block, dict):
        raise QualityError("invalid_plan")
    no_durable = quality_block.get("no_durable_facts")
    if type(quality_block.get("fact_count")) is not int or quality_block["fact_count"] != len(facts):
        raise QualityError("invalid_plan")
    if no_durable is not False:
        raise QualityError("invalid_plan")
    if mode == EXTRACTION_MODE_SOURCE_SPANS:
        validate_selection_evidence(quality_block.get("semantic"), len(facts), False,
                                    config.semantic_threshold)
    else:
        validate_semantic_evidence(quality_block.get("semantic"), facts, no_durable,
                                   config.semantic_threshold)
    return facts
