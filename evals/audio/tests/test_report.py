import json

from evals_audio.datasets import DATASETS
from evals_audio.metrics import Item, compare, coverage_curve, ranking_auc, summarize
from evals_audio.report import SCHEMA_VERSION, add_run, load, render
from evals_audio.runner import withheld_cost

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


def test_an_older_results_file_is_not_merged(tmp_path):
    path = tmp_path / "audio-2026-10-21.json"
    path.write_text(json.dumps({"schemaVersion": 1, "runs": [{"suite": "tempo"}]}))
    assert load(path) == {"schemaVersion": SCHEMA_VERSION, "runs": []}


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
    assert "### Withheld" in text and "correct / n if returned too" in text
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
