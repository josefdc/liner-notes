import json
from pathlib import Path

import pytest

from evals_audio import calibration, golden, service
from evals_audio.controls import GROUPS, added_families, group_description
from evals_audio.datasets import DATASETS
from evals_audio.metrics import Item, Key, compare, coverage_curve, ranking_auc, summarize
from evals_audio.report import (
    SCHEMA_VERSION,
    OlderResults,
    add_run,
    count_p_values,
    guide,
    load,
    measured,
    not_run,
    render,
)
from evals_audio.runner import compare_pairs, lifted_views, withheld_cost
from evals_audio.service import REPO_ROOT

ITEMS = {
    "librosa": [
        Item("t1", 0.9, {"acc1": 1.0, "acc2": 1.0}),
        Item("t2", 0.5, {"acc1": 0.0, "acc2": 1.0}),
        Item("t3", None, None),
    ],
    "essentia": [
        Item("t1", 0.8, {"acc1": 1.0, "acc2": 1.0}),
        Item("t2", None, None),
        Item("t3", None, None),
    ],
}


def run(suite="tempo", dataset="ballroom", limit=3, seed=1):
    spec = DATASETS[dataset]
    metrics = ["acc1", "acc2"] if suite == "tempo" else ["mirex", "exact"]
    items = ITEMS if suite == "tempo" else {}
    curves = {}
    for name, its in items.items():
        points, unranked = coverage_curve(its, metrics, seed, min_answered=1)
        curves[name] = {
            "points": [
                {
                    "coverage": p.coverage,
                    "answered": p.answered,
                    "minConfidence": p.min_confidence,
                    "accuracy": {m: e.as_dict() for m, e in p.accuracy.items()},
                }
                for p in points
            ],
            "unranked": unranked,
            "ranking": {m: ranking_auc(its, m) for m in metrics},
        }
    rows = {
        name: [
            {
                "trackId": i.track_id,
                "estimate": None if i.scores is None else "120",
                "confidence": i.confidence,
                "withheld": i.scores is None,
                "gate": {"passed": True, "reason": None},
                "scores": i.scores,
                **(
                    {}
                    if i.scores is not None
                    else {
                        "withheldReason": "tempo does not hold over the window",
                        "unreturned": {
                            "estimate": "119",
                            "confidence": 0.3,
                            "scores": {"acc1": 1.0, "acc2": 1.0},
                        },
                    }
                ),
            }
            for i in its
        ]
        for name, its in items.items()
    }
    return {
        "suite": suite,
        "command": f"uv run python -m evals_audio --suite {suite} --limit {limit}",
        "startedAt": "2026-10-21T00:00:00Z",
        "wallSeconds": 12.0,
        "jobs": 4,
        "seeds": {"selection": seed, "clips": seed, "bootstrap": seed},
        "limit": limit,
        "selection": "3 of 698 usable tracks",
        "clipSeconds": 30.0,
        "gitCommit": "abc1234",
        "analyzerVersion": "2.0.0",
        "analyzerVersions": {"librosa": "2.0.0+librosa"},
        "environment": {"python": "3.12.3"},
        "dataUsageBytes": 1_000_000,
        "dataCapBytes": 2_000_000_000,
        "dataset": {
            "name": dataset,
            "mirdataName": spec.mirdata_name,
            "title": spec.title,
            "annotationLicence": spec.annotation_licence,
            "audioRights": spec.audio_rights,
            "credits": list(spec.credits),
            "sources": [list(s) for s in spec.sources],
            "referenceNote": spec.reference_note,
            "referenceStats": None,
            "notes": list(spec.notes),
            "tracksInIndex": 698,
            "usable": 698,
            "excluded": {},
            "selected": 3,
            "audioPresent": 3,
            "audioUnavailable": [],
            "audioSources": {"https://example.org/<file>": 3},
        },
        "summaries": {name: summarize(its, metrics, seed).as_dict() for name, its in items.items()},
        "paired": (
            {"first": "librosa", "second": "essentia", **compare(*items.values(), metrics, seed)}
            if items
            else None
        ),
        "withheldCost": {name: withheld_cost(rows[name], metrics, seed) for name in items},
        "coverage": curves,
        "clips": [{"trackId": t, "window": None} for t in ("t1", "t2", "t3")],
        "tracks": rows,
    }


