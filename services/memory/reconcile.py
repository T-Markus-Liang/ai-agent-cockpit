"""Cross-event correction / conflict resolution for recalled memory facts.

This is a *pure*, offline reducer: standard-library only, no I/O, no clock, no
third-party imports, no dependency on :mod:`services.memory.service`.  It takes a
flat list of *receipts* -- the source-backed facts a caller already trusts -- and
returns a deterministic, versioned view of which facts are ``current``, which
have been ``superseded``, and which could not be resolved without guessing
(``conflicts``).

Frozen contract (0.3.0 I02/P1, first slice)
-------------------------------------------
Input receipt (mapping):

    event_id     required, non-empty str
    user_id      required, non-empty str
    text         required, str
    created_at   required, finite number (int/float, not bool, not NaN/inf)
    source       optional, str
    slot         optional, str   -- the identity slot this fact occupies,
                                    e.g. ``"user:nickname"``
    supersedes   optional, str   -- event_id this receipt explicitly corrects
    forgotten    optional, int/bool

Any structurally invalid receipt raises :class:`ReconcileError` with code
``"invalid-receipt"``.  A receipt whose ``forgotten`` is truthy is skipped
defensively (callers are expected to pre-filter too).

Adjudication rules
------------------
1. Grouping by ``(user_id, slot)``.  A missing/empty ``slot`` defaults to the
   receipt's own ``event_id``, so slot-less receipts never supersede one another
   and are always independent.  Different users are fully isolated namespaces.
2. Explicit correction: a receipt carrying ``supersedes`` must point at an
   existing target in the same user **and** the same slot; otherwise the receipt
   goes to ``conflicts`` with reason ``supersede-target-invalid`` and the
   correction is never silently applied.  When valid, the target is recorded as
   superseded by the declarer.
3. Timeline supersession: the remaining members of a group are ordered by
   ``(created_at, event_id)``; the newest is ``current`` and the rest are
   ``superseded`` with ``superseded_by`` pointing at their successor in that
   order (a chain ``A -> B -> C`` gives A and B successors B and C).
4. Same-timestamp conflict: if any two members of a group share an identical
   ``created_at`` (with distinct ``event_id``) the group cannot be ordered; every
   member of the group goes to ``conflicts`` with reason
   ``same-timestamp-conflict`` and the group contributes no ``current``.
5. Determinism: the result depends only on the set of receipts -- never on input
   order -- and two calls on the same input are deeply equal.

Output::

    {"current": [...], "superseded": [...], "conflicts": [...]}

``current``/``superseded`` items are the original receipt fields plus:

    version       1-based position within the group's time-ordered chain
    superseded_by the successor event_id, or ``None`` for ``current``
    chain         the group's event_ids in time order

``conflicts`` items are the original receipt fields plus a ``reason``.

The source fields (``source``/``slot``/``created_at``/``text``) are always
preserved, including on ``superseded`` items: an old value is never deleted, it
is merely no longer current.

Documented behaviour beyond the literal contract
-------------------------------------------------
* Two receipts may not share an ``event_id``; duplicates raise
  ``ReconcileError("invalid-receipt")`` rather than collapse ambiguously.
* ``None`` for the optional keys ``source``/``slot``/``supersedes`` is treated
  as *absent*; any other non-string value is invalid.
* If an explicit declaration contradicts the timeline (the target is newer than
  its declarer) the resulting successor graph can contain a cycle.  In that
  corner the explicit edges are dropped and the group falls back to the pure
  timeline, so every resolvable group always yields exactly one ``current``.
"""

from __future__ import annotations

import math

__all__ = ["ReconcileError", "reconcile"]

INVALID_RECEIPT = "invalid-receipt"
SUPERSEDE_TARGET_INVALID = "supersede-target-invalid"
SAME_TIMESTAMP_CONFLICT = "same-timestamp-conflict"

_REQUIRED = ("event_id", "user_id", "text", "created_at")


class ReconcileError(Exception):
    """A rejected reconciliation request.

    Carries a stable, machine-readable ``code`` (``"invalid-receipt"``) so
    callers can branch without string-matching the message.
    """

    def __init__(self, code: str, detail: str | None = None):
        message = code if detail is None else f"{code}: {detail}"
        super().__init__(message)
        self.code = code
        self.detail = detail


def _is_finite_number(value) -> bool:
    # bool is a subclass of int but is not a meaningful timestamp.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _validate(receipt) -> None:
    """Raise :class:`ReconcileError` unless ``receipt`` matches the contract."""
    if not isinstance(receipt, dict):
        raise ReconcileError(INVALID_RECEIPT, "receipt must be a mapping")
    for key in _REQUIRED:
        if key not in receipt:
            raise ReconcileError(INVALID_RECEIPT, f"missing {key}")
    if not isinstance(receipt["event_id"], str) or not receipt["event_id"]:
        raise ReconcileError(INVALID_RECEIPT, "event_id must be a non-empty string")
    if not isinstance(receipt["user_id"], str) or not receipt["user_id"]:
        raise ReconcileError(INVALID_RECEIPT, "user_id must be a non-empty string")
    if not isinstance(receipt["text"], str):
        raise ReconcileError(INVALID_RECEIPT, "text must be a string")
    if not _is_finite_number(receipt["created_at"]):
        raise ReconcileError(INVALID_RECEIPT, "created_at must be a finite number")
    for key in ("source", "slot", "supersedes"):
        value = receipt.get(key)
        if value is not None and not isinstance(value, str):
            raise ReconcileError(INVALID_RECEIPT, f"{key} must be a string")
    forgotten = receipt.get("forgotten", 0)
    if not isinstance(forgotten, (bool, int)):
        raise ReconcileError(INVALID_RECEIPT, "forgotten must be an int or bool")


