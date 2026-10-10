"""Per-client request authority — Python mirror of ``control-plane/request-authority.mjs``.

The memory service authenticates each request from a small authority document
that lists per-client principals, instead of a single shared bearer token. The
document schema, the token-digest algorithm and the live-reload safety semantics
are byte-for-byte aligned with the Node implementation so that ONE
``authority.json`` can be consumed by both the Node services and this service:

    { "version": 1,
      "principals": [ { "id", "role", "tokenDigest", "expiresAt"?, "revoked"? } ] }

- ``tokenDigest`` is ``sha256(<bearer token string>)`` as lowercase hex, exactly
  as the Node side computes it (``createHash('sha256').update(token).digest('hex')``).
- ``expiresAt`` is a finite, non-negative epoch value. To stay consumable across
  both runtimes it uses the SAME unit Node's ``Date.now()`` produces: epoch
  **milliseconds**. ``clock() >= expiresAt`` means the principal no longer
  matches. (A seconds-based value would make every Node-written expiry look
  already-expired on this side, breaking the shared-document contract.)
- ``revoked: true`` entries never match and are retained as revocation evidence;
  they are never silently dropped.
- Unknown keys, duplicate ids/digests and any other malformed field fail closed
  with ``AUTH_CONFIGURATION`` (500 semantics).

No token, digest or file content is ever logged or returned by this module.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import stat as stat_module
import time
from typing import Mapping

# Parsed authority documents are tiny; anything larger is refused rather than
# read. Kept in lock-step with the Node MAX_AUTHORITY_BYTES limit.
MAX_AUTHORITY_BYTES = 16384

ROLES = frozenset({"operator", "coordinator", "chief", "viewer"})
_HEX64 = re.compile(r"[a-f0-9]{64}")
_ID = re.compile(r"[A-Za-z0-9:_-]{1,200}")
_KNOWN_KEYS = frozenset({"id", "role", "tokenDigest", "expiresAt", "revoked"})


class AuthorityError(Exception):
    """Fail-closed authentication/configuration error.

    ``status`` carries the HTTP status the caller must render: 401 for
    ``AUTH_REQUIRED``, 403 for ``AUTH_FORBIDDEN`` and 500 for
    ``AUTH_CONFIGURATION`` — mirroring ``AuthorityError`` in the Node module.
    """

    def __init__(self, code: str, status: int = 403):
        message = ("request authentication required" if code == "AUTH_REQUIRED"
                   else "request authority rejected")
        super().__init__(message)
        self.name = "AuthorityError"
        self.code = code
        self.status = status


def _now_ms() -> float:
    """Wall-clock epoch milliseconds — the unit Node's ``Date.now()`` returns."""
    return time.time() * 1000.0


