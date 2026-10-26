"""Malformed input, unknown audio types, decode limits, concurrency and the docs switch."""

import asyncio

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import main
from preview import (
    MAX_PREVIEW_BYTES,
    PreviewDownloadError,
    PreviewURLError,
    _check_headers,
    fetch_to_file,
    validate_preview_url,
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    with TestClient(main.app) as c:
        yield c


@pytest.mark.parametrize(
    "url",
    [
        "https://p.scdn.co[x]/a.mp3",
        "https://[p.scdn.co]/a.mp3",
        "https://xn--p-scdn-xx.dzcdn.net/a.mp3",
        "https://cdnt-preview.xn--dzcdn-abc.net/a.mp3",
    ],
)
def test_malformed_and_punycode_hosts_are_rejected(url):
    with pytest.raises(PreviewURLError):
        validate_preview_url(url)


@pytest.mark.parametrize("url", ["https://p.scdn.co[x]/a.mp3", "https://[p.scdn.co]/a.mp3"])
def test_malformed_urls_get_a_400_not_a_500(client, url):
    assert client.post("/analyze", json={"preview_url": url}).status_code == 400


def test_invalid_hosts_at_download_time_are_wrapped(temp_dir):
    # Bypasses the guard on purpose: httpx itself refuses this host while encoding it.
    with pytest.raises(PreviewDownloadError):
        asyncio.run(fetch_to_file("https://xn--p-scdn-xx.dzcdn.net/a.mp3"))
    assert list(temp_dir.iterdir()) == []


@pytest.mark.parametrize("content_type", ["audio/x-unknown", "audio/midi", "text/html"])
def test_only_known_audio_types_are_accepted(content_type):
    response = httpx.Response(200, headers={"content-type": content_type})
    with pytest.raises(PreviewDownloadError, match="content type"):
        _check_headers(response, MAX_PREVIEW_BYTES)


def test_decoding_stops_at_the_preview_length(tmp_path):
    # Two minutes of audio: only the first MAX_DECODE_SECONDS are decoded.
    path = tmp_path / "long.wav"
    sf.write(path, np.zeros(22050 * 120, dtype=np.float32), 22050)
    v2 = main.analyze_audio_file(str(path))["v2"]
    assert v2["window"]["durationSeconds"] <= main.MAX_DECODE_SECONDS + 0.1


def test_no_tempo_is_reported_as_null_not_a_default(tmp_path):
    path = tmp_path / "silence.wav"
    sf.write(path, np.zeros(22050 * 5, dtype=np.float32), 22050)
    v2 = main.analyze_audio_file(str(path))["v2"]
    assert v2["tempo"] is None
    assert v2["withheld"]["tempo"]["code"] == "gate_silence"


def test_docs_and_schema_are_off_by_default(client):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_silence_has_no_key_rather_than_a_default(tmp_path):
    path = tmp_path / "silence.wav"
    sf.write(path, np.zeros(22050 * 5, dtype=np.float32), 22050)
    v2 = main.analyze_audio_file(str(path))["v2"]
    assert v2["key"] is None
    assert v2["withheld"]["key"]["code"] == "gate_silence"


def test_a_tone_still_gets_a_key(tmp_path):
    # An A major triad: the detector must still name a key for pitched audio.
    t = np.arange(22050 * 5) / 22050
    chord = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.18, 329.63)) / 3
    path = tmp_path / "chord.wav"
    sf.write(path, chord.astype(np.float32), 22050)
    v2 = main.analyze_audio_file(str(path))["v2"]
    assert v2["key"] is not None and "key" not in v2["withheld"]
