"""
beat-this (Foscarin, Schlüter and Widmer, ISMIR 2024) as a tempo estimator for the bake-off.

The service does not ship it; the harness wraps it behind the service's estimator interface
(`name`, `min_tempo_confidence`, `tempo(signals)`, `key(signals)`) so that its tempo goes
through the same rules as the service's own estimators:

- the onset-periodicity minimum (estimators.MIN_TEMPO_PERIODICITY, read at call time so the
  calibration can lift it as it does for the others);
- the 40-208 BPM range and the minimum number of beats;
- the tempo refined from the beats that fall on onsets (refine_bpm, onset_beats), starting
  from the median beat interval;
- the steadiness check (steady_tempo); beat-this's beats follow tempo changes, as Essentia's do.

beat-this gives beats and downbeats but no confidence, so none is reported (and no confidence
minimum applies); it has no key. The checkpoint is `final0`, the authors' main model, run on
the CPU without the DBN post-processing (their default). Its authors note that `final0` was
trained on every dataset they used except GTZAN, Ballroom included: its Ballroom numbers are on
its own training data.

Needs the `beat-this` extra (`uv sync --extra beat-this`, torch from the CPU-only index) and
the checkpoint, fetched by ensure_checkpoint() into the data directory and checked by its
SHA-256.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path

import httpx
import numpy as np

from .storage import DiskBudget

CHECKPOINT_NAME = "final0"
CHECKPOINT_URL = (
    f"https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/{CHECKPOINT_NAME}.ckpt"
)
CHECKPOINT_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
CHECKPOINT_BYTES = 81_058_141
# Where the CLI tells the worker processes the checkpoint is (they inherit the environment).
CHECKPOINT_ENV = "EVALS_AUDIO_BEAT_THIS_CHECKPOINT"
# beat-this works on 22.05 kHz mono, the rate of the service's shared signal.
TRACKER_RATE = 22050
METHOD = f"beat-this {CHECKPOINT_NAME} (CPU, no DBN)+beat-regression"
REFERENCE = (
    "Foscarin, F., Schlüter, J., Widmer, G. (2024). Beat this! Accurate beat tracking without "
    "DBN postprocessing. Proc. ISMIR 2024. arXiv:2407.21658. "
    "https://github.com/CPJKU/beat_this: the code and the published model weights (checkpoint "
    f"{CHECKPOINT_NAME}, from the authors' cloud space) are under the MIT licence"
)
HARMONIX_REFERENCE = (
    "Nieto, O., McCallum, M., Davies, M., Robertson, A., Stark, A., Egozy, E. (2019). The "
    "Harmonix Set: beats, downbeats, and functional segment annotations of Western popular "
    "music. Proc. ISMIR 2019. https://github.com/urinieto/harmonixset (MIT); its metadata was "
    "used to find golden songs in beat-this's training data"
)
# The authors' statement on their training data, and where it is listed.
TRAINING_DATA_NOTE = (
    "beat-this's checkpoint was trained on every dataset its authors used except GTZAN, "
    "Ballroom included (CPJKU/beat_this_annotations lists ballroom; the authors warn that "
    "results on training data are unfairly good). Its Ballroom numbers are on its own "
    "training data: they are shown, marked, but they say nothing about new music and are kept "
    "out of the bake-off conclusion (its pair tables on this dataset are not printed)."
)
# Datasets the checkpoint was trained on, among those the harness measures.
TRAINED_ON = frozenset({"ballroom"})
# What GOLDEN_IN_TRAINING rests on, for the report: a lower bound.
GOLDEN_TRAINING_NOTE = (
    "A lower bound: the golden songs were matched by title and artist against the Harmonix Set's "
    "metadata. The track names of the other training sets (8-folds.split in "
    "CPJKU/beat_this_annotations) hold no golden song where they name one (ASAP, Beatles, "
    "Candombe, Filosax, Groove MIDI, GuitarSet, HJDB, JAAH, RWC, SIMAC), but Hainsworth, SMC "
    "and part of SIMAC give numbers only and TapCorrect gives YouTube ids, so a golden song "
    "there would not be found. "
    'Harmonix also has a remix edit of "Alors on danse" (Stromae\'s production, another '
    'recording) and Lionel Richie\'s 2012 duet of "Hello"; neither is counted.'
)
# Golden rows whose song is in the Harmonix Set, one of the checkpoint's training datasets
# (CPJKU/beat_this_annotations harmonix/8-folds.split, matched by title and artist against the
# Harmonix Set's metadata.csv, github.com/urinieto/harmonixset; checked 2026-10-24). Two more
# share a title with a Harmonix track but are other recordings and are not listed: "Hello"
# (Harmonix has Lionel Richie's 2012 duet with Jennifer Nettles) and "Alors on danse" (a remix
# edit featuring Kanye West).
GOLDEN_IN_TRAINING = {
    "USUM70741299": "Harmonix Set 0921_stronger",
    "USSB29000129": "Harmonix Set 0132_iceicebaby",
    "USCA29000294": "Harmonix Set 0523_ucanttouchthis",
    "USSM10804556": "Harmonix Set 0708_haloradioedit (the radio edit)",
    "USUM71210283": "Harmonix Set 0388_gangnamstyle",
}


class Unavailable(RuntimeError):
    pass


def available() -> bool:
    return importlib.util.find_spec("beat_this") is not None


def checkpoint_path(root: Path) -> Path:
    return root / "models" / "beat-this" / f"{CHECKPOINT_NAME}.ckpt"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_checkpoint(root: Path, budget: DiskBudget, client: httpx.Client | None = None) -> Path:
    """The checkpoint in the data directory, downloaded and checked (SHA-256) when missing."""
    path = checkpoint_path(root)
    if path.is_file() and _sha256(path) == CHECKPOINT_SHA256:
        return path
    budget.require(CHECKPOINT_BYTES, f"the beat-this checkpoint {CHECKPOINT_NAME}")
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    digest = hashlib.sha256()
    own = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(120.0, connect=20.0))
    try:
        with client.stream("GET", CHECKPOINT_URL, follow_redirects=True) as response:
            response.raise_for_status()
            written = 0
            with open(part, "wb") as f:
                for chunk in response.iter_bytes(1 << 20):
                    written += len(chunk)
                    if written > CHECKPOINT_BYTES:
                        raise Unavailable("the beat-this checkpoint is larger than pinned")
                    digest.update(chunk)
                    f.write(chunk)
        if digest.hexdigest() != CHECKPOINT_SHA256:
            raise Unavailable(
                f"the beat-this checkpoint does not match its pinned SHA-256 "
                f"(got {digest.hexdigest()})"
            )
        os.replace(part, path)
        return path
    finally:
        part.unlink(missing_ok=True)
        if own:
            client.close()


def tempo_from_beats(beats: np.ndarray, signals, onset_check: bool = True):
    """
    The service's rules applied to a list of beat times: None when there are too few beats or
    the median interval is out of range; otherwise the refined tempo and whether it holds
    (the steadiness check, with or without its onset-tempo part).
    """
    from . import service

    _, estimators = service.load()
    beats = np.asarray(beats, dtype=float)
    if len(beats) < estimators.MIN_BEATS:
        return None
    start = 60.0 / float(np.median(np.diff(beats)))
    if not estimators.MIN_BPM <= start <= estimators.MAX_BPM:
        return None
    bpm = estimators.refine_bpm(estimators.onset_beats(beats, signals), start)
    measured = estimators.steadiness(beats, bpm, signals)
    return estimators.TempoEstimate(
        bpm=bpm,
        confidence=None,
        raw_confidence=None,
        beats=beats,
        method=METHOD,
        steady=bool(measured.holds(onset_check=onset_check)),
        beats_follow_changes=True,
        steadiness=measured,
    )


class BeatThisEstimator:
    name = "beat-this"
    # beat-this gives no confidence, so there is no minimum to apply (the harness lifts this
    # attribute for calibration as it does for the others; 0 changes nothing).
    min_tempo_confidence = 0.0
    # Its beats follow tempo changes, as Essentia's do: it takes the service's Essentia setting
    # for the onset-tempo part of the steadiness check.
    steady_onset_check = True

    def __init__(self, checkpoint: str):
        import torch
        from beat_this.inference import Audio2Beats

        # One thread per worker, like the other estimators (runner.THREAD_ENV).
        torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS") or 1))
        self._tracker = Audio2Beats(checkpoint_path=checkpoint, device="cpu", dbn=False)

    def beats(self, signals) -> np.ndarray:
        import torch

        y = np.asarray(signals.at(TRACKER_RATE), dtype=np.float32)
        with torch.inference_mode():
            beats, _ = self._tracker(y, TRACKER_RATE)
        return np.asarray(beats, dtype=float)

    def tempo(self, signals):
        from . import service

        _, estimators = service.load()
        if signals.onset_periodicity < estimators.MIN_TEMPO_PERIODICITY:
            return None
        return tempo_from_beats(self.beats(signals), signals, self.steady_onset_check)

    def key(self, signals):
        return None


def estimator() -> BeatThisEstimator:
    from .service import EstimatorUnavailable

    if not available():
        raise EstimatorUnavailable(
            "the beat-this estimator needs the beat-this extra: run `uv sync --extra beat-this` "
            "in evals/audio"
        )
    checkpoint = os.environ.get(CHECKPOINT_ENV)
    if not checkpoint or not Path(checkpoint).is_file():
        raise EstimatorUnavailable(
            "the beat-this checkpoint is not in place (the CLI fetches it into the data "
            "directory before a run)"
        )
    return BeatThisEstimator(checkpoint)
