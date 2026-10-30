"""
Rules that could withhold the keys of pitched drums (toms, two rack toms and a floor tom over a
kit, tabla), measured on the newest committed report: how many drum keys each would withhold,
and how many right keys it would take from every other control and from the GiantSteps+ clips.
None is shipped (services/audio/README.md states drums as a limit).

A rule placed after the others can withhold only a key that is served, so only the served
controls and clips are analysed: every control to which the controls run served a key with
either estimator (the drums at 500-529 and 600-629 among them), and every clip to which the
GiantSteps+ key run served one. Each is made again (a control from its seed, a clip from the
local GiantSteps+ audio, cut at the run's clip seed), then decoded and analysed by the service.
Before anything is reported, reproduce() checks each one against the report: no evidence rule
withholds its key, the single-source evidence is the one recorded (the controls run's, or the
GiantSteps+ calibration run's for a clip), and each estimator serves the key it served, at the
recorded strength, or none where it served none.

The measurements, each per hit at the onsets librosa finds (hop 512, 23 ms; frames 93 ms long):

- **Gliding partials**: the spectral peaks of the harmonic part in the frame GLIDE_FRAMES[0]
  (2) after the onset, each followed to the nearest peak in the frame GLIDE_FRAMES[1] (4) after
  it, 46 ms later. The share of their energy that falls by more than GLIDE_CENTS, minus the
  share that rises by as much: a struck membrane falls in pitch just after the hit, a chord
  holds still, a vibrato goes both ways.
- **Decaying lines**: the share of the hits' harmonic-part energy that comes SUSTAIN_FRAMES (70
  ms) or more after each hit's loudest frame (hit_spans), over all hits: low when every line
  dies away right after its hit.
- **A pitch line that jumps between hits**: the pitch track's spread around its smoothed line
  (Voice.vibrato_cents, 90th percentile): one drum after another sets the tracker hopping
  between their pitches.
- **Membrane modes**: per hit, in the frame GLIDE_FRAMES[0] after the onset, each of the three
  strongest peaks is taken as a reference. Of the other peaks' energy, the largest share (over
  the references) within MODE_CENTS of an ideal membrane's overtone ratios (MEMBRANE_RATIOS)
  to its reference, minus the largest share within MODE_CENTS of a whole multiple (2x and up);
  then the mean over hits, weighted by their peaks' energy. 1.594 lies 7 cents from a minor
  sixth, so a chord with a minor sixth over a strong partial (a major triad in first
  inversion, a minor triad in second) reads as membrane modes too (tests/test_drum_rules.py
  pins one); 2.136 and 2.653 lie 14 and 11 cents from a minor ninth and an eleventh.
- **A falling strongest partial**: the strongest of those peaks followed to the nearest peak
  GLIDE_FRAMES[1] after the onset, in cents; the median over hits.
- **Tonal ratio**: Tonality.tonal_ratio, the share of the 60 Hz-5 kHz energy in spectral lines.

The candidates (CANDIDATES) are the first three measurements each on its own; membrane modes or
a falling strongest partial; and, aimed at the tabla, a pitch line that jumps between hits on a
tonal sound. All five were first measured on all the data; the split came later, with the glide
frames and the hit spans revised, and the last two were proposed after held-out numbers had been
seen, so no held-out number here is an untouched test (for the first three, that can only
flatter rules that fail anyway). Thresholds are chosen on the training half and judged on the
held-out one. A seeded control goes by its seed: 500-529 (the drums and the other
one-pitch-class families) and 700-729 (the chord families) train, 600-629 and 800-829 are held
out. The unseeded controls and the clips, sorted by name, go alternately to each half, so
near-copies of one chord in the grids (soft-third, seventh, detuned-third) fall on both sides.
One threshold serves both estimators. A rule withholds no right key of the training half at the
middle of the gap between the most drum-like right key there and the next drum (for an "or",
each measurement has its own; for an "and", the first is tried at each drum value and the second
placed at its gap among the rows the first takes, keeping the pair that withholds most of the
training drums it aims at). For each single measurement it also gives the strictest threshold
(the highest value of a drum it is aimed at, searched from the top) that withholds more than
half of the training keys of the drums it is aimed at, with each estimator that served one of
them, with the right keys it takes in both halves. A candidate is aimed at the families its
entry in CANDIDATES names (None: every drum); scripts/still_chord_rules.py passes in its own
table and families.

    cd evals/audio && uv run python scripts/drum_rules.py ../reports/audio-2026-10-29.json [--jobs J]

5-11 min at --jobs 4 on a shared machine, as its load allows. Needs the GiantSteps+ audio on
disk (--data-dir, as the harness; nothing is downloaded) and mirdata's index in this
environment, both checked before the work starts. In a fresh environment, run once with
--jobs 1 first: librosa's numba cache written by several workers at once can crash them.
Nothing is written. Deterministic.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

import numpy as np

REPORTS = Path(__file__).resolve().parents[2] / "reports"
DATASET = "giantsteps-key"
DRUMS = ("toms", "kit-toms", "tabla")
SPANS = {"pinned": range(500, 530), "held out": range(600, 630)}
TRAINING_SEEDS = (range(500, 530), range(700, 730))
ESTIMATORS = ("essentia", "librosa")
FAMILY = re.compile(r"^(?P<family>.+)-s(?P<seed>\d+)$")
GLIDE_CENTS = 15.0
# The frames after an onset whose peaks are compared. onset_detect marks a hit 1-1.7 frames
# after it starts; the 93 ms window of the second frame after the onset starts after the
# attack, so a struck note's new phase does not read as a glide (from the first frame, a steady
# triad cut while it rings reads -0.13).
GLIDE_FRAMES = (2, 4)
PEAK_LEVEL = 0.1  # peaks from this share of the frame's strongest, 30 Hz-5 kHz
GLIDE_MATCH_CENTS = 300.0  # a peak is followed to the nearest one within this
SUSTAIN_FRAMES = 3  # 70 ms
PEAK_SEARCH_FRAMES = 2  # a hit's loudest frame is looked for this far before its onset
# An ideal circular membrane's overtones over its fundamental (zeros of the Bessel functions).
MEMBRANE_RATIOS = (1.594, 2.136, 2.296, 2.653)
MODE_CENTS = 30.0  # a peak within this of a ratio is near it
MODE_REFERENCES = 3
# Per measurement: 1 when a rule withholds at or above its threshold, -1 at or below.
MEASURES = {
    "gliding partials": 1,
    "decaying lines": -1,
    "a pitch line that jumps between hits": 1,
    "membrane modes": 1,
    "a falling strongest partial": -1,
    "tonal ratio": 1,
}
# Per candidate: "any" withholds when one measurement passes its threshold, "all" when each
# does; and the drum families its thresholds are chosen for (None: all).
CANDIDATES = {
    "gliding partials": ("any", ("gliding partials",), None),
    "decaying lines": ("any", ("decaying lines",), None),
    "a pitch line that jumps between hits": (
        "any",
        ("a pitch line that jumps between hits",),
        None,
    ),
    "membrane modes or a falling strongest partial": (
        "any",
        ("membrane modes", "a falling strongest partial"),
        None,
    ),
    "a pitch line that jumps between hits, on a tonal sound": (
        "all",
        ("a pitch line that jumps between hits", "tonal ratio"),
        ("tabla",),
    ),
}


def newest(path: Path | None) -> tuple[str, dict, dict, dict]:
    """
    The report's controls run, GiantSteps+ key run and GiantSteps+ calibration run (the newest
    report that holds all three).
    """
    for p in [path] if path else sorted(REPORTS.glob("audio-*.json"), reverse=True):
        runs = json.loads(p.read_text())["runs"]
        controls = [r for r in runs if r["suite"] == "controls"]
        key, calibration = (
            [r for r in runs if r["suite"] == suite and r["dataset"]["name"] == DATASET]
            for suite in ("key", "calibration")
        )
        if controls and key and calibration:
            return p.name, controls[0], key[0], calibration[0]
    raise SystemExit("no report holds a controls run and the GiantSteps+ key and calibration runs")


def drum(name: str, families: tuple[str, ...] = DRUMS) -> tuple[str, str] | None:
    """(family, seed span) of a control of `families` (the drums), or None."""
    m = FAMILY.match(name)
    if not m or m["family"] not in families:
        return None
    span = next((s for s, seeds in SPANS.items() if int(m["seed"]) in seeds), None)
    return (m["family"], span) if span else None


def _estimate(block: dict | None) -> tuple[str, str, float] | None:
    """(tonic, mode, strength) of a recorded key estimate with the rules lifted, or None."""
    raw = (block or {}).get("raw")
    return None if raw is None else (raw["tonic"], raw["mode"], raw["strength"])


def served_rows(
    controls_run: dict, key_run: dict, calibration_run: dict, families: tuple[str, ...] = DRUMS
) -> list[dict]:
    """
    One row per served control or clip: its name, kind ("control" or "clip"), family and span
    if it is one of `families`, the families the rules are aimed at (the "drum" field; None
    otherwise), group, and per estimator (served, right), the key it served (or None) and
    its recorded estimate; and the single-source evidence recorded for it. A control's key is
    right when it is its truth, or any key for the controls whose truth is "any key"; a clip's
    when the key run scored it exact.
    """
    rows = []
    for c in controls_run["controls"]:
        truth = c["truth"]["key"]
        keys, served, estimates = {}, {}, {}
        for est in ESTIMATORS:
            block = (c["estimators"].get(est) or {}).get("key")
            got = (block or {}).get("served")
            served[est] = None if got is None else tuple(got)
            estimates[est] = _estimate(block)
            keys[est] = (
                got is not None,
                got is not None and (truth == "any key" or list(got) == truth),
            )
        if any(s for s, _ in keys.values()):
            rows.append(
                {
                    "name": c["name"],
                    "kind": "control",
                    "drum": drum(c["name"], families),
                    "group": _group(c),
                    "keys": keys,
                    "served": served,
                    "estimates": estimates,
                    "source": (c["evidence"] or {}).get("source"),
                }
            )
    tracks = {est: {r["trackId"]: r for r in key_run["tracks"][est]} for est in ESTIMATORS}
    recorded = {c["trackId"]: c for c in calibration_run["clips"]}
    for tid in sorted(tracks[ESTIMATORS[0]]):
        keys, served, estimates = {}, {}, {}
        for est in ESTIMATORS:
            row = tracks[est][tid]
            keys[est] = (not row["withheld"], not row["withheld"] and row["scores"]["exact"] == 1)
            served[est] = None if row["withheld"] else tuple(row["estimate"].split(" "))
            estimates[est] = _estimate(recorded[tid]["estimators"][est].get("key"))
        if any(s for s, _ in keys.values()):
            rows.append(
                {
                    "name": tid,
                    "kind": "clip",
                    "drum": None,
                    "group": "GiantSteps+",
                    "keys": keys,
                    "served": served,
                    "estimates": estimates,
                    "source": recorded[tid]["evidence"]["source"],
                }
            )
    return rows


# --- the measurements --------------------------------------------------------------------------


def _peaks(column: np.ndarray, lo: int, hi: int) -> np.ndarray:
    m = column[lo:hi]
    if m.size < 3 or not m.max() > 0:
        return np.zeros(0, dtype=int)
    inner = (m[1:-1] > m[:-2]) & (m[1:-1] >= m[2:]) & (m[1:-1] >= PEAK_LEVEL * m.max())
    return np.flatnonzero(inner) + 1 + lo


def instantaneous_hz(stft: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Each bin's frequency from its phase advance since the frame before (frame 0: NaN)."""
    n_fft = 2 * (stft.shape[0] - 1)
    k = np.arange(stft.shape[0])[:, None]
    advance = np.angle(stft[:, 1:]) - np.angle(stft[:, :-1]) - 2 * np.pi * k * hop / n_fft
    advance = (advance + np.pi) % (2 * np.pi) - np.pi
    hz = (k + advance * n_fft / (2 * np.pi * hop)) * sr / n_fft
    return np.concatenate([np.full((stft.shape[0], 1), np.nan), hz], axis=1)


