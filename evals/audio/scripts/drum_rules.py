"""
Three rules that could withhold the keys of pitched drums (toms, two rack toms and a floor tom
over a kit, tabla), measured on the newest committed report: how many drum keys each would
withhold, and how many right keys it would take from every other control and from the
GiantSteps+ clips. None is shipped (services/audio/README.md states drums as a limit).

A rule placed after the others can only withhold a key that is served, so only the served
controls and clips are analysed: every control the controls run served a key with either
estimator (the drums at 500-529 and 600-629 among them) and every clip the GiantSteps+ key run
served. Each is made again (controls from their seeds, clips from the local GiantSteps+ audio,
cut at the run's clip seed), then decoded and analysed by the service; reproduce() checks first
that the service lets each key through as the run recorded and measures the single-source
evidence the run recorded.

- **Gliding partials**: at each onset, the spectral peaks of the harmonic part one frame after
  it are followed to the nearest peak three frames (70 ms) later. The share of their energy
  that falls by more than GLIDE_CENTS, minus the share that rises by as much: a struck membrane
  falls in pitch just after the hit, a chord holds still, a vibrato goes both ways.
- **Decaying lines**: the share of each hit's harmonic-part energy that comes more than three
  frames after its onset, over all hits (low: every line dies away right after its onset).
- **A pitch line that jumps between hits**: the pitch track's spread around its smoothed line
  (Voice.vibrato_cents, 90th percentile): one drum after another sets the tracker hopping
  between their pitches.

For each, it prints the least strict threshold that takes no right key (chosen on all the data,
held-out seeds and GiantSteps+ included, so the most favourable one) with the drum keys it
withholds, and the threshold that withholds more than half of the drum keys with both
estimators with the right keys it takes.

    cd evals/audio && uv run python scripts/drum_rules.py [../reports/audio-<date>.json] [--jobs J]

Needs the GiantSteps+ audio on disk (--data-dir, as the harness; nothing is downloaded) and
mirdata's index in this environment. Nothing is written. Deterministic.
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
ESTIMATORS = ("essentia", "librosa")
FAMILY = re.compile(r"^(?P<family>.+)-s(?P<seed>\d+)$")
GLIDE_CENTS = 15.0
GLIDE_FRAMES = (1, 4)  # frames after the onset where the peaks are compared
PEAK_LEVEL = 0.1  # peaks from this share of the frame's strongest, 30 Hz-5 kHz
GLIDE_MATCH_CENTS = 300.0  # a peak is followed to the nearest one within this
SUSTAIN_FRAMES = 3
CANDIDATES = ("gliding partials", "decaying lines", "a pitch line that jumps between hits")


def newest(path: Path | None) -> tuple[str, dict, dict]:
    """The report's controls run and GiantSteps+ key run (the newest report that holds both)."""
    for p in [path] if path else sorted(REPORTS.glob("audio-*.json"), reverse=True):
        runs = json.loads(p.read_text())["runs"]
        controls = [r for r in runs if r["suite"] == "controls"]
        key = [r for r in runs if r["suite"] == "key" and r["dataset"]["name"] == DATASET]
        if controls and key:
            return p.name, controls[0], key[0]
    raise SystemExit("no report holds a controls run and a GiantSteps+ key run")


def drum(name: str) -> tuple[str, str] | None:
    """(family, seed span) of a drum control, or None."""
    m = FAMILY.match(name)
    if not m or m["family"] not in DRUMS:
        return None
    span = next((s for s, seeds in SPANS.items() if int(m["seed"]) in seeds), None)
    return (m["family"], span) if span else None


