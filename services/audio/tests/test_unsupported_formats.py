"""
MP4 (M4A) and AAC previews: libsndfile does not read them, so the service refuses them with
that reason, never as a generic decode or download failure.

The fixtures are 1 s of a 440 Hz sine, mono at 22.05 kHz, AAC-LC at 24 kb/s, made with FFmpeg
(N-127579, native aac encoder) without metadata:

    ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=22050:duration=1" -ac 1 -c:a aac \\
        -b:a 24k -map_metadata -1 -fflags +bitexact -flags:a +bitexact -movflags +faststart \\
        tone.m4a

and the same command with `-f adts` for tone.aac (a raw ADTS stream, as served as audio/aac).
"""

from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import main
import preview

FIXTURES = Path(__file__).parent / "fixtures"
M4A = FIXTURES / "tone.m4a"
AAC = FIXTURES / "tone.aac"
REASON = "it is an MP4 (M4A) or AAC file, a format the service does not decode"
DETAIL = f"The preview is not analysable audio: {REASON}"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    with TestClient(main.app) as c:
        yield c


def _serve(cdn, monkeypatch, fixture: Path, content_type: str) -> str:
    """Serves the fixture from the local CDN as `content_type`; the allowlist is lifted."""
    base, server = cdn
    path = f"/api/1/1/a/b/0/{fixture.name}"
    server.files[path] = fixture.read_bytes()
    server.types[path] = content_type
    monkeypatch.setattr(preview, "validate_preview_url", lambda url: None)
    return f"{base}{path}"


@pytest.mark.parametrize("fixture", [M4A, AAC], ids=lambda p: p.suffix)
def test_decode_refuses_them_as_a_format_it_does_not_decode(fixture):
    with pytest.raises(main.InvalidAudioError) as refused:
        main.decode(str(fixture))
    assert str(refused.value) == REASON


@pytest.mark.parametrize(
    ("fixture", "content_type"),
    [(M4A, "audio/mp4"), (M4A, "audio/x-m4a"), (AAC, "audio/aac")],
)
def test_a_preview_declared_as_mp4_or_aac_is_refused_with_that_reason(
    client, cdn, monkeypatch, temp_dir, fixture, content_type
):
    url = _serve(cdn, monkeypatch, fixture, content_type)
    response = client.post("/analyze", json={"preview_url": url})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": DETAIL}
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize("fixture", [M4A, AAC], ids=lambda p: p.suffix)
def test_an_mp4_or_aac_preview_served_as_mp3_is_refused_with_that_reason(
    client, cdn, monkeypatch, temp_dir, fixture
):
    url = _serve(cdn, monkeypatch, fixture, "audio/mpeg")
    response = client.post("/analyze", json={"preview_url": url})
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": DETAIL}
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize(
    "content_type", ["audio/mp4", "audio/x-m4a", "audio/aac", "audio/AAC; charset=binary"]
)
def test_the_header_check_refuses_them_as_a_format_not_a_download(content_type):
    response = httpx.Response(200, headers={"content-type": content_type})
    with pytest.raises(preview.UnsupportedFormatError):
        preview._check_headers(response, preview.MAX_PREVIEW_BYTES)