def onsets(signals) -> np.ndarray:
    import librosa

    return librosa.onset.onset_detect(
        onset_envelope=signals.onset_envelope, sr=signals.sr, hop_length=signals.hop
    )


def gliding_partials(signals) -> float | None:
    """Net share of the followed peaks' energy that falls by more than GLIDE_CENTS."""
    stft, sr, hop = signals.harmonic_stft, signals.sr, signals.hop
    magnitude, hz = np.abs(stft), instantaneous_hz(stft, sr, hop)
    n_fft = 2 * (stft.shape[0] - 1)
    lo, hi = int(30 * n_fft / sr) + 1, int(5000 * n_fft / sr)
    found = onsets(signals)
    if not found.size:
        return None
    ends = np.append(found[1:], stft.shape[1])
    drift, weight = [], []
    for onset, end in zip(found, ends, strict=True):
        a, b = onset + GLIDE_FRAMES[0], onset + GLIDE_FRAMES[1]
        if b >= min(end, stft.shape[1]):
            continue
        first, later = _peaks(magnitude[:, a], lo, hi), _peaks(magnitude[:, b], lo, hi)
        if not first.size or not later.size or not np.all(np.isfinite(hz[later, b])):
            continue
        for p in first:
            if not hz[p, a] > 0:
                continue
            cents = 1200 * np.log2(np.maximum(hz[later, b], 1e-3) / hz[p, a])
            nearest = cents[int(np.argmin(np.abs(cents)))]
            if abs(nearest) <= GLIDE_MATCH_CENTS:
                drift.append(nearest)
                weight.append(magnitude[p, a] ** 2)
    if not weight:
        return None
    drift, weight = np.array(drift), np.array(weight)
    falling = weight[drift <= -GLIDE_CENTS].sum() - weight[drift >= GLIDE_CENTS].sum()
    return float(falling / weight.sum())


