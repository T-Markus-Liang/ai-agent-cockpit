#!/opt/homebrew/bin/python3.11
from __future__ import annotations

import json
import os
import sqlite3
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("KIMI_SHIM_PORT", "4323"))
DB = "/Users/markus/.cc-switch/cc-switch.db"
UPSTREAM = "https://api.kimi.com/coding/v1/chat/completions"

# Hop-by-hop / re-framing headers that must not be forwarded verbatim.
SKIP_HEADERS = {"connection", "transfer-encoding", "content-encoding"}

# Bounded, redacted error body: never leak upstream or credential details.
GENERIC_ERROR_BODY = json.dumps(
    {"error": {"type": "kimi_shim_error", "message": "kimi shim upstream failure"}}
).encode()


def kimi_token() -> str:
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
        row = con.execute("select settings_config from providers where name='Kimi'").fetchone()
    if not row:
        raise RuntimeError("Kimi provider not found in CC Switch")
    env = json.loads(row[0]).get("env", {})
    token = str(env.get("ANTHROPIC_AUTH_TOKEN", "")).strip()
    if not token:
        raise RuntimeError("Kimi token missing in CC Switch")
    return token


def _stream_reader(upstream):
    """Prefer read1 so available bytes are streamed without waiting for EOF."""
    read1 = getattr(upstream, "read1", None)
    if callable(read1):
        return read1
    return upstream.read


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            body = json.dumps({"object": "list", "data": [{"id": "kimi-k3", "object": "model", "owned_by": "moonshot"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_error(404)
            return
        payload = self.rfile.read(int(self.headers.get("Content-Length", "0") or "0"))
        headers_sent = False
        upstream = None
        try:
            # Credential acquisition lives inside the protected block so a
            # missing token/db yields the same bounded generic 502.
            token = kimi_token()
            req = urllib.request.Request(
                UPSTREAM,
                data=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "User-Agent": "ai-agent-cockpit-kimi-shim/1.0",
                },
                method="POST",
            )
            upstream = urllib.request.urlopen(req, timeout=120)
            self.send_response(upstream.status)
            for key, value in upstream.headers.items():
                if key.lower() not in SKIP_HEADERS:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            headers_sent = True

            read_chunk = _stream_reader(upstream)
            while True:
                chunk = read_chunk(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except urllib.error.HTTPError as exc:
            if headers_sent:
                self.close_connection = True
            else:
                self._send_generic_502(upstream_status=exc.code)
        except Exception:
            # The response line is already on the wire: close the stream
            # instead of appending a second HTTP status.
            if headers_sent:
                self.close_connection = True
            else:
                self._send_generic_502()
        finally:
            if upstream is not None:
                try:
                    upstream.close()
                except Exception:
                    pass

    def _send_generic_502(self, upstream_status=None):
        try:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(GENERIC_ERROR_BODY)))
            if isinstance(upstream_status, int) and 100 <= upstream_status <= 599:
                self.send_header("X-Kimi-Upstream-Status", str(upstream_status))
            self.end_headers()
            self.wfile.write(GENERIC_ERROR_BODY)
        except Exception:
            self.close_connection = True


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    if os.environ.get("KIMI_SHIM_REPORT_READY") == "1":
        print(json.dumps({"port": server.server_address[1]}), flush=True)
    server.serve_forever()
