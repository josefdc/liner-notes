"""
Checks every analysis result in the tests goes through:

- the v2 block, after a strict JSON round trip (json.dumps(allow_nan=False): JSON Schema range
  checks accept NaN and infinity), validates against the contract's committed JSON Schema
  (packages/contract/schemas/audio-features.schema.json), which states the gate with if/then,
  plus the producer-side checks of the contract (finite numbers, scores within their range);
- the v1 fields say nothing that v2 withholds or contradicts: they are derived from it.
"""

import json
import math
import os

import jsonschema

SCHEMA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "packages", "contract", "schemas"
)
with open(os.path.join(SCHEMA_PATH, "audio-features.schema.json")) as f:
    SCHEMA = json.load(f)
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
MEASURED_BLOCKS = ["tempo", "key", "loudness", "beats", "energyContour", "sections", "fingerprint"]
PERCEPTUAL = {
    "danceability": "danceability",
    "acousticness": "acoustic",
    "instrumentalness": "instrumental",
}


def check_v2(v2: dict) -> dict:
    """Strict JSON round trip, the contract's JSON Schema, and the producer-side checks."""
    data = json.loads(json.dumps(v2, allow_nan=False))
    errors = sorted(VALIDATOR.iter_errors(data), key=lambda e: list(e.path))
    assert not errors, [f"{list(e.path)}: {e.message}" for e in errors]
    duration = data["window"]["durationSeconds"]
    if data["beats"]:
        times = data["beats"]["times"]
        assert times == sorted(times) and all(0 <= t <= duration for t in times)
    for moment in data["keyMoments"]:
        assert 0 <= moment["time"] <= duration
    for segment in (data["sections"] or {}).get("segments", []):
        assert 0 <= segment["start"] < segment["end"] <= duration
    moods = ((data["fingerprint"] or {}).get("moods")) or {}
    for score in moods.values():
        if score is not None:
            low, high = score["range"]
            assert low <= score["value"] <= high
    return data


def check_v1_follows_v2(result: dict) -> None:
    """The v1 fields are what v2 measured, and null wherever v2 is null."""
    v2 = result["v2"]
    tempo, key, loudness = v2["tempo"], v2["key"], v2["loudness"]
    assert result["bpm"] == (None if tempo is None else round(tempo["bpm"])), (result["bpm"], tempo)
    if key is None:
        assert (result["key"], result["mode"]) == (None, None)
    else:
        assert (result["key"], result["mode"]) == (key["tonic"], key["mode"].capitalize())
    assert (result["energy"] is None) == (loudness is None)
    assert result["keyMoments"] == v2["keyMoments"]
    assert result["duration"] == round(v2["window"]["durationSeconds"], 2)
    moods = ((v2["fingerprint"] or {}).get("moods")) or {}
    for v1_name, v2_name in PERCEPTUAL.items():
        score = moods.get(v2_name)
        expected = None if score is None else score["value"]
        assert (result[v1_name] is None) == (expected is None)
        if expected is not None:
            assert math.isclose(result[v1_name], expected, abs_tol=0.001)
    valence = moods.get("valence")
    assert (result["valence"] is None) == (valence is None)
    if valence is not None:
        assert math.isclose(result["valence"], (valence["value"] - 1) / 8, abs_tol=0.001)


def check_result(result: dict) -> dict:
    """Both checks; returns the round-tripped v2 block."""
    data = check_v2(result["v2"])
    check_v1_follows_v2(result)
    return data
