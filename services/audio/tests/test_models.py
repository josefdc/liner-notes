"""Model checksums: unverified files are never used, and failed downloads leave nothing behind."""

import hashlib

import pytest

import download_models
from download_models import MODELS, Model, is_verified


def test_wrong_bytes_never_verify(tmp_path):
    for model in MODELS:
        (tmp_path / model.filename).write_bytes(b"not the model " + model.name.encode())
    assert [is_verified(m, str(tmp_path)) for m in MODELS] == [False] * len(MODELS)


def test_missing_files_never_verify(tmp_path):
    assert not any(is_verified(m, str(tmp_path)) for m in MODELS)


def test_matching_bytes_verify(tmp_path):
    body = b"model bytes"
    model = Model("x", "x.pb", "unused", hashlib.sha256(body).hexdigest(), "test model")
    (tmp_path / "x.pb").write_bytes(body)
    assert is_verified(model, str(tmp_path))
    (tmp_path / "x.pb").write_bytes(body + b"!")
    assert not is_verified(model, str(tmp_path))


def test_download_with_wrong_checksum_leaves_nothing(cdn, tmp_path):
    base, _ = cdn
    model = Model("x", "x.pb", f"{base}/audio.mp3", "0" * 64, "test model")
    with pytest.raises(ValueError, match="checksum mismatch"):
        download_models.download(model, str(tmp_path))
    assert list(tmp_path.iterdir()) == []


def test_download_with_right_checksum_is_kept(cdn, tmp_path):
    from tests.conftest import SMALL_BODY

    base, _ = cdn
    model = Model("x", "x.pb", f"{base}/audio.mp3", hashlib.sha256(SMALL_BODY).hexdigest(), "")
    download_models.download(model, str(tmp_path))
    assert [p.name for p in tmp_path.iterdir()] == ["x.pb"]
    assert is_verified(model, str(tmp_path))


def test_failed_download_leaves_nothing(cdn, tmp_path):
    base, _ = cdn
    model = Model("x", "x.pb", f"{base}/missing.pb", "0" * 64, "test model")
    with pytest.raises(Exception):  # noqa: B017 - any failure, as long as nothing is kept
        download_models.download(model, str(tmp_path))
    assert list(tmp_path.iterdir()) == []
