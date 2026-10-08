"""Permanent-erasure policy and execution for the memory service (I02/P1 slice 2).

V36 semantics: a user who forgets a memory chooses either to *stop retrieval /
re-extraction* (soft forget — the durable tombstone path owned by
``lifecycle.py``) or to *confirm deletion* (permanent erasure — this module).
Purge always runs **after** a soft forget: this module refuses to physically
erase anything that has no tombstone yet, so the reversible operator action and
the irreversible one stay strictly ordered.

Three invariants shape the design:

* Erase the content, keep the evidence. A turn row is never physically removed:
  its content copies are scrubbed to an erasure marker, ``purged`` is set, and
  the original ``digest`` is preserved verbatim — so the deletion itself stays
  auditable. Vector entries are the only physical deletion, and every effect
  goes through an *injected* function (never a real SDK/DB call here).
* Verify the content, not just the flag. A success is claimed only after the
  layer re-reads every content copy it owns on the turn — ``payload`` and the
  ``plan``/``quote`` extraction record — and finds each erased to the agreed
  marker or empty. A correctly-set ``purged`` flag and an unchanged ``digest``
  are necessary but not sufficient. If the read surface cannot expose a content
  field, the outcome is ``unverifiable``, never ``verified``.
* Re-check before you erase -- and again *at the effect boundary*. No
  irreversible effect is dispatched until the target's live identity has been
  re-read from the authoritative store and compared item by item to the approved
  plan: the content ``digest`` always, plus every identity field the read
  surface exposes (owning ``user_id``, ``event_id``, ``source_hash`` and the
  bound ``vector_ids``) and the approval (tombstone) status when a probe is
  supplied. The batch is checked up front *and* again immediately before every
  ``delete``/``scrub``, because a single synchronous scan cannot prove the
  window is closed: a sibling's own effect can let a concurrent writer change a
  later target between the scan and that target's erase. A target that drifted
  keeps zero ``delete``/``scrub`` and the batch fails truthfully -- as
  ``drifted-target`` with a per-target status map, never a silent success and
  never a fake rollback. When the caller's store can apply an atomic conditional
  effect (``... WHERE id = ? AND digest = ?``, checked via affected rows) the
  window narrows to that store's own critical section; otherwise the re-read and
  the effect run back to back in the same critical section and the residual
  window is declared rather than hidden.
* No revival of an old summary. This module never deletes tombstones. The
  tombstone left behind by the prior soft forget keeps intercepting any replay
  of the same source text under a new event id (``lifecycle.ForgetStore.match``
  by ``event_id`` / ``source_hash`` / ``quote_hash``), so an erased fact can
  never be re-extracted, re-trusted or recalled from a stale archive copy.

The conversation ``conversation-archive/`` is owned by the vendor bridge, not
by this service. The plan therefore only *references* archived events through
``archive_refs``; the execution stage never touches the archive (there is no
archive callback in :func:`execute_purge`), leaving archive coordination to the
local coordinator/vendor bridge.

Pure Python standard library; no model, SDK or service is imported or called.
The caller supplies the physical-effect callbacks (``delete_vector``,
``scrub_turn``, ``vector_exists``, ``turn_get``); tests drive them with pure
in-memory fakes. ``turn_get(event_id)`` is contracted to return the current turn
with, at minimum, ``purged``, ``digest`` and the layer-owned content copies
``payload`` / ``plan`` (both must be readable, or the erase is unverifiable).
For the boundary fence it should also expose the authoritative identity fields
``user_id``, ``event_id``, ``source_hash`` and ``vector_ids``; a field the
surface cannot expose cannot contradict the plan, so a store that omits them
gets a weaker (digest-only) fence and must be aware of that residual.
"""
from __future__ import annotations

PURGE_ERROR_CODES = (
    "invalid-request",
    "tombstone-required",
    "purge-incomplete",
    "verify-failed",
    "drifted-target",
    "unverifiable",
)

_MODES = ("event", "fact")
_SELECTOR_KEYS = ("event_id", "source_hash")
_RECEIPT_KEYS = frozenset({"event_id", "user_id", "digest", "source_hash",
                           "vector_ids", "has_archive"})
