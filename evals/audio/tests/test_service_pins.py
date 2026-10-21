"""The harness must run the service's numerics: both locks resolve the same versions."""

import tomllib

import pytest

from evals_audio.service import REPO_ROOT, SERVICE_DIR

SHARED = (
    "librosa",
    "numpy",
    "scipy",
    "soundfile",
    "soxr",
    "numba",
    "llvmlite",
    "scikit-learn",
    "essentia-tensorflow",
)


def locked(path):
    with open(path, "rb") as f:
        return {p["name"]: p["version"] for p in tomllib.load(f)["package"]}


@pytest.mark.parametrize("package", SHARED)
def test_same_versions_as_the_service(package):
    service = locked(SERVICE_DIR / "uv.lock")
    harness = locked(REPO_ROOT / "evals" / "audio" / "uv.lock")
    assert package in service, f"{package} is no longer in the service's lock"
    assert harness.get(package) == service[package]
