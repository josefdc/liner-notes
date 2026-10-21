from evals_audio.report import add_run, render


def run(suite="tempo", dataset="ballroom", n=3):
    metric = {"n": 2, "mean": 0.5, "ciLow": 0.0, "ciHigh": 1.0}
    return {
        "suite": suite,
        "command": f"uv run python -m evals_audio --suite {suite} --limit {n}",
        "startedAt": "2026-10-21T00:00:00Z",
        "wallSeconds": 12.0,
        "jobs": 4,
        "seed": 1,
        "limit": n,
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
            "title": "Ballroom",
            "licence": "CC BY-NC-SA 4.0",
            "licenceSource": "mirdata",
            "sources": [["audio", "https://example.org/a.tar.gz"]],
            "referenceNote": "ground truth",
            "notes": [],
            "tracksInIndex": 698,
            "usable": 698,
            "excluded": {},
            "selected": 3,
            "audioPresent": 3,
            "audioUnavailable": [],
            "audioSources": {},
        },
        "summaries": {
            "librosa": {
                "n": 3,
                "answered": 2,
                "withheld": 1,
                "failed": 0,
                "coverage": 2 / 3,
                "metrics": {"acc1": metric, "acc2": metric},
            }
        },
        "coverage": {
            "librosa": [
                {
                    "coverage": 2 / 3,
                    "answered": 2,
                    "minConfidence": 0.4,
                    "accuracy": {"acc1": 0.5, "acc2": 0.5},
                }
            ]
        },
        "clips": [],
        "tracks": {"librosa": []},
    }


def test_rerunning_a_suite_replaces_its_entry():
    doc = {"schemaVersion": 1, "runs": []}
    doc = add_run(doc, run())
    doc = add_run(doc, run(suite="key", dataset="giantsteps-key"))
    doc = add_run(doc, run(n=5))
    assert [(r["suite"], r["limit"]) for r in doc["runs"]] == [("tempo", 5), ("key", 3)]


def test_render_has_n_ci_withheld_coverage_and_licence():
    text = render({"date": "2026-10-21", "runs": [run()]})
    assert "| `librosa` | 3 | 2 | 1 | 0 | 66.7 % | 50.0 % [0.0, 100.0] |" in text
    assert "### Accuracy vs coverage" in text
    assert "| 66.7 % | 2 | 0.400 | 50.0 % | 50.0 % |" in text
    assert "| licence | CC BY-NC-SA 4.0 |" in text
    assert "--suite tempo --limit 3" in text
    assert "beat-this" in text  # says what is not covered yet


def test_the_markdown_is_rendered_from_the_json_alone(tmp_path):
    import json

    from evals_audio.cli import main

    doc = {"schemaVersion": 1, "date": "2026-10-21", "runs": [run()]}
    path = tmp_path / "audio-2026-10-21.json"
    path.write_text(json.dumps(doc))
    assert main(["--render", str(path)]) == 0
    assert (tmp_path / "audio-2026-10-21.md").read_text() == render(doc)
