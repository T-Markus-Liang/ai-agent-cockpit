"""Per-client authority + role-matrix tests for the memory service.

Two layers, all synthetic (tmp state dirs only; no production service, DB,
launchd or real user files are touched):

- ``AuthorityUnitTests`` exercises ``services.memory.authority`` directly: the
  document schema, the Bearer/digest contract, per-client lifecycle
  (revoked/expired/unknown), rotation-without-restart, and the RR-F004
  safety-before-cache guarantee mirroring the Node ``request-authority.mjs``.
- ``MemoryAuthHttpTests`` drives the real FastAPI app (FakeEngine, run_worker
  off) to pin the role×action matrix and per-client authentication end to end.
"""
import hashlib
import os
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from services.memory import quality
from services.memory.authority import (
    AuthorityError, LiveAuthority, create_request_authority, token_digest,
    write_authority_file)
from services.memory.service import MemoryService, Turn, create_app


def _principal(principal_id, role, token, **extra):
    entry = {"id": principal_id, "role": role, "tokenDigest": token_digest(token),
             "expiresAt": int(time.time() * 1000) + 3_600_000}
    entry.update(extra)
    return entry


def _document(principals):
    return {"version": 1, "principals": principals}


def _change_key(path):
    info = os.stat(path)
    return (info.st_ino, info.st_mtime_ns, info.st_size)


class AuthorityUnitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="memory-authority-unit-")
        self.root = Path(self.tmp.name)
        self.file = str(self.root / "authority.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, document):
        write_authority_file(self.file, document)

    # ---- schema ---------------------------------------------------------
    def test_schema_rejects_malformed_documents(self):
        good_digest = token_digest("A" * 40)
        bad = [
            {"version": 2, "principals": [{"id": "x", "role": "viewer", "tokenDigest": good_digest}]},
            {"version": 1, "principals": []},
            {"version": 1, "principals": [{"id": "x", "role": "viewer", "tokenDigest": good_digest}] * 17},
            {"version": 1, "principals": [{"id": "x", "role": "root", "tokenDigest": good_digest}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer", "tokenDigest": "not-hex"}]},
            {"version": 1, "principals": [{"id": "bad id", "role": "viewer", "tokenDigest": good_digest}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer", "tokenDigest": good_digest, "extra": True}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer", "tokenDigest": good_digest, "expiresAt": -1}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer", "tokenDigest": good_digest, "expiresAt": True}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer", "tokenDigest": good_digest, "revoked": False}]},
            {"version": 1, "principals": [
                {"id": "dup", "role": "viewer", "tokenDigest": good_digest},
                {"id": "dup", "role": "chief", "tokenDigest": token_digest("B" * 40)}]},
            {"version": 1, "principals": [
                {"id": "a", "role": "viewer", "tokenDigest": good_digest},
                {"id": "b", "role": "chief", "tokenDigest": good_digest}]},
        ]
        for document in bad:
            with self.assertRaises(AuthorityError) as caught:
                create_request_authority(document)
            self.assertEqual(caught.exception.code, "AUTH_CONFIGURATION")
            self.assertEqual(caught.exception.status, 500)
        # The upper bound (16) is inclusive.
        sixteen = [{"id": f"p{i}", "role": "viewer", "tokenDigest": token_digest(f"t{i}" * 20)}
                   for i in range(16)]
        create_request_authority(_document(sixteen))

    def test_bearer_shape_and_digest(self):
        token = "B" * 40
        authority = create_request_authority(_document([_principal("c", "operator", token)]))
        self.assertEqual(authority.authenticate({"authorization": "Bearer " + token}),
                         {"id": "c", "role": "operator", "authenticated": True})
        for header in [None, "", "Bearer short", "Bearer " + "x" * 31,
                       "Bearer " + "x" * 257, "Bearer with space" + " " + "x" * 31,
                       token, "Basic " + token]:
            with self.assertRaises(AuthorityError) as caught:
                authority.authenticate({"authorization": header})
            self.assertEqual(caught.exception.code, "AUTH_REQUIRED")
            self.assertEqual(caught.exception.status, 401)

    def test_per_client_revoked_expired_unknown(self):
        good, revoked, expired = "G" * 40, "R" * 40, "E" * 40
        clock_value = 5000
        authority = create_request_authority(_document([
            _principal("valid", "operator", good),
            _principal("revoked", "operator", revoked, revoked=True),
            _principal("expired", "operator", expired, expiresAt=4000),
        ]), clock=lambda: clock_value)
        self.assertEqual(authority.authenticate({"authorization": "Bearer " + good})["id"], "valid")
        for token in (revoked, expired, "U" * 40):
            with self.assertRaises(AuthorityError) as caught:
                authority.authenticate({"authorization": "Bearer " + token})
            self.assertEqual(caught.exception.status, 401)

    # ---- live authority -------------------------------------------------
    def test_rotation_takes_effect_without_restart(self):
        old, new = "O" * 40, "N" * 40
        self.write(_document([_principal("c", "operator", old)]))
        live = LiveAuthority(self.file)
        self.assertEqual(live.authenticate({"authorization": "Bearer " + old})["id"], "c")
        self.assertEqual(live.generation, 1)
        self.write(_document([_principal("c", "operator", new)]))
        with self.assertRaises(AuthorityError):
            live.authenticate({"authorization": "Bearer " + old})
        self.assertEqual(live.authenticate({"authorization": "Bearer " + new})["id"], "c")
        self.assertEqual(live.generation, 2)

    def test_widening_permissions_alone_is_refused_on_a_warm_cache(self):
        token = "W" * 40
        self.write(_document([_principal("c", "operator", token)]))
        live = LiveAuthority(self.file)
        self.assertEqual(live.authenticate({"authorization": "Bearer " + token})["id"], "c")
        self.assertEqual(live.generation, 1)
        before = _change_key(self.file)
        os.chmod(self.file, 0o644)
        # chmod changes neither ino, mtime nor size: the naive change key is
        # untouched, so only safety-before-cache can catch this (RR-F004).
        self.assertEqual(_change_key(self.file), before)
        for _ in range(2):
            with self.assertRaises(AuthorityError) as caught:
                live.authenticate({"authorization": "Bearer " + token})
            self.assertEqual(caught.exception.code, "AUTH_CONFIGURATION")
            self.assertEqual(caught.exception.status, 500)
        self.assertEqual(live.generation, 1)  # never re-parsed/served from cache
        os.chmod(self.file, 0o600)
        self.assertEqual(live.authenticate({"authorization": "Bearer " + token})["id"], "c")

    def test_dangerous_permissions_before_first_call_and_symlink(self):
        token = "D" * 40
        self.write(_document([_principal("c", "operator", token)]))
        os.chmod(self.file, 0o640)
        live = LiveAuthority(self.file)
        with self.assertRaises(AuthorityError) as caught:
            live.authenticate({"authorization": "Bearer " + token})
        self.assertEqual(caught.exception.status, 500)
        self.assertEqual(live.generation, 0)
        # A symlinked authority path is refused (O_NOFOLLOW).
        link = str(self.root / "link.json")
        os.symlink(self.file, link)
        linked = LiveAuthority(link)
        with self.assertRaises(AuthorityError) as caught:
            linked.authenticate({"authorization": "Bearer " + token})
        self.assertEqual(caught.exception.status, 500)
        self.assertEqual(linked.generation, 0)

    def test_missing_or_broken_file_is_fail_closed(self):
        live = LiveAuthority(str(self.root / "absent.json"))
        with self.assertRaises(AuthorityError) as caught:
            live.authenticate({"authorization": "Bearer " + "M" * 40})
        self.assertEqual(caught.exception.status, 500)
        broken = str(self.root / "broken.json")
        Path(broken).write_text("{not json", encoding="utf-8")
        os.chmod(broken, 0o600)
        with self.assertRaises(AuthorityError) as caught:
            LiveAuthority(broken).authenticate({"authorization": "Bearer " + "M" * 40})
        self.assertEqual(caught.exception.status, 500)
        # A relative path is a configuration error at construction.
        with self.assertRaises(AuthorityError) as caught:
            LiveAuthority("relative/authority.json")
        self.assertEqual(caught.exception.status, 500)

    # ---- writer ---------------------------------------------------------
    def test_write_authority_file_is_atomic_and_never_writes_invalid(self):
        good = _document([_principal("keep", "viewer", "K" * 40)])
        write_authority_file(self.file, good)
        self.assertEqual(os.stat(self.file).st_mode & 0o777, 0o600)
        before = Path(self.file).read_bytes()
        bad = [
            {"version": 2, "principals": good["principals"]},
            {"version": 1, "principals": []},
            {"version": 1, "principals": [{"id": "x", "role": "root",
                                           "tokenDigest": token_digest("z")}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer",
                                           "tokenDigest": "not-hex"}]},
            {"version": 1, "principals": [{"id": "x", "role": "viewer",
                                           "tokenDigest": token_digest("z"), "extra": 1}]},
        ]
        for snapshot in bad:
            with self.assertRaises(AuthorityError):
                write_authority_file(self.file, snapshot)
        self.assertEqual(Path(self.file).read_bytes(), before)
        self.assertFalse(any(name.endswith(".tmp") for name in os.listdir(self.root)))

    def test_token_digest_matches_sha256_hex(self):
        token = "hello-world-token"
        self.assertEqual(token_digest(token), hashlib.sha256(token.encode()).hexdigest())


class FakeEngine:
    """Minimal stand-in: no model calls, no vector store, deterministic."""
    version = "test"
    embedding_model = "test-local"
    extraction_mode = "source_spans"

    def __init__(self):
        self.quality = quality.QualityConfig(
            max_text_chars=200, max_facts=5, semantic_threshold=0.90, max_attempts=3)

    def search(self, query):
        return []


class MemoryAuthHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="memory-authority-http-")
        self.root = Path(self.tmp.name)
        self.service = MemoryService(self.root, FakeEngine())
        write_authority_file(str(self.root / "authority.json"), _document([
            _principal("viewer-c", "viewer", "V" * 40),
            _principal("coordinator-c", "coordinator", "C" * 40),
            _principal("chief-c", "chief", "H" * 40),
            _principal("operator-c", "operator", "O" * 40),
        ]))
        self.client = TestClient(create_app(self.service, run_worker=False))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def headers(self, token):
        return {"Authorization": "Bearer " + token}

    def turn(self, text="我喜欢用中文回复"):
        return {"event_id": "one", "user_id": "alice", "role": "user", "text": text}

    def test_no_shared_token_file_is_created(self):
        # The legacy shared-token producer is gone; no compatibility path.
        self.assertFalse((self.root / "api-token").exists())

    def test_authentication_is_per_client(self):
        for token in (None, "S" * 40, "too-short"):
            headers = {} if token is None else self.headers(token)
            self.assertEqual(self.client.post("/v1/turns", headers=headers,
                             json=self.turn()).status_code, 401)
        self.assertEqual(self.client.post("/v1/turns", headers=self.headers("O" * 40),
                         json=self.turn()).status_code, 202)

    def test_role_matrix_read_writes_and_forget(self):
        # viewer / coordinator: read only.
        for token in ("V" * 40, "C" * 40):
            self.assertEqual(self.client.post("/v1/turns", headers=self.headers(token),
                             json=self.turn()).status_code, 403)
            self.assertEqual(self.client.post("/v1/search", headers=self.headers(token),
                             json={"user_id": "alice", "query": "偏好"}).status_code, 200)
            self.assertEqual(self.client.post("/v1/controls", headers=self.headers(token),
                             json={"user_id": "alice"}).status_code, 200)
        # chief: read + ingest, but never forget.
        self.assertEqual(self.client.post("/v1/turns", headers=self.headers("H" * 40),
                         json=self.turn()).status_code, 202)
        self.assertEqual(self.client.post("/v1/forget", headers=self.headers("H" * 40),
                         json={"request_id": "r", "user_id": "alice",
                               "event_ids": ["one"]}).status_code, 403)
        self.assertEqual(self.client.post("/v1/status", headers=self.headers("H" * 40),
                         json={"event_id": "one", "user_id": "alice"}).status_code, 200)
        # operator: everything, including irreversible forget.
        self.assertEqual(self.client.post("/v1/forget", headers=self.headers("O" * 40),
                         json={"request_id": "r", "user_id": "alice",
                               "event_ids": ["one"]}).status_code, 200)

    def test_forbidden_request_never_mutates_state(self):
        self.assertEqual(self.client.post("/v1/turns", headers=self.headers("V" * 40),
                         json=self.turn()).status_code, 403)
        self.assertEqual(self.service.health()["ingestion"]["pending"], 0)
        self.assertEqual(self.client.post("/v1/forget", headers=self.headers("H" * 40),
                         json={"request_id": "r", "user_id": "alice",
                               "event_ids": ["one"]}).status_code, 403)
        self.assertEqual(self.service.forget_store.epoch("alice"), 0)

    def test_revocation_lands_without_restart(self):
        document = _document([
            _principal("a", "operator", "A" * 40),
            _principal("b", "operator", "B" * 40),
        ])
        write_authority_file(str(self.root / "authority.json"), document)
        self.assertEqual(self.client.post("/v1/search", headers=self.headers("B" * 40),
                         json={"user_id": "alice", "query": "q"}).status_code, 200)
        document["principals"][1]["revoked"] = True  # retained as evidence
        write_authority_file(str(self.root / "authority.json"), document)
        self.assertEqual(self.client.post("/v1/search", headers=self.headers("B" * 40),
                         json={"user_id": "alice", "query": "q"}).status_code, 401)
        self.assertEqual(self.client.post("/v1/search", headers=self.headers("A" * 40),
                         json={"user_id": "alice", "query": "q"}).status_code, 200)

    def test_missing_authority_fails_business_requests_closed_but_health_is_open(self):
        tmp = tempfile.TemporaryDirectory(prefix="memory-authority-missing-")
        root = Path(tmp.name)
        service = MemoryService(root, FakeEngine())  # no authority.json written
        client = TestClient(create_app(service, run_worker=False))
        client.__enter__()
        try:
            self.assertEqual(client.get("/health").status_code, 200)
            response = client.post("/v1/search", headers=self.headers("O" * 40),
                                   json={"user_id": "alice", "query": "q"})
            self.assertEqual(response.status_code, 500)
        finally:
            client.__exit__(None, None, None)
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
