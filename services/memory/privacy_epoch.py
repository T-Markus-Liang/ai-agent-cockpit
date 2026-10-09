"""Per-user privacy epoch for the memory service (0.3.0 S04, remediation §6-1).

A privacy epoch is a POST-STORAGE, per-user monotonic integer. Bumping it is
the privacy-reset entry point: it raises the epoch WITHOUT deleting any native
history (the ingestion SQLite, the vector store, archives and tombstones are
all left byte-for-byte untouched) and WITHOUT killing or replaying in-flight
tasks. An epoch change only affects SUBSEQUENT READS: an in-flight worker keeps
its current input, and the generation/delivery boundaries re-check the epoch
and settle honestly (hold / needs-review) instead of forcing stale context
through.

State is persisted as one small JSON file per user under
``<state_dir>/privacy-epochs/<user_id>.json`` (atomic tmp + replace, mode
0600, directory 0700). The epoch is deliberately kept OUT of the ingestion
SQLite so a privacy reset never needs a write lock on the store it protects.

To distinguish never-initialized new users from established users whose state
file has been lost/deleted (PE-F002 fail-closed fix), a durable marker file
is maintained under ``<state_dir>/privacy-markers/<user_id>.marker`` (mode 0600,
directory 0700).

Read semantics (fail-closed):

* Unestablished user (no marker AND no epoch file) -> epoch ``0`` (legal initial era).
* Established user with missing, unreadable, corrupted, tampered epoch file,
  missing parent directory, or permission anomalies -> :data:`EPOCH_UNKNOWN` (``-1``).
  This is NEITHER ``0`` NOR any old value: the caller MUST treat the epoch as unknown,
  hold generation/delivery, and route the receipt to needs-review.
* Valid epoch file with missing marker -> returns epoch and self-heals by
  writing the durable marker.

Bump semantics:

* ``bump_epoch`` advances the epoch in ``privacy-epochs/<user_id>.json`` and
  guarantees the durable marker exists in ``privacy-markers/<user_id>.marker``.
  Raises :class:`PrivacyEpochError` on corruption or write failure.
* An established user whose epoch state file (or its parent directory) has
  been lost raises ``epoch-state-missing`` instead of restarting at 0+1: a
  resurrected era number could make a past era's facts retrievable again.


Internal-session rebuild: once the epoch is KNOWN, an internal conversation may
rebuild its context from records of the CURRENT era only via the pure function
:func:`filter_by_epoch`. Records carry the epoch they were written under;
records without a valid integer marker are excluded (fail-closed), because an
unmarked record cannot be proven to belong to the requested privacy era.

Hard boundaries:

* No native history is ever deleted, rewritten, truncated or re-stamped here.
* No network/model/WeChat call is made; only small per-user epoch/lock files
  are read/written inside ``state_dir``.
* The production state directory is never opened by this module itself —
  callers pass a ``state_dir`` and every path derived from it is validated.
"""
from __future__ import annotations

import json
import fcntl
import math
import os
import re
import stat
import time
from contextlib import contextmanager
from pathlib import Path

#: Sentinel returned by :func:`get_epoch` when the epoch cannot be determined.
#: Deliberately neither 0 (the known initial era) nor any stored value, so a
#: caller can never mistake "unknown" for "no reset has happened".
EPOCH_UNKNOWN = -1

#: Directory (inside ``state_dir``) holding the per-user epoch files.
EPOCH_DIR_NAME = "privacy-epochs"

#: Directory (inside ``state_dir``) holding the per-user durable markers.
MARKER_DIR_NAME = "privacy-markers"

_VERSION = 1

#: User ids are the same shape the authority document accepts; anything else is
#: refused (reads fail closed to EPOCH_UNKNOWN, bumps raise).
_USER_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{1,200}$")

#: Epoch files are tiny; bound them like the authority document.
_MAX_FILE_BYTES = 16384
_LOCK_TIMEOUT_SECONDS = 2.0


