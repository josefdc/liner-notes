#!/usr/bin/env python3
"""
Download the Essentia TensorFlow models from the MTG model zoo and verify their checksums.

Models are stored in MODELS_DIR (default: services/audio/models) and used by the service to
estimate valence, danceability, acousticness and instrumentalness. A file is only kept when
its SHA-256 matches the value pinned below; partial or corrupted downloads are removed.
The models are not part of the image: the container fetches them when it starts.

Usage:
    uv run python download_models.py           # download missing models
    uv run python download_models.py --check   # only verify what is on disk
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from dataclasses import dataclass

import httpx

BASE_URL = "https://essentia.upf.edu/models"
MAX_MODEL_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class Model:
    name: str
    filename: str
    url: str
    sha256: str
    description: str


MODELS = (
    # Feature extractors (embedding models)
    Model(
        "musicnn",
        "msd-musicnn-1.pb",
        f"{BASE_URL}/feature-extractors/musicnn/msd-musicnn-1.pb",
        "cdea0722bcee7f731286843f2233e3aa69887bb5c3e2dce011eff55f38d04f3e",
        "MusiCNN feature extractor (200-dim embeddings)",
    ),
    Model(
        "effnet",
        "discogs-effnet-bs64-1.pb",
        f"{BASE_URL}/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb",
        "3ed9af50d5367c0b9c795b294b00e7599e4943244f4cbd376869f3bfc87721b1",
        "EffNet-Discogs feature extractor (1280-dim embeddings)",
    ),
    # Classification heads
    Model(
        "valence",
        "deam-msd-musicnn-2.pb",
        f"{BASE_URL}/classification-heads/deam/deam-msd-musicnn-2.pb",
        "beb5eeb0909266eeb78b8d6bb1323b10829cf2fe55e3c01a13fa1846fa98b371",
        "Valence/arousal regression (DEAM dataset)",
    ),
    Model(
        "danceability",
        "danceability-msd-musicnn-1.pb",
        f"{BASE_URL}/classification-heads/danceability/danceability-msd-musicnn-1.pb",
        "874a4b86afc9e12de3f15a47baf9ff1ac676ace109c56203e26103f2259eb95e",
        "Danceability classifier",
    ),
    Model(
        "acousticness",
        "mood_acoustic-discogs-effnet-1.pb",
        f"{BASE_URL}/classification-heads/mood_acoustic/mood_acoustic-discogs-effnet-1.pb",
        "96a48d403f52fe9047214437fe396dd2f46699da765c911cd6dfbd456a20f733",
        "Acousticness classifier",
    ),
    Model(
        "instrumentalness",
        "voice_instrumental-msd-musicnn-1.pb",
        f"{BASE_URL}/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb",
        "eb762cc7ee6751b2ea32179d3716e2d60a1d1a9e615b7e3b8be8a6f79d71675e",
        "Voice/instrumental classifier",
    ),
)


def models_dir() -> str:
    default = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    return os.environ.get("MODELS_DIR") or default


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_verified(model: Model, directory: str) -> bool:
    """True when the model file exists and its SHA-256 matches the pinned value."""
    try:
        return sha256_of(os.path.join(directory, model.filename)) == model.sha256
    except OSError:
        return False


def download(model: Model, directory: str) -> None:
    """Download one model to a temporary file and move it into place once verified."""
    dest = os.path.join(directory, model.filename)
    partial = dest + ".part"
    digest = hashlib.sha256()
    received = 0
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)
    try:
        with (
            httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False) as client,
            client.stream("GET", model.url) as response,
        ):
            response.raise_for_status()
            with open(partial, "wb") as f:
                for chunk in response.iter_bytes():
                    received += len(chunk)
                    if received > MAX_MODEL_BYTES:
                        raise ValueError(f"larger than {MAX_MODEL_BYTES} bytes")
                    digest.update(chunk)
                    f.write(chunk)
        if digest.hexdigest() != model.sha256:
            raise ValueError(f"checksum mismatch (got {digest.hexdigest()})")
        os.replace(partial, dest)
    finally:
        if os.path.exists(partial):
            os.remove(partial)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download and verify the Essentia models.")
    parser.add_argument(
        "--check", action="store_true", help="verify the models on disk without downloading"
    )
    args = parser.parse_args()

    directory = models_dir()
    print(f"Models directory: {directory}")
    if not args.check:
        os.makedirs(directory, exist_ok=True)

    failed = 0
    for model in MODELS:
        if is_verified(model, directory):
            print(f"  [ok] {model.filename}")
            continue
        if args.check:
            print(f"  [missing or invalid] {model.filename}")
            failed += 1
            continue
        print(f"  [download] {model.filename}: {model.description}")
        try:
            download(model, directory)
            print(f"  [ok] {model.filename}")
        except (httpx.HTTPError, OSError, ValueError) as e:
            print(f"  [failed] {model.filename}: {e}", file=sys.stderr)
            failed += 1

    if failed:
        print(
            f"{failed} model(s) unavailable; the service runs without perceptual features.",
            file=sys.stderr,
        )
        return 1
    print("All models verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
