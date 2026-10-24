import httpx
import pytest

from evals_audio import cli, datasets
from evals_audio.cli import DownloadFailed, recorded_command


def test_the_recorded_command_leaves_out_local_paths():
    argv = ["--suite", "tempo", "--data-dir", "/home/x/data", "--report-dir=/tmp/r", "--limit", "5"]
    assert recorded_command(argv) == "uv run python -m evals_audio --suite tempo --limit 5"


class Args:
    limit, selection_seed = 1, 1


def failing(error):
    def fail(*args, **kwargs):
        raise error

    return fail


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("refused"),
        datasets.DownloadError("range request returned 403"),
        ConnectionResetError("reset"),
    ],
)
def test_network_failures_are_reported_as_download_failures(monkeypatch, tmp_path, error):
    monkeypatch.setattr(datasets, "ensure_annotations", failing(error))
    with pytest.raises(DownloadFailed):
        cli.fetch(datasets.DATASETS["ballroom"], tmp_path, Args, None)


def test_a_local_write_error_is_not_called_a_download_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(datasets, "ensure_annotations", failing(PermissionError("read-only")))
    with pytest.raises(PermissionError):
        cli.fetch(datasets.DATASETS["ballroom"], tmp_path, Args, None)


def test_main_exits_with_distinct_codes(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LINER_NOTES_DATA", str(tmp_path / "data"))
    monkeypatch.setattr(cli.service, "estimator", lambda name: None)
    argv = ["--suite", "tempo", "--estimator", "librosa", "--limit", "1"]
    monkeypatch.setattr(cli, "run", failing(DownloadFailed("ConnectError: refused")))
    assert cli.main(argv) == 4
    monkeypatch.setattr(cli, "run", failing(PermissionError("read-only")))
    assert cli.main(argv) == 5
    err = capsys.readouterr().err
    assert "a download failed" in err and "a local file could not be read or written" in err


def test_abbreviated_options_are_refused(capsys):
    with pytest.raises(SystemExit):
        cli.parse_args(["--suite", "tempo", "--data-d", "/somewhere"])
    assert "unrecognized arguments" in capsys.readouterr().err


def test_a_suite_refuses_an_estimator_it_cannot_run(capsys):
    with pytest.raises(SystemExit):
        cli.parse_args(["--suite", "key", "--estimator", "beat-this"])
    assert "the key suite does not run beat-this" in capsys.readouterr().err
    assert cli.parse_args(["--suite", "tempo", "--estimator", "beat-this"]).estimator == "beat-this"


def test_the_golden_and_cost_suites_take_their_own_datasets(capsys):
    assert cli.parse_args(["--suite", "golden"]).dataset == "golden"
    assert cli.parse_args(["--suite", "cost"]).dataset == "giantsteps-tempo"
    with pytest.raises(SystemExit):
        cli.parse_args(["--suite", "cost", "--dataset", "giantsteps-key"])
    with pytest.raises(SystemExit):
        cli.parse_args(["--lookup", "abc", "--dataset", "golden"])


def test_a_missing_beat_this_extra_is_an_error_before_any_download(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("LINER_NOTES_DATA", str(tmp_path / "data"))
    monkeypatch.setattr(cli.beatthis, "available", lambda: False)
    monkeypatch.setattr(cli, "fetch_checkpoint", failing(AssertionError("no download expected")))
    assert cli.main(["--suite", "tempo", "--estimator", "beat-this", "--limit", "1"]) == 2
    assert "uv sync --extra beat-this" in capsys.readouterr().err


def test_beat_this_is_marked_as_trained_on_ballroom_only():
    names = ["librosa", "essentia", "beat-this"]
    assert cli.trained_on_dataset(names, "ballroom") == ["beat-this"]
    assert cli.trained_on_dataset(names, "giantsteps-tempo") == []
    assert cli.trained_on_dataset(["librosa"], "ballroom") == []


def test_golden_songs_beat_this_was_trained_on_leave_the_unseen_comparison():
    from evals_audio import beatthis

    seen = next(iter(beatthis.GOLDEN_IN_TRAINING))
    values = {seen: 115.8, "GBAAA0000001": 120.0, "GBAAA0000002": None}
    assert cli.without_training_songs(values) == {"GBAAA0000001": 120.0, "GBAAA0000002": None}
