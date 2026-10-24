import hashlib

import pytest

from evals_audio.datasets import Reference, _write_checked
from evals_audio.storage import (
    DataCapExceeded,
    DataDirBusy,
    DiskBudget,
    SettingError,
    cap_bytes,
    check_outside,
    data_dir,
    disk_usage,
    exclusive,
)


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


def test_cap_settings_are_validated(monkeypatch):
    for bad in ("2GB", "2e9", "-5", "1.5"):
        monkeypatch.setenv("LINER_NOTES_DATA_CAP_BYTES", bad)
        with pytest.raises(SettingError, match="whole number of bytes"):
            cap_bytes()
    monkeypatch.setenv("LINER_NOTES_DATA_CAP_BYTES", "0")
    with pytest.raises(SettingError, match="positive"):
        cap_bytes()


def test_the_data_directory_must_be_outside_the_repository(tmp_path):
    repo = tmp_path / "repo"
    with pytest.raises(SettingError):
        check_outside(repo / "data", repo)
    with pytest.raises(SettingError):
        check_outside(repo, repo)
    check_outside(tmp_path / "data", repo)


def test_one_run_at_a_time_holds_the_data_directory(tmp_path):
    with exclusive(tmp_path):
        with pytest.raises(DataDirBusy):
            with exclusive(tmp_path):
                pass
    with exclusive(tmp_path):  # released after the first run
        pass


def test_a_download_of_unknown_size_counts_what_is_already_there(tmp_path):
    # 90 kB already used, a 100 kB cap and a 90 kB stream of unknown size: stopped while
    # streaming, before the directory passes the cap, not after the whole file is written.
    (tmp_path / "existing").write_bytes(b"x" * 90_000)
    budget = DiskBudget(tmp_path, cap=100_000 + 4096 * 2)
    chunks = [b"z" * 10_000] * 9
    seen = []

    def stream():
        for chunk in chunks:
            seen.append(len(chunk))
            yield chunk

    with pytest.raises(DataCapExceeded):
        _write_checked(tmp_path, ref_for(b"".join(chunks)), stream(), None, budget)
    assert sum(seen) < 90_000
    assert list((tmp_path / "audio").iterdir()) == []


def fake_fetcher(payloads, url="https://example.org/archive", fail_after=None):
    calls = []

    def fetch(home, missing, budget, client, fetched):
        calls.append([r.track_id for r in missing])
        for k, r in enumerate(missing):
            if fail_after is not None and k == fail_after:
                raise DataCapExceeded("cap reached")
            if _write_checked(home, r, [payloads[r.track_id]], len(payloads[r.track_id]), budget):
                fetched(r.track_id, url)

    return fetch, calls


def test_audio_provenance_is_kept_across_runs(tmp_path, monkeypatch):
    from evals_audio import datasets

    payload = b"clip"
    wanted = [ref_for(payload)]
    fetch, calls = fake_fetcher({"t1": payload})
    monkeypatch.setitem(datasets.FETCHERS, "ballroom", fetch)
    budget = DiskBudget(tmp_path, cap=10_000_000)
    spec = datasets.DATASETS["ballroom"]
    first = datasets.ensure_audio(spec, tmp_path, wanted, budget)
    second = datasets.ensure_audio(spec, tmp_path, wanted, budget)
    assert first == second == ({"t1"}, {"t1": "https://example.org/archive"})
    assert calls == [["t1"]]  # the second run found the verified file and fetched nothing


def test_provenance_survives_a_fetch_that_stops_partway(tmp_path, monkeypatch):
    from evals_audio import datasets

    payloads = {"t1": b"one", "t2": b"two"}
    wanted = [
        Reference(t, 120.0, None, f"audio/{t}.wav", hashlib.md5(p).hexdigest())
        for t, p in payloads.items()
    ]
    spec = datasets.DATASETS["ballroom"]
    budget = DiskBudget(tmp_path, cap=10_000_000)
    fetch, _ = fake_fetcher(payloads, fail_after=1)
    monkeypatch.setitem(datasets.FETCHERS, "ballroom", fetch)
    with pytest.raises(DataCapExceeded):
        datasets.ensure_audio(spec, tmp_path, wanted, budget)
    # t1 was written and verified before the fetch stopped: its source is on record.
    fetch, calls = fake_fetcher(payloads, url="https://example.org/second")
    monkeypatch.setitem(datasets.FETCHERS, "ballroom", fetch)
    present, sources = datasets.ensure_audio(spec, tmp_path, wanted, budget)
    assert calls == [["t2"]]
    assert present == {"t1", "t2"}
    assert sources == {"t1": "https://example.org/archive", "t2": "https://example.org/second"}


def test_partial_files_left_by_a_killed_run_are_swept(tmp_path, monkeypatch):
    from evals_audio import datasets

    payload = b"clip"
    stale = tmp_path / "audio" / "t9.wav.part"
    stale.parent.mkdir()
    stale.write_bytes(b"x" * 1000)
    fetch, _ = fake_fetcher({"t1": payload})
    monkeypatch.setitem(datasets.FETCHERS, "ballroom", fetch)
    budget = DiskBudget(tmp_path, cap=10_000_000)
    datasets.ensure_audio(datasets.DATASETS["ballroom"], tmp_path, [ref_for(payload)], budget)
    assert not stale.exists()