def hit_spans(energy: np.ndarray, found: np.ndarray) -> list[tuple[int, int, int]]:
    """
    (start, loudest, end) frames of each hit in a per-frame `energy`, from the onsets `found`.
    onset_detect marks a hit 1-1.7 frames after it starts, so a hit's loudest frame is looked
    for from PEAK_SEARCH_FRAMES before its onset to the onset. A hit runs from the quietest frame
    between the loudest frame of the hit before and its own (the first hit: within
    PEAK_SEARCH_FRAMES + SUSTAIN_FRAMES before its loudest frame) to the quietest frame before
    the next hit's loudest; the last runs to the end. Onsets that share a loudest frame are one
    hit.
    """
    loudest = sorted(
        {
            int(lo + np.argmax(energy[lo : o + 1]))
            for o in found
            for lo in [max(0, int(o) - PEAK_SEARCH_FRAMES)]
        }
    )
    if not loudest:
        return []
    first = max(0, loudest[0] - PEAK_SEARCH_FRAMES - SUSTAIN_FRAMES)
    quiet = [
        int(a + np.argmin(energy[a:b])) for a, b in zip(loudest[:-1], loudest[1:], strict=True)
    ]
    starts = [int(first + np.argmin(energy[first : loudest[0] + 1])), *quiet]
    ends = [*quiet, energy.size]
    return list(zip(starts, loudest, ends, strict=True))


