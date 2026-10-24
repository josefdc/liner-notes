"""
The golden set (evals/golden.jsonl) on Deezer previews: agreement with Deezer's `bpm` and with
the set's sheet-music labels, and the style fingerprint against Discogs styles.

Nothing here is accuracy against an annotated dataset. Deezer's `bpm` is Deezer's own estimate
(a sourced hint, never a measurement) and the sheet-music labels are nominal markings, so the
tempo and key figures are named *agreement*. The Discogs styles are those of the release a
recording first came out on, so a style hit says the fingerprint names a style the release is
filed under, not that the style is right for the recording. The style model was trained on
Discogs-4M, an unreleased set of about 3.3 million tracks labelled with their Discogs release
styles; well-known recordings such as these may be among them, so a hit may be recall of a
training label rather than a judgement of new music.

Sources, all keyless:

- Deezer, `GET https://api.deezer.com/track/<deezerId>`: the preview and `bpm` (0 is missing).
  Preview URLs are signed and expire within minutes, and Deezer's terms do not allow keeping
  the audio: each preview is downloaded right after its lookup into a temporary directory
  outside the data directory and deleted at the end of the run. URLs are never written down.
- MusicBrainz (`/ws/2/release?recording=<mbid>`, then `/ws/2/release-group/<id>?inc=url-rels`,
  1 request a second): the release groups that carry the row's recording, and their Discogs
  links. Among official singles, EPs and albums with no secondary type (no compilations, live
  albums, remixes or soundtracks), the earliest by first release date is used (a single before
  an EP before an album on the same date), and its Discogs master; when it has none, the
  Discogs release linked from one of its releases; when neither, the next release group.
- Discogs (`GET https://api.discogs.com/masters/<id>` or `/releases/<id>`, 25 requests a
  minute without a token): the genres and styles. Search needs a token and is not used.

The Discogs labels are cached with where they came from and when, in
`<data dir>/golden/discogs.json`, so later runs score against the same labels without asking
again (delete the file to fetch them afresh).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np

from .metrics import Key, parse_key

logger = logging.getLogger("evals_audio")

GOLDEN_FILE = Path(__file__).resolve().parents[2] / "golden.jsonl"
# MusicBrainz asks for a User-Agent that identifies the client and how to reach its maker. This
# names the project and its owner's GitHub identity (a noreply address: an identifier, not a
# monitored mailbox); a reachable contact is the owner's to choose.
USER_AGENT = "liner-notes-evals/0.0 (77589315+josefdc@users.noreply.github.com)"
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=15.0)
DEEZER_TRACK = "https://api.deezer.com/track/{}"
MB_RELEASES = "https://musicbrainz.org/ws/2/release"
MB_RELEASE_GROUP = "https://musicbrainz.org/ws/2/release-group/{}"
MB_RELEASE = "https://musicbrainz.org/ws/2/release/{}"
DISCOGS_API = "https://api.discogs.com/{}s/{}"
# Pauses between requests to each service, inside their published limits.
PAUSES = {"deezer": 0.3, "musicbrainz": 1.1, "discogs": 2.5}
MAX_PREVIEW_BYTES = 5_000_000
# Release groups the Discogs link is taken from, earliest first.
RELEASE_TYPES = ("Single", "EP", "Album")
MAX_RELEASE_GROUPS = 6  # tried per recording before the label is given up as missing
MAX_RELEASES_PER_GROUP = 3  # releases tried for a Discogs release link when a group has none
LABELS_FILE = "discogs.json"
HIT_KS = (1, 5, 10)

DATASET = {
    "name": "golden",
    "title": "Golden set on Deezer previews",
    "file": "evals/golden.jsonl",
    "sources": [
        ["previews and bpm", "https://api.deezer.com/track/<deezerId> (keyless)"],
        [
            "release groups and Discogs links",
            "https://musicbrainz.org/ws/2/ (keyless; data CC0)",
        ],
        [
            "genres and styles",
            "https://api.discogs.com/masters/<id> and /releases/<id> (keyless)",
        ],
    ],
    "audioRights": (
        "Deezer 30 s previews, streamed for analysis into a temporary directory and deleted at "
        "the end of the run; preview URLs are not recorded."
    ),
    "labelRights": (
        "Deezer `bpm` values are Deezer's (the preview coverage report already lists them). "
        "MusicBrainz core data is CC0. Discogs publishes its release data under CC0 (its data "
        "dumps) and its API terms ask for the credit 'Data provided by Discogs'; the results "
        "keep the Discogs ids and the model's hit ranks, not the releases' style lists."
    ),
    "credits": [
        "Deezer API (https://developers.deezer.com/api)",
        "MusicBrainz (https://musicbrainz.org), CC0",
        "Data provided by Discogs (https://www.discogs.com)",
        "Alonso-Jiménez, P., Serra, X., Bogdanov, D. (2022). Music representation learning "
        "based on editorial metadata from Discogs. Proc. ISMIR 2022 (discogs-effnet, the style "
        "model; weights CC BY-NC-SA 4.0, essentia.upf.edu/models)",
    ],
}


@dataclass(frozen=True)
class Row:
    isrc: str
    mbid: str | None
    deezer_id: int | None
    stratum: str
    bpm: float | None  # the set's own label (sheet music), nominal
    key: Key | None


def golden_sha256(path: Path = GOLDEN_FILE) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_rows(path: Path = GOLDEN_FILE) -> list[Row]:
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        doc = json.loads(line)
        labels = doc.get("labels") or {}
        key = None
        if labels.get("key"):
            tonic, mode = labels["key"].split()
            key = parse_key(tonic, mode)
        rows.append(
            Row(
                isrc=doc["isrc"],
                mbid=doc.get("mbid"),
                deezer_id=doc.get("deezerId"),
                stratum=doc["stratum"],
                bpm=None if labels.get("bpm") is None else float(labels["bpm"]),
                key=key,
            )
        )
    return rows


def select(rows: list[Row], limit: int | None, seed: int) -> list[Row]:
    """`limit` rows drawn at the seed (every row without a limit), in ISRC order."""
    ordered = sorted(rows, key=lambda r: r.isrc)
    order = np.random.default_rng(seed).permutation(len(ordered))
    chosen = order if limit is None else order[:limit]
    return sorted((ordered[i] for i in chosen), key=lambda r: r.isrc)


class Paced:
    """
    An httpx client that keeps a minimum pause between requests to each service and retries a
    429 or 503 answer (after its Retry-After, or 5 s, 10 s) up to RETRIES times in all.
    """

    def __init__(
        self,
        client: httpx.Client,
        pauses: dict[str, float] = PAUSES,
        sleep=time.sleep,
        clock=time.monotonic,
    ):
        self.client = client
        self.pauses = pauses
        self.sleep = sleep
        self.clock = clock
        self._last: dict[str, float] = {}

    def _pace(self, service: str) -> None:
        wait = self._last.get(service, -1e9) + self.pauses[service] - self.clock()
        if wait > 0:
            self.sleep(wait)

    def get(self, service: str, url: str, **kwargs) -> httpx.Response:
        for attempt in range(RETRIES):
            self._pace(service)
            response = self.client.get(url, **kwargs)
            self._last[service] = self.clock()
            if response.status_code not in (429, 503) or attempt == RETRIES - 1:
                return response
            retry = response.headers.get("retry-after", "")
            self.sleep(float(retry) if retry.isdigit() else 5.0 * (attempt + 1))
        raise AssertionError("unreachable")

    def download(self, service: str, url: str, limit: int) -> tuple[int, bytes | None]:
        """
        (status, body) of a GET read as a stream; body None when the answer is not 200 or
        would pass `limit` bytes (reading stops there).
        """
        self._pace(service)
        try:
            with self.client.stream("GET", url) as response:
                if response.status_code != 200:
                    return response.status_code, None
                body = bytearray()
                for chunk in response.iter_bytes(1 << 16):
                    body += chunk
                    if len(body) > limit:
                        return response.status_code, None
                return response.status_code, bytes(body)
        finally:
            self._last[service] = self.clock()


RETRIES = 3


def quiet_http_logs() -> None:
    """
    httpx logs every request with its full URL at INFO, and the service's import sets the root
    logger to INFO: a signed preview URL would end up on stderr. Its loggers stay at WARNING.
    """
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    quiet_http_logs()
    return httpx.Client(
        timeout=HTTP_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
        transport=transport,
    )


# --- Deezer ----------------------------------------------------------------------------------


def fetch_preview(paced: Paced, row: Row, directory: Path) -> dict:
    """
    Deezer's view of the row's `deezerId`: its `bpm` (None when 0 or absent) and, when it has a
    preview, the preview downloaded into `directory` (path in "path"). The URL is not kept,
    and a network error marks this row unavailable (by the error's type only: its message can
    carry the URL) without stopping the others.
    """
    out: dict = {"deezerId": row.deezer_id, "bpm": None, "path": None, "unavailable": None}
    if row.deezer_id is None:
        out["unavailable"] = "no deezerId"
        return out
    try:
        return _fetch_preview(paced, row, directory, out)
    except httpx.HTTPError as e:
        out["path"] = None
        out["unavailable"] = f"network error ({type(e).__name__})"
        return out


def _fetch_preview(paced: Paced, row: Row, directory: Path, out: dict) -> dict:
    response = paced.get("deezer", DEEZER_TRACK.format(row.deezer_id))
    if response.status_code != 200:
        out["unavailable"] = f"track lookup returned {response.status_code}"
        return out
    doc = response.json()
    if "error" in doc:
        out["unavailable"] = f"track lookup error: {doc['error'].get('type', 'unknown')}"
        return out
    bpm = doc.get("bpm")
    out["bpm"] = float(bpm) if isinstance(bpm, int | float) and bpm > 0 else None
    url = doc.get("preview") or ""
    if not url or doc.get("readable") is False:
        out["unavailable"] = "no preview"
        return out
    status, body = paced.download("deezer", url, MAX_PREVIEW_BYTES)
    if status != 200:
        out["unavailable"] = f"preview download returned {status}"
        return out
    if body is None:
        out["unavailable"] = "preview larger than expected"
        return out
    if not body:
        out["unavailable"] = "empty preview"
        return out
    path = directory / f"{row.isrc}.mp3"
    path.write_bytes(body)
    out["path"] = str(path)
    return out


# --- MusicBrainz and Discogs -----------------------------------------------------------------


def release_groups(paced: Paced, mbid: str) -> tuple[list[dict], dict[str, list[str]]]:
    """
    The official release groups that carry the recording, candidates first (see the module
    docstring), and the ids of each group's releases that carry it.
    """
    releases, offset = [], 0
    while True:
        response = paced.get(
            "musicbrainz",
            MB_RELEASES,
            params={
                "recording": mbid,
                "inc": "release-groups",
                "status": "official",
                "limit": 100,
                "offset": offset,
                "fmt": "json",
            },
        )
        response.raise_for_status()
        doc = response.json()
        releases += doc.get("releases", [])
        offset += 100
        if offset >= doc.get("release-count", 0):
            break
    groups: dict[str, dict] = {}
    members: dict[str, list[str]] = {}
    for release in releases:
        group = release.get("release-group") or {}
        if group.get("primary-type") not in RELEASE_TYPES or group.get("secondary-types"):
            continue
        groups[group["id"]] = group
        members.setdefault(group["id"], []).append(release["id"])
    order = sorted(
        groups.values(),
        key=lambda g: (
            g.get("first-release-date") or "9999",
            RELEASE_TYPES.index(g["primary-type"]),
            g["id"],
        ),
    )
    return order, {k: sorted(v) for k, v in members.items()}


def discogs_link(relations: list[dict], kind: str) -> int | None:
    """The id of the first Discogs `kind` ("master" or "release") link among url relations."""
    for relation in relations:
        url = ((relation.get("url") or {}).get("resource") or "").rstrip("/")
        prefix = f"https://www.discogs.com/{kind}/"
        if relation.get("type") == "discogs" and url.startswith(prefix):
            tail = url[len(prefix) :].split("-")[0]
            if tail.isdigit():
                return int(tail)
    return None


def resolve_discogs(paced: Paced, mbid: str) -> dict:
    """Where the row's Discogs label comes from: the release group and the Discogs id."""
    groups, members = release_groups(paced, mbid)
    if not groups:
        return {"missing": "no official single, EP or album in MusicBrainz"}
    for group in groups[:MAX_RELEASE_GROUPS]:
        response = paced.get(
            "musicbrainz",
            MB_RELEASE_GROUP.format(group["id"]),
            params={"inc": "url-rels", "fmt": "json"},
        )
        response.raise_for_status()
        found = discogs_link(response.json().get("relations", []), "master")
        kind = "master"
        if found is None:
            kind = "release"
            for release_id in members[group["id"]][:MAX_RELEASES_PER_GROUP]:
                response = paced.get(
                    "musicbrainz",
                    MB_RELEASE.format(release_id),
                    params={"inc": "url-rels", "fmt": "json"},
                )
                response.raise_for_status()
                found = discogs_link(response.json().get("relations", []), "release")
                if found is not None:
                    break
        if found is not None:
            return {
                "releaseGroup": {
                    "id": group["id"],
                    "type": group["primary-type"],
                    "firstReleaseDate": group.get("first-release-date") or None,
                },
                "discogs": {"kind": kind, "id": found},
            }
    return {"missing": "no Discogs link on the earliest release groups"}


