"""Loopback-only tests for the Kimi HTTP shim streaming fix.

No host file, credential, DB, real model or external endpoint is touched:
``kimi_token`` is always monkeypatched with a dummy string and both the
upstream peer and the shim listen on synthetic 127.0.0.1 ephemeral ports.
"""
from __future__ import annotations

import importlib.util
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SHIM_PATH = ROOT / "gateway" / "kimi-chat-shim.py"


def load_shim():
    spec = importlib.util.spec_from_file_location("kimi_chat_shim_under_test", SHIM_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep test output quiet
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length:
            self.rfile.read(length)
        self.server.on_post(self)


def _start_server(handler_cls, on_post=None):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    server.on_post = on_post
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    return server


def _request_bytes(body: bytes) -> bytes:
    return (
        b"POST /v1/chat/completions HTTP/1.1\r\n"
        b"Host: 127.0.0.1\r\n"
        b"Content-Type: application/json\r\n"
        + f"Content-Length: {len(body)}\r\n".encode()
        + b"Connection: close\r\n\r\n"
        + body
    )


def _open_client(port: int, body: bytes, timeout: float = 3.0) -> socket.socket:
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    sock.sendall(_request_bytes(body))
    return sock


def _read_all(sock: socket.socket, timeout: float = 3.0) -> bytes:
    sock.settimeout(timeout)
    data = b""
    while True:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            break
        if not chunk:
            break
        data += chunk
    return data


class ShimTestCase(unittest.TestCase):
    def setUp(self):
        self.module = load_shim()
        self._servers = []
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for server in self._servers:
            server.shutdown()
            server.server_close()

    def _start_upstream(self, on_post):
        server = _start_server(_UpstreamHandler, on_post)
        self._servers.append(server)
        return server

    def _start_shim(self, upstream_url):
        self.module.UPSTREAM = upstream_url
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.module.Handler)
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        thread.start()
        self._servers.append(server)
        return server.server_address[1]

    def _upstream_url(self, server):
        return f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions"


class StreamingTests(ShimTestCase):
    def test_legacy_buffering_is_rejected_by_pre_eof_check(self):
        with mock.patch.object(self.module, "_stream_reader", lambda upstream: upstream.read):
            with self.assertRaisesRegex(AssertionError, "SSE frame must arrive before"):
                self.test_sse_frame_streamed_before_upstream_eof()

    def test_sse_frame_streamed_before_upstream_eof(self):
        frame = b"data: hello\n\n"
        released = threading.Event()
        upstream_done = threading.Event()

        def on_post(handler):
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(frame)
            handler.wfile.flush()
            # Hold the upstream open until the client has seen the frame.
            released.wait(5)
            upstream_done.set()

        upstream = self._start_upstream(on_post)
        port = self._start_shim(self._upstream_url(upstream))

        with mock.patch.object(self.module, "kimi_token", lambda: "dummy-token"):
            sock = _open_client(port, b"{}", timeout=0.75)
            try:
                data = b""
                deadline = time.monotonic() + 1
                while frame not in data and time.monotonic() < deadline:
                    try:
                        chunk = sock.recv(4096)
                    except socket.timeout:
                        break
                    if not chunk:
                        break
                    data += chunk
                self.assertIn(
                    frame,
                    data,
                    "SSE frame must arrive before the upstream closes (no EOF wait)",
                )
                self.assertFalse(upstream_done.is_set(), "upstream must still be open when the frame arrives")
            finally:
                released.set()
                sock.close()

    def test_stream_reader_prefers_read1(self):
        seen = []

        class Fake:
            def read1(self, size):
                seen.append(("read1", size))
                return b"x"

            def read(self, size):  # pragma: no cover - must not be used
                seen.append(("read", size))
                return b"y"

        reader = self.module._stream_reader(Fake())
        self.assertEqual(reader(65536), b"x")
        self.assertEqual(seen, [("read1", 65536)])

    def test_stream_reader_falls_back_to_read(self):
        seen = []

        class Fake:
            def read(self, size):
                seen.append(size)
                return b"z"

        reader = self.module._stream_reader(Fake())
        self.assertEqual(reader(65536), b"z")
        self.assertEqual(seen, [65536])