def decaying_lines(signals) -> float | None:
    """
    The share of the hits' harmonic-part energy that comes SUSTAIN_FRAMES or more after each
    hit's loudest frame (hit_spans).
    """
    energy = (np.abs(signals.harmonic_stft) ** 2).sum(axis=0)
    late = total = 0.0
    for start, loudest, end in hit_spans(energy, onsets(signals)):
        late += float(energy[loudest + SUSTAIN_FRAMES : end].sum())
        total += float(energy[start:end].sum())
    return late / total if total > 0 else None


def _cents(hz: np.ndarray, reference) -> np.ndarray:
    return 1200 * np.log2(np.maximum(hz, 1e-6) / np.maximum(reference, 1e-6))


def hit_peaks(signals):
    """
    Per hit whose frames GLIDE_FRAMES both come before the next onset: the Hz and energy of the
    harmonic part's peaks in the first frame, and the Hz of those in the second.
    """
    stft, sr, hop = signals.harmonic_stft, signals.sr, signals.hop
    magnitude, hz = np.abs(stft), instantaneous_hz(stft, sr, hop)
    n_fft = 2 * (stft.shape[0] - 1)
    lo, hi = int(30 * n_fft / sr) + 1, int(5000 * n_fft / sr)
    found = onsets(signals)
    if not found.size:
        return
    ends = np.append(found[1:], stft.shape[1])
    for onset, end in zip(found, ends, strict=True):
        a, b = onset + GLIDE_FRAMES[0], onset + GLIDE_FRAMES[1]
        if b >= min(end, stft.shape[1]):
            continue
        first = _peaks(magnitude[:, a], lo, hi)
        first_hz, energy = hz[first, a], magnitude[first, a] ** 2
        audible = np.isfinite(first_hz) & (first_hz > 20)
        if not audible.any():
            continue
        later_hz = hz[_peaks(magnitude[:, b], lo, hi), b]
        yield first_hz[audible], energy[audible], later_hz[np.isfinite(later_hz)]


