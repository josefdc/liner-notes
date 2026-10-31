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

    def _start_chunked(self):
        self.protocol_version = "HTTP/1.1"
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()

    def _write_chunked(self, body, last=True):
        """``body`` in 16 KB chunks, then the last chunk unless ``last`` is false (a cut body)."""
        for at in range(0, len(body), 16 * 1024):
            part = body[at : at + 16 * 1024]
            self.wfile.write(b"%x\r\n%s\r\n" % (len(part), part))
        if last:
            self.wfile.write(b"0\r\n\r\n")

    def do_GET(self):
        self.server.hits.append(self.path)
        path = self.path.split("?", 1)[0]
        if path in self.server.files:
            body = self.server.files[path]
            content_type = self.server.types.get(path, "audio/mpeg")
            framing = self.server.framing.get(path, "length")
            # Bytes of the body sent before the connection closes; all of them by default.
            sent = body[: self.server.cut.get(path, len(body))]
            headers = {"Content-Type": content_type} if content_type is not None else {}
            if framing == "length":
                headers["Content-Length"] = str(len(body))
            elif framing == "chunked":
                self.protocol_version = "HTTP/1.1"
                headers["Transfer-Encoding"] = "chunked"
                headers["Connection"] = "close"
            else:
                # Neither a length nor chunking: the body runs to the connection's close.
                if framing == "close":
                    self.protocol_version = "HTTP/1.1"
                headers["Connection"] = "close"
            self._send(200, headers)
            if framing == "chunked":
                self._write_chunked(sent, last=len(sent) == len(body))
            else:
                self.wfile.write(sent)
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
            # Chunked, with no Content-Length: streams up to 50 MB until the client hangs up.
            self._start_chunked()
            chunk = b"\x00" * (64 * 1024)
            try:
                for _ in range(800):
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                    self.server.sent += len(chunk)
                # Reached only by a client without the cap: the body then ends cleanly.
                self.wfile.write(b"0\r\n\r\n")
            except OSError:
                pass
        elif path == "/slow.mp3":
            # Chunked; a byte every 0.2 s keeps each read under the read timeout.
            self._start_chunked()
            try:
                for _ in range(100):
                    self.wfile.write(b"1\r\n\x00\r\n")
                    self.wfile.flush()
                    time.sleep(0.2)
                # Reached only by a client without the deadline: the body then ends cleanly.
                self.wfile.write(b"0\r\n\r\n")
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
    streamed by /endless.mp3, server.files maps extra paths to bodies, served as audio/mpeg
    unless server.types names another content type for the path (None: no Content-Type).
    server.framing names how an extra path's body is framed: "length" (Content-Length, the
    default), "chunked", or with neither, "http/1.0" (an HTTP/1.0 response) or "close" (HTTP/1.1
    with Connection: close). server.cut maps a path to the bytes sent before the connection
    closes.
    """
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.hits = []
    server.sent = 0
    server.files = {}
    server.types = {}
    server.framing = {}
    server.cut = {}
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
