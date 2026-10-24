import pytest

from evals_audio.datasets import (
    DATASETS,
    SUITE_DATASETS,
    Reference,
    lookup,
    parse_giantsteps_key,
    public_id,
    public_ids,
    select,
)
from evals_audio.metrics import Key


@pytest.mark.parametrize(
    ("label", "key", "reason"),
    [
        ("C minor", Key(0, "minor"), None),
        ("F minor dorian", Key(5, "minor"), None),
        ("Gb major ionian", Key(6, "major"), None),
        ("E major phrygian-major", Key(4, "major"), None),
        (" Ab major \n", Key(8, "major"), None),
        ("E major | E minor", None, "two keys"),
        ("Eb other", None, "mode other than major/minor"),
        ("Bb other monotonic", None, "mode other than major/minor"),
        ("X", None, "no mode"),
        ("", None, "no label"),
        (None, None, "no label"),
        ("D_ major", None, "unparseable"),
        ("Eb^ minor", None, "unparseable"),
    ],
)
def test_giantsteps_key_labels(label, key, reason):
    assert parse_giantsteps_key(label) == (key, reason)


def refs(n):
    out = [Reference(f"t{i:03d}", 100.0 + i, None, f"a/{i}.wav", "0" * 32) for i in range(n)]
    out.append(Reference("bad", None, "no tempo", "a/bad.wav", "0" * 32))
    return out


def test_selection_is_fixed_by_the_seed_and_skips_unusable_tracks():
    a = select(refs(100), 10, seed=3)
    assert a == select(refs(100), 10, seed=3)
    assert a != select(refs(100), 10, seed=4)
    assert len(a) == 10 and all(r.excluded is None for r in a)
    assert [r.track_id for r in a] == sorted(r.track_id for r in a)
    assert len(select(refs(100), None, seed=3)) == 100


def test_every_dataset_records_what_its_licence_covers_and_whom_to_credit():
    for spec in DATASETS.values():
        # The licence row names the annotations; the audio has its own row and no licence.
        assert "creativecommons.org" in spec.annotation_licence
        assert "no licence is stated for the audio" in spec.audio_rights
        assert "never redistributed" in spec.audio_rights
        assert any("doi:" in c for c in spec.credits)
        assert spec.sources and all(url for _, url in spec.sources)
        assert spec.name in SUITE_DATASETS[spec.suite]
    # Where the licence is known only from mirdata, the cell says so.
    assert "per mirdata" in DATASETS["ballroom"].annotation_licence
    assert "per mirdata" in DATASETS["giantsteps-tempo"].annotation_licence


def test_ballroom_ids_are_replaced_by_a_stable_hash_and_can_be_looked_up_locally():
    ballroom, key = DATASETS["ballroom"], DATASETS["giantsteps-key"]
    pid = public_id(ballroom, "Albums-Cafe_Paradiso-07")
    assert pid == public_id(ballroom, "Albums-Cafe_Paradiso-07")  # the same in every run
    assert len(pid) == 10 and "Albums" not in pid and int(pid, 16) >= 0
    assert public_id(key, "43") == "43"  # numeric dataset ids are kept
    rs = refs(20)
    ids = public_ids(ballroom, rs)
    assert len(set(ids.values())) == len(rs)
    assert lookup(ballroom, rs, ids["t007"]) == ["t007"]
    assert lookup(ballroom, rs, "0000000000") == []
