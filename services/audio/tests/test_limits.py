"""Concurrency limits, request body limits, the token check order, HEAD /health, decode span."""

import asyncio
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import fingerprint
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
    "v2": {"analyzerVersion": "2.0.0+test"},
}


# Upper bound on any wait in the slot tests. A test only reaches it when it is about to fail, so
# it can be generous: a loaded machine makes these tests slower, never wrong.
PATIENCE_S = 30.0


class HeldAnalyses:
    """Fake analyses that start and then hold their slot until ``release`` is set."""

    def __init__(self):
        self.release = threading.Event()
        self.running = 0
        self.peak = 0
        self._lock = threading.Lock()

    async def __call__(self, url):
        with self._lock:
            self.running += 1
            self.peak = max(self.peak, self.running)
        try:
            # Wait in a worker thread: the event loop stays free to serve the other requests.
            if not await asyncio.to_thread(self.release.wait, PATIENCE_S):
                raise AssertionError("the analysis was never released")
            return RESULT
        finally:
            with self._lock:
                self.running -= 1


@pytest.fixture
def limited(monkeypatch):
    """Returns a factory for a client whose analyses hold their slot until released."""
    monkeypatch.delenv("AUDIO_SERVICE_TOKEN", raising=False)

    def make(*, slots, queued, wait_s):
        monkeypatch.setattr(main, "MAX_CONCURRENT_ANALYSES", slots)
        monkeypatch.setattr(main, "MAX_QUEUED_ANALYSES", queued)
        monkeypatch.setattr(main, "QUEUE_WAIT_S", wait_s)
        held = HeldAnalyses()
        monkeypatch.setattr(main, "analyze_preview_url", held)
        return TestClient(main.create_app()), held

    return make


def post(client):
    return client.post("/analyze", json={"preview_url": DEEZER_URL})


def wait_until(condition, what):
    deadline = time.monotonic() + PATIENCE_S
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting until {what}")
        time.sleep(0.005)


def test_requests_beyond_the_slots_wait_instead_of_failing(limited):
    client, held = limited(slots=4, queued=16, wait_s=PATIENCE_S)
    with client, ThreadPoolExecutor(max_workers=5) as pool:
        slots = client.app.state.analysis_slots
        try:
            requests = [pool.submit(post, client) for _ in range(5)]
            wait_until(
                lambda: held.running + slots.waiting + sum(r.done() for r in requests) == 5,
                "every request has started, is waiting or has been answered",
            )
            assert held.running == 4
            assert slots.waiting == 1  # the fifth waits for a slot
            assert not any(r.done() for r in requests)  # and is not refused
        finally:
            held.release.set()
        responses = [r.result(timeout=PATIENCE_S) for r in requests]
    assert [r.status_code for r in responses] == [200] * 5
    assert held.peak == 4


def test_full_queue_answers_503_with_retry_after(limited, caplog):
    client, held = limited(slots=1, queued=0, wait_s=PATIENCE_S)
    with client, ThreadPoolExecutor(max_workers=2) as pool:
        slots = client.app.state.analysis_slots
        try:
            first = pool.submit(post, client)
            wait_until(lambda: held.running == 1, "the first request holds the slot")
            second = pool.submit(post, client)
            wait_until(
                lambda: second.done() or slots.waiting or held.running > 1,
                "the second request is answered, waits or starts",
            )
            assert second.done()  # refused at once, without waiting for the slot
            assert not first.done()
        finally:
            held.release.set()
        assert first.result(timeout=PATIENCE_S).status_code == 200
    busy = second.result()
    assert busy.status_code == 503
    assert busy.headers["retry-after"] == str(main.RETRY_AFTER_S)
    assert busy.json() == {"detail": "The analysis service is busy; try again"}
    assert "service busy: queue full" in caplog.text


def test_wait_beyond_the_limit_answers_503(limited, caplog):
    wait_s = 0.1
    client, held = limited(slots=1, queued=4, wait_s=wait_s)
    with client, ThreadPoolExecutor(max_workers=2) as pool:
        try:
            first = pool.submit(post, client)
            wait_until(lambda: held.running == 1, "the first request holds the slot")
            asked = time.monotonic()
            # The slot stays held, so only the wait limit can answer the second request.
            busy = pool.submit(post, client).result(timeout=PATIENCE_S)
            waited = time.monotonic() - asked
            assert not first.done()
        finally:
            held.release.set()
        assert first.result(timeout=PATIENCE_S).status_code == 200
    assert busy.status_code == 503
    assert busy.headers["retry-after"] == str(main.RETRY_AFTER_S)
    assert "service busy: no slot within the wait limit" in caplog.text
    assert waited >= wait_s


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


def test_model_input_is_cut_to_the_decode_span(monkeypatch, tmp_path):
    """The models read the decoded signal (no second decode), so the same 35 s."""
    seen = []

    def model_input(native, sr):
        seen.append((len(native), sr))
        return np.zeros(16000 * 35, dtype=np.float32)

    sr = 22050
    t = np.arange(sr * 40) / sr  # 40 s of an A major triad
    chord = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.18, 329.63)) / 4
    path = tmp_path / "long.wav"
    sf.write(path, chord.astype(np.float32), sr)

    monkeypatch.setattr(main, "MODELS_LOADED", True)
    monkeypatch.setattr(fingerprint, "model_input", model_input)
    monkeypatch.setattr(fingerprint, "mel_frames", lambda audio: np.zeros((2186, 96), np.float32))
    monkeypatch.setattr(fingerprint, "_models", {})  # every part fails: no fingerprint

    result = main.analyze_audio_file(str(path))
    assert seen == [(int(sr * main.MAX_DECODE_SECONDS), sr)]
    assert result["v2"]["fingerprint"] is None