def membrane_modes(signals) -> float | None:
    """
    Per hit, with each of the MODE_REFERENCES strongest peaks as a reference (itself left out):
    the largest share of the other peaks' energy near MEMBRANE_RATIOS times the reference, minus
    the largest share near its whole multiples from 2x; the mean over hits, weighted by energy.
    """
    shares, weights = [], []
    for hz, energy, _ in hit_peaks(signals):
        modes = multiples = 0.0
        for i in np.argsort(-energy)[:MODE_REFERENCES]:
            ratio = hz / hz[i]
            rest = np.abs(_cents(ratio, 1.0)) > MODE_CENTS
            if not energy[rest].sum() > 0:
                continue
            near_mode = np.any([np.abs(_cents(ratio, m)) <= MODE_CENTS for m in MEMBRANE_RATIOS], 0)
            near_multiple = (ratio >= 1.5) & (np.abs(_cents(ratio, np.round(ratio))) <= MODE_CENTS)
            modes = max(modes, float(energy[near_mode & rest].sum() / energy[rest].sum()))
            multiples = max(
                multiples, float(energy[near_multiple & rest].sum() / energy[rest].sum())
            )
        shares.append(modes - multiples)
        weights.append(float(energy.sum()))
    return float(np.average(shares, weights=weights)) if weights else None


def falling_partial(signals) -> float | None:
    """The median over hits of the strongest peak's move to the nearest later peak, in cents."""
    moves = []
    for hz, energy, later in hit_peaks(signals):
        if later.size:
            cents = _cents(later, hz[int(np.argmax(energy))])
            moves.append(float(cents[int(np.argmin(np.abs(cents)))]))
    return float(np.median(moves)) if moves else None


def pitch_jumps(signals) -> float | None:
    voice = signals.voice
    return None if voice is None else float(voice.vibrato_cents)


def checked(signals) -> dict:
    """
    What reproduce() checks against the report: the evidence rules' verdict, the single-source
    evidence and each estimator's key ((tonic, mode, strength) or None).
    """
    from evals_audio import service

    _, E = service.load()
    withheld = signals.key_withheld()
    source = signals.source_evidence
    keys = {}
    for est in ESTIMATORS:
        key = E.select_estimator(est).key(signals)
        keys[est] = None if key is None else (key.tonic, key.mode, key.strength)
    return {
        "withheld": None if withheld is None else withheld.code,
        "source": [source.bins, source.movement, source.shared, source.depth],
        "keys": keys,
    }


def measure(signals) -> dict:
    """checked(), and the measurements."""
    return {
        **checked(signals),
        "gliding partials": gliding_partials(signals),
        "decaying lines": decaying_lines(signals),
        "a pitch line that jumps between hits": pitch_jumps(signals),
        "membrane modes": membrane_modes(signals),
        "a falling strongest partial": falling_partial(signals),
        "tonal ratio": float(signals.tonality.tonal_ratio),
    }


# --- the work ----------------------------------------------------------------------------------

_CONTROLS: dict = {}
_CLIPS: dict = {}


def _cap_threads() -> None:
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(var, "1")


def signals_of(item: tuple[str, str, int, str]):
    """One served control or clip, made again and decoded as its run did (in a worker)."""
    from evals_audio import clips, datasets, service
    from evals_audio import controls as C

    kind, name, seed, data_dir = item
    if kind == "control":
        if not _CONTROLS:
            _CONTROLS.update({c.name: c for c in C.controls()})
        # Written and decoded as the controls suite does (some controls are MP3s).
        with tempfile.TemporaryDirectory(prefix="drum-rules-") as tmp:
            return service.decode_file(C.write(_CONTROLS[name], tmp))
    spec = datasets.DATASETS[DATASET]
    home = Path(data_dir) / spec.mirdata_name
    if not _CLIPS:
        refs = datasets.references(spec, home)
        _CLIPS.update({datasets.public_id(spec, r.track_id): r for r in refs})
    ref = _CLIPS[name]
    wav, _ = clips.read_clip(str(home / ref.audio_rel), seed, DATASET, ref.track_id)
    return service.decode(wav)


def analyse(item: tuple[str, str, int, str]) -> dict:
    """One served control or clip, made again and measured (in a worker)."""
    return measure(signals_of(item))


def reproduce(rows: list[dict], measured: dict) -> int:
    """
    Check every row against the report before anything is reported: no evidence rule withholds
    its key; the single-source evidence is the one recorded; each estimator serves the key it
    served, at the strength recorded with the rules lifted, and none where it served none.
    Exits on the first row that differs. Returns how many rows were checked.
    """

    def refuse(row: dict, what: str) -> None:
        raise SystemExit(f"{row['name']}: {what} differs from the report; nothing is reported")

    for row in rows:
        got = measured[row["name"]]
        if got["withheld"] is not None:
            refuse(row, f"the key withheld as {got['withheld']}")
        source = row["source"]
        if source is None:
            refuse(row, "the single-source evidence (none recorded)")
        recorded = [source["bins"], source["movement"], source["shared"], source["depth"]]
        if got["source"][0] != recorded[0] or not np.allclose(
            got["source"][1:], recorded[1:], rtol=1e-6, atol=1e-9
        ):
            refuse(row, "the single-source evidence")
        for est in ESTIMATORS:
            key, served, estimate = got["keys"][est], row["served"][est], row["estimates"][est]
            if (key is None) != (served is None):
                refuse(row, f"{est}'s key served or withheld")
            if key is None:
                continue
            if key[:2] != served or estimate is None or key[:2] != estimate[:2]:
                refuse(row, f"{est}'s key")
            if not np.isclose(key[2], estimate[2], rtol=1e-5, atol=1e-6):
                refuse(row, f"{est}'s key strength")
    return len(rows)


