import pytest

from evals_audio.datasets import DATASETS, SUITE_DATASETS, Reference, parse_giantsteps_key, select
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


def test_every_dataset_records_its_licence_and_sources():
    for spec in DATASETS.values():
        assert spec.licence and spec.licence_source
        assert spec.sources and all(url for _, url in spec.sources)
        assert spec.name in SUITE_DATASETS[spec.suite]