class PrivacyEpochError(Exception):
    """A privacy-epoch state failure.

    ``code`` is a stable, sanitized token safe to persist or log (it never
    carries file content or paths).
    """

    def __init__(self, code: str, message: str = ""):
        self.code = code
        super().__init__(message or code)


# ---------------------------------------------------------------------------
# path / parsing helpers
# ---------------------------------------------------------------------------
def _epoch_path(state_dir, user_id: str) -> Path:
    """Resolve the epoch file for ``user_id``, refusing unsafe ids."""
    if not isinstance(state_dir, (str, os.PathLike)):
        raise PrivacyEpochError("invalid-state-dir", "state_dir is not a path")
    if not isinstance(user_id, str) or not _USER_ID_RE.fullmatch(user_id):
        raise PrivacyEpochError("invalid-user-id", "user_id has an unsafe shape")
    return Path(state_dir) / EPOCH_DIR_NAME / (user_id + ".json")


def _marker_path(state_dir, user_id: str) -> Path:
    """Resolve the durable marker file for ``user_id``, refusing unsafe ids."""
    if not isinstance(state_dir, (str, os.PathLike)):
        raise PrivacyEpochError("invalid-state-dir", "state_dir is not a path")
    if not isinstance(user_id, str) or not _USER_ID_RE.fullmatch(user_id):
        raise PrivacyEpochError("invalid-user-id", "user_id has an unsafe shape")
    return Path(state_dir) / MARKER_DIR_NAME / (user_id + ".marker")


def _parse(raw: bytes, user_id: str):
    """Strictly parse an epoch file body; raise ``PrivacyEpochError`` on drift."""
    def unique_keys(pairs):
        doc = {}
        for key, value in pairs:
            if key in doc:
                raise ValueError("duplicate key")
            doc[key] = value
        return doc

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise PrivacyEpochError("epoch-state-corrupt", "epoch file is not utf-8") from None
    try:
        doc = json.loads(text, object_pairs_hook=unique_keys)
    except (json.JSONDecodeError, TypeError, ValueError, RecursionError):
        raise PrivacyEpochError("epoch-state-corrupt", "epoch file is not json") from None
    if not isinstance(doc, dict):
        raise PrivacyEpochError("epoch-state-corrupt", "epoch file is not an object")
    if set(doc) != {"version", "user_id", "epoch", "updated_at"}:
        raise PrivacyEpochError("epoch-state-corrupt", "epoch file has unknown keys")
    if type(doc["version"]) is not int or doc["version"] != _VERSION or doc["user_id"] != user_id:
        raise PrivacyEpochError("epoch-state-corrupt", "epoch file identity mismatch")
    epoch = doc["epoch"]
    # ``bool`` is an ``int`` subclass in Python; reject it explicitly.
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
        raise PrivacyEpochError("epoch-state-corrupt", "epoch is not a non-negative integer")
    if (isinstance(doc["updated_at"], bool)
            or not isinstance(doc["updated_at"], (int, float))
            or (isinstance(doc["updated_at"], float)
                and not math.isfinite(doc["updated_at"]))):
        raise PrivacyEpochError("epoch-state-corrupt", "updated_at is not numeric")
    return epoch


def _validate(st, *, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    mode = 0o700 if directory else 0o600
    if (not kind(st.st_mode) or st.st_uid != os.geteuid()
            or stat.S_IMODE(st.st_mode) != mode
            or (not directory and st.st_nlink != 1)):
        raise PrivacyEpochError("epoch-state-unsafe")


@contextmanager
def _directory(path: Path, *, create: bool):
    """Walk with directory FDs; never follow caller-controlled symlinks.

    macOS's fixed /tmp and /var system aliases are canonicalized first.
    Existing state/epoch directories must already be owned and private;
    unsafe permissions are refused, never silently repaired.
    """
    root = path.parent.parent.absolute()
    parts = root.parts[1:]
    if os.uname().sysname == "Darwin" and parts and parts[0] in ("tmp", "var"):
        root = Path("/private") / Path(*parts)
    if ".." in root.parts:
        raise PrivacyEpochError("invalid-state-dir")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        components = (*root.parts[1:], path.parent.name)
        for index, component in enumerate(components):
            if component in (".", ".."):
                raise PrivacyEpochError("invalid-state-dir")
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)
            os.close(fd)
            fd = child
            if index >= len(components) - 2:
                _validate(os.fstat(fd), directory=True)
        yield fd
    finally:
        os.close(fd)


