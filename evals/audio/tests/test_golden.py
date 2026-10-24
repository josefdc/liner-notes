"""The golden suite's sources and scores, with made-up responses (no network)."""

import json

import httpx
import pytest

from evals_audio import golden
from evals_audio.metrics import Key

NO_PAUSE = {"deezer": 0.0, "musicbrainz": 0.0, "discogs": 0.0}


def paced(handler):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return golden.Paced(client, NO_PAUSE, sleep=lambda s: None)


def row(isrc="GBAAA0000001", deezer_id=1, mbid="rec-1", bpm=None, key=None):
    return golden.Row(isrc, mbid, deezer_id, "obscure", bpm, key)


def test_the_golden_file_reads_with_its_sheet_music_labels():
    rows = golden.read_rows()
    assert len(rows) == len({r.isrc for r in rows}) >= 40
    assert all(r.mbid and r.deezer_id for r in rows)
    labelled = [r for r in rows if r.key is not None]
    assert labelled and all(isinstance(r.key, Key) for r in labelled)
    assert any(r.bpm is not None for r in rows)


def test_selection_is_fixed_by_the_seed():
    rows = [row(isrc=f"GBAAA00000{i:02d}") for i in range(20)]
    assert golden.select(rows, 5, 1) == golden.select(list(reversed(rows)), 5, 1)
    assert golden.select(rows, None, 1) == sorted(rows, key=lambda r: r.isrc)
    assert golden.select(rows, 5, 1) != golden.select(rows, 5, 2)


def test_a_preview_is_downloaded_and_its_url_is_not_kept(tmp_path):
    preview_url = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/abc.mp3?hdnea=exp=1~acl=x"

    def handler(request):
        if request.url.host == "api.deezer.com":
            return httpx.Response(
                200, json={"id": 1, "bpm": 0, "readable": True, "preview": preview_url}
            )
        return httpx.Response(200, content=b"ID3 fake mp3 bytes")

    out = golden.fetch_preview(paced(handler), row(), tmp_path)
    assert out["bpm"] is None  # Deezer's 0 is missing, not a tempo
    assert out["unavailable"] is None
    assert (tmp_path / "GBAAA0000001.mp3").read_bytes() == b"ID3 fake mp3 bytes"
    assert "hdnea" not in json.dumps(out) and "dzcdn" not in json.dumps(out)


@pytest.mark.parametrize(
    "doc, reason",
    [
        ({"id": 1, "bpm": 120.5, "readable": False, "preview": "https://x/p.mp3"}, "no preview"),
        ({"id": 1, "bpm": 120.5, "readable": True, "preview": ""}, "no preview"),
        ({"error": {"type": "DataException"}}, "track lookup error: DataException"),
    ],
)
def test_a_track_without_a_preview_is_recorded_as_unavailable(tmp_path, doc, reason):
    out = golden.fetch_preview(paced(lambda r: httpx.Response(200, json=doc)), row(), tmp_path)
    assert out["unavailable"] == reason and out["path"] is None
    assert not list(tmp_path.iterdir())


def mb_release(release_id, group_id, kind, date, secondary=()):
    return {
        "id": release_id,
        "release-group": {
            "id": group_id,
            "primary-type": kind,
            "secondary-types": list(secondary),
            "first-release-date": date,
        },
    }


def test_the_earliest_single_ep_or_album_without_a_secondary_type_comes_first():
    releases = [
        mb_release("r1", "g-album", "Album", "2001-03-12"),
        mb_release("r2", "g-comp", "Album", "1999-01-01", ["Compilation"]),
        mb_release("r3", "g-single", "Single", "2000-09-28"),
        mb_release("r4", "g-single-same-day", "Album", "2000-09-28"),
        mb_release("r5", "g-other", "Other", "1990-01-01"),
    ]

    def handler(request):
        return httpx.Response(200, json={"release-count": len(releases), "releases": releases})

    groups, members = golden.release_groups(paced(handler), "rec-1")
    assert [g["id"] for g in groups] == ["g-single", "g-single-same-day", "g-album"]
    assert members["g-album"] == ["r1"]