def served_rows(controls_run: dict, key_run: dict) -> list[dict]:
    """
    One row per served control or clip: its name, kind ("control" or "clip"), drum family and
    span (or None), and per estimator (served, right). A control's key is right when it is
    its truth, or any key for the controls whose truth is "any key"; a clip's when the key run
    scored it exact.
    """
    rows = []
    for c in controls_run["controls"]:
        truth = c["truth"]["key"]
        keys = {}
        for est in ESTIMATORS:
            served = ((c["estimators"].get(est) or {}).get("key") or {}).get("served")
            keys[est] = (
                served is not None,
                served is not None and (truth == "any key" or list(served) == truth),
            )
        if any(s for s, _ in keys.values()):
            rows.append(
                {
                    "name": c["name"],
                    "kind": "control",
                    "drum": drum(c["name"]),
                    "group": _group(c),
                    "keys": keys,
                    "source": (c["evidence"] or {}).get("source"),
                }
            )
    tracks = {est: {r["trackId"]: r for r in key_run["tracks"][est]} for est in ESTIMATORS}
    for tid in sorted(tracks[ESTIMATORS[0]]):
        keys = {}
        for est in ESTIMATORS:
            row = tracks[est][tid]
            served = not row["withheld"]
            keys[est] = (served, served and row["scores"]["exact"] == 1)
        if any(s for s, _ in keys.values()):
            rows.append(
                {
                    "name": tid,
                    "kind": "clip",
                    "drum": None,
                    "group": "GiantSteps+",
                    "keys": keys,
                    "source": None,
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


def decaying_lines(signals) -> float | None:
    """Share of the hits' harmonic-part energy more than SUSTAIN_FRAMES after their onsets."""
    stft = signals.harmonic_stft
    found = onsets(signals)
    if not found.size:
        return None
    ends = np.append(found[1:], stft.shape[1])
    late = total = 0.0
    for onset, end in zip(found, ends, strict=True):
        energy = np.abs(stft[:, onset:end]) ** 2
        if energy.shape[1] >= SUSTAIN_FRAMES:
            late += float(energy[:, SUSTAIN_FRAMES:].sum())
            total += float(energy.sum())
    return late / total if total > 0 else None


def pitch_jumps(signals) -> float | None:
    voice = signals.voice
    return None if voice is None else float(voice.vibrato_cents)


def measure(signals) -> dict:
    """The evidence rules' verdict, the single-source evidence and the three measurements."""
    withheld = signals.key_withheld()
    source = signals.source_evidence
    return {
        "withheld": None if withheld is None else withheld.code,
        "source": [source.bins, source.movement, source.shared, source.depth],
        "gliding partials": gliding_partials(signals),
        # A rule withholds at or above its threshold, so the decaying share is negated.
        "decaying lines": (lambda v: None if v is None else -v)(decaying_lines(signals)),
        "a pitch line that jumps between hits": pitch_jumps(signals),
    }


# --- the work ----------------------------------------------------------------------------------

_CONTROLS: dict = {}
_CLIPS: dict = {}


def _init() -> None:
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(var, "1")


def analyse(item: tuple[str, str, int, str]) -> dict:
    """One served control or clip, made again and measured (in a worker)."""
    from evals_audio import clips, datasets, service
    from evals_audio import controls as C

    kind, name, seed, data_dir = item
    if kind == "control":
        if not _CONTROLS:
            _CONTROLS.update({c.name: c for c in C.controls()})
        # Written and decoded as the controls suite does (some controls are MP3s).
        with tempfile.TemporaryDirectory(prefix="drum-rules-") as tmp:
            signals = service.decode_file(C.write(_CONTROLS[name], tmp))
    else:
        spec = datasets.DATASETS[DATASET]
        home = Path(data_dir) / spec.mirdata_name
        if not _CLIPS:
            refs = datasets.references(spec, home)
            _CLIPS.update({datasets.public_id(spec, r.track_id): r for r in refs})
        ref = _CLIPS[name]
        wav, _ = clips.read_clip(str(home / ref.audio_rel), seed, DATASET, ref.track_id)
        signals = service.decode(wav)
    return measure(signals)


def reproduce(rows: list[dict], measured: dict) -> int:
    """
    Check that the service, as it is, lets every served key through (no evidence rule
    withholds it) and measures the single-source evidence the controls run recorded. Returns
    how many rows were checked.
    """
    for row in rows:
        got = measured[row["name"]]
        assert got["withheld"] is None, (row["name"], got["withheld"])
        source = row["source"]
        if source is not None:
            recorded = [source["bins"], source["movement"], source["shared"], source["depth"]]
            assert got["source"][0] == recorded[0], row["name"]
            assert np.allclose(got["source"][1:], recorded[1:], rtol=1e-6, atol=1e-9), row["name"]
    return len(rows)


def _drum_counts(rows: list[dict], measured: dict, rule: str, threshold: float) -> dict:
    """{estimator: {(family, span): (withheld, served)}} at `threshold` (withheld: value >= it)."""
    out: dict = {}
    for est in ESTIMATORS:
        out[est] = {}
        for family in DRUMS:
            for span in SPANS:
                served = [r for r in rows if r["drum"] == (family, span) and r["keys"][est][0]]
                hit = [r for r in served if _value(measured, r["name"], rule) >= threshold]
                out[est][(family, span)] = (len(hit), len(served))
    return out


def _costs(rows: list[dict], measured: dict, rule: str, threshold: float) -> dict:
    """
    {estimator: {group: (right keys withheld, keys withheld)}} at `threshold`, over every
    served row that is not a drum: the controls by group of families, and the clips.
    """
    out: dict = {}
    for est in ESTIMATORS:
        out[est] = {}
        for r in rows:
            served, right = r["keys"][est]
            if r["drum"] is not None or not served:
                continue
            if _value(measured, r["name"], rule) < threshold:
                continue
            lost_right, lost = out[est].get(r["group"], (0, 0))
            out[est][r["group"]] = (lost_right + right, lost + 1)
    return out


GRIDS = ("detuned-third", "soft-third", "seventh", "sus2", "sus4")


def _group(control: dict) -> str:
    """A seeded control's family, a grid's name, or the control's group."""
    m = FAMILY.match(control["name"])
    if m:
        return m["family"]
    grid = next((g for g in GRIDS if control["name"].startswith(f"{g}-")), None)
    return grid or control["group"]


def _value(measured: dict, name: str, rule: str) -> float:
    value = measured[name][rule]
    return -np.inf if value is None else value


def candidates(rows: list[dict], measured: dict) -> dict:
    """
    Per rule: the least strict threshold that takes no right key ("free", just above the
    highest value of a row with a right key: "highest", with its group and name) with its drum
    counts, and the least strict
    threshold that withholds more than half of the drum keys with each estimator ("most") with
    its drum counts and costs.
    """
    out = {}
    for rule in CANDIDATES:
        right = [
            (_value(measured, r["name"], rule), r["group"], r["name"])
            for r in rows
            if r["drum"] is None and any(ok for _, ok in r["keys"].values())
        ]
        highest = max(right)
        free = float(np.nextafter(highest[0], np.inf))
        values = sorted(
            {_value(measured, r["name"], rule) for r in rows if r["drum"]} - {-np.inf},
            reverse=True,
        )
        most = None
        for value in values:
            counts = _drum_counts(rows, measured, rule, value)
            if all(
                2 * sum(h for h, _ in c.values()) > sum(n for _, n in c.values())
                for c in counts.values()
            ):
                most = value
                break
        out[rule] = {
            "free": free,
            "highest": highest,
            "freeDrums": _drum_counts(rows, measured, rule, free),
            "freeCosts": _costs(rows, measured, rule, free),
            "most": most,
            "mostDrums": None if most is None else _drum_counts(rows, measured, rule, most),
            "mostCosts": None if most is None else _costs(rows, measured, rule, most),
        }
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


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("results", nargs="?", type=Path)
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument(
        "--data-dir",
        default=os.environ.get("LINER_NOTES_DATA", str(Path.home() / "liner-notes-data")),
    )
    args = p.parse_args()
    name, controls_run, key_run = newest(args.results)
    print(
        f"{name}: controls run on commit {controls_run['gitCommit']}, key run on commit "
        f"{key_run['gitCommit']}, analyzer {controls_run['analyzerVersion']}"
    )
    rows = served_rows(controls_run, key_run)
    seed = key_run["seeds"]["clips"]
    items = [(r["kind"], r["name"], seed, args.data_dir) for r in rows]
    with ProcessPoolExecutor(args.jobs, mp_context=get_context("spawn"), initializer=_init) as pool:
        results = list(pool.map(analyse, items, chunksize=4))
    measured = dict(zip([r["name"] for r in rows], results, strict=True))
    checked = reproduce(rows, measured)
    print(f"reproduced: {checked} served controls and clips")
    print("\nwhy the served drums' lines fail the single-source time test:")
    failing = time_test(rows, controls_run["rules"]["one_source"])
    for (family, span), counts in sorted(failing.items()):
        print(f"  {family}, {span}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    for rule, c in candidates(rows, measured).items():
        value, group, row = c["highest"]
        print(f"\n{rule}: takes no right key above {value:.3f} ({group} {row} has a right key)")
        print(f"  withholds there {_fmt_drums(c['freeDrums'])}")
        if c["most"] is None:
            print("  no threshold withholds more than half of the drum keys")
            continue
        print(f"  more than half of the drum keys from {c['most']:.3f} up:")
        print(f"  withholds there {_fmt_drums(c['mostDrums'])}")
        print(f"  right keys it takes there (of keys withheld): {_fmt_costs(c['mostCosts'])}")


if __name__ == "__main__":
    main()