def discogs_styles(paced: Paced, kind: str, discogs_id: int) -> dict:
    """
    The genres and styles of a Discogs master or release. Only a 404 is a definitive miss; any
    other failure (429 after the retries, 5xx) raises, so the row is not cached and the next
    run asks again.
    """
    response = paced.get("discogs", DISCOGS_API.format(kind, discogs_id))
    if response.status_code == 404:
        return {"missing": "not on Discogs (404)"}
    response.raise_for_status()
    doc = response.json()
    return {"genres": sorted(doc.get("genres") or []), "styles": sorted(doc.get("styles") or [])}


def ensure_labels(
    rows: list[Row], home: Path, paced_factory: Callable[[], Paced], today: str
) -> dict[str, dict]:
    """
    The Discogs label of every row, from the cache in `home` or fetched (and cached) for the
    rows it lacks. A row whose lookup failed (a network error, a 429 or 5xx answer) is not
    cached, so the next run tries again; a definitive miss (no link, a Discogs 404, no styles)
    is cached as missing.
    """
    path = home / LABELS_FILE
    cache = json.loads(path.read_text()) if path.exists() else {}
    wanted = [r for r in rows if r.isrc not in cache]
    if wanted:
        home.mkdir(parents=True, exist_ok=True)
        paced = paced_factory()
        for row in wanted:
            try:
                label = _label(paced, row)
            except httpx.HTTPError as e:
                logger.warning("Discogs label for %s failed (%s)", row.isrc, type(e).__name__)
                continue
            cache[row.isrc] = {**label, "retrieved": today}
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(cache, indent=1, sort_keys=True) + "\n")
            os.replace(tmp, path)
    return {r.isrc: cache[r.isrc] for r in rows if r.isrc in cache}