def test_discogs_links_are_read_from_url_relations():
    relations = [
        {"type": "wikidata", "url": {"resource": "https://www.wikidata.org/wiki/Q1"}},
        {"type": "discogs", "url": {"resource": "https://www.discogs.com/master/26637"}},
        {"type": "discogs", "url": {"resource": "https://www.discogs.com/release/123-Title"}},
    ]
    assert golden.discogs_link(relations, "master") == 26637
    assert golden.discogs_link(relations, "release") == 123
    assert golden.discogs_link([], "master") is None


def labels_handler(calls):
    def handler(request):
        calls.append(str(request.url))
        path = request.url.path
        if path == "/ws/2/release":
            return httpx.Response(
                200,
                json={"release-count": 1, "releases": [mb_release("r1", "g1", "Single", "1985")]},
            )
        if path == "/ws/2/release-group/g1":
            return httpx.Response(
                200,
                json={
                    "relations": [
                        {
                            "type": "discogs",
                            "url": {"resource": "https://www.discogs.com/master/28695"},
                        }
                    ]
                },
            )
        if path == "/masters/28695":
            return httpx.Response(
                200, json={"genres": ["Rock", "Electronic"], "styles": ["Synth-pop", "Pop Rock"]}
            )
        return httpx.Response(404)

    return handler


def test_labels_are_fetched_once_and_cached_with_their_source(tmp_path):
    calls = []
    rows = [row()]
    first = golden.ensure_labels(rows, tmp_path, lambda: paced(labels_handler(calls)), "2026-10-24")
    label = first["GBAAA0000001"]
    assert label["discogs"] == {"kind": "master", "id": 28695}
    assert label["styles"] == ["Pop Rock", "Synth-pop"] and label["retrieved"] == "2026-10-24"
    assert label["releaseGroup"]["id"] == "g1"
    n_calls = len(calls)

    def refuse():
        raise AssertionError("cached labels must not be fetched again")

    assert golden.ensure_labels(rows, tmp_path, refuse, "2026-10-25") == first
    assert len(calls) == n_calls


def test_a_network_failure_is_not_cached(tmp_path):
    def handler(request):
        raise httpx.ConnectError("down")

    assert golden.ensure_labels([row()], tmp_path, lambda: paced(handler), "2026-10-24") == {}
    assert not (tmp_path / golden.LABELS_FILE).exists()


def test_hit_rank_needs_the_genre_and_the_style():
    top = ["Pop---Ballad", "Rock---Pop Rock", "Electronic---Synth-pop"]
    assert golden.hit_rank(top, ["Rock", "Electronic"], ["Synth-pop", "Pop Rock"]) == 2
    # "Pop Rock" under Pop is not the release's (genre Rock): no hit at rank 1.
    assert golden.hit_rank(["Pop---Pop Rock"], ["Rock"], ["Pop Rock"]) is None
    assert golden.hit_rank([], ["Rock"], ["Pop Rock"]) is None


def test_the_constant_baseline_uses_the_scores_only():
    tops = [
        [{"label": "A---a", "score": 0.5}, {"label": "B---b", "score": 0.4}],
        [{"label": "B---b", "score": 0.3}, {"label": "C---c", "score": 0.2}],
    ]
    assert golden.constant_top(tops, 2) == ["B---b", "A---a"]


def analysed(tid, top):
    return {
        "trackId": tid,
        "styles": None if top is None else [{"label": t, "score": 0.1} for t in top],
    }


def label(styles=("Synth-pop",), genres=("Electronic",)):
    return {
        "discogs": {"kind": "master", "id": 1},
        "releaseGroup": {"id": "g", "type": "Single", "firstReleaseDate": "1985"},
        "retrieved": "2026-10-24",
        "genres": list(genres),
        "styles": list(styles),
    }


