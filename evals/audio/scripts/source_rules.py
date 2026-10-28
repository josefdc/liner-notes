"""
Two rules that could withhold a tubular bell's key, measured on the newest committed controls
run: what each would separate, and what the one tried for analyzer 2.3.5 would cost. Neither
is shipped (services/audio/README.md states the tubular bell as a limit).

- **Off the grid**: the share of note pairs, among the notes a still control spells, whose
  interval is more than 20 cents off the equal-tempered semitones. Read from the run's
  recorded evidence (`evidence.source.notes`); no audio is analysed.
- **Few harmonics** (tried for 2.3.5): the share of the level of the lines from
  SOURCE_NOTE_FLOOR up that are overtones of the notes they spell. The service no longer
  records it, so it is measured again here on each still control that spells a chord, from
  the control's signal, by the service's own line histogram and overtone test. 2.3.5 took one
  pitched source when the share was at most 0.1, so a control whose served key was right
  loses it then.

    uv run python scripts/source_rules.py [evals/reports/audio-<date>.json] [--jobs J]

Prints one line per family and seed range; nothing is written. Deterministic: the controls are
drawn from their seeds.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

import numpy as np

REPORTS = Path(__file__).resolve().parents[2] / "reports"
FEW_HARMONICS = 0.1  # the 2.3.5 value (SOURCE_MAX_HARMONICS, not shipped)
OFF_GRID_CENTS = 20.0
FAMILIES = re.compile(r"^(?P<family>.+)-s(?P<seed>\d+)$")


def newest_controls(path: Path | None) -> tuple[str, dict]:
    paths = [path] if path else sorted(REPORTS.glob("audio-*.json"))
    runs = [
        (p.name, run)
        for p in paths
        for run in json.loads(p.read_text())["runs"]
        if run["suite"] == "controls"
    ]
    return max(runs, key=lambda item: item[1]["startedAt"])


def still(source: dict, values: dict) -> bool:
    return (
        source["bins"] >= values["minBins"]
        and source["movement"] <= values["maxMovement"]
        and source["shared"] >= values["minShared"]
        and source["depth"] >= values["minDepth"]
    )


def off_grid(notes: list[float]) -> float:
    """The share of note pairs more than OFF_GRID_CENTS off the equal-tempered semitones."""
    pairs = [(a, b) for i, a in enumerate(notes) for b in notes[i + 1 :]]
    off = [abs((1200 * math.log2(b / a)) % 100 - 50) < 50 - OFF_GRID_CENTS for a, b in pairs]
    return sum(off) / len(off)


def harmonics_share(name: str) -> float:
    """The 2.3.5 share for one control: overtones' level over the level of the lines."""
    from evals_audio import controls as C
    from evals_audio import service

    _, E = service.load()
    control = next(c for c in C.controls() if c.name == name)
    s = E.Signals(np.asarray(control.make(), dtype=np.float32), 22050)
    stft, sr, hop = s.harmonic_stft, s.sr, s.hop
    lo, hi = E.SERIES_LOW_HZ, E.HARMONIC_MAX_HZ
    n_fft = 2 * (stft.shape[0] - 1)
    rows = int(min(stft.shape[0], np.ceil(hi * n_fft / sr) + 2))
    spectrum = stft[:rows]
    k = np.arange(rows)[:, None]
    advance = np.angle(spectrum[:, 1:]) - np.angle(spectrum[:, :-1]) - 2 * np.pi * k * hop / n_fft
    advance = (advance + np.pi) % (2 * np.pi) - np.pi
    freqs = (k + advance * n_fft / (2 * np.pi * hop)) * sr / n_fft
    magnitude = np.abs(spectrum)
    weight = np.sqrt(magnitude[:, 1:] * magnitude[:, :-1])
    vote = (weight > 1e-3 * weight.max()) & (freqs >= lo) & (freqs <= hi)
    position = 1200 * np.log2(freqs[vote] / lo) / E.SOURCE_NOTE_CENTS_BIN
    size = int(1200 * np.log2(hi / lo) / E.SOURCE_NOTE_CENTS_BIN) + 1
    histogram = np.bincount(position.astype(int), weights=weight[vote], minlength=size)
    import scipy.ndimage
    import scipy.signal

    smooth = scipy.ndimage.gaussian_filter1d(histogram, 2.0)
    found, _ = scipy.signal.find_peaks(smooth, prominence=0.01 * smooth.max())
    lines = [
        (
            lo * 2 ** ((i + 0.5) * E.SOURCE_NOTE_CENTS_BIN / 1200),
            float(histogram[max(0, i - 7) : i + 8].sum()),
        )
        for i in found
    ]
    kept: list[tuple[float, float]] = []
    for f, a in sorted(lines, key=lambda line: -line[1]):
        if all(E._cents(f, g) > E.SOURCE_NOTE_MERGE_CENTS for g, _ in kept):
            kept.append((f, a))
    strongest = kept[0][1]
    notes: list[tuple[float, float]] = []
    level = folded = 0.0
    for f, a in sorted(kept):
        if a < E.SOURCE_NOTE_FLOOR * strongest:
            continue
        level += a
        if any(E._overtone(f, a, f0, a0, strongest) for f0, a0 in notes):
            folded += a
        else:
            notes.append((f, a))
    return folded / level


