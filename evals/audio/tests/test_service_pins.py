"""
The harness must run the service with the service's own libraries: every package both locks
resolve is at the same version (numerics and web stack alike). When the service's lock changes,
regenerate `constraint-dependencies` in pyproject.toml from it and run `uv lock`.
"""

import tomllib

from evals_audio.service import REPO_ROOT, SERVICE_DIR

# The two projects themselves.
OWN = {"liner-notes-audio", "liner-notes-evals-audio"}
# The numeric core: must stay in both locks, or the comparison above says nothing about it.
CORE = (
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


def test_every_shared_package_has_the_service_version():
    service = locked(SERVICE_DIR / "uv.lock")
    harness = locked(REPO_ROOT / "evals" / "audio" / "uv.lock")
    shared = (set(service) & set(harness)) - OWN
    differ = {p: (service[p], harness[p]) for p in sorted(shared) if service[p] != harness[p]}
    assert differ == {}, f"(service, harness) versions differ: {differ}"
    assert set(CORE) <= shared, f"missing from a lock: {sorted(set(CORE) - shared)}"


def test_the_constraints_list_every_service_runtime_package_the_harness_installs():
    service = locked(SERVICE_DIR / "uv.lock")
    harness = locked(REPO_ROOT / "evals" / "audio" / "uv.lock")
    with open(REPO_ROOT / "evals" / "audio" / "pyproject.toml", "rb") as f:
        constraints = tomllib.load(f)["tool"]["uv"]["constraint-dependencies"]
    pinned = dict(c.split("==") for c in constraints)
    shared = (set(service) & set(harness)) - OWN
    assert {p: service[p] for p in shared} == {p: pinned.get(p) for p in shared}
