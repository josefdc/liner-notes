"""HTTP behaviour of the service (FastAPI TestClient, no internet)."""

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import main
from preview import PreviewDownloadError

DEEZER_URL = "https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/f8c5.mp3?hdnea=exp=1~hmac=ab"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    with TestClient(main.app) as c:
        yield c


def test_health_reports_missing_models_as_degraded(client, monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "degraded", "version": main.VERSION, "models": False}


def test_health_reports_loaded_models(client, monkeypatch):
    monkeypatch.setattr(main, "MODELS_LOADED", True)
    assert client.get("/health").json() == {"status": "ok", "version": main.VERSION, "models": True}


def test_models_are_not_loaded_without_verified_files(tmp_path, monkeypatch):
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    (tmp_path / "msd-musicnn-1.pb").write_bytes(b"partial download")
    assert main._init_essentia_models() is False


def test_analyze_test_route_is_gone(client):
    assert client.post("/analyze-test", json={"preview_url": DEEZER_URL}).status_code == 404


def test_rejects_internal_url_without_contacting_it(client, cdn):
    base, server = cdn
    response = client.post("/analyze", json={"preview_url": f"{base}/redirect?x=dzcdn.net"})
    assert response.status_code == 400
    assert server.hits == []
    assert "127.0.0.1" not in response.text


def test_download_errors_do_not_leak_details(client, monkeypatch):
    async def failing_download(url):
        raise PreviewDownloadError("ConnectError: [Errno 111] connect to 10.0.0.7:6379 refused")

    monkeypatch.setattr(main, "download_preview", failing_download)
    response = client.post("/analyze", json={"preview_url": DEEZER_URL})
    assert response.status_code == 502
    assert response.json() == {"detail": "Could not download the preview"}


def test_analysis_errors_do_not_leak_details(client, monkeypatch, tmp_path):
    secret_path = tmp_path / "preview-secret.audio"
    secret_path.write_bytes(b"not audio")

    async def fake_download(url):
        return str(secret_path)

    monkeypatch.setattr(main, "download_preview", fake_download)
    response = client.post("/analyze", json={"preview_url": DEEZER_URL})
    assert response.status_code == 500
    assert response.json() == {"detail": "Audio analysis failed"}
    assert not secret_path.exists()


def test_analyzes_a_downloaded_preview_and_removes_it(client, monkeypatch, tmp_path):
    sr = 22050
    t = np.arange(sr * 6) / sr
    tone = 0.3 * np.sin(2 * np.pi * 440 * t)
    clicks = np.zeros_like(t)
    clicks[:: sr // 2] = 1.0  # 120 BPM click track
    path = tmp_path / "preview.wav"
    sf.write(path, (tone + clicks).astype(np.float32), sr)

    async def fake_download(url):
        assert url == DEEZER_URL
        return str(path)

    monkeypatch.setattr(main, "download_preview", fake_download)
    response = client.post("/analyze", json={"preview_url": DEEZER_URL})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "analyzed"
    assert 5.5 < body["duration"] < 6.5
    assert not path.exists()


@pytest.mark.parametrize("header", [None, "wrong"])
def test_token_is_required_when_configured(client, monkeypatch, header):
    monkeypatch.setenv("AUDIO_SERVICE_TOKEN", "s3cret")
    headers = {main.TOKEN_HEADER: header} if header else {}
    response = client.post("/analyze", json={"preview_url": DEEZER_URL}, headers=headers)
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized"}


def test_matching_token_is_accepted(client, monkeypatch):
    monkeypatch.setenv("AUDIO_SERVICE_TOKEN", "s3cret")
    response = client.post(
        "/analyze",
        json={"preview_url": "https://evil.example/?x=dzcdn.net"},
        headers={main.TOKEN_HEADER: "s3cret"},
    )
    # Past the token check, the URL guard rejects the request.
    assert response.status_code == 400


def test_health_does_not_require_the_token(client, monkeypatch):
    monkeypatch.setenv("AUDIO_SERVICE_TOKEN", "s3cret")
    assert client.get("/health").status_code == 200


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, []),
        ("", []),
        (
            "http://localhost:3000, https://liner.example ",
            ["http://localhost:3000", "https://liner.example"],
        ),
        ("*", []),
        ("*,http://localhost:3000", ["http://localhost:3000"]),
    ],
)
def test_cors_origins_come_from_the_environment(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("CORS_ORIGINS", raising=False)
    else:
        monkeypatch.setenv("CORS_ORIGINS", value)
    assert main._cors_origins() == expected


def test_cors_is_off_without_configured_origins(monkeypatch):
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    with TestClient(main.create_app()) as c:
        response = c.get("/health", headers={"Origin": "https://liner.example"})
    assert "access-control-allow-origin" not in response.headers


def test_cors_allows_configured_origins_without_credentials(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://liner.example")
    with TestClient(main.create_app()) as c:
        preflight = c.options(
            "/analyze",
            headers={
                "Origin": "https://liner.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        simple = c.get("/health", headers={"Origin": "https://liner.example"})
        refused = c.options(
            "/analyze",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "https://liner.example"
    assert "access-control-allow-credentials" not in preflight.headers
    assert simple.headers["access-control-allow-origin"] == "https://liner.example"
    assert "access-control-allow-credentials" not in simple.headers
    assert refused.status_code == 400
    assert "access-control-allow-origin" not in refused.headers