def _init() -> None:
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(var, "1")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("results", nargs="?", type=Path)
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument("--only", default="", help="a regular expression on the family names")
    args = p.parse_args()
    name, run = newest_controls(args.results)
    values = run["rules"]["one_source"]
    print(f"{name}: controls run of {run['startedAt']}, analyzer {run['analyzerVersion']}")
    rows = []
    for c in run["controls"]:
        m = FAMILIES.match(c["name"])
        source = c["evidence"].get("source") or {}
        if not m or not source.get("notes") or not still(source, values):
            continue
        if not re.search(args.only, m["family"]):
            continue
        seed = int(m["seed"])
        span = {5: "500-529", 6: "600-629", 7: "700-729", 8: "800-829"}.get(seed // 100)
        truth = c["truth"]["key"]
        served = {
            est: (c["estimators"][est]["key"] or {}).get("served")
            for est in ("essentia", "librosa")
        }
        keys = {
            est: (
                served[est] is not None,
                isinstance(truth, list) and list(served[est] or ()) == truth,
            )
            for est in served
        }
        rows.append((m["family"], span, c["name"], source, keys))
    detuned = [
        (c["name"], c["evidence"]["source"])
        for c in run["controls"]
        if c["name"].startswith("detuned-third-")
        and (c["evidence"].get("source") or {}).get("notes")
        and still(c["evidence"]["source"], values)
    ]
    chords = [r[2] for r in rows if r[3].get("chord")]
    _init()
    with ProcessPoolExecutor(args.jobs, mp_context=get_context("spawn"), initializer=_init) as pool:
        share = dict(zip(chords, pool.map(harmonics_share, chords, chunksize=2), strict=True))

    def spread(values: list[float]) -> str:
        if not values:
            return "-"
        return f"{min(values):.2f}-{max(values):.2f} (median {statistics.median(values):.2f})"

    print(
        f"\nfamily, seeds: still controls with notes; off the grid (>{OFF_GRID_CENTS:g} c); "
        f"harmonics share of those that spell a chord; the served keys a share <= {FEW_HARMONICS} "
        "would withhold, and how many of them are right (Essentia / librosa)"
    )
    for family, span in sorted({(r[0], r[1]) for r in rows}):
        group = [r for r in rows if r[0] == family and r[1] == span]
        offs = [off_grid(r[3]["notes"]) for r in group if len(r[3]["notes"]) > 1]
        shares = [share[r[2]] for r in group if r[2] in share]
        taken = [r for r in group if r[2] in share and share[r[2]] <= FEW_HARMONICS]
        lost = " / ".join(
            f"{sum(r[4][est][0] for r in taken)} (right {sum(r[4][est][1] for r in taken)})"
            for est in ("essentia", "librosa")
        )
        print(
            f"{family}, {span}: {len(group)}; off the grid {spread(offs)}; harmonics "
            f"{spread(shares)}; keys it would withhold {lost}"
        )
    offs = {n: off_grid(s["notes"]) for n, s in detuned if len(s["notes"]) > 1}
    print(
        f"detuned thirds (10-25 c, still): {len(offs)}; off the grid {spread(list(offs.values()))};"
        f" at 25 c: {spread([v for n, v in offs.items() if n.endswith('25')])}"
    )


if __name__ == "__main__":
    main()