def _read_current(path: Path, directory_fd: int) -> int:
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory_fd)
    except FileNotFoundError:
        return 0
    try:
        _validate(os.fstat(fd))
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(_MAX_FILE_BYTES + 1)
        if len(raw) > _MAX_FILE_BYTES:
            raise PrivacyEpochError("epoch-state-corrupt")
        return _parse(raw, path.stem)
    finally:
        os.close(fd)


@contextmanager
def _locked(directory_fd: int, name: str):
    """Persistent lock inode: never unlink it, including on timeout/failure."""
    # macOS APFS namei race: two processes racing O_CREAT on the same name
    # can spuriously get ENOENT (~10%, reproduced in plain C). The inode is
    # either present or creatable, so retry briefly instead of misreading the
    # kernel race as privacy-state loss.
    fd = None
    for attempt in range(5):
        try:
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o600, dir_fd=directory_fd)
            break
        except FileNotFoundError:
            if attempt == 4:
                raise
            time.sleep(0.005 * (attempt + 1))
    try:
        _validate(os.fstat(fd))
        deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise PrivacyEpochError("epoch-lock-timeout") from None
                time.sleep(0.01)
        opened = os.fstat(fd)
        named = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise PrivacyEpochError("epoch-lock-changed")
        yield
    finally:
        # Closing releases the lock even if fsync/replace fails.
        os.close(fd)


def _atomic_write(directory_fd: int, name: str, data: bytes) -> None:
    """Atomic tmp + replace write inside directory_fd with mode 0600."""
    tmp = name + "." + os.urandom(8).hex() + ".tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory_fd)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(data)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, name, src_dir_fd=directory_fd,
                   dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        try:
            os.unlink(tmp, dir_fd=directory_fd)
        except FileNotFoundError:
            pass


def _ensure_marker(state_dir, user_id: str) -> None:
    """Ensure the durable marker for ``user_id`` exists in privacy-markers."""
    path = _marker_path(state_dir, user_id)
    try:
        with _directory(path, create=False) as directory_fd:
            try:
                st = os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
                _validate(st)
                return
            except FileNotFoundError:
                pass
    except (FileNotFoundError, PrivacyEpochError):
        pass

    with _directory(path, create=True) as directory_fd:
        with _locked(directory_fd, path.stem + ".lock"):
            try:
                st = os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
                _validate(st)
                return
            except FileNotFoundError:
                pass
            doc = {
                "version": _VERSION,
                "user_id": user_id,
                "established_at": time.time(),
            }
            serialized = json.dumps(doc, separators=(",", ":")).encode("utf-8")
            _atomic_write(directory_fd, path.name, serialized)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------
def initialize_user(state_dir, user_id: str, initial_epoch: int = 0) -> int:
    """Explicitly establish a user with a durable marker and initial epoch.

    Writes the durable marker in ``<state_dir>/privacy-markers/<user_id>.marker``
    and the initial epoch state file in ``<state_dir>/privacy-epochs/<user_id>.json``.
    Returns the initial epoch (defaults to 0).

    Fails closed on ANY establishment trace: an existing epoch state file
    (``already-established``) or a durable marker with the state file lost
    (``epoch-state-missing``) raises :class:`PrivacyEpochError` and nothing
    is written. Re-initializing an established user would silently reset its
    era (e.g. epoch 3 back to 0) and could re-expose a past era's facts.
    Only a user with no trace at all may be initialized.
    """
    if isinstance(initial_epoch, bool) or not isinstance(initial_epoch, int) or initial_epoch < 0:
        raise PrivacyEpochError("invalid-epoch", "initial_epoch must be a non-negative integer")
    path = _epoch_path(state_dir, user_id)
    try:
        with _directory(path, create=True) as directory_fd:
            with _locked(directory_fd, path.stem + ".lock"):
                try:
                    st = os.stat(path.name, dir_fd=directory_fd,
                                 follow_symlinks=False)
                except FileNotFoundError:
                    st = None
                if st is not None:
                    _validate(st)  # unsafe existing state is refused too
                    raise PrivacyEpochError(
                        "already-established",
                        "user already has an epoch state file; refusing to re-initialize")
                if is_user_established(state_dir, user_id):
                    raise PrivacyEpochError(
                        "epoch-state-missing",
                        "user is established but the epoch state file is lost; "
                        "refusing to re-initialize from scratch")
                doc = {
                    "version": _VERSION,
                    "user_id": user_id,
                    "epoch": initial_epoch,
                    "updated_at": time.time(),
                }
                serialized = json.dumps(doc, separators=(",", ":")).encode("utf-8")
                _atomic_write(directory_fd, path.name, serialized)
                _ensure_marker(state_dir, user_id)
                return initial_epoch
    except (OSError, ValueError):
        raise PrivacyEpochError("epoch-state-unwritable") from None