GRIDS = ("detuned-third", "soft-third", "seventh", "sus2", "sus4")


def _group(control: dict) -> str:
    """A seeded control's family, a grid's name, or the control's group."""
    m = FAMILY.match(control["name"])
    if m:
        return m["family"]
    grid = next((g for g in GRIDS if control["name"].startswith(f"{g}-")), None)
    return grid or control["group"]


def halves(rows: list[dict]) -> dict[str, str]:
    """
    {name: "training" or "held out"}: a seeded control by its seed (TRAINING_SEEDS); the
    unseeded controls and the clips, sorted by name, alternately.
    """
    unseeded = sorted(r["name"] for r in rows if not FAMILY.match(r["name"]))
    out = {name: ("training", "held out")[i % 2] for i, name in enumerate(unseeded)}
    for r in rows:
        m = FAMILY.match(r["name"])
        if m:
            seed = int(m["seed"])
            training = any(seed in span for span in TRAINING_SEEDS)
            out[r["name"]] = "training" if training else "held out"
    return out


def _value(measured: dict, name: str, measure: str) -> float:
    """The measurement signed so that a rule withholds at or above its threshold."""
    value = measured[name][measure]
    if value is None or np.isnan(value):
        return -np.inf
    return MEASURES.get(measure, 1) * value


def withholds(measured: dict, name: str, rule: tuple[str, dict]) -> bool:
    """rule: ("any" or "all", {measurement: signed threshold})."""
    how, thresholds = rule
    passed = [_value(measured, name, m) >= t for m, t in thresholds.items()]
    return any(passed) if how == "any" else all(passed)


def _right(row: dict) -> bool:
    return row["drum"] is None and any(ok for _, ok in row["keys"].values())


def _drum_counts(
    rows: list[dict], measured: dict, rule: tuple[str, dict], families: tuple[str, ...] = DRUMS
) -> dict:
    """{estimator: {(family, span): (withheld, served)}}, for each of `families`."""
    out: dict = {}
    for est in ESTIMATORS:
        out[est] = {}
        for family in families:
            for span in SPANS:
                served = [r for r in rows if r["drum"] == (family, span) and r["keys"][est][0]]
                hit = [r for r in served if withholds(measured, r["name"], rule)]
                out[est][(family, span)] = (len(hit), len(served))
    return out


def _costs(rows: list[dict], measured: dict, rule: tuple[str, dict]) -> dict:
    """
    {estimator: {group: (right keys withheld, keys withheld)}} over every served row that is
    not a drum: the controls by group of families, and the clips.
    """
    out: dict = {}
    for est in ESTIMATORS:
        out[est] = {}
        for r in rows:
            served, right = r["keys"][est]
            if r["drum"] is not None or not served:
                continue
            if not withholds(measured, r["name"], rule):
                continue
            lost_right, lost = out[est].get(r["group"], (0, 0))
            out[est][r["group"]] = (lost_right + right, lost + 1)
    return out


def _gap(drums: list[float], right: list[float]) -> tuple[float, float] | None:
    """
    The middle of the gap between the highest right value and the next drum value above it,
    with that right value; None when no drum value lies above it.
    """
    top = max(right, default=-np.inf)
    above = sorted(v for v in drums if v > top)
    if not above:
        return None
    return (above[0] - 1e-9 if top == -np.inf else (top + above[0]) / 2), top


