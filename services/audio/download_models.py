#!/usr/bin/env python3
"""
Download Essentia TensorFlow models from the MTG model zoo.

Models are stored in services/audio/models/ and used by the audio analysis
service to predict valence, danceability, acousticness, and instrumentalness.

Usage:
    python download_models.py
    # or
    uv run python download_models.py
"""

import os
import sys

import requests

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

BASE_URL = "https://essentia.upf.edu/models"

# (local_filename, remote_path, description)
MODELS = [
    # Feature extractors (embedding models)
    (
        "msd-musicnn-1.pb",
        f"{BASE_URL}/feature-extractors/musicnn/msd-musicnn-1.pb",
        "MusiCNN feature extractor (200-dim embeddings)",
    ),
    (
        "discogs-effnet-bs64-1.pb",
        f"{BASE_URL}/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb",
        "EffNet-Discogs feature extractor (1280-dim embeddings)",
    ),
    # Classification heads
    (
        "deam-msd-musicnn-2.pb",
        f"{BASE_URL}/classification-heads/deam/deam-msd-musicnn-2.pb",
        "Valence/arousal regression (DEAM dataset)",
    ),
    (
        "danceability-msd-musicnn-1.pb",
        f"{BASE_URL}/classification-heads/danceability/danceability-msd-musicnn-1.pb",
        "Danceability classifier",
    ),
    (
        "mood_acoustic-discogs-effnet-1.pb",
        f"{BASE_URL}/classification-heads/mood_acoustic/mood_acoustic-discogs-effnet-1.pb",
        "Acousticness classifier",
    ),
    (
        "voice_instrumental-msd-musicnn-1.pb",
        f"{BASE_URL}/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb",
        "Voice/instrumental classifier",
    ),
]


def download_file(url: str, dest: str, description: str) -> bool:
    """Download a file with progress reporting."""
    if os.path.exists(dest):
        size_mb = os.path.getsize(dest) / (1024 * 1024)
        print(f"  [skip] {os.path.basename(dest)} already exists ({size_mb:.1f} MB)")
        return True

    print(f"  [download] {description}")
    print(f"    {url}")

    try:
        response = requests.get(url, stream=True, timeout=120)
        response.raise_for_status()

        total = int(response.headers.get("content-length", 0))
        downloaded = 0

        with open(dest, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = downloaded / total * 100
                    print(
                        f"\r    {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB ({pct:.0f}%)",
                        end="",
                        flush=True,
                    )

        print()  # newline after progress
        size_mb = os.path.getsize(dest) / (1024 * 1024)
        print(f"    saved ({size_mb:.1f} MB)")
        return True

    except Exception as e:
        print(f"\n    ERROR: {e}")
        # Clean up partial download
        if os.path.exists(dest):
            os.remove(dest)
        return False


def main():
    print("Essentia TensorFlow Model Downloader")
    print("=" * 50)
    print(f"Target directory: {MODELS_DIR}\n")

    os.makedirs(MODELS_DIR, exist_ok=True)

    success = 0
    failed = 0

    for filename, url, description in MODELS:
        dest = os.path.join(MODELS_DIR, filename)
        if download_file(url, dest, description):
            success += 1
        else:
            failed += 1

    print(f"\nDone: {success} downloaded, {failed} failed")

    if failed > 0:
        print("WARNING: Some models failed to download. The service will fall back to estimation.")
        sys.exit(1)


if __name__ == "__main__":
    main()
