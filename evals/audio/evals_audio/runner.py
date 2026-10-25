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
from itertools import combinations

from . import calibration, clips, service
from .metrics import Item, acc1, acc2, compare, estimate, mirex_key_score, parse_key

MAX_JOBS = 4  # the box is shared
METRICS = {"tempo": ("acc1", "acc2"), "key": ("mirex", "exact")}
METRIC_LABELS = {"acc1": "Acc1", "acc2": "Acc2", "mirex": "MIREX", "exact": "exact"}
# The rules that withhold an answer the estimator had (the key reasons other than KEY_WEAK are
# the service's own evidence rule), and "no estimate" for no value with every rule lifted.
NO_ESTIMATE = "no estimate"
TEMPO_LOW_PERIODICITY = "onsets do not repeat enough (periodicity under the minimum)"
TEMPO_LOW_CONFIDENCE = "confidence under the estimator's minimum"
TEMPO_UNSTEADY = "tempo does not hold over the window"
KEY_WEAK = "key strength under the minimum"
CALIBRATION_UNAVAILABLE = "unknown (the calibration call failed)"
# Withheld cost rows: clips that more than one rule withholds.
SEVERAL_RULES = "several rules"
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
    """
    One track: the clip window and, per estimator, the service's tempo/key/gate blocks.

    The task is (dataset, track id, path, clip seed, estimator names[, options]). Options:
    "whole" has the service's decoder read the file itself (a Deezer preview, as the service
    gets it) instead of cutting a 30 s window; "styles" keeps the fingerprint's
    Discogs styles (the models must be loaded, see analyze_all).
    """
    dataset, track_id, path, seed, names = task[:5]
    options = task[5] if len(task) > 5 else {}
    try:
        with captured_stderr() as warnings:
            if options.get("whole"):
                window = clips.whole_window(path)
                signals = service.decode_file(path)
            else:
                wav, window = clips.read_clip(path, seed, dataset, track_id)
                signals = service.decode(wav)
    except Exception as e:  # a broken file is recorded, not fatal
        return {"trackId": track_id, "error": f"{type(e).__name__}: {e}"}
    if warnings:
        window["decodeWarnings"] = warnings
    results = {}
    record: dict = {"trackId": track_id, "window": window, "results": results}
    if options.get("calibration"):
        record["calibration"] = calibration_record(signals, names, options["calibration"])
    for name, est in _estimators(tuple(names)).items():
        try:
            v2 = service.analyze(signals, est)
        except Exception as e:
            results[name] = {"error": f"{type(e).__name__}: {e}"}
            continue
        results[name] = {"gate": v2["gate"], "tempo": v2["tempo"], "key": v2["key"]}
        if options.get("styles"):
            # The fingerprint does not depend on the estimator: kept once, and checked to be
            # the same for every estimator.
            styles = styles_of(v2.get("fingerprint"))
            if "styles" not in record:
                record["styles"] = styles
            elif styles != record["styles"]:
                record["stylesDiffer"] = True
        # Calibration only: a failure here never touches the answer the service gave.
        if v2["gate"]["passed"] and v2["tempo"] is None:
            try:
                results[name]["tempoWithheld"] = tempo_withheld(signals, est)
            except Exception as e:
                results[name]["tempoWithheld"] = {
                    "reason": CALIBRATION_UNAVAILABLE,
                    "rules": [],
                    "error": f"{type(e).__name__}: {e}",
                }
        if v2["gate"]["passed"] and v2["key"] is None:
            try:
                results[name].update(key_withheld(signals, est))
            except Exception as e:
                results[name].update(
                    keyWithheld=CALIBRATION_UNAVAILABLE,
                    keyRules=[],
                    keyUnreturned=None,
                    calibrationError=f"{type(e).__name__}: {e}",
                )
    return record


def calibration_record(signals, names, suite: str) -> dict:
    """
    What the withholding rules compare on this clip (calibration.record): the gate's
    measurements, the key evidence (key and controls suites) and each estimator's estimate with
    every rule lifted. Calibration only; a failure is recorded, never fatal.
    """
    try:
        return calibration.record(signals, _estimators(tuple(names)), suite)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def styles_of(fingerprint: dict | None) -> list[dict] | None:
    """The fingerprint's Discogs styles, highest first ({label, score}), or None."""
    styles = (fingerprint or {}).get("styles")
    if not styles:
        return None
    return [{"label": e["label"], "score": e["score"]} for e in styles["top"]]


