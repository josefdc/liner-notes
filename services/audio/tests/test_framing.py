"""
A preview is measured only when its download can be told whole: its body is framed by a
Content-Length or by chunking, and a framed body that ends early raises. A body with neither runs
to the connection's close, so a transfer cut short would look like the whole file; it is refused
as a download failure (502) before it is measured.
"""

import asyncio
import io
import os
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import main
import preview
import sniff
from preview import PreviewDownloadError, fetch_to_file

VBR = Path(__file__).parent / "fixtures" / "tone-vbr.mp3"
# Samples in the 40 frames of tone-vbr.mp3.
VBR_SAMPLES = 40 * 1152
UNCHECKED = "length cannot be checked"
PATH = "/api/1/1/a/b/0/preview.mp3"


def _preview() -> bytes:
    """tone-vbr.mp3's frames 29 times over behind its ID3v2 tag: a 30 s VBR preview."""
    raw = VBR.read_bytes()
    tag = sniff.id3v2_end(io.BytesIO(raw), 0)
    return raw[:tag] + raw[tag:] * 29


WHOLE_SECONDS = round(29 * VBR_SAMPLES / 44100, 3)


def fetch(url, **kwargs):
    return asyncio.run(fetch_to_file(url, **kwargs))


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    monkeypatch.setattr(preview, "validate_preview_url", lambda url: None)
    with TestClient(main.app) as c:
        yield c


def _serve(server, framing, cut=None):
    body = _preview()
    server.files[PATH] = body
    server.framing[PATH] = framing
    if cut is not None:
        server.cut[PATH] = cut
    return body


def _analyze(client, base):
    return client.post("/analyze", json={"preview_url": f"{base}{PATH}"})


def _files_created(monkeypatch) -> list[str]:
    """Records each temporary file fetch_to_file creates: the body is written only to one."""
    created = []
    mkstemp = preview.tempfile.mkstemp

    def record(*args, **kwargs):
        fd, path = mkstemp(*args, **kwargs)
        created.append(path)
        return fd, path

    monkeypatch.setattr(preview.tempfile, "mkstemp", record)
    return created


def _never_measured(monkeypatch):
    def fail(path):
        raise AssertionError("measured a preview whose length was not checked")

    monkeypatch.setattr(main, "analyze_audio_file", fail)


@pytest.mark.parametrize("framing", ["http/1.0", "close"])
def test_an_unframed_body_cut_short_is_refused_and_never_measured(
    client, cdn, temp_dir, monkeypatch, framing
):
    base, server = cdn
    created = _files_created(monkeypatch)
    _serve(server, framing, cut=len(_preview()) // 2)
    # Measured, this half would report about 15 s as the preview's length.
    response = _analyze(client, base)
    assert response.status_code == 502, response.json().get("v2", {}).get("window")
    assert response.json() == {"detail": "Could not download the preview"}

    with pytest.raises(PreviewDownloadError, match=UNCHECKED):
        fetch(f"{base}{PATH}")
    assert list(temp_dir.iterdir()) == []

    # Refused before the file reaches the analysis.
    _never_measured(monkeypatch)
    assert _analyze(client, base).status_code == 502
    assert list(temp_dir.iterdir()) == []
    # Refused on its headers, before any of the body was read.
    assert created == []


@pytest.mark.parametrize("framing", ["http/1.0", "close"])
def test_an_unframed_body_that_is_whole_is_refused_too(client, cdn, temp_dir, monkeypatch, framing):
    base, server = cdn
    created = _files_created(monkeypatch)
    _serve(server, framing)
    with pytest.raises(PreviewDownloadError, match=UNCHECKED):
        fetch(f"{base}{PATH}")
    response = _analyze(client, base)
    assert response.status_code == 502, response.json().get("v2", {}).get("window")
    assert list(temp_dir.iterdir()) == []
    assert created == []


@pytest.mark.parametrize("framing", ["length", "chunked"])
def test_a_framed_body_is_downloaded_and_measured_in_full(client, cdn, temp_dir, framing):
    base, server = cdn
    body = _serve(server, framing)
    path = fetch(f"{base}{PATH}")
    try:
        assert Path(path).read_bytes() == body
    finally:
        os.remove(path)

    response = _analyze(client, base)
    assert response.status_code == 200, response.text
    assert response.json()["v2"]["window"]["durationSeconds"] == WHOLE_SECONDS
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize("framing", ["length", "chunked"])
def test_a_framed_body_cut_short_is_still_refused(client, cdn, temp_dir, framing):
    base, server = cdn
    _serve(server, framing, cut=len(_preview()) // 2)
    with pytest.raises(PreviewDownloadError, match="RemoteProtocolError"):
        fetch(f"{base}{PATH}")
    assert list(temp_dir.iterdir()) == []
    assert _analyze(client, base).status_code == 502
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize(
    "framing",
    [
        {"content-length": "4096"},
        {"transfer-encoding": "chunked"},
        {"transfer-encoding": "Chunked"},
    ],
)
def test_the_header_check_accepts_a_framed_body(framing):
    response = httpx.Response(200, headers={"content-type": "audio/mpeg", **framing})
    assert preview._check_headers(response, preview.MAX_PREVIEW_BYTES) == ".mp3"


def test_the_header_check_refuses_a_body_with_neither_a_length_nor_chunking():
    response = httpx.Response(200, headers={"content-type": "audio/mpeg", "connection": "close"})
    with pytest.raises(PreviewDownloadError, match=UNCHECKED):
        preview._check_headers(response, preview.MAX_PREVIEW_BYTES)