def _label(paced: Paced, row: Row) -> dict:
    if not row.mbid:
        return {"missing": "no MusicBrainz recording"}
    found = resolve_discogs(paced, row.mbid)
    if "missing" in found:
        return found
    styles = discogs_styles(paced, found["discogs"]["kind"], found["discogs"]["id"])
    if "missing" in styles:
        return {**found, **styles}
    if not styles["styles"]:
        return {**found, "genres": styles["genres"], "styles": [], "missing": "no styles"}
    return {**found, **styles}


# --- scoring ---------------------------------------------------------------------------------


def split_label(label: str) -> tuple[str, str]:
    genre, _, style = label.partition("---")
    return genre, style


def hit_rank(top: list[str], genres: list[str], styles: list[str]) -> int | None:
    """
    The 1-based rank of the first label in `top` ("Genre---Style") whose genre and style are
    both on the Discogs release, or None.
    """
    genre_set, style_set = set(genres), set(styles)
    for rank, label in enumerate(top, 1):
        genre, style = split_label(label)
        if genre in genre_set and style in style_set:
            return rank
    return None


def in_taxonomy(genres: list[str], styles: list[str], taxonomy) -> int:
    """How many (genre, style) pairs of the release the model can name at all."""
    pairs = {split_label(label) for label in taxonomy}
    return sum(1 for g in genres for s in styles if (g, s) in pairs)