def is_user_established(state_dir, user_id: str) -> bool:
    """Check if user has been established via marker or epoch file.

    Returns True if marker or epoch file exists on disk.
    Fails closed (returns True) on directory permission/corruption errors
    to avoid treating established users as unestablished. Returns False
    only when there is no trace of user presence.
    """
    try:
        m_path = _marker_path(state_dir, user_id)
        e_path = _epoch_path(state_dir, user_id)
    except PrivacyEpochError:
        return False

    # Check marker
    try:
        with _directory(m_path, create=False) as m_dir_fd:
            try:
                os.stat(m_path.name, dir_fd=m_dir_fd, follow_symlinks=False)
                return True
            except FileNotFoundError:
                pass
    except FileNotFoundError:
        pass
    except (PrivacyEpochError, OSError):
        # Fail-closed: directory unreadable or damaged -> treat as established
        return True

    # Check epoch file
    try:
        with _directory(e_path, create=False) as e_dir_fd:
            try:
                os.stat(e_path.name, dir_fd=e_dir_fd, follow_symlinks=False)
                return True
            except FileNotFoundError:
                pass
    except FileNotFoundError:
        pass
    except (PrivacyEpochError, OSError):
        # Fail-closed: directory unreadable or damaged -> treat as established
        return True

    return False


def get_epoch(state_dir, user_id: str) -> int:
    """Return the current privacy epoch for ``user_id`` (0 when never reset).

    ANY failure — missing/invalid ``state_dir`` or ``user_id``, a corrupt,
    tampered or unreadable epoch file, or a missing epoch file for an
    established user — fails closed to :data:`EPOCH_UNKNOWN`.
    The caller MUST treat that as "epoch unknown": hold generation/delivery,
    never fall back to old context, and route the receipt to needs-review.
    """
    try:
        epoch_path = _epoch_path(state_dir, user_id)
        marker_path = _marker_path(state_dir, user_id)
    except PrivacyEpochError:
        return EPOCH_UNKNOWN

    # 1. Check marker
    marker_exists = False
    try:
        with _directory(marker_path, create=False) as m_dir_fd:
            try:
                st = os.stat(marker_path.name, dir_fd=m_dir_fd, follow_symlinks=False)
                marker_exists = True
                _validate(st)
            except FileNotFoundError:
                marker_exists = False
    except FileNotFoundError:
        marker_exists = False
    except (PrivacyEpochError, OSError):
        return EPOCH_UNKNOWN

    # 2. Check epoch directory & epoch file
    try:
        with _directory(epoch_path, create=False) as e_dir_fd:
            try:
                st = os.stat(epoch_path.name, dir_fd=e_dir_fd, follow_symlinks=False)
            except FileNotFoundError:
                if marker_exists:
                    return EPOCH_UNKNOWN
                return 0

            _validate(st)
            fd = os.open(epoch_path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=e_dir_fd)
            try:
                with os.fdopen(fd, "rb", closefd=False) as stream:
                    raw = stream.read(_MAX_FILE_BYTES + 1)
                if len(raw) > _MAX_FILE_BYTES:
                    return EPOCH_UNKNOWN
                epoch = _parse(raw, user_id)
            finally:
                os.close(fd)

            if not marker_exists:
                try:
                    _ensure_marker(state_dir, user_id)
                except Exception:
                    pass
            return epoch

    except FileNotFoundError:
        if marker_exists:
            return EPOCH_UNKNOWN
        return 0
    except (PrivacyEpochError, OSError, ValueError):
        return EPOCH_UNKNOWN


