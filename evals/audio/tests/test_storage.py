import hashlib

import pytest

from evals_audio.datasets import Reference, _write_checked
from evals_audio.storage import DataCapExceeded, DiskBudget, cap_bytes, data_dir, disk_usage


def test_data_dir_and_cap_come_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("LINER_NOTES_DATA", str(tmp_path / "d"))
    monkeypatch.setenv("LINER_NOTES_DATA_CAP_BYTES", "12345")
    assert data_dir() == (tmp_path / "d").resolve()
    assert cap_bytes() == 12345
    monkeypatch.delenv("LINER_NOTES_DATA_CAP_BYTES")
    assert cap_bytes() == 2_000_000_000


def test_disk_usage_counts_allocated_blocks(tmp_path):
    assert disk_usage(tmp_path / "missing") == 0
    (tmp_path / "a").write_bytes(b"x" * 100_000)
    used = disk_usage(tmp_path)
    assert 100_000 <= used < 200_000


def test_budget_refuses_past_the_cap(tmp_path):
    (tmp_path / "a").write_bytes(b"x" * 50_000)
    budget = DiskBudget(tmp_path, cap=100_000)
    budget.require(10_000, "small")
    with pytest.raises(DataCapExceeded, match="refusing to download big"):
        budget.require(60_000, "big")


def ref_for(payload: bytes) -> Reference:
    return Reference("t1", 120.0, None, "audio/t1.wav", hashlib.md5(payload).hexdigest())


def test_a_download_past_the_cap_writes_nothing(tmp_path):
    payload = b"y" * 300_000
    budget = DiskBudget(tmp_path, cap=200_000)
    with pytest.raises(DataCapExceeded):
        _write_checked(tmp_path, ref_for(payload), [payload], len(payload), budget)
    assert not (tmp_path / "audio").exists()


def test_a_download_of_unknown_size_is_stopped_at_the_cap(tmp_path):
    budget = DiskBudget(tmp_path, cap=100_000)
    chunks = [b"z" * 60_000, b"z" * 60_000]
    with pytest.raises(DataCapExceeded):
        _write_checked(tmp_path, ref_for(b"".join(chunks)), chunks, None, budget)
    assert list((tmp_path / "audio").iterdir()) == []


def test_only_files_with_the_indexed_md5_are_kept(tmp_path):
    budget = DiskBudget(tmp_path, cap=10_000_000)
    payload = b"audio bytes"
    assert _write_checked(tmp_path, ref_for(payload), [payload], len(payload), budget)
    assert (tmp_path / "audio" / "t1.wav").read_bytes() == payload
    other = Reference("t2", 120.0, None, "audio/t2.wav", "0" * 32)
    assert not _write_checked(tmp_path, other, [payload], len(payload), budget)
    assert not (tmp_path / "audio" / "t2.wav").exists()
    assert not (tmp_path / "audio" / "t2.wav.part").exists()


def test_audio_provenance_is_kept_across_runs(tmp_path, monkeypatch):
    from evals_audio import datasets

    payload = b"clip"
    wanted = [ref_for(payload)]
    calls = []

    def fake_fetch(home, missing, budget, client):
        calls.append([r.track_id for r in missing])
        for r in missing:
            _write_checked(home, r, [payload], len(payload), budget)
        return {r.track_id: "https://example.org/archive" for r in missing}

    monkeypatch.setitem(datasets.FETCHERS, "ballroom", fake_fetch)
    budget = DiskBudget(tmp_path, cap=10_000_000)
    spec = datasets.DATASETS["ballroom"]
    first = datasets.ensure_audio(spec, tmp_path, wanted, budget)
    second = datasets.ensure_audio(spec, tmp_path, wanted, budget)
    assert first == second == ({"t1"}, {"t1": "https://example.org/archive"})
    assert calls == [["t1"]]  # the second run found the verified file and fetched nothing
