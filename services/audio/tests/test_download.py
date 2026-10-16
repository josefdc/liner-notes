"""Bounded download against a local server (no internet)."""

import asyncio
import io
import os
import resource

import numpy as np
import pytest
import soundfile as sf

from preview import MAX_PREVIEW_BYTES, PreviewDownloadError, fetch_to_file
from tests.conftest import SMALL_BODY


def fetch(url, **kwargs):
    return asyncio.run(fetch_to_file(url, **kwargs))


def test_downloads_audio_to_a_temp_file(cdn, temp_dir):
    base, _ = cdn
    path = fetch(f"{base}/audio.mp3")
    try:
        assert os.path.dirname(path) == str(temp_dir)
        assert path.endswith(".mp3")
        with open(path, "rb") as f:
            assert f.read() == SMALL_BODY
    finally:
        os.remove(path)


def test_refuses_redirects_without_following_them(cdn, temp_dir):
    base, server = cdn
    with pytest.raises(PreviewDownloadError, match="status 302"):
        fetch(f"{base}/redirect")
    assert server.hits == ["/redirect"]
    assert list(temp_dir.iterdir()) == []


def test_refuses_non_audio_content_type(cdn, temp_dir):
    base, _ = cdn
    with pytest.raises(PreviewDownloadError, match="content type"):
        fetch(f"{base}/page.html")
    assert list(temp_dir.iterdir()) == []


def test_refuses_error_status(cdn, temp_dir):
    base, _ = cdn
    with pytest.raises(PreviewDownloadError, match="status 404"):
        fetch(f"{base}/missing.mp3")
    assert list(temp_dir.iterdir()) == []


def test_refuses_declared_length_over_the_cap(cdn, temp_dir):
    base, _ = cdn
    with pytest.raises(PreviewDownloadError, match="declared length"):
        fetch(f"{base}/declared-huge.mp3")
    assert list(temp_dir.iterdir()) == []


def test_stops_streaming_at_the_cap(cdn, temp_dir):
    base, server = cdn
    peak_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    with pytest.raises(PreviewDownloadError, match="over the cap"):
        fetch(f"{base}/endless.mp3")
    peak_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    assert list(temp_dir.iterdir()) == []
    # The server would send 50 MB; the client hangs up shortly after the 2 MB cap
    # (socket buffers let a few more MB through before writes fail).
    assert server.sent < 20 * 1024 * 1024
    assert (peak_after - peak_before) * 1024 < 20 * 1024 * 1024


def test_cap_is_two_megabytes():
    assert MAX_PREVIEW_BYTES == 2 * 1024 * 1024


def test_overall_deadline(cdn, temp_dir):
    base, _ = cdn
    with pytest.raises(PreviewDownloadError, match="exceeded"):
        fetch(f"{base}/slow.mp3", deadline_s=1.0)
    assert list(temp_dir.iterdir()) == []


def test_connection_errors_are_wrapped(temp_dir):
    # Port 9 (discard) on localhost is normally closed.
    with pytest.raises(PreviewDownloadError):
        fetch("http://127.0.0.1:9/a.mp3")
    assert list(temp_dir.iterdir()) == []


def test_downloaded_mp3_can_be_decoded(cdn, temp_dir):
    import librosa

    sr = 22050
    tone = 0.3 * np.sin(2 * np.pi * 440 * np.arange(sr * 3) / sr)
    encoded = io.BytesIO()
    sf.write(encoded, tone.astype(np.float32), sr, format="MP3")
    base, server = cdn
    server.files["/tone.mp3"] = encoded.getvalue()

    path = fetch(f"{base}/tone.mp3")
    try:
        y, _ = librosa.load(path, sr=sr, mono=True)
        assert 2.5 < len(y) / sr < 3.5
    finally:
        os.remove(path)


def test_refuses_compressed_bodies(cdn, temp_dir):
    base, _ = cdn
    with pytest.raises(PreviewDownloadError, match="content encoding"):
        fetch(f"{base}/gzip.mp3")
    assert list(temp_dir.iterdir()) == []


def test_ignores_proxy_settings_from_the_environment(cdn, temp_dir, monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    proxy_hits = []

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            proxy_hits.append(self.path)
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()

    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        proxy_url = f"http://127.0.0.1:{proxy.server_address[1]}"
        for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY"):
            monkeypatch.setenv(name, proxy_url)
        for name in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(name, raising=False)
        base, server = cdn
        path = fetch(f"{base}/audio.mp3")
        os.remove(path)
    finally:
        proxy.shutdown()
        proxy.server_close()
    assert proxy_hits == []
    assert server.hits == ["/audio.mp3"]
