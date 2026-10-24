import json

import pytest

from evals_audio import golden
from evals_audio.datasets import DATASETS
from evals_audio.metrics import Item, Key, compare, coverage_curve, ranking_auc, summarize
from evals_audio.report import (
    SCHEMA_VERSION,
    OlderResults,
    add_run,
    count_p_values,
    load,
    render,
)
from evals_audio.runner import compare_pairs, withheld_cost
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
    assert f"This report prints {n};" in render(doc)


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


def cost_run():
    memory = {
        "clips": 2,
        "rssServiceBytes": 300_000_000,
        "rssReadyBytes": 600_000_000,
        "peakRssBytes": 900_000_000,
        "readySeconds": 1.0,
        "firstCall": {"wallSeconds": 4.0, "cpuSeconds": 4.0},
        "perClip": {
            "n": 1,
            "medianWallSeconds": 3.4,
            "medianCpuSeconds": 3.4,
            "maxWallSeconds": 3.4,
        },
        "tempoEstimates": 2,
    }
    return {
        "suite": "cost",
        "command": "uv run python -m evals_audio --suite cost --limit 2",
        "startedAt": "2026-10-24T00:00:00Z",
        "wallSeconds": 10.0,
        "jobs": 1,
        "seeds": {"selection": 1, "clips": 1, "bootstrap": 1},
        "limit": 2,
        "selection": "2 giantsteps-tempo tracks",
        "gitCommit": "abc1234",
        "analyzerVersion": "2.0.0",
        "analyzerVersions": {"beat-this": "2.0.0+beat-this"},
        "estimators": ["beat-this"],
        "environment": {"python": "3.12.3"},
        "dataUsageBytes": 1,
        "dataCapBytes": 2,
        "machine": {"cpu": "test cpu", "cpus": 4, "system": "Linux x86_64"},
        "dataset": {"name": "giantsteps-tempo", "title": "GiantSteps Tempo"},
        "clips": [{"trackId": "1"}, {"trackId": "2"}],
        "memory": {"beat-this": memory},
        "install": {
            "beat-this": {
                "extra": "beat-this",
                "packages": [
                    {
                        "name": "torch",
                        "version": "2.11.0+cpu",
                        "installedBytes": 700_000_000,
                        "wheelBytes": 190_000_000,
                    }
                ],
                "installedBytes": 700_000_000,
                "wheelBytes": 190_000_000,
            }
        },
        "modelFiles": {"beat-this": {"file": "final0.ckpt", "bytes": 81_058_141}},
    }


def v5_doc():
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
    doc = add_run(v5_doc(), run(suite="key", dataset="giantsteps-key"))
    assert [r["suite"] for r in doc["runs"]] == ["tempo", "tempo", "key", "golden", "cost"]


def test_a_schema_4_report_keeps_its_wording_and_a_new_one_says_what_it_covers():
    legacy = render({"schemaVersion": 4, "date": "2026-10-21", "runs": [run()]})
    assert "come in the next part of this work and are not here" in legacy
    assert "## Tempo estimator bake-off" not in legacy
    text = render(v5_doc())
    assert "come in the next part" not in text
    assert "Runs in this report: tempo on Ballroom" in text
    assert "the service's default estimator is not changed by this report" in text


def test_the_bakeoff_table_marks_an_estimator_trained_on_the_dataset():
    text = render(v5_doc())
    bakeoff = text.split("## Tempo estimator bake-off", 1)[1].split("\n## ", 1)[0]
    assert "| `beat-this` | 2/3 = 66.7 % [20.8, 93.9] (trained on this dataset) |" in bakeoff
    assert "agrees with Deezer `bpm` within 4 % / n" in bakeoff
    assert "| 900.0 MB | 3.40 s | 700.0 MB installed + 81.1 MB model |" in bakeoff
    # Only the Ballroom run marks it.
    assert bakeoff.count("(trained on this dataset)") == 2  # Acc1 and Acc2 on Ballroom
    assert "`beat-this` (trained on this dataset)" in text
    assert (
        "(`beat-this` was trained on this dataset: this pair says nothing about new music)" in text
    )