_TOMBSTONE_KEYS = frozenset({"user_id", "event_id", "source_hash", "quote_hashes"})
_REQUEST_KEYS = frozenset({"user_id", "selector", "mode"})

# Content copies this layer owns on a turn row and must prove erased: the raw
# ``payload`` and the extraction ``plan`` (whose ``facts[*].quote`` entries echo
# the original text). ``turn_get`` must expose both for a purge to be verified.
_CONTENT_FIELDS = ("payload", "plan")
# The agreed marker a scrubbed content field is rewritten to; an empty value is
# equally accepted (see :func:`_is_erased`).
ERASURE_MARKER = "[purged]"

# Per-target outcome labels carried by a partial-batch failure so the caller sees
# the honest state of *every* target instead of a single all-green/ all-red flag:
#   completed      - the erase was dispatched and passed the post-erase check;
#   already-purged - the turn was already erased; nothing re-dispatched;
#   refused-drift  - a boundary re-read showed it no longer matches the plan, so
#                    it kept zero delete/scrub;
#   failed         - a physical-effect callback raised for it;
#   unknown        - some of its effects were dispatched but a mid-target drift
#                    left the final state unconfirmable (never called success).
_TARGET_STATUSES = ("completed", "already-purged", "refused-drift", "failed", "unknown")


class PurgeError(Exception):
    """A typed permanent-erasure failure.

    ``code`` is one of :data:`PURGE_ERROR_CODES`. ``completed``/``failed`` carry
    the truthful per-target outcome lists for a ``purge-incomplete`` failure so
    a partial erase is reported explicitly, never silently swallowed.
    ``statuses`` maps every target's ``event_id`` to one of
    :data:`_TARGET_STATUSES`, so a partially-applied batch is legible target by
    target rather than collapsed into a single flag.
    """

    def __init__(self, code: str, *, completed=None, failed=None, drifted=None,
                 statuses=None, detail: str | None = None):
        if code not in PURGE_ERROR_CODES:
            raise ValueError(f"unknown purge error code: {code!r}")
        self.code = code
        self.completed = list(completed or [])
        self.failed = list(failed or [])
        self.drifted = list(drifted or [])
        self.statuses = dict(statuses or {})
        self.detail = detail
        super().__init__(code)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (f"PurgeError({self.code!r}, completed={self.completed!r}, "
                f"failed={self.failed!r}, drifted={self.drifted!r}, "
                f"statuses={self.statuses!r}, detail={self.detail!r})")


class _FrozenDict(dict):
    """A dict whose contents cannot be mutated, so a plan stays a frozen value."""

    def _immutable(self, *args, **kwargs):
        raise TypeError("purge plan is frozen")

    __setitem__ = _immutable
    __delitem__ = _immutable
    __ior__ = _immutable
    clear = _immutable
    pop = _immutable
    popitem = _immutable
    setdefault = _immutable
    update = _immutable