def _free(rows: list[dict], measured: dict, candidate: tuple) -> dict | None:
    """
    The thresholds of a candidate that withhold no right key of `rows` (the training half), or
    None: {measurement: (signed threshold, signed value of the most drum-like right key, or
    None for the first of an "all")}.
    """
    how, measures, aimed = candidate
    drums = [r for r in rows if r["drum"] and (aimed is None or r["drum"][0] in aimed)]
    right = [r for r in rows if _right(r)]

    def values(of: list[dict], measure: str) -> list[float]:
        return [_value(measured, r["name"], measure) for r in of]

    if how == "any":
        gaps = {m: _gap(values(drums, m), values(right, m)) for m in measures}
        return {m: g for m, g in gaps.items() if g is not None} or None
    first, second = measures
    best = None
    for a in sorted(set(values(drums, first)) - {-np.inf}):
        g = _gap(
            values([r for r in drums if _value(measured, r["name"], first) >= a], second),
            values([r for r in right if _value(measured, r["name"], first) >= a], second),
        )
        if g is None:
            continue
        below = [v for v in values(rows, first) if v < a and v > -np.inf]
        start = (a + max(below)) / 2 if below else a
        rule = ("all", {first: start, second: g[0]})
        if any(withholds(measured, r["name"], rule) for r in right):
            continue
        n = sum(withholds(measured, r["name"], rule) for r in drums)
        if best is None or n > best[0]:
            best = (n, {first: (start, None), second: g})
    return None if best is None else best[1]


def candidates(
    rows: list[dict],
    measured: dict,
    table: dict | None = None,
    families: tuple[str, ...] = DRUMS,
) -> dict:
    """
    Per candidate (of `table`, CANDIDATES by default), thresholds chosen on the training half
    (halves): "free", those that withhold no right key there ({measurement: (signed threshold,
    most drum-like right value)}), and for a single measurement "most", the strictest one (from
    the highest value of a drum it is aimed at down) that withholds more than half of the
    training keys of the drums it is aimed at, with each estimator that served one. For each,
    the counts of every family in `families` ("...Drums") and per half the costs ("...Costs").
    """
    half = halves(rows)
    parts = {h: [r for r in rows if half[r["name"]] == h] for h in ("training", "held out")}

    def judged(rule: tuple[str, dict]) -> dict:
        return {
            "drums": _drum_counts(rows, measured, rule, families),
            "costs": {h: _costs(part, measured, rule) for h, part in parts.items()},
        }

    out = {}
    for name, candidate in (CANDIDATES if table is None else table).items():
        how, measures, aimed = candidate
        free = _free(parts["training"], measured, candidate)
        entry = {"free": free, "most": None}
        if free is not None:
            entry["freeRule"] = (how, {m: t for m, (t, _) in free.items()})
            entry.update({"free" + k.title(): v for k, v in judged(entry["freeRule"]).items()})
        if len(measures) == 1:
            (measure,) = measures
            training = [
                r
                for r in parts["training"]
                if r["drum"] and (aimed is None or r["drum"][0] in aimed)
            ]
            for value in sorted(
                {_value(measured, r["name"], measure) for r in training} - {-np.inf},
                reverse=True,
            ):
                counts = _drum_counts(training, measured, ("any", {measure: value}), families)
                if all(
                    2 * sum(h for h, _ in c.values()) > sum(n for _, n in c.values())
                    for c in counts.values()
                    if sum(n for _, n in c.values())
                ):
                    entry["most"] = value
                    entry.update(
                        {
                            "most" + k.title(): v
                            for k, v in judged(("any", {measure: value})).items()
                        }
                    )
                    break
        out[name] = entry
    return out


def time_test(rows: list[dict], values: dict) -> dict:
    """Per drum family and span: why the served drums' lines fail the single-source time test."""
    out: dict = {}
    for r in rows:
        if r["drum"] is None:
            continue
        s = r["source"]
        failed = [
            name
            for name, ok in (
                ("bins", s["bins"] >= values["minBins"]),
                ("movement", s["movement"] <= values["maxMovement"]),
                ("shared", s["shared"] >= values["minShared"]),
                ("depth", s["depth"] >= values["minDepth"]),
            )
            if not ok
        ]
        reason = "+".join(failed) if failed else ("still, spell a chord" if s["chord"] else "still")
        counts = out.setdefault(r["drum"], {})
        counts[reason] = counts.get(reason, 0) + 1
    return out


def _fmt_drums(counts: dict) -> str:
    return "; ".join(
        f"{est} "
        + ", ".join(f"{f} {s} {h}/{n}" for (f, s), (h, n) in c.items())
        + f" (all {sum(h for h, _ in c.values())}/{sum(n for _, n in c.values())})"
        for est, c in counts.items()
    )


def _fmt_costs(costs: dict) -> str:
    return "; ".join(
        f"{est} " + (", ".join(f"{g} {r} of {n}" for g, (r, n) in sorted(c.items())) or "none")
        for est, c in costs.items()
    )


def _fmt_threshold(measure: str, signed: float) -> str:
    """The threshold as the measurement is defined (MEASURES gives the side that is withheld)."""
    side = "at or above" if MEASURES[measure] > 0 else "at or under"
    return f"{measure} {side} {MEASURES[measure] * signed:.4g}"


