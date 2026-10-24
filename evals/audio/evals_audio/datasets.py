"""
The annotated datasets: what they are, where they come from, and how their audio is fetched.

Annotations and track indexes come from mirdata (its loaders, indexes and per-file MD5s); mirdata
fetches only the annotations. The audio archives are larger than the data directory's cap
allows for both datasets at once (Ballroom's tar.gz is 1.45 GB before extraction, GiantSteps+'s
zip 0.86 GB), so the harness fetches only the tracks a run selects, each checked against the
MD5 in mirdata's index:

- Ballroom: the tar.gz is streamed and only the selected members are written. The archive is
  read until the last selected member arrives, which for a draw across all dance styles is
  most of the 1.45 GB (network, not disk);
- GiantSteps+ Key: the zip is read with HTTP range requests, member by member;
- GiantSteps Tempo: mirdata cannot fetch this audio. The dataset's download script names two
  locations; since 2025 upstream (GiantSteps/giantsteps-tempo-dataset 2ea2180) it tries the
  JKU Linz copy first because the Beatport URLs no longer work, and so does the harness.

Every file's source (the URL actually used, after redirects) is recorded in SOURCES_FILE as
soon as the file is written and verified. Writes ask the DiskBudget first (storage.py).
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import shutil
import tarfile
import time
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import numpy as np

from .metrics import Key, parse_key
from .storage import DataCapExceeded, DiskBudget

logger = logging.getLogger("evals_audio")


class DownloadError(OSError):
    """A remote answered in a way the fetch cannot use (e.g. a range request not honoured)."""


# Where each audio file was fetched from, per dataset directory.
SOURCES_FILE = ".audio-sources.json"
HTTP_TIMEOUT = httpx.Timeout(60.0, connect=20.0)
USER_AGENT = "liner-notes-evals (dataset fetch)"
RETRY_PAUSE_S = 2.0

CC_BY_SA = "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)"
CC_BY_NC_SA = "CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/)"
KNEES_2015 = (
    "Knees, P., Faraldo, Á., Herrera, P., Vogl, R., Böck, S., Hörschläger, F., Le Goff, M. "
    "(2015). Two data sets for tempo estimation and key detection in electronic dance music "
    "annotated from user corrections. Proc. ISMIR 2015, 364-370. doi:10.5281/zenodo.1414996"
)


@dataclass(frozen=True)
class Dataset:
    name: str  # CLI name
    mirdata_name: str
    suite: str  # "tempo" or "key"
    title: str
    annotation_licence: str  # what covers the labels
    audio_rights: str  # what covers the audio (none of the sources licenses it)
    sources: tuple[tuple[str, str], ...]  # (what, url)
    credits: tuple[str, ...]  # citations to give when the data is used
    annotation_remotes: tuple[str, ...]  # mirdata remotes to download (small)
    annotation_bytes: int  # upper bound on their size once extracted (for the budget)
    reference_note: str
    notes: tuple[str, ...] = field(default_factory=tuple)
    # The dataset's track ids are audio file names that carry album or artist names; results
    # use a short hash of the id instead (public_id), looked up locally with --lookup.
    hash_ids: bool = False


COMMERCIAL_AUDIO = (
    "commercial excerpts ({}); no licence is stated for the audio. Fetched into the local data "
    "directory for evaluation only and never redistributed: the repository holds no audio and "
    "no audio file names."
)

DATASETS: dict[str, Dataset] = {
    "ballroom": Dataset(
        name="ballroom",
        mirdata_name="ballroom",
        suite="tempo",
        title="Ballroom (ISMIR 2004 tempo induction contest)",
        annotation_licence=f"{CC_BY_NC_SA}, per mirdata 1.0.0 (ballroom.LICENSE_INFO); "
        "not stated by the dataset: the contest page states no licence",
        audio_rights=COMMERCIAL_AUDIO.format("BallroomDancers.com, credited on the contest page"),
        sources=(
            ("audio", "https://mtg.upf.edu/ismir2004/contest/tempoContest/data1.tar.gz"),
            ("tempo", "https://mtg.upf.edu/ismir2004/contest/tempoContest/data2.tar.gz"),
            ("index", "https://zenodo.org/records/13993346 (mirdata index 1.0)"),
        ),
        credits=(
            "Gouyon, F., Klapuri, A., Dixon, S., Alonso, M., Tzanetakis, G., Uhle, C., Cano, P. "
            "(2006). An experimental comparison of audio tempo induction algorithms. IEEE "
            "Transactions on Audio, Speech, and Language Processing 14(5), 1832-1844. "
            "doi:10.1109/TSA.2005.858509",
        ),
        annotation_remotes=("tempo",),
        annotation_bytes=20_000_000,
        hash_ids=True,
        reference_note="the contest's ground-truth tempo (one value per excerpt)",
        notes=(
            "698 excerpts of about 30 s from BallroomDancers.com, eight dance styles, so the "
            "30 s window covers nearly all of each excerpt.",
            "Published Ballroom figures use all 698 excerpts; a sample of n clips is only "
            "comparable within its interval.",
            "Ballroom's track ids are its file names (album names included), so the results "
            "use the first 10 hex digits of a SHA-256 of the dataset name and the id; `uv run "
            "python -m evals_audio "
            "--lookup ID --dataset ballroom` maps one back from the local index.",
        ),
    ),
    "giantsteps-tempo": Dataset(
        name="giantsteps-tempo",
        mirdata_name="giantsteps_tempo",
        suite="tempo",
        title="GiantSteps Tempo",
        annotation_licence=f"{CC_BY_SA}, per mirdata 1.0.0 (giantsteps_tempo.LICENSE_INFO); "
        "not stated by the dataset: the annotation repository has no licence",
        audio_rights=COMMERCIAL_AUDIO.format("Beatport two-minute previews"),
        sources=(
            (
                "annotations",
                "https://github.com/GiantSteps/giantsteps-tempo-dataset "
                "(commit 0b7d47ba8cae59d3535a02e3db69e2cf6d0af5bb)",
            ),
            ("audio (first)", "https://www.cp.jku.at/datasets/giantsteps/backup/<id>.LOFI.mp3"),
            ("audio (second)", "https://geo-samples.beatport.com/lofi/<id>.LOFI.mp3"),
            ("index", "https://zenodo.org/records/13993327 (mirdata index 2.0)"),
        ),
        credits=(
            KNEES_2015,
            "Schreiber, H., Müller, M. (2018). A crowdsourced experiment for tempo estimation "
            "of electronic dance music. Proc. ISMIR 2018. doi:10.5281/zenodo.1492437 "
            "(the v2 annotations used here)",
        ),
        annotation_remotes=("annotations",),
        annotation_bytes=60_000_000,
        reference_note="annotations_v2 (Schreiber & Müller 2018): of the tempi the crowd "
        "tapped, the one with the highest share",
        notes=(
            "664 two-minute Beatport previews of electronic dance music.",
            "mirdata does not download this audio; the harness uses the locations in the "
            "dataset's download script and checks each file's MD5.",
            "Published GiantSteps Tempo figures are computed on the whole two-minute previews, "
            "mostly against the v1 labels; here one 30 s window per preview is scored against "
            "v2, and the window can fall on an intro, a breakdown or the fade. Not comparable.",
        ),
    ),
    "giantsteps-key": Dataset(
        name="giantsteps-key",
        mirdata_name="giantsteps_key",
        suite="key",
        title="GiantSteps Key, as GiantSteps+ (Faraldo 2017 revision)",
        annotation_licence=f"{CC_BY_SA}, stated in the Zenodo record "
        "(10.5281/zenodo.1095691); mirdata 1.0.0 agrees",
        audio_rights=COMMERCIAL_AUDIO.format(
            "Beatport two-minute previews; the record says the audio belongs to Beatport"
        ),
        sources=(
            ("audio", "https://zenodo.org/records/1095691/files/audio.zip"),
            ("keys", "https://zenodo.org/records/1095691/files/keys.zip"),
            ("metadata", "https://zenodo.org/records/1095691/files/original_metadata.zip"),
            ("index", "https://zenodo.org/records/13993357 (mirdata index '+')"),
        ),
        credits=(
            "Faraldo, Á. (2017). GiantSteps+ EDM Key Dataset. Zenodo. doi:10.5281/zenodo.1095691",
            "Faraldo, Á. (2017). Tonality Estimation in Electronic Dance Music: A "
            "Computational and Musically Informed Examination. PhD thesis, Universitat Pompeu "
            "Fabra, Barcelona",
            KNEES_2015 + " (the original GiantSteps Key dataset)",
            "The record's description asks for 10.5281/zenodo.1101082, but that DOI resolves "
            "to a different record (the Beatport EDM Key Dataset, 1,486 excerpts); the record "
            "used here is cited above",
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
            "Published GiantSteps Key figures are computed on the whole two-minute previews, "
            "mostly against the original 2015 labels; here one 30 s window per preview is "
            "scored against GiantSteps+ with the ambiguous labels left out. Not comparable.",
        ),
    ),
}

SUITE_DATASETS = {
    "tempo": ("ballroom", "giantsteps-tempo"),
    "key": ("giantsteps-key",),
    # The golden set's Deezer previews (evals_audio.golden), not a mirdata dataset.
    "golden": ("golden",),
    # What each tempo estimator costs, measured on clips of a tempo dataset (evals_audio.costs).
    "cost": ("giantsteps-tempo", "ballroom"),
}


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
    # GiantSteps Tempo: the v1 tempo (Knees et al. 2015), the number of crowd tempi in v2 and
    # the share gap between the top two (near ties make the v2 reference fragile).
    details: dict = field(default_factory=dict, compare=False)


def initialize(dataset: Dataset, home: Path):
    import mirdata

    return mirdata.initialize(dataset.mirdata_name, data_home=str(home))


def ensure_annotations(dataset: Dataset, home: Path, budget: DiskBudget) -> None:
    """
    Download the (small) annotation remotes with mirdata when they are missing. The budget is
    asked once for an upper bound on their extracted size (mirdata's own download and
    extraction are not metered file by file). mirdata keeps its index next to its own code, in
    this project's environment, not in the data directory.
    """
    ds = initialize(dataset, home)
    marker = home / ".annotations-complete"
    if marker.exists():
        if not os.path.exists(ds.index_path):
            # A new environment: only the index is missing, the annotations are on disk.
            ds.download(partial_download=["index"])
        return
    budget.require(dataset.annotation_bytes, f"{dataset.name} annotations")
    home.mkdir(parents=True, exist_ok=True)
    ds.download(partial_download=list(dataset.annotation_remotes), cleanup=True)
    # macOS resource forks that come with keys.zip.
    shutil.rmtree(home / "__MACOSX", ignore_errors=True)
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
        details = _details(dataset, track) if excluded is None else {}
        refs.append(Reference(str(tid), value, excluded, audio_rel, audio_md5, details))
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


def _details(dataset: Dataset, track) -> dict:
    if dataset.name != "giantsteps-tempo":
        return {}
    shares = sorted((float(c) for c in track.tempo_v2.confidence), reverse=True)
    try:
        v1 = track.tempo
        v1_tempo = None if v1 is None or len(v1.tempos) == 0 else float(v1.tempos[0])
    except ValueError:
        v1_tempo = None
    return {
        "v1": v1_tempo,
        "crowdTempi": len(shares),
        "topGap": shares[0] - shares[1] if len(shares) > 1 else 1.0,
    }


PUBLIC_ID_HEX = 10


def public_id(dataset: Dataset, track_id: str) -> str:
    """
    The id a track goes by in the committed results: the dataset's own id, or for a dataset
    whose ids are file names (hash_ids) the first PUBLIC_ID_HEX hex digits of the SHA-256 of
    (dataset, id). It depends on nothing else, so it is the same in every run.
    """
    if not dataset.hash_ids:
        return track_id
    digest = hashlib.sha256(f"{dataset.name}\x1f{track_id}".encode()).hexdigest()
    return digest[:PUBLIC_ID_HEX]


def public_ids(dataset: Dataset, refs: Iterable[Reference]) -> dict[str, str]:
    """public_id for every reference; refuses a collision (none at 40 bits for these sizes)."""
    ids = {r.track_id: public_id(dataset, r.track_id) for r in refs}
    if len(set(ids.values())) != len(ids):
        raise ValueError(f"two {dataset.name} track ids share a public id")
    return ids


def lookup(dataset: Dataset, refs: Iterable[Reference], pid: str) -> list[str]:
    """The dataset's track ids whose public id is `pid` (local only: it needs the index)."""
    return [r.track_id for r in refs if public_id(dataset, r.track_id) == pid]


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
    """
    Write one file through a .part file; keep it only when its MD5 matches the index. A file
    of known size is refused before anything is written when it does not fit; one of unknown
    size is stopped as soon as the directory would pass the cap.
    """
    target = home / ref.audio_rel
    used = budget.used()
    budget.require(size if size is not None else 0, f"{ref.audio_rel}")
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    digest = hashlib.md5()
    written = 0
    try:
        with open(part, "wb") as f:
            for chunk in chunks:
                written += len(chunk)
                if size is None and used + written > budget.cap:
                    raise DataCapExceeded(
                        f"{ref.audio_rel} (size unknown) would take {budget.root} past its cap"
                    )
                digest.update(chunk)
                f.write(chunk)
        if digest.hexdigest() != ref.audio_md5:
            logger.warning("MD5 mismatch for %s; discarded", ref.audio_rel)
            part.unlink(missing_ok=True)
            return False
        os.replace(part, target)
        return True
    except BaseException:
        part.unlink(missing_ok=True)
        raise


