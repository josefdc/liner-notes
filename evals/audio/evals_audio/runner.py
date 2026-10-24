"""
Runs the service on each clip (in worker processes) and scores what it returns.

A worker cuts the clip, decodes it with the service's decoder, and calls the service's
`analyze_signals` once per estimator on the same decoded signals (they share the cached
representations). Scoring happens in the parent, against the references.
"""

from __future__ import annotations

import multiprocessing
import os
import sys
import tempfile
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
from functools import cache

from . import clips, service
from .metrics import Item, acc1, acc2, estimate, mirex_key_score, parse_key

MAX_JOBS = 4  # the box is shared
METRICS = {"tempo": ("acc1", "acc2"), "key": ("mirex", "exact")}
METRIC_LABELS = {"acc1": "Acc1", "acc2": "Acc2", "mirex": "MIREX", "exact": "exact"}
# One thread per worker for the numeric libraries, so N workers use about N cores.
THREAD_ENV = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMBA_NUM_THREADS",
    "TF_NUM_INTRAOP_THREADS",
    "TF_NUM_INTEROP_THREADS",
)


@cache
def _estimators(names: tuple[str, ...]) -> dict:
    return {name: service.estimator(name) for name in names}


def analyze_track(task: tuple) -> dict:
    """One track: the clip window and, per estimator, the service's tempo/key/gate blocks."""
    dataset, track_id, path, seed, names = task
    try:
        with captured_stderr() as warnings:
            wav, window = clips.read_clip(path, seed, dataset, track_id)
            signals = service.decode(wav)
    except Exception as e:  # a broken file is recorded, not fatal
        return {"trackId": track_id, "error": f"{type(e).__name__}: {e}"}
    if warnings:
        window["decodeWarnings"] = warnings
    results = {}
    for name, est in _estimators(tuple(names)).items():
        try:
            v2 = service.analyze(signals, est)
            results[name] = {"gate": v2["gate"], "tempo": v2["tempo"], "key": v2["key"]}
            if v2["gate"]["passed"] and v2["tempo"] is None:
                # Why the service returned no tempo: the estimator gave none (too little
                # periodicity or confidence), or its tempo did not hold over the window. The
                # estimate the service did not return is kept apart, for calibration only.
                tempo = est.tempo(signals)
                results[name]["tempoWithheld"] = (
                    {"reason": "no estimate"}
                    if tempo is None
                    else {
                        "reason": "tempo does not hold over the window",
                        "bpm": round(float(tempo.bpm), 2),
                        "confidence": None
                        if tempo.confidence is None
                        else round(float(tempo.confidence), 3),
                    }
                )
            if v2["gate"]["passed"] and v2["key"] is None:
                # The service's own reason (cached on the signals); None means the estimator
                # itself returned nothing (e.g. a strength under KEY_MIN_STRENGTH).
                withheld = signals.key_withheld()
                results[name]["keyWithheld"] = None if withheld is None else str(withheld)
                if withheld is not None:
                    raw = service.key_without_evidence_rule(signals, est)
                    results[name]["keyUnreturned"] = (
                        None
                        if raw is None
                        else {
                            "tonic": raw.tonic,
                            "mode": raw.mode,
                            "strength": None if raw.strength is None else round(raw.strength, 3),
                        }
                    )
        except Exception as e:
            results[name] = {"error": f"{type(e).__name__}: {e}"}
    return {"trackId": track_id, "window": window, "results": results}


@contextmanager
def captured_stderr():
    """
    What the decoders write to the process's stderr (file descriptor 2, where libsndfile's
    mpg123 reports corrupt frames), as a list of distinct lines with their counts.
    """
    sys.stderr.flush()
    saved = os.dup(2)
    lines: list[str] = []
    with tempfile.TemporaryFile() as tmp:
        os.dup2(tmp.fileno(), 2)
        try:
            yield lines
        finally:
            sys.stderr.flush()
            os.dup2(saved, 2)
            os.close(saved)
            tmp.seek(0)
            text = tmp.read().decode("utf-8", "replace")
            counts = Counter(line.strip() for line in text.splitlines() if line.strip())
            lines.extend(f"{line} (x{n})" if n > 1 else line for line, n in counts.items())


def _worker_init(numba_cache: str) -> None:
    # Each worker compiles librosa's numba functions into its own cache directory, made for
    # this run. Workers sharing one cache (librosa's default, inside the environment) can
    # leave it in a state that crashes a later run with a segmentation fault.
    os.environ["NUMBA_CACHE_DIR"] = os.path.join(numba_cache, str(os.getpid()))
    service.load()