def constant_top(tops: list[list[dict]], k: int) -> list[str]:
    """
    The baseline: one top-k for every track, the model's average output: the labels with the
    highest summed score over the top-10 lists of the scored previews (absent counts as 0;
    ties by label). Built from the model's outputs alone, never from the Discogs labels.
    """
    totals: dict[str, float] = {}
    for top in tops:
        for entry in top:
            totals[entry["label"]] = totals.get(entry["label"], 0.0) + float(entry["score"])
    return [label for label, _ in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))][:k]


def best_constant(labels: list[tuple[list[str], list[str]]], taxonomy, k: int) -> list[str]:
    """
    An optimistic reference, not a baseline: one top-k for every track chosen *with* the
    labels, by greedy cover (each step adds the taxonomy label that hits the most tracks not
    hit yet; ties by label). It is at least (1 - 1/e) of the best possible constant and shows
    how far a fixed answer can go on these tracks.
    """
    hits = {
        label: {i for i, (genres, styles) in enumerate(labels) if hit_rank([label], genres, styles)}
        for label in sorted(taxonomy)
    }
    chosen: list[str] = []
    covered: set[int] = set()
    for _ in range(min(k, len(hits))):
        best = min(
            (label for label in hits if label not in chosen),
            key=lambda label: (-len(hits[label] - covered), label),
        )
        chosen.append(best)
        covered |= hits[best]
    return chosen


