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