def _effective_slot(receipt) -> str:
    """The identity slot; a missing/empty slot falls back to the event_id."""
    slot = receipt.get("slot")
    return slot if slot else receipt["event_id"]


def _truthy_forgotten(receipt) -> bool:
    return bool(receipt.get("forgotten"))


def _resolve_group(members, by_id):
    """Resolve a single ``(user_id, slot)`` group.

    Returns ``(current, superseded, conflicts)`` where every list is ordered
    deterministically (time order for resolved items, then event_id for
    conflicts), independent of the order the members arrived in.
    """
    current, superseded, conflicts = [], [], []

    # Rule 2 -- validate explicit corrections before anything else.  A receipt
    # whose correction cannot be honoured is quarantined, never silently applied.
    active = []
    for receipt in members:
        target_id = receipt.get("supersedes") or ""
        if not target_id:
            active.append(receipt)
            continue
        target = by_id.get(target_id)
        valid = (
            target is not None
            and target["event_id"] != receipt["event_id"]
            and target["user_id"] == receipt["user_id"]
            and _effective_slot(target) == _effective_slot(receipt)
        )
        if not valid:
            conflicts.append({**receipt, "reason": SUPERSEDE_TARGET_INVALID})
            continue
        active.append(receipt)

    # Rule 4 -- an unresolvable tie poisons the whole group: no guessing, no
    # current.  (Distinct event_ids are guaranteed by the duplicate check.)
    if len({receipt["created_at"] for receipt in active}) != len(active):
        for receipt in active:
            conflicts.append({**receipt, "reason": SAME_TIMESTAMP_CONFLICT})
        conflicts.sort(key=lambda item: (item["created_at"], item["event_id"]))
        return current, superseded, conflicts

    if not active:
        conflicts.sort(key=lambda item: (item["created_at"], item["event_id"]))
        return current, superseded, conflicts

    # Rule 3 -- the time-ordered chain defines versions and the default successor.
    ordered = sorted(active, key=lambda receipt: (receipt["created_at"], receipt["event_id"]))
    chain = [receipt["event_id"] for receipt in ordered]
    successor = {
        ordered[index]["event_id"]: ordered[index + 1]["event_id"]
        for index in range(len(ordered) - 1)
    }
    successor[ordered[-1]["event_id"]] = None

    # Valid explicit corrections override the default successor.  Iterating the
    # time order means the newest declarer wins if several correct one target.
    for receipt in ordered:
        target_id = receipt.get("supersedes") or ""
        if target_id:
            successor[target_id] = receipt["event_id"]

    # Cycle guard for contradictory declarations: fall back to the pure timeline
    # so a resolvable group always has exactly one current.
    if not any(value is None for value in successor.values()):
        successor = {
            receipt["event_id"]: (ordered[index + 1]["event_id"]
                                  if index + 1 < len(ordered) else None)
            for index, receipt in enumerate(ordered)
        }

    for index, receipt in enumerate(ordered):
        superseded_by = successor[receipt["event_id"]]
        item = {
            **receipt,
            "version": index + 1,
            "superseded_by": superseded_by,
            "chain": list(chain),
        }
        if superseded_by is None:
            current.append(item)
        else:
            superseded.append(item)

    conflicts.sort(key=lambda item: (item["created_at"], item["event_id"]))
    return current, superseded, conflicts


def reconcile(receipts) -> dict:
    """Reduce ``receipts`` into ``{"current", "superseded", "conflicts"}``.

    Pure and deterministic: the output depends only on the receipt set, never on
    input order, and repeated calls are deeply equal.  Raises
    :class:`ReconcileError` (``code == "invalid-receipt"``) for malformed input.
    """
    if receipts is None:
        raise ReconcileError(INVALID_RECEIPT, "receipts must be an iterable of mappings")
    try:
        items = list(receipts)
    except TypeError:
        raise ReconcileError(INVALID_RECEIPT, "receipts must be an iterable of mappings")

    kept = []
    seen = set()
    for receipt in items:
        _validate(receipt)
        if _truthy_forgotten(receipt):
            continue
        event_id = receipt["event_id"]
        if event_id in seen:
            raise ReconcileError(INVALID_RECEIPT, "duplicate event_id")
        seen.add(event_id)
        kept.append(receipt)

    by_id = {receipt["event_id"]: receipt for receipt in kept}
    groups: dict = {}
    for receipt in kept:
        key = (receipt["user_id"], _effective_slot(receipt))
        groups.setdefault(key, []).append(receipt)

    current, superseded, conflicts = [], [], []
    for key in sorted(groups):
        group_current, group_superseded, group_conflicts = _resolve_group(groups[key], by_id)
        current.extend(group_current)
        superseded.extend(group_superseded)
        conflicts.extend(group_conflicts)

    return {"current": current, "superseded": superseded, "conflicts": conflicts}
