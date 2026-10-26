"""
Checks every analysis result in the tests goes through:

- the v2 block, after a strict JSON round trip (json.dumps(allow_nan=False): JSON Schema range
  checks accept NaN and infinity), validates against the contract's committed JSON Schema
  (packages/contract/schemas/audio-features.schema.json), which states the gate with if/then,
  plus the producer-side checks of the contract (finite numbers, scores within their range);
- the response holds the v2 block only (no v1 fields), and every value the block leaves null
  has its reason in `withheld`, while no measured value has one.
"""

import json
import os

import jsonschema

SCHEMA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "packages", "contract", "schemas"
)
with open(os.path.join(SCHEMA_PATH, "audio-features.schema.json")) as f:
    SCHEMA = json.load(f)
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
MEASURED_BLOCKS = ["tempo", "key", "loudness", "beats", "energyContour", "sections", "fingerprint"]


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


MOOD_HEADS = ["danceability", "acoustic", "instrumental", "valence", "arousal"]
GATE_CODES = {"silence": "gate_silence", "noise": "gate_noise", "too_short": "gate_too_short"}


def check_withheld(v2: dict) -> None:
    """
    Every null value has its reason and no measured value has one: each measured block, and
    within a fingerprint the styles, the tags and each mood head (a null fingerprint's reason
    covers its parts). When the gate did not pass, every reason is the gate's.
    """
    withheld = v2["withheld"]
    for block in MEASURED_BLOCKS:
        if v2[block] is None:
            assert block in withheld, (block, withheld)
        else:
            assert block not in withheld, (block, withheld[block])
    if not v2["gate"]["passed"]:
        code = GATE_CODES[v2["gate"]["reason"]]
        assert {entry["code"] for entry in withheld.values()} == {code}, withheld
    fingerprint = v2["fingerprint"]
    if fingerprint is None:
        assert not {"styles", "tags", "moods"} & set(withheld), withheld
        return
    for part in ("styles", "tags"):
        assert (fingerprint[part] is None) == (part in withheld), (part, withheld)
    moods, reasons = fingerprint["moods"] or {}, withheld.get("moods", {})
    for head in MOOD_HEADS:
        assert (moods.get(head) is None) == (head in reasons), (head, reasons)
    assert set(reasons) <= set(MOOD_HEADS) and (reasons or "moods" not in withheld)


def check_result(result: dict) -> dict:
    """The response is the v2 block only; checks it and its reasons, returns it round-tripped."""
    assert set(result) == {"v2"}, sorted(result)
    data = check_v2(result["v2"])
    check_withheld(data)
    return data
