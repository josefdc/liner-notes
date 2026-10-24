"""
What each tempo estimator costs: memory and time on real clips, and what it adds to an install.

Memory and time are measured in a fresh process per estimator (spawned, one thread, as the
suites run), on the clips of a dataset already in the data directory:

- RSS once the service is imported (the same for every estimator: the service imports
  Essentia when it is installed), then once the estimator is ready (beat-this loads torch and
  its checkpoint here);
- the estimator's `tempo()` on each clip, on freshly decoded signals, so each call computes
  what it needs (the onset envelope, its own model), timed in wall and CPU seconds. A clip
  the onset-periodicity minimum stops never reaches the estimator's own work; such clips are
  counted and left out of the times. The first clip that does reach it pays the one-time
  costs (numba compilation for librosa, the first pass through beat-this's model) and is
  reported apart, with its id and the RSS right after it;
- the process's peak RSS at the end (getrusage), which includes that one-time memory.

The thread variables (runner.THREAD_ENV) are forced to 1 for these processes, whatever the
caller's environment says, and recorded.

Install cost is read from the environment, two ways:

- what an estimator adds to the service image as it ships: the service installs its
  `models` extra (essentia-tensorflow, for the fingerprint) whatever the estimator, so the
  packages already in the service's lock (services/audio/uv.lock, runtime and `models`) cost
  nothing more;
- what its extra adds to the harness's base install.

Each with the packages' installed size (the files their metadata lists, what an image layer
holds uncompressed) and the size of the wheel uv.lock pins for this platform. No image is
built here. Model files are counted apart.
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
SERVICE_LOCK = service.SERVICE_DIR / "uv.lock"
SERVICE_PROJECT = "liner-notes-audio"
# What services/audio/Dockerfile installs: `uv sync --no-dev --extra models`.
SERVICE_EXTRAS = ("models",)
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
    _, estimators = service.load()
    rss_service = rss_bytes()
    t0 = time.perf_counter()
    est = service.estimator(name)
    ready_seconds = time.perf_counter() - t0
    rss_ready = rss_bytes()
    first, rss_after_first, runs, stopped = None, None, [], 0
    for dataset, track_id, path, seed, public_id in tasks:
        wav, _ = clips.read_clip(path, seed, dataset, track_id)
        signals = service.decode(wav)
        w0, c0 = time.perf_counter(), time.process_time()
        tempo = est.tempo(signals)
        wall, cpu = time.perf_counter() - w0, time.process_time() - c0
        # onset_periodicity is cached on the signals: reading it again costs nothing.
        if signals.onset_periodicity < estimators.MIN_TEMPO_PERIODICITY:
            stopped += 1
            continue
        if first is None:
            first = {
                "trackId": public_id,
                "wallSeconds": round(wall, 3),
                "cpuSeconds": round(cpu, 3),
            }
            rss_after_first = rss_bytes()
            continue
        runs.append((wall, cpu, tempo is not None))
    walls, cpus = [r[0] for r in runs], [r[1] for r in runs]
    return {
        "clips": len(tasks),
        "stoppedByPeriodicity": stopped,
        "rssServiceBytes": rss_service,
        "rssReadyBytes": rss_ready,
        "rssAfterFirstBytes": rss_after_first,
        "peakRssBytes": peak_rss_bytes(),
        "readySeconds": round(ready_seconds, 3),
        "firstAnalysed": first,
        "perClip": {
            "n": len(runs),
            "medianWallSeconds": round(statistics.median(walls), 3) if runs else None,
            "medianCpuSeconds": round(statistics.median(cpus), 3) if runs else None,
            "maxWallSeconds": round(max(walls), 3) if runs else None,
        },
        "tempoEstimates": sum(1 for r in runs if r[2]),
    }


def measure(names: list[str], tasks: list[tuple], numba_cache: str) -> dict[str, dict]:
    """
    Each estimator in its own fresh process, one after the other (never two at once), with
    every thread variable forced to 1 (a caller's OMP_NUM_THREADS=4 would otherwise make
    beat-this look about three times faster than one thread).
    """
    from .runner import THREAD_ENV

    saved = {var: os.environ.get(var) for var in THREAD_ENV}
    for var in THREAD_ENV:
        os.environ[var] = "1"
    out = {}
    context = multiprocessing.get_context("spawn")
    try:
        for name in names:
            with ProcessPoolExecutor(1, mp_context=context) as pool:
                out[name] = pool.submit(_measure, name, tasks, numba_cache).result()
    finally:
        for var, value in saved.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value
    return out


def thread_settings() -> dict[str, str]:
    from .runner import THREAD_ENV

    return dict.fromkeys(THREAD_ENV, "1")


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


def extra_closure(root: str, extra: str) -> set[str]:
    """The installed distributions the requirements of `root`'s `extra` alone bring, with them."""
    base = {name for name, _ in _requirements(root, set())}
    out: set[str] = set()
    for name, req_extras in _requirements(root, {extra}):
        if name in base:
            continue
        key = _canonical(name)
        try:
            metadata.distribution(key)
        except metadata.PackageNotFoundError:
            continue
        out.add(key)
        out |= closure(key, req_extras)
    return out


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


def service_packages(lock: dict) -> set[str]:
    """
    Every package the service image installs: the service project's runtime dependencies and
    its SERVICE_EXTRAS, followed through the lock (dependencies, and the extras they ask for).
    """
    by_name: dict[str, list[dict]] = {}
    for package in lock.get("package", []):
        by_name.setdefault(_canonical(package["name"]), []).append(package)
    project = by_name[_canonical(SERVICE_PROJECT)][0]
    todo = list(project.get("dependencies", []))
    for extra in SERVICE_EXTRAS:
        todo += project.get("optional-dependencies", {}).get(extra, [])
    seen: set[str] = set()
    while todo:
        dep = todo.pop()
        key = _canonical(dep["name"])
        extras = dep.get("extra", [])
        if key in seen and not extras:
            continue
        seen.add(key)
        for package in by_name.get(key, []):
            todo += package.get("dependencies", [])
            for extra in extras:
                todo += package.get("optional-dependencies", {}).get(extra, [])
    return seen


def _sized(lock: dict, names: list[str], content_length) -> dict:
    packages = []
    for dist_name in names:
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
    return {
        "packages": packages,
        "installedBytes": sum(p["installedBytes"] for p in packages),
        "wheelBytes": None
        if any(p["wheelBytes"] is None for p in packages)
        else sum(p["wheelBytes"] for p in packages),
    }


def install_cost(
    names: list[str],
    content_length=None,
    lock: dict | None = None,
    service_lock: dict | None = None,
) -> dict[str, dict]:
    """
    Per estimator, the packages its extra adds and their sizes: to the service image as it
    ships ("serviceImage") and to the harness's base install (the top-level fields). uv.lock
    records no size for wheels from the PyTorch index; `content_length(url)`, when given, asks
    the index for it.
    """
    lock = lock if lock is not None else tomllib.loads(LOCK_FILE.read_text())
    if service_lock is None:
        service_lock = tomllib.loads(SERVICE_LOCK.read_text())
    shipped = service_packages(service_lock)
    base = closure(PROJECT, set())
    out = {}
    for name in names:
        extra = EXTRAS[name]
        needed = set() if extra is None else closure(PROJECT, {extra})
        own = set() if extra is None else extra_closure(PROJECT, extra)
        harness = _sized(lock, sorted(needed - base), content_length)
        image = _sized(lock, sorted(own - shipped), content_length)
        out[name] = {"extra": extra, **harness, "serviceImage": image}
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