def test_styles_table_counts_hits_over_n_and_over_answered():
    taxonomy = ["Electronic---Synth-pop", "Rock---Pop Rock", "Pop---Ballad"]
    records = [
        analysed("t1", ["Electronic---Synth-pop", "Pop---Ballad"]),  # hit at 1
        analysed("t2", ["Pop---Ballad", "Rock---Pop Rock"]),  # hit at 2
        analysed("t3", None),  # no fingerprint: no hit over n
        analysed("t4", ["Pop---Ballad"]),  # no label: left out
    ]
    labels = {
        "t1": label(),
        "t2": label(styles=["Pop Rock"], genres=["Rock"]),
        "t3": label(),
        "t4": {"missing": "no styles", "styles": []},
    }
    st = golden.styles_table(records, labels, taxonomy)
    assert st["n"] == 3 and st["answered"] == 2 and st["noLabel"] == {"no styles": 1}
    assert st["hits"]["1"]["overN"]["total"] == 1 and st["hits"]["1"]["overN"]["n"] == 3
    assert st["hits"]["5"]["overN"]["total"] == 2
    assert st["hits"]["5"]["overAnswered"]["n"] == 2
    assert [t["hitRank"] for t in st["tracks"]] == [1, 2, None]
    # The baseline answers every track with the same list.
    assert st["baseline"][0] == "Pop---Ballad"
    assert "Synth-pop" not in json.dumps(st["tracks"][0]["discogs"])


def test_agreement_counts_a_withheld_tempo_as_not_agreeing():
    pass_gate = {"passed": True, "reason": None}
    records = [
        {
            "trackId": "a",
            "results": {"x": {"gate": pass_gate, "tempo": {"bpm": 120.0, "confidence": 0.9}}},
        },
        {
            "trackId": "b",
            "results": {
                "x": {
                    "gate": pass_gate,
                    "tempo": None,
                    "tempoWithheld": {"reason": "no estimate", "rules": []},
                }
            },
        },
        {
            "trackId": "c",
            "results": {"x": {"gate": pass_gate, "tempo": {"bpm": 90.0, "confidence": 0.9}}},
        },
    ]
    block = golden.agreement("tempo", {"a": 60.0, "b": 100.0, "c": None}, records, ["x"], 1)
    s = block["summaries"]["x"]
    assert block["n"] == 2 and s["answered"] == 1
    assert s["overN"]["acc1"]["total"] == 0 and s["overN"]["acc2"]["total"] == 1
    assert block["paired"] == []


# --- pacing, retries, headers and caps ------------------------------------------------------


class Clock:
    """A fake monotonic clock that sleeping moves forward."""

    def __init__(self):
        self.t = 100.0
        self.slept = []

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.slept.append(round(seconds, 3))
        self.t += seconds


def test_each_service_keeps_its_own_pause():
    clock = Clock()
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    paced = golden.Paced(client, golden.PAUSES, sleep=clock.sleep, clock=clock)
    paced.get("musicbrainz", "https://mb/1")
    clock.t += 0.2
    paced.get("musicbrainz", "https://mb/2")
    paced.get("discogs", "https://dc/1")  # another service: no wait
    paced.get("discogs", "https://dc/2")
    assert clock.slept == [round(golden.PAUSES["musicbrainz"] - 0.2, 3), golden.PAUSES["discogs"]]
    assert golden.PAUSES["musicbrainz"] >= 1.0  # MusicBrainz allows one request a second


def test_429_and_503_are_retried_after_retry_after_up_to_three_attempts():
    clock = Clock()
    answers = iter(
        [
            httpx.Response(429, headers={"retry-after": "7"}),
            httpx.Response(503),
            httpx.Response(200),
        ]
    )
    client = httpx.Client(transport=httpx.MockTransport(lambda r: next(answers)))
    paced = golden.Paced(client, NO_PAUSE, sleep=clock.sleep, clock=clock)
    assert paced.get("discogs", "https://dc/1").status_code == 200
    assert clock.slept == [7.0, 10.0]

    calls = []

    def always_busy(request):
        calls.append(request)
        return httpx.Response(503)

    client = httpx.Client(transport=httpx.MockTransport(always_busy))
    paced = golden.Paced(client, NO_PAUSE, sleep=lambda s: None)
    assert paced.get("discogs", "https://dc/1").status_code == 503
    assert len(calls) == golden.RETRIES == 3


def test_requests_carry_a_user_agent_with_a_contact():
    seen = []

    def handler(request):
        seen.append(request.headers.get("user-agent"))
        return httpx.Response(200, json={})

    with golden.client(httpx.MockTransport(handler)) as http:
        http.get("https://musicbrainz.org/ws/2/release")
    assert seen == [golden.USER_AGENT]
    assert "@users.noreply.github.com" in golden.USER_AGENT


