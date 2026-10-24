"""Install and memory cost helpers (the measurement itself is a real run)."""

import importlib.util
import os
import tomllib
from importlib import metadata

import pytest
from packaging.tags import sys_tags

from evals_audio import costs
from evals_audio.runner import THREAD_ENV


def test_librosa_adds_nothing():
    out = costs.install_cost(["librosa"])["librosa"]
    assert out["extra"] is None and out["packages"] == [] and out["installedBytes"] == 0
    assert out["serviceImage"]["packages"] == [] and out["serviceImage"]["installedBytes"] == 0


def test_the_base_closure_holds_the_service_libraries():
    base = costs.closure(costs.PROJECT, set())
    assert {"librosa", "numpy", "scipy", "mirdata"} <= base
    assert "torch" not in base and "essentia-tensorflow" not in base


FAKE_LOCK = {
    "package": [
        {
            "name": "torch",
            "version": "2.0+cpu",
            "wheels": [{"url": "https://x/torch-2.0%2Bcpu-py3-none-any.whl"}],  # no size
        },
        {
            "name": "beat-this",
            "version": "1.0",
            "wheels": [{"url": "https://x/beat_this-1.0-py3-none-any.whl", "size": 2}],
        },
        {
            "name": "filelock",
            "version": "3.0",
            "wheels": [{"url": "https://x/filelock-3.0-py3-none-any.whl", "size": 3}],
        },
    ]
}
SERVICE_LOCK = {
    "package": [
        {
            "name": "liner-notes-audio",
            "dependencies": [{"name": "numpy"}],
            "optional-dependencies": {"models": [{"name": "essentia-tensorflow"}]},
        },
        {"name": "numpy", "dependencies": []},
        {
            "name": "essentia-tensorflow",
            "dependencies": [{"name": "filelock"}, {"name": "pyyaml", "extra": ["fast"]}],
        },
        {"name": "filelock"},
        {"name": "pyyaml", "optional-dependencies": {"fast": [{"name": "cyaml"}]}},
        {"name": "cyaml"},
        {"name": "pytest"},  # dev only: not in the image
    ]
}


def test_the_service_image_holds_its_runtime_and_models_extra_only():
    assert costs.service_packages(SERVICE_LOCK) == {
        "numpy",
        "essentia-tensorflow",
        "filelock",
        "pyyaml",
        "cyaml",
    }


def test_the_real_service_image_ships_essentia_and_not_torch():
    shipped = costs.service_packages(tomllib.loads(costs.SERVICE_LOCK.read_text()))
    assert {"essentia-tensorflow", "librosa", "numpy"} <= shipped
    assert "torch" not in shipped and "pytest" not in shipped


@pytest.fixture
def fake_env(monkeypatch):
    base = {"numpy", "librosa"}
    with_extra = base | {"beat-this", "torch", "filelock"}
    monkeypatch.setattr(costs, "closure", lambda root, extras: with_extra if extras else base)
    monkeypatch.setattr(
        costs, "extra_closure", lambda root, extra: {"beat-this", "torch", "numpy", "filelock"}
    )
    sizes = {"torch": 700, "beat-this": 1, "filelock": 5}
    monkeypatch.setattr(costs, "installed_bytes", lambda name: sizes[name])
    versions = {"torch": "2.0+cpu", "beat-this": "1.0", "filelock": "3.0"}
    monkeypatch.setattr(costs.metadata, "version", lambda name: versions[name])


def test_an_extra_counts_only_what_the_base_or_the_image_lacks(fake_env):
    asked = []

    def content_length(url):
        asked.append(url)
        return 190

    out = costs.install_cost(["beat-this"], content_length, FAKE_LOCK, SERVICE_LOCK)["beat-this"]
    # Against the harness: numpy and librosa are already there.
    assert [p["name"] for p in out["packages"]] == ["beat-this", "filelock", "torch"]
    assert out["installedBytes"] == 706 and out["wheelBytes"] == 195
    # Against the service image: filelock ships with essentia-tensorflow, numpy with the service.
    image = out["serviceImage"]
    assert [p["name"] for p in image["packages"]] == ["beat-this", "torch"]
    assert image["installedBytes"] == 701 and image["wheelBytes"] == 192
    assert asked and all("torch" in url for url in asked)


