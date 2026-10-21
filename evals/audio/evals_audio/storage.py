"""
Where the datasets live and how much disk they may use.

The data directory is outside the repository (``~/liner-notes-data`` unless
``LINER_NOTES_DATA`` names another) and holds at most ``LINER_NOTES_DATA_CAP_BYTES`` bytes
(2 GB by default). Every download asks the budget first and is refused when it would take the
directory past the cap; usage is counted like ``du`` (allocated blocks), so the number matches
``du -s`` on the directory.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_DATA_DIR = "~/liner-notes-data"
DEFAULT_CAP_BYTES = 2_000_000_000


class DataCapExceeded(RuntimeError):
    """A download would take the data directory past its cap."""


def data_dir(override: str | None = None) -> Path:
    raw = override or os.environ.get("LINER_NOTES_DATA") or DEFAULT_DATA_DIR
    return Path(raw).expanduser().resolve()


def cap_bytes(override: int | None = None) -> int:
    if override is not None:
        return int(override)
    raw = os.environ.get("LINER_NOTES_DATA_CAP_BYTES")
    return int(raw) if raw else DEFAULT_CAP_BYTES


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