# --- the service's fingerprint models --------------------------------------------------------


class ModelsUnavailable(RuntimeError):
    """The fingerprint models could not be fetched or did not match their pinned SHA-256."""


# An upper bound on the six model files (about 22 MB), asked of the budget before fetching.
MODELS_BYTES = 25_000_000


def ensure_models(root: Path, budget) -> Path:
    """
    The service's fingerprint models in `<data dir>/models/essentia`, fetched with the
    service's own download_models.py (pinned URLs and SHA-256) when any is missing.
    """
    from . import service

    service.load()  # puts services/audio on sys.path
    import download_models

    directory = root / "models" / "essentia"
    missing = [
        m for m in download_models.MODELS if not download_models.is_verified(m, str(directory))
    ]
    if missing:
        budget.require(MODELS_BYTES, "the fingerprint models")
        directory.mkdir(parents=True, exist_ok=True)
        for model in missing:
            try:
                download_models.download(model, str(directory))
            except ValueError as e:
                raise ModelsUnavailable(f"{model.filename}: {e}") from e
    return directory


# --- the run's tables ------------------------------------------------------------------------


def agreement(suite: str, values: dict, analysed: list[dict], names: list[str], seed: int) -> dict:
    """
    How often each estimator's answer agrees with `values` (track id -> tempo or Key; None
    left out), scored like the annotated suites (runner.items_for) but over the golden tracks
    that carry a value. Over n a withheld answer counts as not agreeing.
    """
    from .datasets import Reference
    from .metrics import summarize
    from .runner import METRICS, compare_pairs, items_for

    refs = {tid: Reference(tid, v, None, "", "") for tid, v in values.items() if v is not None}
    subset = [a for a in analysed if a["trackId"] in refs]
    items, rows, summaries = {}, {}, {}
    for name in names:
        items[name], rows[name] = items_for(suite, refs, subset, name)
        summaries[name] = summarize(items[name], METRICS[suite], seed).as_dict()
    return {
        "n": len(subset),
        "summaries": summaries,
        "paired": compare_pairs(items, names, METRICS[suite], seed),
        "tracks": rows,
    }