def _right_keys(rows: list[dict]) -> str:
    clips = [r for r in rows if r["kind"] == "clip"]
    return ", ".join(f"{est} {sum(r['keys'][est][1] for r in clips)}" for est in ESTIMATORS)


def _print_judged(entry: dict, prefix: str) -> None:
    print(f"    drum keys withheld: {_fmt_drums(entry[prefix + 'Drums'])}")
    for half, costs in entry[prefix + "Costs"].items():
        print(f"    right keys taken, {half} (of keys withheld): {_fmt_costs(costs)}")


def report(rows: list[dict], measured: dict) -> None:
    half = halves(rows)
    for h in ("training", "held out"):
        part = [r for r in rows if half[r["name"]] == h]
        print(
            f"{h}: {sum(r['drum'] is not None for r in part)} drums, "
            f"{sum(_right(r) for r in part)} other rows with a right key "
            f"({sum(r['kind'] == 'clip' for r in part)} clips)"
        )
    for name, entry in candidates(rows, measured).items():
        print(f"\n{name}:")
        free = entry["free"]
        if free is None:
            print("  no threshold withholds a training drum key without a right one")
        else:
            how = " or " if entry["freeRule"][0] == "any" else " and "
            print(
                "  no right key of the training half taken at "
                + how.join(_fmt_threshold(m, t) for m, (t, _) in free.items())
            )
            among = " among the rows the first takes" if how == " and " else ""
            for m, (_, top) in free.items():
                if top is not None:
                    shown = "none" if top == -np.inf else f"{MEASURES[m] * top:.4g}"
                    print(f"    (the most drum-like right key there{among}, {m}: {shown})")
            _print_judged(entry, "free")
        if len(CANDIDATES[name][1]) == 1:
            if entry["most"] is None:
                print("  no threshold withholds more than half of the training drum keys")
            else:
                (m,) = CANDIDATES[name][1]
                most = _fmt_threshold(m, entry["most"])
                print(f"  more than half of the training drum keys: {most}")
                _print_judged(entry, "most")


def main() -> None:
    from evals_audio import datasets

    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("results", nargs="?", type=Path)
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument(
        "--data-dir",
        default=os.environ.get("LINER_NOTES_DATA", str(Path.home() / "liner-notes-data")),
    )
    args = p.parse_args()
    name, controls_run, key_run, calibration_run = newest(args.results)
    print(
        f"{name}: controls run on commit {controls_run['gitCommit']}, GiantSteps+ key and "
        f"calibration runs on commits {key_run['gitCommit']} and {calibration_run['gitCommit']}, "
        f"analyzer {controls_run['analyzerVersion']}"
    )
    rows = served_rows(controls_run, key_run, calibration_run)
    # The index and the audio are checked here, not ten minutes in.
    spec = datasets.DATASETS[DATASET]
    home = Path(args.data_dir) / spec.mirdata_name
    try:
        refs = {datasets.public_id(spec, r.track_id): r for r in datasets.references(spec, home)}
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(
            f"GiantSteps+ index or annotations not readable under {home}: {error}"
        ) from None
    clips = [r for r in rows if r["kind"] == "clip"]
    missing = [r["name"] for r in clips if not (home / refs[r["name"]].audio_rel).is_file()]
    if missing:
        raise SystemExit(f"GiantSteps+ audio missing under {home}: {', '.join(missing)}")
    print(
        f"{len(clips)} of {len(key_run['tracks'][ESTIMATORS[0]])} GiantSteps+ clips served a key; "
        f"right keys among them: {_right_keys(rows)}"
    )
    seed = key_run["seeds"]["clips"]
    items = [(r["kind"], r["name"], seed, args.data_dir) for r in rows]
    # The workers inherit the thread caps: set here, they hold before a worker imports numpy.
    _cap_threads()
    with ProcessPoolExecutor(args.jobs, mp_context=get_context("spawn")) as pool:
        results = list(pool.map(analyse, items, chunksize=4))
    measured = dict(zip([r["name"] for r in rows], results, strict=True))
    checked = reproduce(rows, measured)
    print(f"reproduced: {checked} served controls and clips")
    print("\nwhy the served drums' lines fail the single-source time test:")
    failing = time_test(rows, controls_run["rules"]["one_source"])
    for (family, span), counts in sorted(failing.items()):
        print(f"  {family}, {span}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    print()
    report(rows, measured)


if __name__ == "__main__":
    main()
