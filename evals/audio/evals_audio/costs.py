"""
What each tempo estimator costs: memory and time on real clips, and what it adds to an install.

Memory and time are measured in a fresh process per estimator (spawned, one thread, as the
suites run), on the clips of a dataset already in the data directory:

- RSS once the service is imported (the same for every estimator: the service imports
  Essentia when it is installed), then once the estimator is ready (beat-this loads torch and
  its checkpoint here);
- the estimator's `tempo()` on each clip, on freshly decoded signals, so each call computes
  what it needs (the onset envelope, its own model), timed in wall and CPU seconds. A first
  call on the first clip, which pays one-time costs (numba compilation for librosa), is timed
  apart before every clip is timed;
- the process's peak RSS at the end (getrusage).

Install cost is read from the environment: the packages an extra adds to the harness's base
install (the closure of its requirements that the base closure lacks), with their installed
size (the files their metadata lists) and the size of the wheel uv.lock pins for this
platform. This is what the extra would add to an image, uncompressed and compressed; no image
is built here. Model files are counted apart.
"""

from __future__ import annotations

import multiprocessing
import os
import platform
import resource
import statistics
import time
import tomllib
from concurrent.futures import ProcessPoolExecutor
from importlib import metadata
from pathlib import Path

from . import clips, service

PROJECT = "liner-notes-evals-audio"
LOCK_FILE = Path(__file__).resolve().parents[1] / "uv.lock"
# The extra each estimator needs (librosa is in the base install).
EXTRAS = {"librosa": None, "essentia": "models", "beat-this": "beat-this"}


def rss_bytes() -> int:
    """The current resident set size, from /proc (Linux)."""
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    return 0


def peak_rss_bytes() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024  # KiB on Linux


def _measure(name: str, tasks: list[tuple], numba_cache: str) -> dict:
    os.environ["NUMBA_CACHE_DIR"] = os.path.join(numba_cache, name)
    service.load()
    rss_service = rss_bytes()
    t0 = time.perf_counter()
    est = service.estimator(name)
    ready_seconds = time.perf_counter() - t0
    rss_ready = rss_bytes()

    def timed(task) -> tuple[float, float, bool]:
        dataset, track_id, path, seed = task
        wav, _ = clips.read_clip(path, seed, dataset, track_id)
        signals = service.decode(wav)
        w0, c0 = time.perf_counter(), time.process_time()
        tempo = est.tempo(signals)
        return time.perf_counter() - w0, time.process_time() - c0, tempo is not None

    # The first call pays one-time costs (numba compilation, the first pass through a
    # model); it is timed apart, and then every clip is timed, the first one again.
    first = timed(tasks[0])
    runs = [timed(task) for task in tasks]
    walls, cpus = [r[0] for r in runs], [r[1] for r in runs]
    return {
        "clips": len(tasks),
        "rssServiceBytes": rss_service,
        "rssReadyBytes": rss_ready,
        "peakRssBytes": peak_rss_bytes(),
        "readySeconds": round(ready_seconds, 3),
        "firstCall": {"wallSeconds": round(first[0], 3), "cpuSeconds": round(first[1], 3)},
        "perClip": {
            "n": len(runs),
            "medianWallSeconds": round(statistics.median(walls), 3),
            "medianCpuSeconds": round(statistics.median(cpus), 3),
            "maxWallSeconds": round(max(walls), 3),
        },
        "tempoEstimates": sum(1 for r in runs if r[2]),
    }


def measure(names: list[str], tasks: list[tuple], numba_cache: str) -> dict[str, dict]:
    """Each estimator in its own fresh process, one after the other (never two at once)."""
    from .runner import THREAD_ENV

    for var in THREAD_ENV:
        os.environ.setdefault(var, "1")
    out = {}
    context = multiprocessing.get_context("spawn")
    for name in names:
        with ProcessPoolExecutor(1, mp_context=context) as pool:
            out[name] = pool.submit(_measure, name, tasks, numba_cache).result()
    return out


