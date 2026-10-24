import io

import numpy as np
import soundfile as sf

from evals_audio.clips import CLIP_SECONDS, clip_offset, read_clip

SR = 8000


def write_ramp(path, seconds, channels=2):
    n = int(seconds * SR)
    # Each sample holds its own index, so a clip shows exactly where it was cut.
    ramp = (np.arange(n, dtype=np.float64) / n).astype(np.float32)
    data = np.stack([ramp] * channels, axis=1)
    sf.write(path, data, SR, subtype="FLOAT")
    return ramp


def test_offset_is_fixed_by_seed_dataset_and_track(tmp_path):
    n = 120 * SR
    a = clip_offset(n, SR, 1, "giantsteps-key", "42")
    assert a == clip_offset(n, SR, 1, "giantsteps-key", "42")
    others = {
        clip_offset(n, SR, 2, "giantsteps-key", "42"),
        clip_offset(n, SR, 1, "giantsteps-tempo", "42"),
        clip_offset(n, SR, 1, "giantsteps-key", "43"),
    }
    assert a not in others
    for seed in range(50):
        off = clip_offset(n, SR, seed, "d", "t")
        assert 0 <= off <= n - CLIP_SECONDS * SR


def test_short_recordings_are_used_whole():
    assert clip_offset(int(29.5 * SR), SR, 1, "ballroom", "x") == 0
    assert clip_offset(30 * SR, SR, 1, "ballroom", "x") == 0


def test_read_clip_is_deterministic_and_exact(tmp_path):
    path = tmp_path / "long.wav"
    ramp = write_ramp(path, 120)
    wav1, window1 = read_clip(str(path), 5, "giantsteps-key", "7")
    wav2, window2 = read_clip(str(path), 5, "giantsteps-key", "7")
    assert wav1 == wav2 and window1 == window2
    assert window1["durationSeconds"] == 30.0
    assert window1["sourceSeconds"] == 120.0
    clip, sr = sf.read(io.BytesIO(wav1), dtype="float32", always_2d=True)
    assert sr == SR and clip.shape == (30 * SR, 2)
    start = clip_offset(len(ramp), SR, 5, "giantsteps-key", "7")
    assert window1["offsetSeconds"] == round(start / SR, 3)
    np.testing.assert_array_equal(clip[:, 0], ramp[start : start + 30 * SR])


def test_read_clip_keeps_a_short_file_whole(tmp_path):
    path = tmp_path / "short.wav"
    write_ramp(path, 29.2, channels=1)
    wav, window = read_clip(str(path), 1, "ballroom", "x")
    assert window["offsetSeconds"] == 0.0
    assert window["durationSeconds"] == 29.2