def test_an_estimator_without_confidence_has_no_curve():
    text = render(v5_doc())
    assert "`beat-this` gives no confidence: its 2 answered clips cannot be ranked" in text


def test_every_pair_is_compared_and_every_p_value_counted():
    doc = v5_doc()
    text = render(doc)
    assert text.count("### Paired comparisons") == 2
    assert "`librosa` and `beat-this`:" in text and "`essentia` and `beat-this`:" in text
    tempo_pairs = 2 * 3 * 2 * 2  # two runs, three pairs, two metrics, two blocks
    golden_pairs = 1 * 2 * 2  # deezer-bpm: one pair, two metrics, two blocks (sheet bpm empty)
    sheet_bpm_pairs = 1 * 2 * 2  # one pair with n = 0 still prints its rows
    styles = 3
    ranking = sum(
        1
        for r in doc["runs"]
        for c in (r.get("coverage") or {}).values()
        for x in c["ranking"].values()
        if x["p"] is not None
    )
    assert count_p_values(doc) == tempo_pairs + golden_pairs + sheet_bpm_pairs + styles + ranking
    assert f"This report prints {count_p_values(doc)};" in text


def test_the_golden_section_names_agreement_styles_and_sources():
    text = render(v5_doc())
    assert "## Golden set on Deezer previews" in text
    assert "### Tempo agreement with Deezer's `bpm`" in text
    assert "| `beat-this` | 3 | 3/3 = 100.0 % [43.9, 100.0] | 0/3 = 0.0 % [0.0, 56.1]" in text
    assert "### Styles: hit@k against Discogs" in text
    assert "| 1 | 3/3 = 100.0 % [43.9, 100.0]" in text
    assert "- id3 warning: 3 previews (GBAAA0000000, GBAAA0000001, GBAAA0000002)" in text
    assert "Data provided by Discogs" in text
    golden_part = text.split("## Golden set on Deezer previews", 1)[1].split("\n## ", 1)[0]
    assert "hdnea" not in golden_part and ".mp3" not in golden_part


def test_the_cost_section_gives_memory_time_and_install_size():
    text = render(v5_doc())
    assert "## Cost: tempo estimators on GiantSteps Tempo clips" in text
    assert "| `beat-this` | 300.0 MB | 600.0 MB | 900.0 MB | 1.00 s | 4.00 / 4.00 s |" in text
    assert "final0.ckpt, 81.1 MB" in text
    assert "- `beat-this` (extra `beat-this`) adds: torch 2.11.0+cpu (700.0 MB)." in text


def test_a_v5_document_is_rendered_from_its_json_alone(tmp_path):
    from evals_audio.cli import main

    doc = v5_doc()
    path = tmp_path / "audio-2026-10-24.json"
    path.write_text(json.dumps(doc))
    assert main(["--render", str(path)]) == 0
    assert (tmp_path / "audio-2026-10-24.md").read_text() == render(json.loads(json.dumps(doc)))


def test_golden_songs_beat_this_was_trained_on_are_listed_and_left_out_of_the_bakeoff():
    doc = v5_doc()
    run_ = next(r for r in doc["runs"] if r["suite"] == "golden")
    records_ids = [c["trackId"] for c in run_["clips"]]
    run_["trainedOn"] = {"beat-this": {records_ids[0]: "Harmonix Set 0000_song"}}
    block = run_["agreement"]["deezer-bpm"]
    run_["agreement"]["deezer-bpm-unseen"] = {**block, "n": 2}
    text = render(doc)
    assert (
        f"| selected songs in `beat-this`'s training data | 1: {records_ids[0]} (Harmonix Set 0000_song) |"
        in text
    )
    assert "golden previews beat-this was not trained on: agrees with Deezer `bpm`" in text
    assert "without the songs beat-this was trained on" in text
