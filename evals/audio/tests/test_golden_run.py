"""
The golden suite's handling of Deezer previews: signed URLs never reach a log or the output,
and the previews live only in a temporary directory outside the data directory.
"""

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from evals_audio import cli, golden, runner, service
from evals_audio.storage import DiskBudget

SECRET = "SIGNATURE_6f1c"


@pytest.fixture
def deezer(monkeypatch):
    """A local stand-in for Deezer: a track whose preview URL is signed."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            port = self.server.server_address[1]
            if self.path.startswith("/track/"):
                preview = f"http://127.0.0.1:{port}/preview.mp3?hdnea=exp=1~acl={SECRET}~hmac=ab"
                body = json.dumps({"bpm": 120.2, "readable": True, "preview": preview}).encode()
            else:
                body = b"ID3 not really an mp3"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # the server's own request log would print the URL
            pass

    for proxy in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.delenv(proxy, raising=False)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        golden, "DEEZER_TRACK", f"http://127.0.0.1:{server.server_address[1]}/track/{{}}"
    )
    yield
    server.shutdown()


NO_PAUSE = {"deezer": 0.0, "musicbrainz": 0.0, "discogs": 0.0}
ROW = golden.Row("GBAAA0000001", "rec-1", 1, "obscure", None, None)


def fetch(tmp_path):
    with golden.client() as http:
        return golden.fetch_preview(golden.Paced(http, NO_PAUSE), ROW, tmp_path)


def test_a_signed_preview_url_reaches_no_log_and_no_output(deezer, tmp_path, caplog, capfd):
    service.load()  # the service's import sets the root logger to INFO, as in a real run
    caplog.set_level(logging.DEBUG)
    out = fetch(tmp_path)
    assert out["path"] and out["unavailable"] is None
    captured = capfd.readouterr()
    for text in (caplog.text, captured.out, captured.err, json.dumps(out)):
        assert SECRET not in text and "hdnea" not in text


def test_the_url_check_above_would_see_a_leak(deezer, tmp_path, caplog):
    """Control: with httpx's logger let through, the signed URL does show up."""
    caplog.set_level(logging.DEBUG)
    with golden.client() as http:
        logging.getLogger("httpx").setLevel(logging.INFO)
        try:
            golden.fetch_preview(golden.Paced(http, NO_PAUSE), ROW, tmp_path)
        finally:
            golden.quiet_http_logs()
    assert SECRET in caplog.text


class Args:
    suite, dataset, limit, selection_seed, bootstrap_seed, clip_seed = (
        "golden",
        "golden",
        None,
        1,
        1,
        1,
    )
    jobs, no_report, report_dir = 1, True, None


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    """run_golden with every source stubbed; returns what the stubs saw."""
    seen: dict = {"dirs": [], "existed": []}
    rows = [ROW, golden.Row("GBAAA0000002", "rec-2", 2, "obscure", None, None)]
    monkeypatch.setattr(golden, "read_rows", lambda: rows)
    monkeypatch.setattr(golden, "ensure_models", lambda root, budget: tmp_path / "models")
    monkeypatch.setattr(golden, "ensure_labels", lambda *a, **k: {})
    monkeypatch.setattr(service, "load_models", lambda directory: True)

    def fake_fetch(paced, row, directory):
        seen["dirs"].append(Path(directory))
        path = Path(directory) / f"{row.isrc}.mp3"
        path.write_bytes(b"x")
        return {"deezerId": row.deezer_id, "bpm": 120.0, "path": str(path), "unavailable": None}

    monkeypatch.setattr(golden, "fetch_preview", fake_fetch)

    def fake_analyze(tasks, jobs, progress=None, models_dir=None):
        seen["existed"] = [Path(t[2]).exists() for t in tasks]
        if seen.get("fail"):
            raise RuntimeError("analysis failed")
        gate = {"passed": True, "reason": None}
        return [
            {
                "trackId": t[1],
                "window": {},
                "styles": None,
                "results": {"librosa": {"gate": gate, "tempo": {"bpm": 120.0}, "key": None}},
            }
            for t in tasks
        ]

    monkeypatch.setattr(runner, "analyze_all", fake_analyze)
    return seen


def run(tmp_path):
    root = tmp_path / "data"
    root.mkdir()
    return cli.run_golden(
        Args, ["--suite", "golden"], ["librosa"], root, DiskBudget(root, 10**9)
    ), root


def test_previews_live_outside_the_data_directory_and_are_deleted(stubbed, tmp_path):
    code, root = run(tmp_path)
    assert code == 0
    directory = stubbed["dirs"][0]
    assert stubbed["existed"] == [True, True]  # there while analysed
    assert not directory.is_relative_to(root) and not directory.exists()
    assert not list(root.rglob("*.mp3"))


def test_previews_are_deleted_when_the_run_fails(stubbed, tmp_path):
    stubbed["fail"] = True
    with pytest.raises(RuntimeError):
        run(tmp_path)
    assert not stubbed["dirs"][0].exists()


def test_sigterm_unwinds_like_ctrl_c():
    with pytest.raises(SystemExit) as stop:
        cli.stop_on_sigterm(15, None)
    assert stop.value.code == 143


def test_quieting_keeps_the_http_loggers_at_warning():
    logging.getLogger("httpx").setLevel(logging.DEBUG)
    golden.client().close()
    assert logging.getLogger("httpx").level == logging.WARNING
    assert logging.getLogger("httpcore").level == logging.WARNING
    assert isinstance(golden.client(), httpx.Client)


def test_the_unseen_comparison_leaves_out_training_songs_end_to_end(stubbed, monkeypatch, tmp_path):
    from evals_audio import beatthis

    seen = next(iter(beatthis.GOLDEN_IN_TRAINING))
    rows = [ROW, golden.Row(seen, "rec-3", 3, "documented-samples", None, None)]
    monkeypatch.setattr(golden, "read_rows", lambda: rows)

    def analyze(tasks, jobs, progress=None, models_dir=None):
        gate = {"passed": True, "reason": None}
        block = {"gate": gate, "tempo": {"bpm": 120.0, "confidence": None}, "key": None}
        return [
            {"trackId": t[1], "window": {}, "styles": None, "results": dict.fromkeys(t[4], block)}
            for t in tasks
        ]

    monkeypatch.setattr(runner, "analyze_all", analyze)

    class WithReport(Args):
        no_report = False
        report_dir = tmp_path / "reports"

    root = tmp_path / "data"
    root.mkdir()
    names = ["librosa", "beat-this"]
    assert (
        cli.run_golden(WithReport, ["--suite", "golden"], names, root, DiskBudget(root, 10**9)) == 0
    )
    doc = json.loads(next((tmp_path / "reports").glob("audio-*.json")).read_text())
    agreement = doc["runs"][0]["agreement"]

    def ids(key):
        return {r["trackId"] for r in agreement[key]["tracks"]["beat-this"]}

    assert ids("deezer-bpm") == {ROW.isrc, seen}
    assert ids("deezer-bpm-unseen") == {ROW.isrc}
    assert doc["runs"][0]["trainedOn"]["beat-this"] == {seen: beatthis.GOLDEN_IN_TRAINING[seen]}
