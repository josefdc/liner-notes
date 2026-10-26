"""Shared fixtures: a local HTTP server that plays the part of a preview CDN."""

import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SMALL_BODY = b"ID3" + b"\x00" * 4093
MB = 1024 * 1024


class _Handler(BaseHTTPRequestHandler):
    hits: list[str]

    def log_message(self, *args):
        pass

    def _send(self, status, headers, body=b""):
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        self.server.hits.append(self.path)
        path = self.path.split("?", 1)[0]
        if path in self.server.files:
            body = self.server.files[path]
            self._send(200, {"Content-Type": "audio/mpeg", "Content-Length": str(len(body))}, body)
        elif path == "/audio.mp3":
            self._send(
                200,
                {"Content-Type": "audio/mpeg", "Content-Length": str(len(SMALL_BODY))},
                SMALL_BODY,
            )
        elif path == "/redirect":
            self._send(302, {"Location": "/internal-admin", "Content-Length": "0"})
        elif path == "/internal-admin":
            self._send(200, {"Content-Type": "audio/mpeg", "Content-Length": "4"}, b"data")
        elif path == "/gzip.mp3":
            self._send(
                200,
                {"Content-Type": "audio/mpeg", "Content-Encoding": "gzip", "Content-Length": "4"},
                b"data",
            )
        elif path == "/page.html":
            self._send(200, {"Content-Type": "text/html", "Content-Length": "6"}, b"<html>")
        elif path == "/declared-huge.mp3":
            # Declares 200 MB but never sends it.
            self._send(200, {"Content-Type": "audio/mpeg", "Content-Length": str(200 * MB)})
        elif path == "/endless.mp3":
            # No Content-Length: streams up to 50 MB until the client hangs up.
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = b"\x00" * (64 * 1024)
            try:
                for _ in range(800):
                    self.wfile.write(chunk)
                    self.server.sent += len(chunk)
            except OSError:
                pass
        elif path == "/slow.mp3":
            # A byte every 0.2 s keeps each read under the read timeout.
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                for _ in range(100):
                    self.wfile.write(b"\x00")
                    self.wfile.flush()
                    time.sleep(0.2)
            except OSError:
                pass
        else:
            self._send(404, {"Content-Length": "0"})


def pytest_configure(config):
    """AUDIO_REQUIRE_MODELS=1 (CI's models job): fail instead of skipping without the models."""
    if os.environ.get("AUDIO_REQUIRE_MODELS") == "1":
        import estimators
        import main

        if not (estimators.ESSENTIA_AVAILABLE and main.MODELS_LOADED):
            raise pytest.UsageError(
                "AUDIO_REQUIRE_MODELS=1 but essentia or the models are not available "
                "(uv sync --extra models, then download_models.py)"
            )


@pytest.fixture
def cdn():
    """
    Yields (base_url, server). server.hits lists requested paths, server.sent counts bytes
    streamed by /endless.mp3, and server.files maps extra paths to audio/mpeg bodies.
    """
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.hits = []
    server.sent = 0
    server.files = {}
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", server
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def temp_dir(tmp_path, monkeypatch):
    """Points tempfile at an empty directory so tests can check that nothing is left behind."""
    import tempfile

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    return tmp_path
