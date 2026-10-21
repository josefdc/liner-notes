"""
Runs the service on each clip (in worker processes) and scores what it returns.

A worker cuts the clip, decodes it with the service's decoder, and calls the service's
`analyze_signals` once per estimator on the same decoded signals (they share the cached
representations). Scoring happens in the parent, against the references.
"""

from __future__ import annotations

import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from functools import cache

from . import clips, service
from .metrics import Item, Key, acc1, acc2, mirex_key_score, parse_key

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
        wav, window = clips.read_clip(path, seed, dataset, track_id)
        signals = service.decode(wav)
    except Exception as e:  # a broken file is recorded, not fatal
        return {"trackId": track_id, "error": f"{type(e).__name__}: {e}"}
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
        except Exception as e:
            results[name] = {"error": f"{type(e).__name__}: {e}"}
    return {"trackId": track_id, "window": window, "results": results}


def _worker_init() -> None:
    service.load()


def analyze_all(tasks: list[tuple], jobs: int, progress=None) -> list[dict]:
    jobs = max(1, min(jobs, MAX_JOBS))
    for var in THREAD_ENV:
        os.environ.setdefault(var, "1")
    context = multiprocessing.get_context("spawn")
    out = []
    with ProcessPoolExecutor(jobs, mp_context=context, initializer=_worker_init) as pool:
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
    """Why the service withheld the answer, and (tempo) how its unreturned estimate scores."""
    gate = result["gate"]
    if not gate["passed"]:
        return {"withheldReason": f"gate: {gate['reason']}"}
    if suite == "key":
        return {"withheldReason": result.get("keyWithheld") or "the estimator returned no key"}
    detail = result.get("tempoWithheld") or {"reason": "unknown"}
    out = {"withheldReason": detail["reason"]}
    if "bpm" in detail:
        bpm = detail["bpm"]
        out["unreturned"] = {
            "bpm": bpm,
            "confidence": detail.get("confidence"),
            "acc1": float(acc1(bpm, reference)),
            "acc2": float(acc2(bpm, reference)),
        }
    return out


def reference_text(value) -> str:
    return str(value) if isinstance(value, Key) else f"{value:g}"