def _tempo_block(tempo, rules: list[str], steady: bool) -> dict:
    return {
        "reason": rules[0],
        "rules": rules,
        "bpm": round(float(tempo.bpm), 2),
        "confidence": None if tempo.confidence is None else round(float(tempo.confidence), 3),
        "steady": steady,
    }


def tempo_withheld(signals, est) -> dict:
    """
    Why the service returned no tempo, and the estimate it did not return (kept apart, for
    calibration only). `rules` lists every rule that withholds it, in the order the service
    applies them: onsets that do not repeat enough (the periodicity minimum), a confidence
    under the estimator's minimum, a tempo that does not hold over the window. The estimate
    is recomputed with the minimums lifted. "no estimate" (no rules) when the estimator has no
    tempo even then (out of range, too few beats).
    """
    tempo = est.tempo(signals)
    if tempo is not None:
        return _tempo_block(tempo, [TEMPO_UNSTEADY], bool(tempo.steady))
    lifted = service.tempo_without_confidence_minimum(signals, est)
    if lifted is not None:
        rules = [TEMPO_LOW_CONFIDENCE] + ([] if lifted.steady else [TEMPO_UNSTEADY])
        return _tempo_block(lifted, rules, bool(lifted.steady))
    lifted, steady = service.tempo_without_minimums(signals, est)
    if lifted is None:
        return {"reason": NO_ESTIMATE, "rules": []}
    rules = [TEMPO_LOW_PERIODICITY]
    if lifted.confidence is not None and lifted.confidence < est.min_tempo_confidence:
        rules.append(TEMPO_LOW_CONFIDENCE)
    if not steady:
        rules.append(TEMPO_UNSTEADY)
    return _tempo_block(lifted, rules, steady)


def key_withheld(signals, est) -> dict:
    """
    Why the service returned no key, and the key the estimator gives with both rules lifted
    (the evidence rule and the estimator's minimum strength), kept apart for calibration
    only. `keyRules` lists every rule that withholds it.
    """
    withheld = service.key_evidence(signals, est)
    raw = service.key_without_withholding(signals, est)
    rules = [] if withheld is None else [str(withheld)]
    if raw is not None and (raw.strength or 0.0) < service.key_min_strength(est):
        rules.append(KEY_WEAK)
    unreturned = None
    if raw is not None:
        unreturned = {
            "tonic": raw.tonic,
            "mode": raw.mode,
            "strength": None if raw.strength is None else round(raw.strength, 3),
        }
    return {
        "keyWithheld": rules[0] if rules else "the estimator returned no key",
        "keyRules": rules,
        "keyUnreturned": unreturned,
    }


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


def _worker_init(numba_cache: str, models_dir: str | None = None) -> None:
    # Each worker compiles librosa's numba functions into its own cache directory, made for
    # this run. Workers sharing one cache (librosa's default, inside the environment) can
    # leave it in a state that crashes a later run with a segmentation fault.
    os.environ["NUMBA_CACHE_DIR"] = os.path.join(numba_cache, str(os.getpid()))
    service.load()
    if models_dir is not None and not service.load_models(models_dir):
        raise RuntimeError(f"the fingerprint models in {models_dir} did not load")


def analyze_all(
    tasks: list[tuple], jobs: int, progress=None, models_dir: str | None = None
) -> list[dict]:
    """Every task in worker processes; `models_dir` loads the fingerprint models in each."""
    jobs = max(1, min(jobs, MAX_JOBS))
    for var in THREAD_ENV:
        os.environ.setdefault(var, "1")
    context = multiprocessing.get_context("spawn")
    out = []
    with (
        tempfile.TemporaryDirectory(prefix="evals-audio-numba-") as numba_cache,
        ProcessPoolExecutor(
            jobs,
            mp_context=context,
            initializer=_worker_init,
            initargs=(numba_cache, models_dir),
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
    tempo that did not hold over the window or was under the confidence minimum; a key the
    evidence rule stopped or under the minimum strength). The unreturned estimate is for
    calibration only and never counts as the service's answer.
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
                "rules": result.get("keyRules") or [out["withheldReason"]],
                "scores": {"mirex": s, "exact": float(s == 1.0)},
            }
        if result.get("calibrationError"):
            out["calibrationError"] = result["calibrationError"]
        return out
    detail = result.get("tempoWithheld") or {"reason": "unknown"}
    out = {"withheldReason": detail["reason"]}
    if detail.get("error"):
        out["calibrationError"] = detail["error"]
    if "bpm" in detail:
        bpm = detail["bpm"]
        out["unreturned"] = {
            "estimate": f"{bpm:g}",
            "confidence": detail.get("confidence"),
            "steady": detail.get("steady"),
            "rules": detail.get("rules") or [detail["reason"]],
            "scores": {"acc1": float(acc1(bpm, reference)), "acc2": float(acc2(bpm, reference))},
        }
    return out