def test_a_run_is_replaced_only_by_one_with_the_same_seeds_and_limit():
    doc = {"schemaVersion": SCHEMA_VERSION, "runs": []}
    doc = add_run(doc, run())
    doc = add_run(doc, run(suite="key", dataset="giantsteps-key"))
    doc = add_run(doc, run(limit=5))
    doc = add_run(doc, run(seed=2))
    doc = add_run(doc, run())  # the same as the first: replaces it
    keys = [(r["suite"], r["limit"], r["seeds"]["selection"]) for r in doc["runs"]]
    assert sorted(keys) == sorted(
        [("tempo", 3, 1), ("key", 3, 1), ("tempo", 5, 1), ("tempo", 3, 2)]
    )


def test_an_older_results_file_is_refused_not_dropped(tmp_path):
    path = tmp_path / "audio-2026-10-21.json"
    path.write_text(json.dumps({"schemaVersion": 1, "runs": [{"suite": "tempo"}]}))
    with pytest.raises(OlderResults, match="schemaVersion 1"):
        load(path)
    assert load(tmp_path / "missing.json") == {"schemaVersion": SCHEMA_VERSION, "runs": []}


def test_a_run_with_other_estimators_does_not_replace_the_paired_run():
    both = run()
    librosa_only = run()
    librosa_only["summaries"] = {"librosa": both["summaries"]["librosa"]}
    doc = add_run(add_run({"schemaVersion": SCHEMA_VERSION, "runs": []}, both), librosa_only)
    assert sorted(len(r["summaries"]) for r in doc["runs"]) == [1, 2]


def test_the_guide_counts_the_p_values_it_prints():
    doc = {"date": "2026-10-21", "runs": [run()]}
    n = count_p_values(doc)
    # 2 metrics x 2 paired blocks, and one AUC per binary metric and estimator when defined.
    ranking = [r for c in run()["coverage"].values() for r in c["ranking"].values()]
    assert n == 4 + sum(1 for r in ranking if r["p"] is not None)
    assert f"This report gives {n} distinct ones" in render(doc)


def test_render_gives_coverage_over_n_and_over_answered_with_intervals():
    text = render({"date": "2026-10-21", "runs": [run()]})
    # Coverage first, then correct / n, then correct / answered, each with its denominator.
    assert (
        "| `librosa` | 3 | 2/3 = 66.7 % [20.8, 93.9] | 1 | 0 | 1/3 = 33.3 % [6.1, 79.2] |" in text
    )
    assert "1/2 = 50.0 % [9.5, 90.5]" in text
    # 2/2 right over answered: a Wilson interval, never a zero-width one.
    assert "2/2 = 100.0 % [34.2, 100.0]" in text
    assert "- `librosa` returns a tempo for 2 of 3 clips (66.7 %)" in text
    assert "### Paired comparison" in text
    assert "both answered (n = 1)" in text
    assert "### Withheld" in text and "Acc1: correct / n with these too" in text
    assert "tempo does not hold over the window (1)" in text
    assert "### Accuracy vs coverage" in text and "Confidence ranking: Acc1" in text
    assert "--suite tempo --limit 3" in text
    assert "beat-this" in text  # says what is not covered yet


def test_a_report_that_mixes_analyzer_versions_says_so():
    one = run()
    assert "mixes analyzer versions" not in render({"date": "2026-10-21", "runs": [one]})
    other = {**run(), "analyzerVersion": "9.9.9"}
    text = render({"date": "2026-10-21", "runs": [one, other]})
    assert f"**This report mixes analyzer versions ({one['analyzerVersion']}, 9.9.9).**" in text


def test_render_scopes_the_licence_and_credits_the_data():
    text = render({"date": "2026-10-21", "runs": [run()]})
    assert "| licence (annotations) | CC BY-NC-SA 4.0" in text
    assert "per mirdata 1.0.0" in text
    assert "| audio | commercial excerpts" in text
    assert "Credits (cite these when using the data):" in text
    assert "doi:10.1109/TSA.2005.858509" in text
    assert "Seeds: selection 1, clip windows 1, bootstrap 1" in text