def test_a_preview_over_the_size_cap_is_stopped_while_streaming(tmp_path, monkeypatch):
    monkeypatch.setattr(golden, "MAX_PREVIEW_BYTES", 10)

    def handler(request):
        if request.url.host == "api.deezer.com":
            return httpx.Response(200, json={"bpm": 120, "preview": "https://cdn/p.mp3"})
        return httpx.Response(200, content=b"x" * 11)

    out = golden.fetch_preview(paced(handler), row(), tmp_path)
    assert out["unavailable"] == "preview larger than expected" and out["path"] is None
    assert not list(tmp_path.iterdir())


def test_a_failed_track_lookup_or_a_network_error_marks_only_that_row(tmp_path):
    out = golden.fetch_preview(paced(lambda r: httpx.Response(500)), row(), tmp_path)
    assert out["unavailable"] == "track lookup returned 500"

    def down(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")

    out = golden.fetch_preview(paced(down), row(), tmp_path)
    assert out["unavailable"] == "network error (ConnectError)"  # the type only, never the URL


def test_musicbrainz_releases_are_read_page_by_page():
    offsets = []
    releases = [mb_release(f"r{i}", f"g{i}", "Album", f"20{i:02d}") for i in range(150)]

    def handler(request):
        offset = int(request.url.params["offset"])
        offsets.append(offset)
        return httpx.Response(
            200, json={"release-count": 150, "releases": releases[offset : offset + 100]}
        )

    groups, _ = golden.release_groups(paced(handler), "rec-1")
    assert offsets == [0, 100] and len(groups) == 150


def test_a_release_link_is_used_when_the_group_has_no_master():
    def handler(request):
        path = request.url.path
        if path == "/ws/2/release":
            return httpx.Response(
                200,
                json={"release-count": 1, "releases": [mb_release("r1", "g1", "Single", "1985")]},
            )
        if path == "/ws/2/release-group/g1":
            return httpx.Response(200, json={"relations": []})
        if path == "/ws/2/release/r1":
            discogs = {"type": "discogs", "url": {"resource": "https://www.discogs.com/release/77"}}
            return httpx.Response(200, json={"relations": [discogs]})
        return httpx.Response(404)

    found = golden.resolve_discogs(paced(handler), "rec-1")
    assert found["discogs"] == {"kind": "release", "id": 77}


def discogs_answer(status):
    def handler(request):
        if request.url.host == "api.discogs.com":
            if status == 200:
                return httpx.Response(200, json={"genres": ["Rock"], "styles": ["Pop Rock"]})
            return httpx.Response(status)
        return labels_handler([])(request)

    return handler


@pytest.mark.parametrize("status", [429, 500, 503])
def test_a_transient_discogs_failure_is_not_cached_and_is_asked_again(tmp_path, status):
    rows = [row()]
    assert golden.ensure_labels(rows, tmp_path, lambda: paced(discogs_answer(status)), "d1") == {}
    labels = golden.ensure_labels(rows, tmp_path, lambda: paced(discogs_answer(200)), "d2")
    assert labels["GBAAA0000001"]["styles"] == ["Pop Rock"]


def test_a_discogs_404_is_a_definitive_miss_and_is_cached(tmp_path):
    labels = golden.ensure_labels([row()], tmp_path, lambda: paced(discogs_answer(404)), "d1")
    assert labels["GBAAA0000001"]["missing"] == "not on Discogs (404)"
    cached = json.loads((tmp_path / golden.LABELS_FILE).read_text())
    assert cached["GBAAA0000001"]["missing"] == "not on Discogs (404)"


def test_the_best_constant_covers_greedily_and_breaks_ties_by_label():
    taxonomy = ["Rock---Pop Rock", "Pop---Ballad", "Electronic---House"]
    labels = [
        (["Rock"], ["Pop Rock"]),
        (["Rock"], ["Pop Rock"]),
        (["Pop"], ["Ballad"]),
        (["Electronic"], ["House"]),
    ]
    assert golden.best_constant(labels, taxonomy, 2) == ["Rock---Pop Rock", "Electronic---House"]