# --- install cost ----------------------------------------------------------------------------


def _requirements(dist_name: str, extras: set[str]) -> list[tuple[str, set[str]]]:
    """(name, extras) of what an installed distribution requires with `extras`."""
    from packaging.requirements import Requirement

    try:
        dist = metadata.distribution(dist_name)
    except metadata.PackageNotFoundError:
        return []
    out = []
    for raw in dist.requires or []:
        req = Requirement(raw)
        if req.marker is not None:
            envs = [{"extra": e} for e in sorted(extras or {""})]
            if not any(req.marker.evaluate(env) for env in envs):
                continue
        out.append((req.name, set(req.extras)))
    return out


def _canonical(name: str) -> str:
    from packaging.utils import canonicalize_name

    return str(canonicalize_name(name))


def closure(root: str, extras: set[str]) -> set[str]:
    """Installed distributions `root` needs with `extras` (the root itself excluded)."""
    seen: set[str] = set()
    todo = [(root, extras)]
    while todo:
        name, ex = todo.pop()
        for req, req_extras in _requirements(name, ex):
            key = _canonical(req)
            if key in seen:
                continue
            try:
                metadata.distribution(key)
            except metadata.PackageNotFoundError:
                continue
            seen.add(key)
            todo.append((key, req_extras))
    return seen


def installed_bytes(dist_name: str) -> int:
    dist = metadata.distribution(dist_name)
    total = 0
    for f in dist.files or []:
        try:
            total += os.path.getsize(dist.locate_file(f))
        except OSError:
            continue
    return total


def wheel_for(lock: dict, name: str, version: str) -> dict | None:
    """The wheel uv.lock pins for this platform ({url, size}; size None when not recorded)."""
    from urllib.parse import unquote

    from packaging.tags import sys_tags
    from packaging.utils import parse_wheel_filename

    rank = {tag: i for i, tag in enumerate(sys_tags())}
    for package in lock.get("package", []):
        if _canonical(package["name"]) != name or package.get("version") != version:
            continue
        best = None
        for wheel in package.get("wheels", []):
            filename = unquote(wheel["url"].rsplit("/", 1)[-1])
            tags = parse_wheel_filename(filename)[3]
            score = min((rank[t] for t in tags if t in rank), default=None)
            if score is not None and (best is None or score < best[0]):
                best = (score, {"url": wheel["url"], "size": wheel.get("size")})
        if best is not None:
            return best[1]
    return None


def install_cost(names: list[str], content_length=None) -> dict[str, dict]:
    """
    Per estimator, the packages its extra adds and their sizes. uv.lock records no size for
    wheels from the PyTorch index; `content_length(url)`, when given, asks the index for it.
    """
    lock = tomllib.loads(LOCK_FILE.read_text())
    base = closure(PROJECT, set())
    out = {}
    for name in names:
        extra = EXTRAS[name]
        if extra is None:
            out[name] = {"extra": None, "packages": [], "installedBytes": 0, "wheelBytes": 0}
            continue
        added = sorted(closure(PROJECT, {extra}) - base)
        packages = []
        for dist_name in added:
            version = metadata.version(dist_name)
            wheel = wheel_for(lock, dist_name, version) or {}
            size = wheel.get("size")
            if size is None and wheel.get("url") and content_length is not None:
                size = content_length(wheel["url"])
            packages.append(
                {
                    "name": dist_name,
                    "version": version,
                    "installedBytes": installed_bytes(dist_name),
                    "wheelBytes": size,
                }
            )
        out[name] = {
            "extra": extra,
            "packages": packages,
            "installedBytes": sum(p["installedBytes"] for p in packages),
            "wheelBytes": None
            if any(p["wheelBytes"] is None for p in packages)
            else sum(p["wheelBytes"] for p in packages),
        }
    return out


def machine() -> dict:
    cpu = "unknown"
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
    except OSError:
        pass
    return {
        "cpu": cpu,
        "cpus": os.cpu_count(),
        "system": f"{platform.system()} {platform.machine()}",
    }