def test_an_unknown_wheel_size_makes_the_total_unknown(fake_env):
    out = costs.install_cost(["beat-this"], None, FAKE_LOCK, SERVICE_LOCK)["beat-this"]
    assert out["wheelBytes"] is None and out["serviceImage"]["wheelBytes"] is None


def test_the_wheel_for_this_platform_is_picked_by_tag_priority():
    best = next(iter(sys_tags()))
    specific = f"https://x/demo-1.0-{best.interpreter}-{best.abi}-{best.platform}.whl"
    lock = {
        "package": [
            {
                "name": "demo",
                "version": "1.0",
                "wheels": [
                    {"url": "https://x/demo-1.0-py3-none-any.whl", "size": 3},
                    {"url": specific, "size": 7},
                    {"url": "https://x/demo-1.0-cp27-cp27m-win32.whl", "size": 1},
                ],
            }
        ]
    }
    assert costs.wheel_for(lock, "demo", "1.0") == {"url": specific, "size": 7}
    assert costs.wheel_for(lock, "demo", "2.0") is None


def test_installed_bytes_add_up_the_files_a_distribution_lists():
    dist = metadata.distribution("packaging")
    files = [dist.locate_file(f) for f in dist.files]
    expected = sum(os.path.getsize(f) for f in files if os.path.exists(f))
    assert costs.installed_bytes("packaging") == expected > 0


@pytest.mark.skipif(importlib.util.find_spec("essentia") is None, reason="needs the models extra")
def test_the_models_extra_brings_essentia_and_nothing_the_image_lacks():
    assert "essentia-tensorflow" in costs.extra_closure(costs.PROJECT, "models")
    assert costs.install_cost(["essentia"])["essentia"]["serviceImage"]["packages"] == []


def test_rss_is_read_from_the_process():
    assert costs.rss_bytes() > 0 and costs.peak_rss_bytes() >= costs.rss_bytes() // 2


class InProcess:
    """A stand-in for the spawned single-process pool."""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def submit(self, fn, *args):
        result = fn(*args)

        class Done:
            def result(self):
                return result

        return Done()


def test_the_cost_processes_run_with_one_thread_whatever_the_caller_set(monkeypatch):
    monkeypatch.setenv("OMP_NUM_THREADS", "4")
    monkeypatch.delenv("MKL_NUM_THREADS", raising=False)
    monkeypatch.setattr(costs, "ProcessPoolExecutor", InProcess)
    monkeypatch.setattr(
        costs, "_measure", lambda name, tasks, cache: {v: os.environ.get(v) for v in THREAD_ENV}
    )
    seen = costs.measure(["librosa"], [], "/unused")["librosa"]
    assert all(value == "1" for value in seen.values())
    assert os.environ["OMP_NUM_THREADS"] == "4" and "MKL_NUM_THREADS" not in os.environ


class FakeSignals:
    def __init__(self, periodicity):
        self.onset_periodicity = periodicity


def test_the_first_analysed_clip_is_the_first_past_the_periodicity_minimum(monkeypatch):
    class Est:
        def tempo(self, signals):
            return None if signals.onset_periodicity < 0.2 else object()

    class Estimators:
        MIN_TEMPO_PERIODICITY = 0.2

    periodicity = {"a": 0.1, "b": 0.5, "c": 0.05, "d": 0.6, "e": 0.7}
    monkeypatch.setattr(costs.service, "load", lambda: (None, Estimators))
    monkeypatch.setattr(costs.service, "estimator", lambda name: Est())
    monkeypatch.setattr(costs.clips, "read_clip", lambda path, seed, ds, tid: (tid, {}))
    monkeypatch.setattr(costs.service, "decode", lambda tid: FakeSignals(periodicity[tid]))
    monkeypatch.setenv("NUMBA_CACHE_DIR", "/unused")
    tasks = [("ds", tid, "/x", 1, f"public-{tid}") for tid in periodicity]
    out = costs._measure("x", tasks, "/tmp-numba")
    assert out["stoppedByPeriodicity"] == 2
    assert out["firstAnalysed"]["trackId"] == "public-b"
    assert out["perClip"]["n"] == 2 and out["tempoEstimates"] == 2
    assert out["rssAfterFirstBytes"] > 0
