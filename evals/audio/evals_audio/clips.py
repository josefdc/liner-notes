"""
30-second clips at a fixed seed.

The service analyses 30-second previews, so every track is cut to one 30 s window before it is
analysed. The window's start depends only on the seed, the dataset and the track id (a SHA-256
of the three), never on the order or the number of tracks in a run, so a track gets the same
clip in every run with the same seed. A recording of 30 s or less is used whole.
"""

from __future__ import annotations

import hashlib
import io

import numpy as np
import soundfile as sf

CLIP_SECONDS = 30.0


def unit_fraction(seed: int, dataset: str, track_id: str) -> float:
    """A number in [0, 1) fixed by (seed, dataset, track_id)."""
    digest = hashlib.sha256(f"{seed}\x1f{dataset}\x1f{track_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def clip_offset(
    n_frames: int, sr: int, seed: int, dataset: str, track_id: str, seconds: float = CLIP_SECONDS
) -> int:
    """First frame of the clip: uniform over the starts that keep the whole clip in the file."""
    length = int(round(seconds * sr))
    slack = n_frames - length
    if slack <= 0:
        return 0
    return int(unit_fraction(seed, dataset, track_id) * (slack + 1))


def read_clip(
    path: str, seed: int, dataset: str, track_id: str, seconds: float = CLIP_SECONDS
) -> tuple[bytes, dict]:
    """
    The clip as a 32-bit float WAV (all channels, the file's own rate), ready for the service's
    decoder, and where it was cut. The whole file is decoded first so the cut is
    sample-exact whatever the format's seeking does.
    """
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    n_frames = data.shape[0]
    start = clip_offset(n_frames, sr, seed, dataset, track_id, seconds)
    stop = min(n_frames, start + int(round(seconds * sr)))
    buffer = io.BytesIO()
    sf.write(buffer, np.ascontiguousarray(data[start:stop]), sr, format="WAV", subtype="FLOAT")
    window = {
        "offsetSeconds": round(start / sr, 3),
        "durationSeconds": round((stop - start) / sr, 3),
        "sourceSeconds": round(n_frames / sr, 3),
        "sampleRate": int(sr),
    }
    return buffer.getvalue(), window
