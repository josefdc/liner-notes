"""
The annotated datasets: what they are, where they come from, and how their audio is fetched.

Annotations and track indexes come from mirdata (its loaders, indexes and per-file MD5s). The
audio archives are larger than the data directory's cap allows for both datasets at once
(Ballroom's tar.gz is 1.45 GB before extraction, GiantSteps+'s zip 0.86 GB), so only the
tracks a run selects are fetched, each checked against the MD5 in mirdata's index:

- Ballroom: the tar.gz is streamed and only the selected members are written;
- GiantSteps+ Key: the zip is read with HTTP range requests, member by member;
- GiantSteps Tempo: mirdata cannot fetch this audio. The dataset's own download script
  (audio_dl.sh) names two locations, the Beatport preview URL and a backup at JKU Linz; both
  are tried in that order, per file.

Every write asks the DiskBudget first (storage.py), so a run never takes the data directory
past its cap.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import tarfile
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import numpy as np

from .metrics import Key, parse_key
from .storage import DataCapExceeded, DiskBudget

logger = logging.getLogger("evals_audio")

# Where each audio file was fetched from, per dataset directory.
SOURCES_FILE = ".audio-sources.json"
HTTP_TIMEOUT = httpx.Timeout(60.0, connect=20.0)
USER_AGENT = "liner-notes-evals (dataset fetch)"


@dataclass(frozen=True)
class Dataset:
    name: str  # CLI name
    mirdata_name: str
    suite: str  # "tempo" or "key"
    title: str
    licence: str
    licence_source: str
    sources: tuple[tuple[str, str], ...]  # (what, url)
    annotation_remotes: tuple[str, ...]  # mirdata remotes to download (small)
    annotation_bytes: int  # upper bound on their size once extracted (for the budget)
    reference_note: str
    notes: tuple[str, ...] = field(default_factory=tuple)


DATASETS: dict[str, Dataset] = {
    "ballroom": Dataset(
        name="ballroom",
        mirdata_name="ballroom",
        suite="tempo",
        title="Ballroom (ISMIR 2004 tempo induction contest)",
        licence="CC BY-NC-SA 4.0",
        licence_source="mirdata 1.0.0, mirdata.datasets.ballroom.LICENSE_INFO; "
        "the contest page states no licence",
        sources=(
            ("audio", "https://mtg.upf.edu/ismir2004/contest/tempoContest/data1.tar.gz"),
            ("tempo", "https://mtg.upf.edu/ismir2004/contest/tempoContest/data2.tar.gz"),
            ("index", "https://zenodo.org/records/13993346 (mirdata index 1.0)"),
        ),
        annotation_remotes=("tempo",),
        annotation_bytes=20_000_000,
        reference_note="the contest's ground-truth tempo (one value per excerpt)",
        notes=("698 excerpts of about 30 s from ballroomdancers.com, eight dance styles.",),
    ),
    "giantsteps-tempo": Dataset(
        name="giantsteps-tempo",
        mirdata_name="giantsteps_tempo",
        suite="tempo",
        title="GiantSteps Tempo",
        licence="CC BY-SA 4.0",
        licence_source="mirdata 1.0.0, mirdata.datasets.giantsteps_tempo.LICENSE_INFO; "
        "the annotation repository has no licence file",
        sources=(
            (
                "annotations",
                "https://github.com/GiantSteps/giantsteps-tempo-dataset "
                "(commit 0b7d47ba8cae59d3535a02e3db69e2cf6d0af5bb)",
            ),
            ("audio (primary)", "http://geo-samples.beatport.com/lofi/<id>.LOFI.mp3"),
            ("audio (backup)", "http://www.cp.jku.at/datasets/giantsteps/backup/<id>.LOFI.mp3"),
            ("index", "https://zenodo.org/records/13993327 (mirdata index 2.0)"),
        ),
        annotation_remotes=("annotations",),
        annotation_bytes=60_000_000,
        reference_note="annotations_v2 (Schreiber & Müller 2018): the tempo the most "
        "participants tapped",
        notes=(
            "664 two-minute Beatport previews of electronic dance music.",
            "mirdata does not download this audio; the harness uses the two locations in the "
            "dataset's audio_dl.sh and checks each file's MD5.",
        ),
    ),
    "giantsteps-key": Dataset(
        name="giantsteps-key",
        mirdata_name="giantsteps_key",
        suite="key",
        title="GiantSteps Key, as GiantSteps+ (Faraldo 2017 revision)",
        licence="CC BY-SA 4.0",
        licence_source="Zenodo record 10.5281/zenodo.1095691 metadata; mirdata 1.0.0 agrees",
        sources=(
            ("audio", "https://zenodo.org/records/1095691/files/audio.zip"),
            ("keys", "https://zenodo.org/records/1095691/files/keys.zip"),
            ("metadata", "https://zenodo.org/records/1095691/files/original_metadata.zip"),
            ("index", "https://zenodo.org/records/13993357 (mirdata index '+')"),
        ),
        annotation_remotes=("keys", "metadata"),
        annotation_bytes=20_000_000,
        reference_note="the GiantSteps+ single-key label (keys_gs+), tonic and major/minor",
        notes=(
            "600 two-minute Beatport previews of electronic dance music. mirdata's "
            "giantsteps_key loader is the GiantSteps+ revision of the original GiantSteps Key "
            "labels, with the audio published on Zenodo.",
            "Labels with two keys ('E major | E minor'), 'other' modes, 'X' or a misspelt "
            "tonic are not scored and are counted as unusable; modal labels keep their "
            "major/minor word ('F minor dorian' is scored as F minor).",
        ),
    ),
}

SUITE_DATASETS = {"tempo": ("ballroom", "giantsteps-tempo"), "key": ("giantsteps-key",)}


# --- references ------------------------------------------------------------------------------


def parse_giantsteps_key(label: str | None) -> tuple[Key | None, str | None]:
    """A GiantSteps+ label as a Key, or None and the reason it is not scored."""
    if label is None:
        return None, "no label"
    text = label.strip()
    if not text:
        return None, "no label"
    if "|" in text:
        return None, "two keys"
    words = text.split()
    if len(words) < 2:
        return None, "no mode"
    if words[1].lower() not in ("major", "minor"):
        return None, "mode other than major/minor"
    try:
        return parse_key(words[0], words[1]), None
    except ValueError:
        return None, "unparseable"


@dataclass(frozen=True)
class Reference:
    track_id: str
    value: float | Key | None
    excluded: str | None  # why the track has no usable reference
    audio_rel: str  # path relative to the dataset's data home, as in mirdata's index
    audio_md5: str


def initialize(dataset: Dataset, home: Path):
    import mirdata

    return mirdata.initialize(dataset.mirdata_name, data_home=str(home))


def ensure_annotations(dataset: Dataset, home: Path, budget: DiskBudget) -> None:
    """Download the (small) annotation remotes with mirdata when they are missing."""
    ds = initialize(dataset, home)
    # mirdata keeps its index next to its own code (in this project's environment) and the
    # annotations under `home`; both must be there.
    marker = home / ".annotations-complete"
    if marker.exists() and os.path.exists(ds.index_path):
        return
    budget.require(dataset.annotation_bytes, f"{dataset.name} annotations")
    home.mkdir(parents=True, exist_ok=True)
    ds.download(partial_download=list(dataset.annotation_remotes), cleanup=True)
    marker.write_text("downloaded with mirdata\n")


def references(dataset: Dataset, home: Path) -> list[Reference]:
    ds = initialize(dataset, home)
    index = ds._index["tracks"]
    refs = []
    for tid in sorted(ds.track_ids):
        track = ds.track(tid)
        audio_rel, audio_md5 = index[tid]["audio"]
        try:
            value, excluded = _reference(dataset, track)
        except ValueError:
            # mirdata refuses an empty annotation (GiantSteps Tempo 3041381 has none).
            value, excluded = None, "empty annotation"
        refs.append(Reference(str(tid), value, excluded, audio_rel, audio_md5))
    return refs


def _reference(dataset: Dataset, track) -> tuple[float | Key | None, str | None]:
    value, excluded = None, None
    if dataset.name == "ballroom":
        tempo = track.tempo
        if tempo is None or not tempo > 0:
            excluded = "no tempo"
        else:
            value = float(tempo)
    elif dataset.name == "giantsteps-tempo":
        data = track.tempo_v2
        if data is None or len(data.tempos) == 0:
            excluded = "no tempo"
        else:
            value = float(data.tempos[int(np.argmax(data.confidence))])
    elif dataset.name == "giantsteps-key":
        value, excluded = parse_giantsteps_key(track.key)
    else:
        raise KeyError(dataset.name)
    return value, excluded


def select(refs: list[Reference], limit: int | None, seed: int) -> list[Reference]:
    """`limit` usable tracks drawn at the seed (all of them without a limit), in id order."""
    usable = [r for r in refs if r.excluded is None]
    order = np.random.default_rng(seed).permutation(len(usable))
    chosen = order if limit is None else order[:limit]
    return sorted((usable[i] for i in chosen), key=lambda r: r.track_id)


# --- audio -----------------------------------------------------------------------------------


def _chunks(f, size: int = 1 << 20):
    while block := f.read(size):
        yield block


def md5_of(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def has_audio(home: Path, ref: Reference) -> bool:
    path = home / ref.audio_rel
    return path.is_file() and md5_of(path) == ref.audio_md5


def _write_checked(
    home: Path, ref: Reference, chunks: Iterable[bytes], size: int | None, budget: DiskBudget
) -> bool:
    """Write one file through a .part file; keep it only when its MD5 matches the index."""
    target = home / ref.audio_rel
    budget.require(size if size is not None else 0, f"{ref.audio_rel}")
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    digest = hashlib.md5()
    written = 0
    try:
        with open(part, "wb") as f:
            for chunk in chunks:
                written += len(chunk)
                if size is None and written > budget.cap:
                    raise DataCapExceeded(f"{ref.audio_rel} is larger than the whole cap")
                digest.update(chunk)
                f.write(chunk)
        if size is None and budget.used() > budget.cap:
            raise DataCapExceeded(f"{ref.audio_rel} took {budget.root} past its cap")
        if digest.hexdigest() != ref.audio_md5:
            logger.warning("MD5 mismatch for %s; discarded", ref.audio_rel)
            part.unlink(missing_ok=True)
            return False
        os.replace(part, target)
        return True
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def _fetch_ballroom(home: Path, wanted: list[Reference], budget: DiskBudget, client) -> dict:
    # Members are BallroomData/<style>/<file>.wav; mirdata's index has B_1.0/audio/<style>/...
    by_member = {"BallroomData/" + r.audio_rel.split("B_1.0/audio/", 1)[1]: r for r in wanted}
    got: dict[str, str] = {}
    url = DATASETS["ballroom"].sources[0][1]
    with client.stream("GET", url) as response:
        response.raise_for_status()
        stream = _ResponseStream(response.iter_bytes(1 << 20))
        with tarfile.open(fileobj=stream, mode="r|gz") as tar:
            for member in tar:
                ref = by_member.get(member.name)
                if ref is None or not member.isfile():
                    continue
                f = tar.extractfile(member)
                ok = _write_checked(home, ref, _chunks(f), member.size, budget)
                if ok:
                    got[ref.track_id] = url
                if len(got) == len(wanted):
                    break
    return got


def _fetch_giantsteps_key(home: Path, wanted: list[Reference], budget: DiskBudget, client) -> dict:
    url = DATASETS["giantsteps-key"].sources[0][1]
    got: dict[str, str] = {}
    remote = io.BufferedReader(_HTTPRangeFile(client, url), buffer_size=1 << 20)
    with zipfile.ZipFile(remote) as archive:
        by_name = {
            os.path.basename(info.filename): info
            for info in archive.infolist()
            if not info.filename.startswith("__MACOSX") and not info.is_dir()
        }
        for ref in wanted:
            info = by_name.get(os.path.basename(ref.audio_rel))
            if info is None:
                logger.warning("%s is not in the archive", ref.audio_rel)
                continue
            with archive.open(info) as f:
                if _write_checked(home, ref, _chunks(f), info.file_size, budget):
                    got[ref.track_id] = url
    return got


GIANTSTEPS_TEMPO_LOCATIONS = (
    "http://geo-samples.beatport.com/lofi/",
    "http://www.cp.jku.at/datasets/giantsteps/backup/",
)


def _fetch_giantsteps_tempo(home: Path, wanted: list[Reference], budget: DiskBudget, client):
    got: dict[str, str] = {}
    for ref in wanted:
        name = os.path.basename(ref.audio_rel)
        for base in GIANTSTEPS_TEMPO_LOCATIONS:
            try:
                with client.stream("GET", base + name) as response:
                    if response.status_code != 200:
                        continue
                    size = response.headers.get("content-length")
                    chunks = response.iter_bytes(1 << 20)
                    if _write_checked(home, ref, chunks, int(size) if size else None, budget):
                        got[ref.track_id] = base
                        break
            except httpx.HTTPError as e:
                logger.warning("%s from %s failed: %s", name, base, e)
    return got


FETCHERS: dict[str, Callable] = {
    "ballroom": _fetch_ballroom,
    "giantsteps-key": _fetch_giantsteps_key,
    "giantsteps-tempo": _fetch_giantsteps_tempo,
}


def ensure_audio(
    dataset: Dataset, home: Path, selected: list[Reference], budget: DiskBudget
) -> tuple[set[str], dict[str, str]]:
    """
    Fetch the selected tracks that are missing. Returns the ids whose audio is present and
    verified, and where each of them was fetched from (kept in SOURCES_FILE across runs;
    "unknown" for a file that was already there without a record).
    """
    record_path = home / SOURCES_FILE
    record = json.loads(record_path.read_text()) if record_path.exists() else {}
    missing = [r for r in selected if not has_audio(home, r)]
    if missing:
        logger.warning("fetching %d %s tracks", len(missing), dataset.name)
        headers = {"User-Agent": USER_AGENT}
        with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True, headers=headers) as client:
            fetched = FETCHERS[dataset.name](home, missing, budget, client)
        record.update(fetched)
        record_path.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n")
    present = {r.track_id for r in selected if has_audio(home, r)}
    return present, {tid: record.get(tid, "unknown") for tid in present}


class _ResponseStream(io.RawIOBase):
    """A read-only, non-seekable file over an iterator of byte chunks."""

    def __init__(self, chunks: Iterable[bytes]):
        self._chunks = iter(chunks)
        self._buffer = b""

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while not self._buffer:
            try:
                self._buffer = next(self._chunks)
            except StopIteration:
                return 0
        n = min(len(b), len(self._buffer))
        b[:n] = self._buffer[:n]
        self._buffer = self._buffer[n:]
        return n


class _HTTPRangeFile(io.RawIOBase):
    """A seekable read-only file over HTTP range requests (for reading a remote zip)."""

    def __init__(self, client: httpx.Client, url: str):
        self._client = client
        head = client.head(url)
        head.raise_for_status()
        self._url = str(head.url)
        self._size = int(head.headers["content-length"])
        self._pos = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, base + offset)
        return self._pos

    def readinto(self, b) -> int:
        if self._pos >= self._size:
            return 0
        end = min(self._size, self._pos + len(b)) - 1
        response = self._client.get(self._url, headers={"Range": f"bytes={self._pos}-{end}"})
        if response.status_code != 206:
            raise OSError(f"range request returned {response.status_code}")
        data = response.content
        n = len(data)
        b[:n] = data
        self._pos += n
        return n