Fetched = Callable[[str, str], None]  # (track id, URL actually used)


def _fetch_ballroom(home, wanted, budget, client, fetched: Fetched) -> None:
    # Members are BallroomData/<style>/<file>.wav; mirdata's index has B_1.0/audio/<style>/...
    by_member = {"BallroomData/" + r.audio_rel.split("B_1.0/audio/", 1)[1]: r for r in wanted}
    left = len(wanted)
    with client.stream("GET", DATASETS["ballroom"].sources[0][1]) as response:
        response.raise_for_status()
        url = str(response.url)
        stream = _ResponseStream(response.iter_bytes(1 << 20))
        with tarfile.open(fileobj=stream, mode="r|gz") as tar:
            for member in tar:
                ref = by_member.get(member.name)
                if ref is None or not member.isfile():
                    continue
                f = tar.extractfile(member)
                if _write_checked(home, ref, _chunks(f), member.size, budget):
                    fetched(ref.track_id, url)
                left -= 1
                if left == 0:
                    break


def _fetch_giantsteps_key(home, wanted, budget, client, fetched: Fetched) -> None:
    raw = _HTTPRangeFile(client, DATASETS["giantsteps-key"].sources[0][1])
    with zipfile.ZipFile(io.BufferedReader(raw, buffer_size=1 << 20)) as archive:
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
                    fetched(ref.track_id, raw.url)