def bump_epoch(state_dir, user_id: str) -> int:
    """Bump the privacy epoch for ``user_id`` and return the new value.

    This is the privacy-reset entry point. It does NOT delete or modify any
    native history; it only raises the epoch so subsequent reads rebuild from
    the new era. A persistent mode-0600 per-user lock serializes the read,
    increment and replace across processes, with a bounded wait. The state
    write is atomic and fsynced. Private directories are created 0700;
    unsafe existing state is refused.

    Fails closed: an unsafe ``user_id``, a corrupt existing file (never
    silently reset over unreadable state), or any write failure raises
    :class:`PrivacyEpochError`. An ESTABLISHED user whose epoch state file
    has been lost raises ``epoch-state-missing``: the bump must never
    restart the counter from 0, because that could resurrect a past era's
    number and re-expose its facts (reads already return
    :data:`EPOCH_UNKNOWN` for that state). A failure after replace
    (directory fsync) may already have advanced the epoch; it is never
    rolled back. Callers must reconcile that uncertain outcome before
    retrying.
    """
    path = _epoch_path(state_dir, user_id)
    try:
        with _directory(path, create=True) as directory_fd:
            with _locked(directory_fd, path.stem + ".lock"):
                try:
                    os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
                    file_missing = False
                except FileNotFoundError:
                    file_missing = True
                if file_missing:
                    if is_user_established(state_dir, user_id):
                        raise PrivacyEpochError(
                            "epoch-state-missing",
                            "established user has no epoch state file; "
                            "refusing to bump from zero")
                    current = 0
                else:
                    current = _read_current(path, directory_fd)
                new_epoch = current + 1
                doc = {"version": _VERSION, "user_id": user_id, "epoch": new_epoch,
                       "updated_at": time.time()}
                serialized = json.dumps(doc, separators=(",", ":")).encode("utf-8")
                if len(serialized) > _MAX_FILE_BYTES:
                    raise PrivacyEpochError("epoch-state-corrupt")
                _atomic_write(directory_fd, path.name, serialized)
                _ensure_marker(state_dir, user_id)
                return new_epoch
    except (OSError, ValueError):
        raise PrivacyEpochError("epoch-state-unwritable") from None


def filter_by_epoch(records, epoch: int) -> list:
    """Pure era filter for internal-session context rebuilds.

    Keeps only records whose write-time epoch marker EQUALS ``epoch`` (the
    current, known era). Records without a valid non-negative integer marker
    are excluded: an unmarked record cannot be proven to belong to the
    requested privacy era, so fail closed. Querying with :data:`EPOCH_UNKNOWN`
    yields an empty list — an unknown era can never authorize context.

    A record may be a mapping with an ``"epoch"`` key or any object with an
    ``epoch`` attribute. The input records are returned as-is (no copies, no
    content inspection beyond the marker).
    """
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch == EPOCH_UNKNOWN:
        return []
    kept = []
    for record in records:
        if isinstance(record, dict):
            marker = record.get("epoch", EPOCH_UNKNOWN)
        else:
            marker = getattr(record, "epoch", EPOCH_UNKNOWN)
        if (isinstance(marker, int) and not isinstance(marker, bool)
                and marker == epoch):
            kept.append(record)
    return kept


__all__ = [
    "EPOCH_UNKNOWN",
    "EPOCH_DIR_NAME",
    "MARKER_DIR_NAME",
    "PrivacyEpochError",
    "get_epoch",
    "bump_epoch",
    "filter_by_epoch",
    "initialize_user",
    "is_user_established",
]


