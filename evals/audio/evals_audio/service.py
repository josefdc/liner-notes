"""
The audio service, imported in-process.

services/audio is not an installable package (its modules are top-level: main, estimators,
...), so its directory is put first on sys.path and `main.analyze_signals` is called directly,
not over HTTP: the harness measures exactly what the service returns, with the gate, the steady
tempo check and the key evidence rules, and no network or server in between. The service's
dependencies are this project's dependencies at the versions the service's lock pins
(pyproject.toml; tests/test_service_pins.py checks they agree).

The model fingerprint (Discogs styles, moods) is not loaded: tempo and key do not use it, and
the style comparison belongs to a later suite. `analyzer_version` therefore carries no model
tag here.
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
ESTIMATOR_NAMES = ("librosa", "essentia")


class EstimatorUnavailable(RuntimeError):
    pass


@cache
def load():
    """Import the service once (main, estimators) with the fingerprint models disabled."""
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    if not (SERVICE_DIR / "main.py").is_file():
        raise RuntimeError(f"the audio service was not found at {SERVICE_DIR}")
    if str(SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(SERVICE_DIR))
    import fingerprint

    # main loads the models at import time; tempo and key never read them.
    fingerprint.load = lambda: False
    import estimators
    import main

    # main logs every withheld tempo or key at INFO; the harness counts them instead.
    logging.getLogger("audio").setLevel(logging.WARNING)
    return main, estimators


def estimator(name: str):
    """The named estimator; never the fallback select_estimator() would quietly pick."""
    _, estimators = load()
    if name not in ESTIMATOR_NAMES:
        raise ValueError(f"unknown estimator {name!r}")
    if name == "essentia" and not estimators.ESSENTIA_AVAILABLE:
        raise EstimatorUnavailable(
            "the essentia estimator needs essentia-tensorflow: run `uv sync --extra models` "
            "in evals/audio"
        )
    return estimators.ESTIMATORS[name]()


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