# The order of the dataset's current download script (JKU first since 2025).
GIANTSTEPS_TEMPO_LOCATIONS = (
    "https://www.cp.jku.at/datasets/giantsteps/backup/",
    "https://geo-samples.beatport.com/lofi/",
)


def _fetch_giantsteps_tempo(home, wanted, budget, client, fetched: Fetched) -> None:
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
                        fetched(ref.track_id, str(response.url))
                        break
            except httpx.HTTPError as e:
                logger.warning("%s from %s failed: %s", name, base, e)


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
    verified, and where each of them was fetched from (SOURCES_FILE, written after every file,
    so an interrupted fetch keeps what it got; "unknown" for a file without a record).
    """
    # Partial files left by a killed run.
    for stale in home.rglob("*.part") if home.exists() else ():
        stale.unlink(missing_ok=True)
    record_path = home / SOURCES_FILE
    record = json.loads(record_path.read_text()) if record_path.exists() else {}

    def fetched(track_id: str, url: str) -> None:
        record[track_id] = url
        tmp = record_path.with_name(record_path.name + ".tmp")
        tmp.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n")
        os.replace(tmp, record_path)

    missing = [r for r in selected if not has_audio(home, r)]
    if missing:
        logger.warning("fetching %d %s tracks", len(missing), dataset.name)
        headers = {"User-Agent": USER_AGENT}
        with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True, headers=headers) as client:
            FETCHERS[dataset.name](home, missing, budget, client, fetched)
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
    """
    A seekable read-only file over HTTP range requests (for reading a remote zip). A failed
    range read is retried once, after resolving the URL again (redirect targets can expire).
    """

    def __init__(self, client: httpx.Client, url: str):
        self._client = client
        self._origin = url
        self._resolve()
        self._pos = 0

    def _resolve(self) -> None:
        head = self._client.head(self._origin)
        head.raise_for_status()
        self.url = str(head.url)
        self._size = int(head.headers["content-length"])

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

    def _range(self, start: int, end: int) -> bytes:
        response = self._client.get(self.url, headers={"Range": f"bytes={start}-{end}"})
        if response.status_code != 206:
            raise DownloadError(f"range request returned {response.status_code}")
        return response.content

    def readinto(self, b) -> int:
        if self._pos >= self._size:
            return 0
        end = min(self._size, self._pos + len(b)) - 1
        try:
            data = self._range(self._pos, end)
        except (OSError, httpx.HTTPError) as e:
            logger.warning("range read failed (%s); retrying once", e)
            time.sleep(RETRY_PAUSE_S)
            self._resolve()
            data = self._range(self._pos, end)
        n = len(data)
        b[:n] = data
        self._pos += n
        return n
