"""Concurrency limits, request body limits, the token check order, HEAD /health, decode span."""

import asyncio
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from guards import MAX_BODY_BYTES, RequestGuardMiddleware

DEEZER_URL = "https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/f8c5.mp3?hdnea=exp=1~hmac=ab"
RESULT = {
    "bpm": 120,
    "key": "A",
    "mode": "Major",
    "energy": 0.5,
    "duration": 30.0,
    "keyMoments": [],
}


@pytest.fixture
def limited(monkeypatch):
    """Returns a factory for a client whose analyses take ``delay`` seconds each."""
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    stats = {"running": 0, "peak": 0}
    lock = threading.Lock()

    def make(*, slots, queued, wait_s, delay):
        monkeypatch.setattr(main, "MAX_CONCURRENT_ANALYSES", slots)
        monkeypatch.setattr(main, "MAX_QUEUED_ANALYSES", queued)
        monkeypatch.setattr(main, "QUEUE_WAIT_S", wait_s)

        async def fake_analysis(url):
            with lock:
                stats["running"] += 1
                stats["peak"] = max(stats["peak"], stats["running"])
            try:
                await asyncio.sleep(delay)
                return RESULT
            finally:
                with lock:
                    stats["running"] -= 1

        monkeypatch.setattr(main, "analyze_preview_url", fake_analysis)
        return TestClient(main.create_app()), stats

    return make


def post_concurrently(client, n):
    def post(_):
        return client.post("/analyze", json={"preview_url": DEEZER_URL})

    with ThreadPoolExecutor(max_workers=n) as pool:
        return list(pool.map(post, range(n)))


def test_requests_beyond_the_slots_wait_instead_of_failing(limited):
    client, stats = limited(slots=4, queued=16, wait_s=5.0, delay=0.3)
    with client:
        started = time.monotonic()
        responses = post_concurrently(client, 5)
        elapsed = time.monotonic() - started
    assert [r.status_code for r in responses] == [200] * 5
    assert stats["peak"] == 4
    assert elapsed >= 0.6  # the fifth request waited for a slot


def test_full_queue_answers_503_with_retry_after(limited):
    client, _ = limited(slots=1, queued=0, wait_s=5.0, delay=0.5)
    with client:
        responses = post_concurrently(client, 2)
    assert sorted(r.status_code for r in responses) == [200, 503]
    busy = next(r for r in responses if r.status_code == 503)
    assert busy.headers["retry-after"] == str(main.RETRY_AFTER_S)
    assert busy.json() == {"detail": "The analysis service is busy; try again"}


def test_wait_beyond_the_limit_answers_503(limited):
    client, _ = limited(slots=1, queued=4, wait_s=0.1, delay=0.5)
    with client:
        responses = post_concurrently(client, 2)
    assert sorted(r.status_code for r in responses) == [200, 503]
    assert next(r for r in responses if r.status_code == 503).headers["retry-after"]


def test_executor_has_one_thread_per_slot():
    assert main.executor._max_workers == main.MAX_CONCURRENT_ANALYSES


# --- Body size and token, checked in front of the application -------------------------------


def run_asgi(app, scope_overrides, chunks):
    """Runs one request through ``app``; returns (sent messages, number of receive calls)."""
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/analyze",
        "headers": [(b"content-type", b"application/json")],
        "query_string": b"",
    }
    scope.update(scope_overrides)
    sent = []
    calls = 0

    async def receive():
        nonlocal calls
        calls += 1
        if calls <= len(chunks):
            return {"type": "http.request", "body": chunks[calls - 1], "more_body": True}
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    return sent, calls


def inner_app_must_not_run(scope, receive, send):
    raise AssertionError("the application was called")


def guard(app, token=""):
    return RequestGuardMiddleware(
        app,
        token=lambda: token,
        token_header="X-Audio-Token",
        protected_paths=frozenset({"/analyze"}),
    )


def test_declared_oversized_body_gets_413_without_being_read():
    headers = [(b"content-length", str(300 * 1024 * 1024).encode())]
    sent, calls = run_asgi(guard(inner_app_must_not_run), {"headers": headers}, [b"x" * 65536])
    assert sent[0]["status"] == 413
    assert calls == 0


def test_streamed_oversized_body_gets_413_after_the_limit():
    chunks = [b"x" * 8192] * 10_000  # 80 MB if read to the end
    sent, calls = run_asgi(guard(main.app), {"headers": []}, chunks)
    assert [m["status"] for m in sent if m["type"] == "http.response.start"] == [413]
    assert calls <= MAX_BODY_BYTES // 8192 + 1


def test_missing_token_gets_401_before_the_body_is_read():
    headers = [(b"content-length", b"40")]
    app = guard(inner_app_must_not_run, token="s3cret")
    sent, calls = run_asgi(app, {"headers": headers}, [b"{}"])
    assert sent[0]["status"] == 401
    assert json.loads(sent[1]["body"]) == {"detail": "Unauthorized"}
    assert calls == 0


def test_duplicate_token_headers_are_refused():
    headers = [(b"x-audio-token", b"s3cret"), (b"x-audio-token", b"s3cret")]
    sent, calls = run_asgi(guard(inner_app_must_not_run, token="s3cret"), {"headers": headers}, [])
    assert sent[0]["status"] == 401


def test_oversized_json_over_http_gets_413(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    padding = "a" * (MAX_BODY_BYTES + 1)
    with TestClient(main.app) as c:
        response = c.post("/analyze", json={"preview_url": DEEZER_URL, "pad": padding})
    assert response.status_code == 413


def test_small_requests_still_reach_the_application(monkeypatch):
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)
    with TestClient(main.app) as c:
        response = c.post("/analyze", json={"preview_url": "https://evil.example/"})
    assert response.status_code == 400


# --- HEAD /health and the Essentia decode span ----------------------------------------------


def test_health_answers_head_for_wget_spider(monkeypatch):
    with TestClient(main.app) as c:
        assert c.head("/health").status_code == 200


def test_essentia_input_is_cut_to_the_decode_span(monkeypatch):
    seen = []

    def loader(**kwargs):
        return lambda: np.zeros(16000 * 1800, dtype=np.float32)  # half an hour of audio

    def embed(audio):
        seen.append(len(audio))
        return np.zeros((3, 8), dtype=np.float32)

    def head(embeddings):
        return np.full((len(embeddings), 2), 0.5, dtype=np.float32)

    monkeypatch.setattr(main, "MODELS_LOADED", True)
    monkeypatch.setattr(main, "MonoLoader", loader, raising=False)
    monkeypatch.setattr(main, "_musicnn_extractor", embed)
    monkeypatch.setattr(main, "_effnet_extractor", embed)
    for name in ("_valence_model", "_danceability_model", "_acousticness_model"):
        monkeypatch.setattr(main, name, head)
    monkeypatch.setattr(main, "_instrumentalness_model", head)

    features = main.analyze_perceptual_features("unused.mp3")
    assert seen == [int(16000 * main.MAX_DECODE_SECONDS)] * 2
    assert features["danceability"] == 0.5