def token_digest(token: str) -> str:
    """Lowercase hex sha256 of the bearer token string (Node-identical)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _validate_principal(value, seen_ids: set, seen_digests: set) -> dict:
    if not isinstance(value, Mapping):
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    # Unknown keys are rejected (mirrors Object.keys(...).some(...)).
    if any(key not in _KNOWN_KEYS for key in value.keys()):
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    identifier = value.get("id")
    role = value.get("role")
    digest = value.get("tokenDigest")
    if not isinstance(identifier, str) or not isinstance(role, str) or not isinstance(digest, str):
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    if not _ID.fullmatch(identifier) or role not in ROLES or not _HEX64.fullmatch(digest):
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    if identifier in seen_ids or digest in seen_digests:
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    if "expiresAt" in value:
        expires_at = value.get("expiresAt")
        # bool is an int subclass in Python; Node rejects a non-number boolean.
        if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
            raise AuthorityError("AUTH_CONFIGURATION", 500)
        if not math.isfinite(expires_at) or expires_at < 0:
            raise AuthorityError("AUTH_CONFIGURATION", 500)
    else:
        expires_at = None
    if "revoked" in value and value.get("revoked") is not True:
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    seen_ids.add(identifier)
    seen_digests.add(digest)
    return {
        "public": {"id": identifier, "role": role, "authenticated": True},
        "digest": digest,
        "expiresAt": expires_at,
        "revoked": value.get("revoked") is True,
    }


class RequestAuthority:
    """Strict per-client authority built from an already-parsed document."""

    def __init__(self, document, *, clock=_now_ms):
        if (not isinstance(document, Mapping) or document.get("version") != 1
                or not isinstance(document.get("principals"), list)
                or not 1 <= len(document.get("principals", [])) <= 16):
            raise AuthorityError("AUTH_CONFIGURATION", 500)
        seen_ids: set = set()
        seen_digests: set = set()
        self._principals = [
            _validate_principal(value, seen_ids, seen_digests)
            for value in document["principals"]
        ]
        self._clock = clock
        self.mode = "strict"

    def authenticate(self, headers: Mapping) -> dict:
        header = headers.get("authorization")
        if not isinstance(header, str) or not re.fullmatch(r"Bearer [A-Za-z0-9_-]{32,256}", header):
            raise AuthorityError("AUTH_REQUIRED", 401)
        digest = token_digest(header[7:])
        now = self._clock()
        found = None
        for principal in self._principals:
            if principal["revoked"]:
                continue
            expires_at = principal["expiresAt"]
            if expires_at is not None and now >= expires_at:
                continue
            # Constant-time compare; no early exit so a match cannot be timed by
            # the number of preceding principals (mirrors the Node loop).
            if hmac.compare_digest(digest, principal["digest"]):
                found = principal["public"]
        if found is None:
            raise AuthorityError("AUTH_REQUIRED", 401)
        return found


def create_request_authority(document, *, clock=_now_ms) -> RequestAuthority:
    """Validate ``document`` and return a strict authority (Node parity)."""
    return RequestAuthority(document, clock=clock)


class LiveAuthority:
    """Authority that revalidates the on-disk document on every ``authenticate``.

    Token rotation / revocation / expiry therefore take effect without a
    restart. The document is opened with ``O_NOFOLLOW`` and the change key
    (``ino:mtime:size``) is taken from ``fstat`` on that SAME fd, so there is no
    stat->read path-swap (TOCTOU) window.

    The safety metadata (regular file, ``mode & 0o077 == 0``, uid, size) is
    revalidated on EVERY call, on that same fd, BEFORE the cache key is
    consulted: the cache only ever saves JSON parsing, never a safety check, so a
    file widened in place (chmod changes neither ino, mtime nor size) is still
    refused on a warm cache (RR-F004).

    Fail-closed: any reload failure (file gone, permissions drift, symlink, bad
    JSON, bad schema) raises ``AuthorityError('AUTH_CONFIGURATION', 500)`` and the
    old cache is never used as a fallback. A writer rotating this file MUST do so
    atomically (``write_authority_file``); an in-place truncate+write can be
    observed mid-flight and is rejected, not half-parsed.
    """

    def __init__(self, path, *, clock=_now_ms):
        if not isinstance(path, str) or not os.path.isabs(path):
            raise AuthorityError("AUTH_CONFIGURATION", 500)
        self.path = path
        self.mode = "strict"
        self._clock = clock
        self._cache: tuple | None = None  # (key, RequestAuthority)
        self._generation = 0

    @property
    def generation(self) -> int:
        """Number of successful (re)parses — read-only observation counter."""
        return self._generation

    def authenticate(self, headers: Mapping) -> dict:
        fd = None
        try:
            fd = os.open(self.path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            info = os.fstat(fd)
            # Safety metadata is revalidated on every call, on this same fd,
            # before any cache lookup: a cached parse may save JSON parsing but
            # never these checks. A prior good parse must not mask a file widened
            # in place — chmod changes neither ino, mtime nor size, so a naive
            # change key would miss it and serve the stale principal (RR-F004).
            if (not stat_module.S_ISREG(info.st_mode)
                    or info.st_size > MAX_AUTHORITY_BYTES
                    or (info.st_mode & 0o077) != 0
                    or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
                raise AuthorityError("AUTH_CONFIGURATION", 500)
            key = f"{info.st_ino}:{info.st_mtime_ns}:{info.st_size}"
            if self._cache is not None and self._cache[0] == key:
                return self._cache[1].authenticate(headers)
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                fd = None  # fdopen took ownership; the finally block must not close it
                document = json.loads(handle.read())
            authority = create_request_authority(document, clock=self._clock)
            self._cache = (key, authority)
            self._generation += 1
            return authority.authenticate(headers)
        except AuthorityError:
            raise
        except Exception:  # noqa: BLE001 - any failure is a fail-closed config error
            raise AuthorityError("AUTH_CONFIGURATION", 500) from None
        finally:
            if fd is not None:
                os.close(fd)


def write_authority_file(path, snapshot) -> None:
    """Validate ``snapshot`` then write it atomically (mode 0600, tmp + replace).

    The document is validated FIRST, so an invalid snapshot is never written. The
    write is atomic — a mode-0600 tmp file in the target directory, then renamed
    over the target — so a concurrent ``LiveAuthority`` reader never observes a
    half-written file. Mirrors ``writeAuthorityFile`` in the Node module.
    """
    if not isinstance(path, str) or not os.path.isabs(path):
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    create_request_authority(snapshot)  # structural validation; raises before any write
    serialized = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MAX_AUTHORITY_BYTES:
        raise AuthorityError("AUTH_CONFIGURATION", 500)
    tmp = f"{path}.{os.urandom(8).hex()}.tmp"
    fd = None
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.chmod(tmp, 0o600)
        payload = serialized.encode("utf-8")
        written = 0
        while written < len(payload):
            written += os.write(fd, payload[written:])
        os.fsync(fd)
    except OSError:
        if fd is not None:
            os.close(fd)
        _unlink(tmp)
        raise AuthorityError("AUTH_CONFIGURATION", 500) from None
    os.close(fd)
    try:
        os.replace(tmp, path)
    except OSError:
        _unlink(tmp)
        raise AuthorityError("AUTH_CONFIGURATION", 500) from None


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