def analyze_all(tasks: list[tuple], jobs: int, progress=None) -> list[dict]:
    jobs = max(1, min(jobs, MAX_JOBS))
    for var in THREAD_ENV:
        os.environ.setdefault(var, "1")
    context = multiprocessing.get_context("spawn")
    out = []
    with (
        tempfile.TemporaryDirectory(prefix="evals-audio-numba-") as numba_cache,
        ProcessPoolExecutor(
            jobs, mp_context=context, initializer=_worker_init, initargs=(numba_cache,)
        ) as pool,
    ):
        for k, result in enumerate(pool.map(analyze_track, tasks), 1):
            out.append(result)
            if progress:
                progress(k, len(tasks))
    return out


def score(suite: str, reference, block: dict | None) -> tuple[float | None, dict | None, str]:
    """(confidence, scores, the estimate as text) for one answer; scores None when withheld."""
    if block is None:
        return None, None, "withheld"
    if suite == "tempo":
        bpm = float(block["bpm"])
        return (
            block.get("confidence"),
            {"acc1": float(acc1(bpm, reference)), "acc2": float(acc2(bpm, reference))},
            f"{bpm:g}",
        )
    estimate = parse_key(block["tonic"], block["mode"])
    s = mirex_key_score(estimate, reference)
    return block.get("strength"), {"mirex": s, "exact": float(s == 1.0)}, str(estimate)


def items_for(suite: str, refs: dict, analysed: list[dict], name: str) -> tuple[list, list]:
    """The scored Items for one estimator, and the per-track rows of the results file."""
    items, rows = [], []
    for record in analysed:
        tid = record["trackId"]
        reference = refs[tid].value
        result = record.get("results", {}).get(name)
        error = record.get("error") or (result or {}).get("error")
        if error:
            items.append(Item(tid, None, None, failed=True))
            rows.append({"trackId": tid, "failed": True, "error": error})
            continue
        block = result[suite]
        confidence, scores, text = score(suite, reference, block)
        items.append(Item(tid, confidence, scores))
        row = {
            "trackId": tid,
            "estimate": text if scores is not None else None,
            "confidence": confidence,
            "withheld": scores is None,
            "gate": result["gate"],
            "scores": scores,
        }
        if scores is None:
            row.update(withheld_detail(suite, reference, result))
        rows.append(row)
    return items, rows


def withheld_detail(suite: str, reference, result: dict) -> dict:
    """
    Why the service withheld the answer, and how the estimate it did not return scores (a
    tempo that did not hold over the window; a key the evidence rule stopped). The unreturned
    estimate is for calibration only and never counts as the service's answer.
    """
    gate = result["gate"]
    if not gate["passed"]:
        return {"withheldReason": f"gate: {gate['reason']}"}
    if suite == "key":
        out = {"withheldReason": result.get("keyWithheld") or "the estimator returned no key"}
        raw = result.get("keyUnreturned")
        if raw is not None:
            key = parse_key(raw["tonic"], raw["mode"])
            s = mirex_key_score(key, reference)
            out["unreturned"] = {
                "estimate": str(key),
                "confidence": raw.get("strength"),
                "scores": {"mirex": s, "exact": float(s == 1.0)},
            }
        return out
    detail = result.get("tempoWithheld") or {"reason": "unknown"}
    out = {"withheldReason": detail["reason"]}
    if "bpm" in detail:
        bpm = detail["bpm"]
        out["unreturned"] = {
            "estimate": f"{bpm:g}",
            "confidence": detail.get("confidence"),
            "scores": {"acc1": float(acc1(bpm, reference)), "acc2": float(acc2(bpm, reference))},
        }
    return out


def withheld_cost(rows: list[dict], metric_names, seed: int) -> dict:
    """
    What the withholding rule costs, from the per-track rows of one estimator: the estimates
    the service made but did not return (a tempo that did not hold, a key the evidence rule
    stopped), scored, next to what the share over all n clips would be if they had been
    returned too. Clips with no estimate at all (gate, no estimate) stay at no correct value.
    """
    n = len(rows)
    returned = [r["scores"] for r in rows if r.get("scores") is not None]
    unreturned = [r["unreturned"]["scores"] for r in rows if r.get("unreturned")]
    out = {"n": n, "returned": len(returned), "unreturned": len(unreturned), "metrics": {}}
    for j, m in enumerate(metric_names):
        kept = [s[m] for s in returned]
        dropped = [s[m] for s in unreturned]
        padding = [0.0] * (n - len(kept) - len(dropped))
        out["metrics"][m] = {
            "unreturned": estimate(m, dropped, seed + 200 + j).as_dict(),
            "ifReturnedOverN": estimate(m, kept + dropped + padding, seed + 300 + j).as_dict(),
        }
    return out