def _freeze(value):
    """Deep-freeze a plan: dicts become read-only, lists become tuples."""
    if isinstance(value, _FrozenDict):
        return value
    if isinstance(value, dict):
        return _FrozenDict({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


def _is_id(value) -> bool:
    return isinstance(value, str) and bool(value)


def _valid_receipt(receipt) -> bool:
    if not isinstance(receipt, dict) or set(receipt) != _RECEIPT_KEYS:
        return False
    if not _is_id(receipt["event_id"]) or not _is_id(receipt["user_id"]):
        return False
    if not isinstance(receipt["digest"], str) or not receipt["digest"]:
        return False
    if not isinstance(receipt["source_hash"], str) or not receipt["source_hash"]:
        return False
    vector_ids = receipt["vector_ids"]
    if not isinstance(vector_ids, list) or any(not _is_id(v) for v in vector_ids):
        return False
    if len(set(vector_ids)) != len(vector_ids):
        return False
    if not isinstance(receipt["has_archive"], bool):
        return False
    return True


def _valid_tombstone(tombstone) -> bool:
    if not isinstance(tombstone, dict) or set(tombstone) != _TOMBSTONE_KEYS:
        return False
    if not _is_id(tombstone["user_id"]) or not _is_id(tombstone["event_id"]):
        return False
    if not isinstance(tombstone["source_hash"], str) or not tombstone["source_hash"]:
        return False
    quote_hashes = tombstone["quote_hashes"]
    if not isinstance(quote_hashes, list):
        return False
    if any(not _is_id(q) for q in quote_hashes):
        return False
    return True


def _valid_request(request) -> bool:
    if not isinstance(request, dict) or set(request) != _REQUEST_KEYS:
        return False
    if not _is_id(request["user_id"]):
        return False
    mode = request["mode"]
    if mode not in _MODES:
        return False
    selector = request["selector"]
    if not isinstance(selector, dict):
        return False
    keys = set(selector)
    # Exactly one selector key: ``{event_id}`` or ``{source_hash}``. A user-level
    # purge is deliberately unsupported in this slice.
    if keys not in ({"event_id"}, {"source_hash"}):
        return False
    key = next(iter(keys))
    if not _is_id(selector[key]):
        return False
    # Mode and selector must agree: an event purge targets one event id, a fact
    # purge targets every event sharing one source hash.
    if key == "event_id" and mode != "event":
        return False
    if key == "source_hash" and mode != "fact":
        return False
    return True


def _matches(receipt, user_id, selector) -> bool:
    # Cross-user receipts are never touched, even if the selector value collides.
    if receipt["user_id"] != user_id:
        return False
    if "event_id" in selector:
        return receipt["event_id"] == selector["event_id"]
    return receipt["source_hash"] == selector["source_hash"]


def _is_tombstoned(receipt, user_id, tombstones) -> bool:
    """A target is tombstoned when a same-user tombstone matches its id or source.

    This mirrors the first two levels of ``lifecycle.ForgetStore.match``; the
    quote-hash level needs the original text and is enforced by that store at
    replay time, not here.
    """
    for tombstone in tombstones:
        if tombstone["user_id"] != user_id:
            continue
        if tombstone["event_id"] == receipt["event_id"]:
            return True
        if tombstone["source_hash"] == receipt["source_hash"]:
            return True
    return False


def plan_purge(receipts, tombstones, request) -> dict:
    """Resolve purge targets and return a frozen :class:`PurgePlan` dict.

    ``receipts`` are simplified ingestion receipts
    ``{event_id, user_id, digest, source_hash, vector_ids, has_archive}``;
    ``tombstones`` are ``{user_id, event_id, source_hash, quote_hashes}``; and
    ``request`` is ``{user_id, selector, mode}`` with ``mode`` in
    ``{"event", "fact"}``. Any malformed input raises ``invalid-request``.

    Only same-user receipts matching the selector become targets; a request with
    no match returns ``empty: True`` (reported truthfully, not an error).
    """
    if not isinstance(receipts, list) or not isinstance(tombstones, list):
        raise PurgeError("invalid-request", detail="receipts_or_tombstones_not_list")
    if not _valid_request(request):
        raise PurgeError("invalid-request", detail="request")
    for receipt in receipts:
        if not _valid_receipt(receipt):
            raise PurgeError("invalid-request", detail="receipt")
    for tombstone in tombstones:
        if not _valid_tombstone(tombstone):
            raise PurgeError("invalid-request", detail="tombstone")

    user_id = request["user_id"]
    selector = request["selector"]
    targets = []
    tombstones_required = []
    archive_refs = []
    source_hashes = []
    for receipt in receipts:
        if not _matches(receipt, user_id, selector):
            continue
        targets.append({
            "event_id": receipt["event_id"],
            "digest": receipt["digest"],
            "vector_ids": list(receipt["vector_ids"]),
            "source_hash": receipt["source_hash"],
        })
        if not _is_tombstoned(receipt, user_id, tombstones):
            tombstones_required.append({
                "event_id": receipt["event_id"],
                "source_hash": receipt["source_hash"],
            })
        if receipt["has_archive"]:
            archive_refs.append(receipt["event_id"])
        if receipt["source_hash"] not in source_hashes:
            source_hashes.append(receipt["source_hash"])

    plan = {
        "user_id": user_id,
        "mode": request["mode"],
        "targets": targets,
        "tombstones_required": tombstones_required,
        "archive_refs": archive_refs,
        "verification": {"source_hashes": source_hashes},
        "empty": not targets,
    }
    return _freeze(plan)


def _is_erased(value) -> bool:
    """True only when a content field no longer carries user content.

    Erased means empty (``None``, ``""``/``b""``, or an empty container) or the
    agreed marker — either the string :data:`ERASURE_MARKER` or the structural
    ``{"purged": True}`` form a scrub writer may leave behind. A surviving extra
    key (e.g. ``{"purged": True, "text": ...}``) or any non-empty plan still
    counts as content present.
    """
    if value is None:
        return True
    if isinstance(value, (str, bytes)):
        return value == "" or value == b"" or value == ERASURE_MARKER
    if isinstance(value, (list, tuple, dict, set, frozenset)):
        if len(value) == 0:
            return True
        return (isinstance(value, dict) and set(value) == {"purged"}
                and value["purged"] is True)
    return False


def _read_content(turn):
    """Return ``{field: value}`` for the layer-owned content fields.

    ``None`` means the read surface cannot expose one of them, so erasure is
    unverifiable — the caller must report that, never a ``verified`` success.
    """
    values = {}
    for field in _CONTENT_FIELDS:
        if isinstance(turn, dict):
            if field not in turn:
                return None
            values[field] = turn[field]
        elif hasattr(turn, field):
            values[field] = getattr(turn, field)
        else:
            return None
    return values


def _field(turn, name):
    """Read one attribute from a dict- or object-shaped turn, else ``None``."""
    if isinstance(turn, dict):
        return turn.get(name)
    return getattr(turn, name, None)


def _identity_matches(turn, user_id, target) -> bool:
    """True when a live turn still matches the approved target identity.

    Compared item by item against the frozen plan: the content ``digest`` is
    always required (it is the identity a concurrent writer changes), and every
    other authoritative field *the surface exposes* is compared too -- owning
    ``user_id``, the ``event_id``, the ``source_hash`` and the bound
    ``vector_ids``. A field the surface cannot expose (``None``) cannot
    contradict the plan and is skipped; the caller is expected to expose them all
    for a full fence.
    """
    digest = _field(turn, "digest")
    if not isinstance(digest, str) or digest != target["digest"]:
        return False
    event_id = _field(turn, "event_id")
    if event_id is not None and event_id != target["event_id"]:
        return False
    owner = _field(turn, "user_id")
    if owner is not None and owner != user_id:
        return False
    source_hash = _field(turn, "source_hash")
    if source_hash is not None and source_hash != target["source_hash"]:
        return False
    vector_ids = _field(turn, "vector_ids")
    if vector_ids is not None and set(vector_ids) != set(target["vector_ids"]):
        return False
    return True


def execute_purge(plan, delete_vector, scrub_turn, vector_exists, turn_get, *,
                  delete_vector_if=None, scrub_turn_if=None,
                  guard_approval=None) -> dict:
    """Execute a frozen plan through injected physical-effect callbacks.

    * ``delete_vector(vector_id)`` — physically delete one vector entry.
    * ``scrub_turn(event_id)`` — clear the turn's content copies (``payload`` and
      ``plan``) and set ``purged`` while preserving the ``digest`` (erase
      content, keep evidence).
    * ``vector_exists(vector_id)`` — post-erase existence probe.
    * ``turn_get(event_id)`` — read a turn exposing ``.purged`` / ``.digest``, the
      content copies ``.payload`` / ``.plan`` and ideally the identity fields
      ``user_id`` / ``event_id`` / ``source_hash`` / ``vector_ids``. Without the
      content fields the erase cannot be verified.

    Optional atomic-effect callbacks let a store whose own critical section can
    enforce the precondition narrow the check-to-effect window (see the module
    docstring). When omitted, the module re-reads and then calls the plain
    callback back to back and the residual window is the caller's to declare:

    * ``delete_vector_if(vector_id, expected_digest) -> bool`` — delete only if
      the affected row still carries the approved digest; return whether a row
      was affected. ``False`` means a concurrent change won; no effect applied.
    * ``scrub_turn_if(event_id, expected_digest) -> bool`` — same, for the scrub.
    * ``guard_approval(user_id, event_id, source_hash) -> bool`` — re-check the
      prior soft-forget approval (tombstone) at the effect boundary; ``False``
      refuses the target.

    Ordered guarantees: a plan with unmet tombstones raises
    ``tombstone-required`` with zero side effects; an empty plan returns
    ``{"purged": [], "skipped": True}``; **every** target's identity is re-read
    and compared to the approved plan *before any effect* **and again at each
    effect boundary** (before every ``delete``/``scrub``) — a target that drifted
    keeps zero ``delete``/``scrub`` and the batch fails with ``drifted-target``
    whose ``statuses`` map gives every target's honest outcome
    (:data:`_TARGET_STATUSES`); a callback failure raises ``purge-incomplete``
    with the truthful completed/failed lists; a failed post-erase check raises
    ``verify-failed`` (a verification, not a rollback); a turn whose content
    copies cannot be read raises ``unverifiable`` — never ``verified``.
    Replaying an already-purged plan reports ``already_purged`` without
    re-deleting.
    """
    for name, callback in (("delete_vector", delete_vector), ("scrub_turn", scrub_turn),
                           ("vector_exists", vector_exists), ("turn_get", turn_get)):
        if not callable(callback):
            raise PurgeError("invalid-request", detail=f"{name}_not_callable")
    for name, callback in (("delete_vector_if", delete_vector_if),
                           ("scrub_turn_if", scrub_turn_if),
                           ("guard_approval", guard_approval)):
        if callback is not None and not callable(callback):
            raise PurgeError("invalid-request", detail=f"{name}_not_callable")

    # 1. Soft forget must have happened first: no tombstone -> no physical erase.
    if len(plan["tombstones_required"]) > 0:
        raise PurgeError("tombstone-required")

    targets = plan["targets"]
    # 2. Nothing selected: report the empty outcome, touch nothing.
    if plan["empty"] or len(targets) == 0:
        return {"purged": [], "already_purged": [], "skipped": True}

    user_id = plan["user_id"]

    def authorized(target) -> bool:
        """Re-read the target and re-check its whole authoritative identity.

        This is the fence: it is called *before every irreversible call*, not
        just once, so a write that lands during a sibling target's effect cannot
        slip an erase through. The approval probe (when supplied) and the turn
        identity read must both still agree with the frozen plan.
        """
        if guard_approval is not None:
            try:
                if not guard_approval(user_id, target["event_id"], target["source_hash"]):
                    return False
            except Exception:  # noqa: BLE001 - an unanswerable approval is not a yes
                return False
        try:
            current = turn_get(target["event_id"])
        except Exception:  # noqa: BLE001 - an unreadable target is not confirmable
            return False
        return _identity_matches(current, user_id, target)

    # 3. Preflight gate — read EVERY target's live identity and compare it to the
    # approved plan *before dispatching any effect*. A target that no longer
    # matches (or cannot be read at all) is withheld: it gets zero delete/scrub.
    preflight_refused = []
    ok_targets = []
    statuses = {}
    for target in targets:
        if authorized(target):
            ok_targets.append(target)
        else:
            preflight_refused.append(target["event_id"])
            statuses[target["event_id"]] = "refused-drift"

    # 4. Apply effects, but re-verify each target's identity at the boundary —
    # immediately before every delete and before the scrub. A single synchronous
    # scan cannot prove the window is closed: a sibling's callback may let a
    # concurrent writer change a later target after the preflight read.
    purged = []
    already_purged = []
    boundary_refused = []
    for target in ok_targets:
        event_id = target["event_id"]
        # (a) boundary re-verify before dispatching anything for this target.
        if not authorized(target):
            boundary_refused.append(event_id)
            statuses[event_id] = "refused-drift"
            continue
        # Idempotency: an already-purged target is reported, never re-deleted.
        if _field(turn_get(event_id), "purged"):
            already_purged.append(event_id)
            statuses[event_id] = "already-purged"
            continue
        applied = 0
        aborted = False
        try:
            for vector_id in target["vector_ids"]:
                # (b) re-verify before each delete: a change between deletes must
                # stop the remaining effects for this target.
                if not authorized(target):
                    aborted = True
                    break
                if delete_vector_if is not None:
                    # Atomic conditional delete: the store refuses when the
                    # precondition no longer holds, so no effect is applied.
                    if not delete_vector_if(vector_id, target["digest"]):
                        aborted = True
                        break
                else:
                    delete_vector(vector_id)
                applied += 1
            if not aborted:
                # (c) re-verify before the scrub, after the vector deletes.
                if not authorized(target):
                    aborted = True
                elif scrub_turn_if is not None:
                    if not scrub_turn_if(event_id, target["digest"]):
                        aborted = True
                else:
                    scrub_turn(event_id)  # preserve digest, clear content, set purged
        except Exception as error:  # noqa: BLE001 - report, never half-erase silently
            statuses[event_id] = "failed"
            raise PurgeError("purge-incomplete", completed=list(purged),
                             failed=[event_id],
                             drifted=preflight_refused + boundary_refused,
                             statuses=dict(statuses),
                             detail=type(error).__name__) from error
        if aborted:
            # Drift caught mid-target: whatever was dispatched stays dispatched
            # (truthfully ``unknown`` when part of the erase already happened),
            # and the rest is withheld — never scrubbed under a changed identity.
            boundary_refused.append(event_id)
            statuses[event_id] = "unknown" if applied else "refused-drift"
            continue
        purged.append(event_id)
        statuses[event_id] = "completed"

    # 5. Post-erase verification of the targets whose erase was dispatched:
    # vectors gone, turn purged, digest preserved, and — the part a flag alone
    # cannot prove — every layer-owned content copy actually erased. This is a
    # verification step, never a rollback: it can only report what it finds.
    for target in ok_targets:
        event_id = target["event_id"]
        if statuses.get(event_id) not in ("completed", "already-purged"):
            continue  # a refused target kept its content; nothing to verify
        for vector_id in target["vector_ids"]:
            if vector_exists(vector_id):
                raise PurgeError("verify-failed", completed=list(purged),
                                 drifted=preflight_refused + boundary_refused,
                                 statuses=dict(statuses),
                                 detail=f"vector_present:{vector_id}")
        current = turn_get(event_id)
        if not _field(current, "purged"):
            raise PurgeError("verify-failed", detail=f"turn_not_purged:{event_id}")
        if _field(current, "digest") != target["digest"]:
            raise PurgeError("verify-failed", detail=f"digest_changed:{event_id}")
        content = _read_content(current)
        if content is None:
            # The read surface cannot show us the content: unverifiable, never a
            # verified permanent-erasure claim.
            raise PurgeError("unverifiable", detail=f"content_unavailable:{event_id}")
        for field, value in content.items():
            if not _is_erased(value):
                raise PurgeError("verify-failed",
                                 detail=f"content_present:{event_id}:{field}")

    # 6. A drifted target is rejected only after the confirmable targets are
    # finished, so the outcome is an honest partial purge — never a silent
    # success and never a fake rollback.
    drifted = preflight_refused + boundary_refused
    if drifted:
        detail = "pre_effect_identity_drift" if boundary_refused else "preflight_identity_drift"
        raise PurgeError("drifted-target", completed=list(purged),
                         drifted=list(drifted), statuses=dict(statuses),
                         detail=detail)

    # 7. Tombstones are intentionally left intact (see module docstring): they
    # keep intercepting any replay of the erased source. Nothing here removes a
    # tombstone, and ``archive_refs`` is only a reference — the vendor-owned
    # conversation archive is never touched by this stage.
    return {"purged": purged, "already_purged": already_purged, "verified": True}
