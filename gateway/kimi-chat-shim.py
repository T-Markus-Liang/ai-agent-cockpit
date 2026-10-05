#!/opt/homebrew/bin/python3.11
from __future__ import annotations

import json
import os
import sqlite3
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("KIMI_SHIM_PORT", "4323"))
DB = "/Users/markus/.cc-switch/cc-switch.db"
UPSTREAM = "https://api.kimi.com/coding/v1/chat/completions"


def kimi_token() -> str:
    with sqlite3.connect(DB) as con:
        row = con.execute("select settings_config from providers where name='Kimi'").fetchone()
    if not row:
        raise RuntimeError("Kimi provider not found in CC Switch")
    env = json.loads(row[0]).get("env", {})
    token = str(env.get("ANTHROPIC_AUTH_TOKEN", "")).strip()
    if not token:
        raise RuntimeError("Kimi token missing in CC Switch")
    return token


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
        req = urllib.request.Request(
            UPSTREAM,
            data=payload,
            headers={
                "Authorization": f"Bearer {kimi_token()}",
                "Content-Type": "application/json",
                "User-Agent": "ai-agent-cockpit-kimi-shim/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as upstream:
                self.send_response(upstream.status)
                for key, value in upstream.headers.items():
                    if key.lower() not in {"connection", "transfer-encoding", "content-encoding"}:
                        self.send_header(key, value)
                self.send_header("Connection", "close")
                self.end_headers()
                while chunk := upstream.read(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as exc:
            body = json.dumps({"error": {"type": "kimi_shim_error", "message": str(exc)}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