def test_the_results_file_holds_no_reference_labels_or_file_names():
    doc = {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-21", "runs": [run()]}
    text = json.dumps(doc)
    assert '"reference"' not in text and "audioRel" not in text and ".wav" not in text


def test_the_markdown_is_rendered_from_the_json_alone(tmp_path):
    from evals_audio.cli import main

    doc = {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-21", "runs": [run()]}
    path = tmp_path / "audio-2026-10-21.json"
    path.write_text(json.dumps(doc))
    assert main(["--render", str(path)]) == 0
    assert (tmp_path / "audio-2026-10-21.md").read_text() == render(doc)


COMMITTED = sorted((REPO_ROOT / "evals" / "reports").glob("audio-*.json"))


def test_there_is_a_committed_report():
    """The checks below run once per committed report; with none they would run on nothing."""
    assert COMMITTED, "no evals/reports/audio-*.json"


def test_the_newest_controls_run_is_of_the_service_as_it_is():
    """
    The READMEs quote the control counts of the newest committed controls run, so that run must
    have been made with the analyzer version and the single-source values the service holds
    now: a change to the rule, or any change to the output that bumps the version, needs a
    fresh run (uv run python -m evals_audio --suite controls).
    """
    runs = [
        (path.name, run)
        for path in COMMITTED
        for run in json.loads(path.read_text())["runs"]
        if run["suite"] == "controls"
    ]
    assert runs, "no committed controls run"
    name, newest = max(runs, key=lambda item: item[1]["startedAt"])
    _, est = service.load()
    assert newest["analyzerVersion"] == service.base_version(), name
    assert newest["rules"].get("one_source") == calibration.source_values(est), name


def test_a_group_names_the_families_added_to_it_only_in_reports_that_ran_them():
    """An older report keeps describing the controls it ran; a newer one names the added ones."""
    before = ["tabla-s500", "toms-s501", "cowbell-s502", "faded-pad-s700"]
    for group in ("one-pitch-class-seeded", "chord-keyed-seeded", "no-key"):
        assert group_description(group, before) == GROUPS[group]
    new = group_description(
        "one-pitch-class-seeded", [*before, "kit-toms-s505", "tubular-bell-s507"]
    )
    assert new.endswith(
        "a held synth note, two rack toms and a floor tom over a kit, a tubular bell), 30 seeds each"
    )
    only_bells = group_description("one-pitch-class-seeded", [*before, "tubular-bell-s507"])
    assert "a held synth note, a tubular bell)" in only_bells
    chords = group_description("chord-keyed-seeded", [*before, "mallet-chord-s801"])
    assert chords.endswith(
        "their key not scored; triads struck on bars (a marimba-like bar or a glockenspiel), 30 "
        "seeds each)"
    )
    both = group_description("chord-keyed-seeded", [*before, "mallet-chord-s801", "soft-chord-s7"])
    assert (
        "; triads in a soft timbre (an electric piano, a flute, an FM electric piano or a " in both
    )
    assert group_description("no-key", ["tubular-bell-s507"]) == GROUPS["no-key"]
    assert added_families(before) == []
    assert added_families([*before, "soft-chord-s700", "tubular-bell-s500"]) == [
        "a tubular bell",
        "triads in a soft timbre (an electric piano, a flute, an FM electric piano or a "
        "triangle wave)",
    ]


def test_a_group_description_takes_added_families_whatever_its_wording(monkeypatch):
    """Reworded without a closing parenthesis, a group still names its added families."""
    monkeypatch.setitem(GROUPS, "one-pitch-class-seeded", "no key: one pitched source")
    assert (
        group_description("one-pitch-class-seeded", ["tubular-bell-s500"])
        == "no key: one pitched source, a tubular bell"
    )
    monkeypatch.setitem(GROUPS, "one-pitch-class-seeded", "no key (one source) at 30 seeds")
    assert (
        group_description("one-pitch-class-seeded", ["kit-toms-s500"])
        == "no key (one source, two rack toms and a floor tom over a kit) at 30 seeds"
    )


def test_a_report_says_what_it_measures_and_what_it_does_not_hold():
    """A report of some suites names those only, and the ones it leaves out."""

    def doc(*suites):
        return {"runs": [{"suite": suite} for suite in suites]}

    partial = doc("tempo", "calibration", "controls")
    assert measured(partial) == (
        "Tempo accuracy of the audio service (`services/audio`) on annotated datasets, the "
        "calibration of its withholding rules and its answers on generated controls"
    )
    for words in ("key accuracy", "golden", "costs"):
        assert words not in measured(partial)
    full = doc("tempo", "key", "golden", "cost", "calibration", "controls")
    assert measured(full).startswith("Tempo and key accuracy") and not_run(full) == ""
    assert measured(doc("controls")).endswith("its answers on generated controls")
    assert measured(doc()) == "No measurement of the audio service (`services/audio`)"


def test_a_report_lists_each_run_it_does_not_hold_and_claims_no_other_report():
    def run(suite, dataset):
        return {"suite": suite, "dataset": {"name": dataset}}

    partial = {
        "runs": [
            run("tempo", "ballroom"),
            run("calibration", "ballroom"),
            run("controls", "controls"),
        ]
    }
    text = not_run(partial)
    assert text.startswith(" Not run for this report: tempo on GiantSteps Tempo; key on GiantSteps")
    for words in (
        "what the tempo rules compare on GiantSteps Tempo",
        "what the key rules compare on GiantSteps Key",
        "the golden set; the estimators' costs.",
        "Any report in `evals/reports` that holds them",
    ):
        assert words in text
    assert "Ballroom" not in text and "generated controls" not in text
    assert "the generated controls" in not_run({"runs": [run("tempo", "ballroom")]})


def test_the_guide_explains_only_the_tables_a_report_holds():
    def terms(doc):
        return {line[4:].split("**", 1)[0] for line in guide(doc) if line.startswith("- **")}

    def committed(date):
        return json.loads((REPO_ROOT / "evals" / "reports" / f"audio-{date}.json").read_text())

    full = committed("2026-10-25")  # every suite
    assert {"MIREX", "Paired MIREX difference", "Agreement", "hit@k", "Costs"} <= terms(full)
    partial = dict(full, runs=[r for r in full["runs"] if r["suite"] in ("tempo", "calibration")])
    held = terms(partial)
    assert {"Acc1", "Lifted rules", "Comparability", "Intervals"} <= held
    assert not held & {"MIREX", "Paired MIREX difference", "Agreement", "hit@k", "Costs"}
    with_key = dict(full, runs=[r for r in full["runs"] if r["suite"] in ("key", "calibration")])
    assert {"MIREX", "Paired MIREX difference"} <= terms(with_key)


@pytest.mark.parametrize("path", COMMITTED, ids=[p.name for p in COMMITTED])
def test_each_committed_report_is_rendered_from_its_json_byte_for_byte(path):
    doc = json.loads(path.read_text())
    assert path.with_suffix(".md").read_text() == render(doc)


@pytest.mark.parametrize("path", COMMITTED, ids=[p.name for p in COMMITTED])
def test_committed_results_name_no_local_path_or_audio_file(path):
    text = path.read_text() + path.with_suffix(".md").read_text()
    for marker in ("/home/", "/Users/", "/tmp/", "--data-dir", "--report-dir", '"reference"'):
        assert marker not in text
    assert ".wav" not in text and ".mp3" not in text.replace("<id>.LOFI.mp3", "")


# --- schema 5: three estimators, the golden suite and the cost suite ------------------------


def three_estimator_run(dataset="ballroom"):
    r = run(dataset=dataset)
    items = {
        **ITEMS,
        "beat-this": [
            Item("t1", None, {"acc1": 1.0, "acc2": 1.0}),
            Item("t2", None, {"acc1": 1.0, "acc2": 1.0}),
            Item("t3", None, None),
        ],
    }
    metrics = ["acc1", "acc2"]
    r["estimators"] = list(items)
    r["summaries"] = {n: summarize(its, metrics, 1).as_dict() for n, its in items.items()}
    r["paired"] = compare_pairs(items, list(items), metrics, 1)
    r["trainedOn"] = ["beat-this"] if dataset == "ballroom" else []
    r["estimatorNotes"] = ["trained-on note"] if r["trainedOn"] else []
    points, unranked = coverage_curve(items["beat-this"], metrics, 1, min_answered=1)
    r["coverage"]["beat-this"] = {
        "points": [
            {
                "coverage": p.coverage,
                "answered": p.answered,
                "minConfidence": p.min_confidence,
                "accuracy": {m: e.as_dict() for m, e in p.accuracy.items()},
            }
            for p in points
        ],
        "unranked": unranked,
        "ranking": {m: ranking_auc(items["beat-this"], m) for m in metrics},
    }
    r["tracks"]["beat-this"] = r["tracks"]["librosa"]
    r["serviceDefault"] = "essentia"
    r["estimatorCredits"] = ["beat-this credit"]
    r["lifted"] = lifted_views(r["tracks"], list(items), metrics, 1)
    return r


def golden_run():
    gate = {"passed": True, "reason": None}
    records = [
        {
            "trackId": f"GBAAA000000{i}",
            "window": {"durationSeconds": 30.0, "decodeWarnings": ["id3 warning"]},
            "styles": [{"label": "Electronic---Synth-pop", "score": 0.4}],
            "results": {
                n: {
                    "gate": gate,
                    "tempo": {"bpm": 120.0, "confidence": None},
                    "key": {"tonic": "C", "mode": "major", "strength": 0.6},
                }
                for n in ("librosa", "beat-this")
            },
        }
        for i in range(3)
    ]
    labels = {
        r["trackId"]: {
            "discogs": {"kind": "master", "id": 1},
            "releaseGroup": {"id": "g", "type": "Single", "firstReleaseDate": "1985"},
            "retrieved": "2026-10-24",
            "genres": ["Electronic"],
            "styles": ["Synth-pop"],
        }
        for r in records
    }
    values = {r["trackId"]: 60.0 for r in records}
    keys = {r["trackId"]: Key(0, "major") for r in records}
    names = ["librosa", "beat-this"]
    return {
        "suite": "golden",
        "command": "uv run python -m evals_audio --suite golden",
        "startedAt": "2026-10-24T00:00:00Z",
        "wallSeconds": 10.0,
        "jobs": 4,
        "seeds": {"selection": 1, "clips": 1, "bootstrap": 1},
        "limit": None,
        "selection": "3 of 3 rows",
        "gitCommit": "abc1234",
        "analyzerVersion": "2.0.0",
        "analyzerVersions": {n: f"2.0.0+{n}" for n in names},
        "estimators": names,
        "environment": {"python": "3.12.3"},
        "dataUsageBytes": 1,
        "dataCapBytes": 2,
        "dataset": {
            **golden.DATASET,
            "fileSha256": "0" * 64,
            "rows": 3,
            "selected": 3,
            "previewsAnalysed": 3,
            "previewUnavailable": {},
            "deezerBpm": 3,
            "labelSource": "<data dir>/golden/discogs.json",
        },
        "clips": [{"trackId": r["trackId"], "window": r["window"]} for r in records],
        "agreement": {
            "deezer-bpm": golden.agreement("tempo", values, records, names, 1),
            "sheet-music-bpm": golden.agreement("tempo", {}, records, names, 1),
            "sheet-music-key": golden.agreement("key", keys, records, ["librosa"], 1),
        },
        "styles": {
            "model": "discogs-effnet-bs64-1",
            "topK": 1,
            **golden.styles_table(records, labels, ["Electronic---Synth-pop"]),
        },
        "failed": [],
    }


def memory(per_clip_cpu, peak):
    return {
        "clips": 3,
        "stoppedByPeriodicity": 1,
        "rssServiceBytes": 300_000_000,
        "rssReadyBytes": 600_000_000,
        "rssAfterFirstBytes": 700_000_000,
        "peakRssBytes": peak,
        "readySeconds": 1.0,
        "firstAnalysed": {"trackId": "24", "wallSeconds": 4.0, "cpuSeconds": 4.0},
        "perClip": {
            "n": 1,
            "medianWallSeconds": per_clip_cpu,
            "medianCpuSeconds": per_clip_cpu,
            "maxWallSeconds": per_clip_cpu,
        },
        "tempoEstimates": 2,
    }


def install(packages, image):
    def sized(pkgs):
        return {
            "packages": pkgs,
            "installedBytes": sum(p["installedBytes"] for p in pkgs),
            "wheelBytes": sum(p["wheelBytes"] for p in pkgs),
        }

    return {**sized(packages), "serviceImage": sized(image)}


TORCH = {
    "name": "torch",
    "version": "2.11.0+cpu",
    "installedBytes": 700_000_000,
    "wheelBytes": 190_000_000,
}
ESSENTIA = {
    "name": "essentia-tensorflow",
    "version": "2.1b6",
    "installedBytes": 600_000_000,
    "wheelBytes": 290_000_000,
}


def cost_run():
    return {
        "suite": "cost",
        "command": "uv run python -m evals_audio --suite cost --limit 3",
        "startedAt": "2026-10-24T00:00:00Z",
        "wallSeconds": 10.0,
        "jobs": 1,
        "seeds": {"selection": 1, "clips": 1, "bootstrap": 1},
        "limit": 3,
        "selection": "3 giantsteps-tempo tracks",
        "gitCommit": "abc1234",
        "analyzerVersion": "2.0.0",
        "analyzerVersions": {"essentia": "2.0.0+essentia", "beat-this": "2.0.0+beat-this"},
        "estimators": ["essentia", "beat-this"],
        "environment": {"python": "3.12.3"},
        "dataUsageBytes": 1,
        "dataCapBytes": 2,
        "machine": {
            "cpu": "test cpu",
            "cpus": 4,
            "system": "Linux x86_64",
            "threads": {"OMP_NUM_THREADS": "1"},
        },
        "serviceDefault": "essentia",
        "estimatorCredits": ["beat-this credit"],
        "dataset": {"name": "giantsteps-tempo", "title": "GiantSteps Tempo"},
        "clips": [{"trackId": "1"}, {"trackId": "2"}, {"trackId": "24"}],
        "memory": {"essentia": memory(0.3, 560_000_000), "beat-this": memory(3.6, 900_000_000)},
        "install": {
            "essentia": {"extra": "models", **install([ESSENTIA], [])},
            "beat-this": {"extra": "beat-this", **install([TORCH], [TORCH])},
        },
        "modelFiles": {"beat-this": {"file": "final0.ckpt", "bytes": 81_058_141}},
    }


def current_doc():
    doc = {"schemaVersion": SCHEMA_VERSION, "date": "2026-10-24", "runs": []}
    for r in (
        three_estimator_run(),
        three_estimator_run("giantsteps-tempo"),
        golden_run(),
        cost_run(),
    ):
        doc = add_run(doc, r)
    return doc


def test_runs_are_ordered_tempo_key_golden_cost():
    doc = add_run(current_doc(), run(suite="key", dataset="giantsteps-key"))
    assert [r["suite"] for r in doc["runs"]] == ["tempo", "tempo", "key", "golden", "cost"]


def test_a_schema_4_report_keeps_its_wording_and_a_new_one_says_what_it_covers():
    legacy = render({"schemaVersion": 4, "date": "2026-10-21", "runs": [run()]})
    assert "come in the next part of this work and are not here" in legacy
    assert "## Tempo estimator bake-off" not in legacy
    text = render(current_doc())
    assert "come in the next part" not in text
    assert "Runs in this report: tempo on Ballroom" in text
    assert "the service's default estimator is not changed by this report" in text


def test_the_bakeoff_table_marks_an_estimator_trained_on_the_dataset():
    text = render(current_doc())
    bakeoff = text.split("## Tempo estimator bake-off", 1)[1].split("\n## ", 1)[0]
    assert "| `beat-this` | 2/3 = 66.7 % [20.8, 93.9] (trained on this dataset) |" in bakeoff
    assert "agrees with Deezer `bpm` within 4 % / n" in bakeoff
    assert "| 900.0 MB | 3.60 s | 700.0 MB installed + 81.1 MB model |" in bakeoff
    assert "| 560.0 MB | 0.30 s | nothing (already in the image) |" in bakeoff
    assert bakeoff.count("(trained on this dataset) |") == 2  # Acc1 and Acc2 on Ballroom
    assert "with every withholding rule lifted (calibration, not served)" in bakeoff
    assert "`beat-this` (trained on this dataset)" in text


def test_pairs_with_an_estimator_trained_on_the_dataset_are_not_printed():
    text = render(current_doc())
    ballroom = text.split("## Tempo: Ballroom", 1)[1].split("\n## ", 1)[0]
    assert "`librosa` and `essentia`:" in ballroom
    assert "and `beat-this`:" not in ballroom
    assert "Pairs with `beat-this` are not shown: it was trained on this dataset" in ballroom
    giantsteps = text.split("## Tempo: GiantSteps Tempo", 1)[1].split("\n## ", 1)[0]
    assert "`essentia` and `beat-this`:" in giantsteps


def test_the_default_estimator_section_gives_the_criterion_evidence_and_decision():
    text = render(current_doc())
    section = text.split("## Default estimator", 1)[1].split("\n## ", 1)[0]
    assert "The service's default tempo and key estimator is `essentia`" in section
    assert (
        "Criterion: an estimator replaces the default when, on data it was not trained on"
        in section
    )
    # beat-this only on the data it was not trained on.
    assert "| `beat-this` | giantsteps-tempo |" in section
    assert "| `beat-this` | ballroom |" not in section
    assert "steadiness check lifted: Acc1" in section
    assert "(12 times as much)" in section and "where `essentia` adds nothing" in section
    assert "Decision: the service keeps `essentia` under the current withholding rules." in section
    assert "`beat-this` also has no key" in section
    assert "as served: shown but wrong even forgiving octave and meter (Acc2)" in section


def v(candidate, default, p, n=200):
    return {"candidate": candidate, "default": default, "n": n, "p": p}


def w(candidate, default, p):
    return {**v(candidate, default, p), "shownCandidate": 58, "shownDefault": 73}


def evidence(**row):
    base = {
        "name": "beat-this",
        "data": "giantsteps-tempo",
        "served1": v(46, 42, 0.572),
        "served2": v(57, 57, 1.0),
        "wrong1": w(12, 31, 0.0026),
        "wrong2": w(1, 16, 0.0003),
        "steady": v(150, 98, 1e-8),
        "every": v(153, 115, 4e-5),
    }
    return {
        "default": "essentia",
        "candidates": ["beat-this"],
        "rows": [{**base, **row}],
        "cost": cost_run(),
    }


def test_the_decision_follows_the_numbers():
    from evals_audio.report import decision_lines

    served = decision_lines(evidence(served1=v(80, 42, 0.001)))
    assert "meets the accuracy part of the criterion" in served[0]

    text = decision_lines(evidence())[0]
    assert text.startswith("Decision: the service keeps `essentia` under the current")
    # Wrong tempos shown: both measures, with their own p-values.
    assert (
        "`beat-this` shows fewer wrong tempos than `essentia` on giantsteps-tempo (1 vs 16 "
        "wrong even forgiving octave and meter, p < 0.001; 12 vs 31 on the strict 4 % "
        "measure, p = 0.003)"
    ) in text
    assert "input to recalibrating the withholding rules" in text
    # The cost clause comes from the cost run, for this candidate.
    assert "`beat-this` costs more than `essentia`: 12 times the CPU" in text
    assert "700.0 MB installed + 81.1 MB model added to the service image" in text
    # Both lifted views, each named.
    assert "with only the steadiness check lifted, 150 vs 98 of 200, p < 0.001" in text
    assert "with every rule lifted, 153 vs 115 of 200, p < 0.001" in text

    worse = decision_lines(evidence(wrong1=w(40, 31, 0.01), wrong2=w(30, 16, 0.01)))[0]
    assert "shows more wrong tempos than `essentia`" in worse and "weighs against it" in worse
    plain = decision_lines(evidence(wrong1=w(30, 31, 1.0), wrong2=w(16, 16, 1.0)))[0]
    assert "wrong tempos" not in plain


def test_a_cheaper_candidate_is_not_said_to_cost_more():
    from evals_audio.report import decision_lines

    ev = evidence(name="librosa")
    ev["candidates"] = ["librosa"]
    cheap = cost_run()
    cheap["memory"]["librosa"] = memory(0.05, 600_000_000)
    cheap["install"]["librosa"] = {"extra": None, **install([], [])}
    ev["cost"] = cheap
    text = decision_lines(ev)[0]
    assert "`librosa` costs no more than `essentia`: 0.17 times the CPU" in text
    assert "costs more" not in text and "no key" not in text


def test_the_wrong_shown_counts_come_from_the_rows_on_the_same_clips():
    from evals_audio.report import wrong_shown

    def rows(*scores):
        return [
            {"trackId": f"t{i}", "scores": None if s is None else {"acc1": s, "acc2": s}}
            for i, s in enumerate(scores)
        ]

    run = {"tracks": {"a": rows(0.0, 0.0, 1.0, None), "b": rows(1.0, 0.0, None, 0.0)}}
    out = wrong_shown(run, "a", "b", "acc1")
    assert out == {
        "candidate": 2,
        "default": 2,
        "shownCandidate": 3,
        "shownDefault": 3,
        "n": 4,
        "p": 1.0,
    }
    run["tracks"]["b"] = rows(1.0)
    assert wrong_shown(run, "a", "b", "acc1") is None  # not the same clips


def test_p_values_under_a_thousandth_are_never_shown_as_zero():
    from evals_audio.report import pval

    assert pval(0.00024) == "< 0.001" and pval(0.125) == "= 0.125" and pval(0.001) == "= 0.001"


def test_an_estimator_without_confidence_has_no_curve():
    text = render(current_doc())
    assert "`beat-this` gives no confidence: its 2 answered clips cannot be ranked" in text


def test_every_printed_p_value_is_counted():
    doc = current_doc()
    text = render(doc)
    ranking = sum(
        1
        for r in doc["runs"]
        for c in (r.get("coverage") or {}).values()
        for x in c["ranking"].values()
        if x["p"] is not None
    )
    shown_tempo_pairs = (1 + 3) * 2 * 2  # Ballroom without beat-this, GiantSteps all three
    golden_pairs = 1 * 2 * 2  # Deezer only: the sheet-music tempo table is empty
    styles = 3
    # librosa on both runs, beat-this on GiantSteps; two wrong-shown and two lifted tests each.
    default_table = (2 + 1) * 4
    expected = shown_tempo_pairs + golden_pairs + styles + ranking + default_table
    assert count_p_values(doc) == expected
    assert f"This report gives {expected} distinct ones" in text


def test_the_golden_section_names_agreement_styles_and_sources():
    text = render(current_doc())
    assert "## Golden set on Deezer previews" in text
    assert "### Tempo agreement with Deezer's `bpm`" in text
    assert "| `beat-this` | 3 | 3/3 = 100.0 % [43.9, 100.0] | 0/3 = 0.0 % [0.0, 56.1]" in text
    assert "### Styles: hit@k against Discogs" in text
    assert "| 1 | 3/3 = 100.0 % [43.9, 100.0]" in text
    assert "- id3 warning: 3 previews (GBAAA0000000, GBAAA0000001, GBAAA0000002)" in text
    assert "Data provided by Discogs" in text
    golden_part = text.split("## Golden set on Deezer previews", 1)[1].split("\n## ", 1)[0]
    assert "hdnea" not in golden_part and ".mp3" not in golden_part


def test_the_cost_section_gives_memory_time_and_image_cost():
    text = render(current_doc())
    assert "## Cost: tempo estimators on GiantSteps Tempo clips" in text
    assert (
        "| `beat-this` | 300.0 MB | 600.0 MB | 700.0 MB | 900.0 MB | 1.00 s | "
        "4.00 / 4.00 s (24) | 3.60 / 3.60 s, max 3.60 s (n = 1) | 1 |"
    ) in text
    assert "| `essentia` | 0 | 0 B | 0 B | none | 600.0 MB |" in text
    assert "| `beat-this` | 1 | 700.0 MB | 190.0 MB | final0.ckpt, 81.1 MB | 700.0 MB |" in text
    assert "adds to the service image: torch 2.11.0+cpu (700.0 MB)." in text
    assert "with OMP_NUM_THREADS=1" in text


def test_a_current_document_is_rendered_from_its_json_alone(tmp_path):
    from evals_audio.cli import main

    doc = current_doc()
    path = tmp_path / "audio-2026-10-24.json"
    path.write_text(json.dumps(doc))
    assert main(["--render", str(path)]) == 0
    assert (tmp_path / "audio-2026-10-24.md").read_text() == render(json.loads(json.dumps(doc)))


def test_golden_songs_beat_this_was_trained_on_are_listed_and_left_out_of_the_bakeoff():
    doc = current_doc()
    run_ = next(r for r in doc["runs"] if r["suite"] == "golden")
    records_ids = [c["trackId"] for c in run_["clips"]]
    run_["trainedOn"] = {"beat-this": {records_ids[0]: "Harmonix Set 0000_song"}}
    block = run_["agreement"]["deezer-bpm"]
    run_["agreement"]["deezer-bpm-unseen"] = {**block, "n": 2}
    text = render(doc)
    assert (
        f"| selected songs found in `beat-this`'s training data (a lower bound) | 1: {records_ids[0]} (Harmonix Set 0000_song) |"
        in text
    )
    assert "golden previews beat-this was not trained on: agrees with Deezer `bpm`" in text
    assert "without the songs beat-this was trained on" in text


FIXTURES = Path(__file__).parent / "fixtures"


def test_a_schema_4_results_file_renders_as_the_slice_1_code_rendered_it():
    """
    tests/fixtures/audio-schema4.json is the first report's results trimmed to six clips per
    run; the .md next to it was rendered by the harness that wrote schema 4 (05d8838).
    """
    doc = json.loads((FIXTURES / "audio-schema4.json").read_text())
    assert doc["schemaVersion"] == 4
    assert render(doc) == (FIXTURES / "audio-schema4.md").read_text()
