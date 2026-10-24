"""
The audio service, imported in-process.

services/audio is not an installable package (its modules are top-level: main, estimators,
...), so its directory is put first on sys.path and `main.analyze_signals` is called directly,
not over HTTP: the harness measures exactly what the service returns, with the gate, the steady
tempo check and the key evidence rules, and no network or server in between. The service's
dependencies are this project's dependencies at the versions the service's lock pins
(pyproject.toml; tests/test_service_pins.py checks they agree).

The model fingerprint (Discogs styles, moods) is not loaded for the tempo and key suites: they
do not use it, and `analyzer_version` then carries no model tag. The golden suite loads it
(load_models) to score the styles.

Besides the service's own estimators, the tempo suites can run beat-this (evals_audio.beatthis),
a beat tracker the service does not ship, behind the same interface and the same rules.
"""

from __future__ import annotations

import io
import logging
import os
import sys
from functools import cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVICE_DIR = REPO_ROOT / "services" / "audio"
ESTIMATOR_NAMES = ("librosa", "essentia", "beat-this")
# The estimators each suite can run: beat-this tracks beats and has no key.
SUITE_ESTIMATORS = {
    "tempo": ESTIMATOR_NAMES,
    "key": ("librosa", "essentia"),
    "golden": ESTIMATOR_NAMES,
    "cost": ESTIMATOR_NAMES,
}


class EstimatorUnavailable(RuntimeError):
    pass


_real_fingerprint_load: list = []


@cache
def load():
    """Import the service once (main, estimators) with the fingerprint models disabled."""
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    if not (SERVICE_DIR / "main.py").is_file():
        raise RuntimeError(f"the audio service was not found at {SERVICE_DIR}")
    if str(SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(SERVICE_DIR))
    import fingerprint

    # main loads the models at import time; tempo and key never read them. load_models() loads
    # them afterwards for the suites that score the fingerprint.
    _real_fingerprint_load.append(fingerprint.load)
    fingerprint.load = lambda: False
    import estimators
    import main

    # main logs every withheld tempo or key at INFO; the harness counts them instead.
    logging.getLogger("audio").setLevel(logging.WARNING)
    return main, estimators


def load_models(directory: str) -> bool:
    """
    Load the service's fingerprint models from `directory` (the files download_models.py pins,
    checked by their SHA-256) into the imported service, as its startup does. True when they
    loaded; the service then returns a fingerprint and its analyzer version carries the model
    tag.
    """
    main, _ = load()
    os.environ["MODELS_DIR"] = directory
    main.MODELS_LOADED = bool(_real_fingerprint_load[0]())
    return main.MODELS_LOADED


def estimator(name: str):
    """The named estimator; never the fallback select_estimator() would quietly pick."""
    _, estimators = load()
    if name not in ESTIMATOR_NAMES:
        raise ValueError(f"unknown estimator {name!r}")
    if name == "beat-this":
        from . import beatthis

        return beatthis.estimator()
    if name == "essentia" and not estimators.ESSENTIA_AVAILABLE:
        raise EstimatorUnavailable(
            "the essentia estimator needs essentia-tensorflow: run `uv sync --extra models` "
            "in evals/audio"
        )
    return estimators.ESTIMATORS[name]()


def check_estimator(name: str) -> None:
    """Raise EstimatorUnavailable when the named estimator cannot run (nothing is loaded)."""
    if name == "beat-this":
        from . import beatthis

        if not beatthis.available():
            raise EstimatorUnavailable(
                "the beat-this estimator needs the beat-this extra: run "
                "`uv sync --extra beat-this` in evals/audio"
            )
        return
    estimator(name)


def analyzer_versions(names) -> dict[str, str]:
    main, _ = load()
    return {name: main.analyzer_version(name) for name in names}


def base_version() -> str:
    main, _ = load()
    return main.ANALYZER_VERSION


def decode(wav: bytes):
    """The service's own decoder (downmix, guards) on an in-memory clip."""
    main, _ = load()
    return main.decode(io.BytesIO(wav))


def decode_file(path: str):
    """The service's own decoder on a file, as the service decodes a preview it downloads."""
    main, _ = load()
    return main.decode(path)


def analyze(signals, est) -> dict:
    """The v2 block the service would return for these signals with this estimator."""
    main, _ = load()
    return main.analyze_signals(signals, est)["v2"]


def tempo_without_confidence_minimum(signals, est):
    """
    The tempo the estimator would give without its confidence minimum
    (`min_tempo_confidence`, lifted on this instance for one call). Used only to show what the
    minimum withholds; never scored as the service's answer.
    """
    est.min_tempo_confidence = 0.0
    try:
        return est.tempo(signals)
    finally:
        del est.min_tempo_confidence  # back to the class value


def tempo_without_minimums(signals, est):
    """
    The tempo the estimator would give without the onset-periodicity minimum
    (estimators.MIN_TEMPO_PERIODICITY) and its confidence minimum, both lifted for one call,
    and whether it holds over the window as the service judges it. The steadiness check uses
    the same periodicity minimum, so it is recomputed (estimators.steady_tempo) after the
    minimum is restored. (None, False) when there is still no tempo. Calibration only.
    """
    _, estimators = load()
    minimum = estimators.MIN_TEMPO_PERIODICITY
    estimators.MIN_TEMPO_PERIODICITY = 0.0
    try:
        tempo = tempo_without_confidence_minimum(signals, est)
    finally:
        estimators.MIN_TEMPO_PERIODICITY = minimum
    if tempo is None:
        return None, False
    return tempo, bool(estimators.steady_tempo(tempo.beats, tempo.bpm, signals))


def tempo_periodicity_minimum() -> float:
    _, estimators = load()
    return estimators.MIN_TEMPO_PERIODICITY


def key_without_withholding(signals, est):
    """
    The key the estimator would give if neither the service's evidence rule
    (Signals.key_withheld) nor the minimum strength (KEY_MIN_STRENGTH) stopped it: the
    estimator's own code, with both lifted for this one call. Used only to show what they
    withhold; never scored as the service's answer.
    """
    _, estimators = load()
    minimum = estimators.KEY_MIN_STRENGTH
    signals.key_withheld = lambda: None
    estimators.KEY_MIN_STRENGTH = 0.0
    try:
        return est.key(signals)
    finally:
        estimators.KEY_MIN_STRENGTH = minimum
        del signals.key_withheld


def key_min_strength() -> float:
    _, estimators = load()
    return estimators.KEY_MIN_STRENGTH