def withheld_cost(rows: list[dict], metric_names, seed: int) -> dict:
    """
    What each withholding rule costs, from the per-track rows of one estimator: the estimates
    the service made but did not return, scored. A clip is counted under a rule only when
    that rule alone withholds it, so a rule's row is what lifting that rule alone would give;
    clips that several rules withhold have their own row (SEVERAL_RULES), and "all" lifts every
    rule. Clips with no estimate at all (gate, no estimate) stay at no correct value.
    """
    n = len(rows)
    returned = [r["scores"] for r in rows if r.get("scores") is not None]
    by_rule: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("unreturned"):
            rules = r["unreturned"].get("rules") or [r["withheldReason"]]
            group = rules[0] if len(rules) == 1 else SEVERAL_RULES
            by_rule.setdefault(group, []).append(r["unreturned"]["scores"])
    groups = sorted(by_rule.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    if len(groups) > 1:
        groups.append(("all", [s for _, scores in groups for s in scores]))

    def block(dropped: list[dict], base: int) -> dict:
        metrics = {}
        for j, m in enumerate(metric_names):
            kept = [s[m] for s in returned]
            lost = [s[m] for s in dropped]
            padding = [0.0] * (n - len(kept) - len(lost))
            metrics[m] = {
                "unreturned": estimate(m, lost, base + j).as_dict(),
                "ifReturnedOverN": estimate(m, kept + lost + padding, base + 50 + j).as_dict(),
            }
        return {"count": len(dropped), "metrics": metrics}

    return {
        "n": n,
        "returned": len(returned),
        "unreturned": sum(len(s) for rule, s in groups if rule != "all"),
        "rules": [
            {"rule": rule, **block(scores, seed + 200 + 100 * k)}
            for k, (rule, scores) in enumerate(groups)
        ],
    }


def compare_pairs(items: dict, names: list[str], metric_names, seed: int) -> list[dict]:
    """Every pair of estimators compared on the same clips (metrics.compare), in name order."""
    return [
        {"first": a, "second": b, **compare(items[a], items[b], metric_names, seed)}
        for a, b in combinations(names, 2)
    ]


def lifted_items(rows: list[dict], only: str | None = None) -> list[Item]:
    """
    One estimator's Items with withheld estimates counted as if returned: every unreturned
    estimate (`only` None), or only those that the rule `only` alone withholds. Calibration:
    what the estimator would give without the rules, never what the service serves.
    """
    items = []
    for r in rows:
        if r.get("scores") is not None:
            items.append(Item(r["trackId"], r.get("confidence"), r["scores"]))
            continue
        un = r.get("unreturned")
        if un and (only is None or (un.get("rules") or [r.get("withheldReason")]) == [only]):
            items.append(Item(r["trackId"], un.get("confidence"), un["scores"]))
        else:
            items.append(Item(r["trackId"], None, None, failed=bool(r.get("failed"))))
    return items


# The lifted views a tempo run records, by key.
LIFTED_VIEWS = {"everyRule": None, "steadinessOnly": TEMPO_UNSTEADY}


def lifted_views(tracks: dict, names: list[str], metric_names, seed: int) -> dict:
    """Correct / n and the paired tests with the withholding rules lifted (LIFTED_VIEWS)."""
    from .metrics import summarize

    out = {}
    for key, only in LIFTED_VIEWS.items():
        items = {n: lifted_items(tracks[n], only) for n in names}
        out[key] = {
            "rule": only,
            "summaries": {n: summarize(items[n], metric_names, seed).as_dict() for n in names},
            "paired": compare_pairs(items, names, metric_names, seed),
        }
    return out