class CredentialTests(ShimTestCase):
    def test_credentials_not_read_and_not_leaked(self):
        captured = {}

        def on_post(handler):
            captured["auth"] = handler.headers.get("Authorization")
            body = b'{"ok": true}'
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)

        upstream = self._start_upstream(on_post)
        port = self._start_shim(self._upstream_url(upstream))

        with mock.patch.object(self.module, "kimi_token", return_value="dummy-token") as token:
            sock = _open_client(port, b"{}")
            data = _read_all(sock)
            sock.close()

        # The patched token replaces the real DB-reading function entirely.
        token.assert_called_once()
        self.assertEqual(captured["auth"], "Bearer dummy-token")
        self.assertNotIn(b"dummy-token", data)


class ErrorHandlingTests(ShimTestCase):
    def test_upstream_http_status_is_numeric_and_error_body_is_redacted(self):
        secret = b"SYNTHETIC_UPSTREAM_PRIVATE_ERROR"

        def on_post(handler):
            handler.send_response(400)
            handler.send_header("Content-Length", str(len(secret)))
            handler.end_headers()
            handler.wfile.write(secret)

        upstream = self._start_upstream(on_post)
        port = self._start_shim(self._upstream_url(upstream))
        with mock.patch.object(self.module, "kimi_token", lambda: "dummy-token"):
            sock = _open_client(port, b"{}")
            try:
                data = _read_all(sock)
            finally:
                sock.close()
        self.assertIn(b"HTTP/1.1 502", data)
        self.assertIn(b"X-Kimi-Upstream-Status: 400", data)
        self.assertIn(self.module.GENERIC_ERROR_BODY, data)
        self.assertNotIn(secret, data)

    def test_credential_failure_is_generic_502_without_secret(self):
        def unreachable(handler):  # pragma: no cover - must never be reached
            handler.send_error(599)

        upstream = self._start_upstream(unreachable)
        port = self._start_shim(self._upstream_url(upstream))
        secret = "SECRET_LEAK_abc123"

        with mock.patch.object(
            self.module, "kimi_token", side_effect=RuntimeError(secret)
        ):
            sock = _open_client(port, b"{}")
            data = _read_all(sock)
            sock.close()

        self.assertIn(b"HTTP/1.1 502", data)
        self.assertIn(self.module.GENERIC_ERROR_BODY, data)
        self.assertNotIn(secret.encode(), data)

    def test_upstream_open_failure_is_generic_502(self):
        # Grab an ephemeral port and immediately free it so connecting refuses.
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
        probe.close()
        port = self._start_shim(f"http://127.0.0.1:{dead_port}/v1/chat/completions")

        with mock.patch.object(self.module, "kimi_token", lambda: "dummy-token"):
            sock = _open_client(port, b"{}")
            data = _read_all(sock)
            sock.close()

        self.assertIn(b"HTTP/1.1 502", data)
        self.assertIn(self.module.GENERIC_ERROR_BODY, data)


class PostHeaderFailureTests(ShimTestCase):
    def test_post_header_failure_closes_without_second_status(self):
        frame = b"data: partial\n\n"

        def on_post(handler):
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Transfer-Encoding", "chunked")
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(f"{len(frame):x}\r\n".encode() + frame + b"\r\n")
            handler.wfile.flush()
            # Corrupt the next chunk size: upstream read fails after headers.
            handler.wfile.write(b"garbage-not-a-chunk-size\r\n")
            handler.wfile.flush()

        upstream = self._start_upstream(on_post)
        port = self._start_shim(self._upstream_url(upstream))

        with mock.patch.object(self.module, "kimi_token", lambda: "dummy-token"):
            sock = _open_client(port, b"{}")
            data = _read_all(sock)
            sock.close()

        self.assertIn(frame, data)
        # Exactly one status line and no second 502 status appended.
        self.assertEqual(data.count(b"HTTP/1.1"), 1)
        self.assertNotIn(b"HTTP/1.1 502", data)
        self.assertNotIn(self.module.GENERIC_ERROR_BODY, data)


if __name__ == "__main__":
    unittest.main()
