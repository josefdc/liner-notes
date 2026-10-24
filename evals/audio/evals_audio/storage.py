"""
Where the datasets live and how much disk they may use.

The data directory is outside the repository (``~/liner-notes-data`` unless
``LINER_NOTES_DATA`` names another) and holds at most ``LINER_NOTES_DATA_CAP_BYTES`` bytes
(2 GB by default). Every download asks the budget first and is refused when it would take the
directory past the cap (the annotations, small, are checked once against an upper bound on
their size); usage is counted like ``du`` (allocated blocks), so the number matches ``du -s``
on the directory. One run at a time holds the directory.
"""

from __future__ import annotations

import fcntl
import os
from contextlib import contextmanager
from pathlib import Path

DEFAULT_DATA_DIR = "~/liner-notes-data"
DEFAULT_CAP_BYTES = 2_000_000_000


class DataCapExceeded(RuntimeError):
    """A download would take the data directory past its cap."""


class DataDirBusy(RuntimeError):
    """Another run holds the data directory."""


def data_dir(override: str | None = None) -> Path:
    raw = override or os.environ.get("LINER_NOTES_DATA") or DEFAULT_DATA_DIR
    return Path(raw).expanduser().resolve()


class SettingError(ValueError):
    """A data-directory setting that cannot be used."""


def cap_bytes(override: int | None = None) -> int:
    """The cap in bytes: a positive whole number (LINER_NOTES_DATA_CAP_BYTES, default 2 GB)."""
    if override is not None:
        value = override
    else:
        raw = (os.environ.get("LINER_NOTES_DATA_CAP_BYTES") or "").strip()
        if not raw:
            return DEFAULT_CAP_BYTES
        if not raw.isdigit():
            raise SettingError(
                f"LINER_NOTES_DATA_CAP_BYTES must be a whole number of bytes, got {raw!r}"
            )
        value = int(raw)
    if value <= 0:
        raise SettingError(f"the data cap must be positive, got {value}")
    return value


def check_outside(root: Path, repo: Path) -> None:
    """The datasets never live inside the repository (nothing would keep them out of git)."""
    if root == repo or repo in root.parents:
        raise SettingError(f"the data directory {root} is inside the repository {repo}")


@contextmanager
def exclusive(root: Path):
    """
    Hold the data directory for one run: two runs at once would both pass the cap check and
    write the same partial files. A second run is refused, not queued.
    """
    root.mkdir(parents=True, exist_ok=True)
    with open(root / ".lock", "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DataDirBusy(f"another run is using {root}; wait for it to finish") from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def disk_usage(path: Path) -> int:
    """Bytes allocated under `path` (st_blocks, as du counts them); 0 when it does not exist."""
    total = 0
    if not path.exists():
        return 0
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            try:
                st = os.lstat(os.path.join(root, name))
            except FileNotFoundError:
                continue
            total += st.st_blocks * 512
    return total


def human(n: int) -> str:
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1000 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1000
    raise AssertionError("unreachable")


class DiskBudget:
    """
    The cap on one data directory. `require(n)` is called before writing n more bytes and
    raises DataCapExceeded when the directory would go past the cap; nothing is written then.
    Usage is re-measured on every call, so files written by others (mirdata's extraction)
    count too.
    """

    def __init__(self, root: Path, cap: int):
        self.root = root
        self.cap = cap

    def used(self) -> int:
        return disk_usage(self.root)

    def require(self, n_bytes: int, what: str) -> None:
        used = self.used()
        if used + n_bytes > self.cap:
            raise DataCapExceeded(
                f"refusing to download {what}: {human(n_bytes)} more would take {self.root} to "
                f"{human(used + n_bytes)}, past its cap of {human(self.cap)} "
                f"(now {human(used)}; set LINER_NOTES_DATA_CAP_BYTES to change the cap)"
            )