def styles_table(analysed: list[dict], labels: dict[str, dict], taxonomy) -> dict:
    """
    hit@k of the fingerprint's styles against the Discogs styles, over the analysed tracks
    whose release has styles, next to the constant baseline (constant_top), with exact
    McNemar p-values for the difference on the same tracks, and the best constant found with
    the labels (best_constant, a reference). A track without a fingerprint counts as no hit
    over n. The rows keep the model's hit rank, not its top list, and no rank against the
    constant lists: either pairing would name a style the release carries.
    """
    from .metrics import mcnemar_exact, wilson

    scored, no_label = [], {}
    for record in sorted(analysed, key=lambda a: a["trackId"]):
        label = labels.get(record["trackId"])
        if label is None or label.get("missing"):
            reason = "label lookup failed" if label is None else label["missing"]
            no_label[reason] = no_label.get(reason, 0) + 1
            continue
        scored.append((record, label))
    tops = [r.get("styles") for r, _ in scored if r.get("styles")]
    baseline = constant_top(tops, max(HIT_KS))
    best = best_constant([(lb["genres"], lb["styles"]) for _, lb in scored], taxonomy, max(HIT_KS))
    rows, constant_ranks = [], []
    for record, label in scored:
        top = record.get("styles")
        labels_top = [e["label"] for e in top] if top else None
        rows.append(
            {
                "trackId": record["trackId"],
                "discogs": label["discogs"],
                "releaseGroup": label["releaseGroup"],
                "retrieved": label["retrieved"],
                "stylesOnRelease": len(label["styles"]),
                "pairsInTaxonomy": in_taxonomy(label["genres"], label["styles"], taxonomy),
                "fingerprint": top is not None,
                "hitRank": None
                if labels_top is None
                else hit_rank(labels_top, label["genres"], label["styles"]),
                "stylesDiffer": bool(record.get("stylesDiffer")),
            }
        )
        # Kept apart from the rows: with the published constant lists, a per-track rank would
        # name a style the release carries.
        constant_ranks.append(
            (
                hit_rank(baseline, label["genres"], label["styles"]),
                hit_rank(best, label["genres"], label["styles"]),
            )
        )
    n = len(rows)
    answered = [r for r in rows if r["fingerprint"]]
    hits, comparison = {}, {}
    for k in HIT_KS:
        model = [r["hitRank"] is not None and r["hitRank"] <= k for r in rows]
        base = [b is not None and b <= k for b, _ in constant_ranks]
        best_hits = sum(1 for _, b in constant_ranks if b is not None and b <= k)
        only_model = sum(1 for m, b in zip(model, base, strict=True) if m and not b)
        only_base = sum(1 for m, b in zip(model, base, strict=True) if b and not m)
        hits[str(k)] = {
            "overN": wilson(sum(model), n).as_dict(),
            "overAnswered": wilson(
                sum(1 for r in answered if r["hitRank"] is not None and r["hitRank"] <= k),
                len(answered),
            ).as_dict(),
            "baselineOverN": wilson(sum(base), n).as_dict(),
            "bestConstantOverN": wilson(best_hits, n).as_dict(),
        }
        comparison[str(k)] = {
            "onlyModel": only_model,
            "onlyBaseline": only_base,
            "mcnemarP": mcnemar_exact(only_model, only_base),
        }
    return {
        "n": n,
        "answered": len(answered),
        "coverage": wilson(len(answered), n).as_dict(),
        "noLabel": dict(sorted(no_label.items())),
        "outsideTaxonomy": sum(1 for r in rows if r["pairsInTaxonomy"] == 0),
        "baseline": baseline,
        "bestConstant": best,
        "hits": hits,
        "versusBaseline": comparison,
        "tracks": rows,
    }
