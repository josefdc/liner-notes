"""
The reason codes the service can send (v2.withheld) are exactly the contract's
AudioWithheldCode: a code the service invents fails here, and so does a contract code nothing
sends. The service's codes are read from its source, so a path no other test runs is counted
too.
"""

import ast
import os
import re

import estimators
from tests.checks import SCHEMA

SERVICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = ("main.py", "estimators.py", "fingerprint.py")
CONTRACT_AUDIO = os.path.join(SERVICE, "..", "..", "packages", "contract", "src", "audio.ts")


def service_codes() -> set[str]:
    """Every `code="..."` keyword, `_reason("...", ...)` call and `{"code": "..."}` literal."""
    codes = set()
    for name in SOURCES:
        with open(os.path.join(SERVICE, name)) as f:
            tree = ast.parse(f.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.keyword) and node.arg == "code":
                assert isinstance(node.value, ast.Constant), (name, ast.dump(node))
                codes.add(node.value.value)
            elif (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "_reason"
            ):
                assert isinstance(node.args[0], ast.Constant), (name, ast.dump(node))
                codes.add(node.args[0].value)
            elif isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values, strict=True):
                    # {"code": code, ...} built from a variable is a helper (_reason, entry()).
                    if isinstance(key, ast.Constant) and key.value == "code":
                        if isinstance(value, ast.Constant):
                            codes.add(value.value)
    return codes


def contract_codes() -> set[str]:
    withheld = SCHEMA["properties"]["withheld"]["properties"]
    return set(withheld["tempo"]["properties"]["code"]["enum"])


def test_the_service_sends_exactly_the_contracts_codes():
    sent, listed = service_codes(), contract_codes()
    assert sent - listed == set(), "codes the contract does not list"
    assert listed - sent == set(), "contract codes the service never sends"


def test_every_withheld_field_takes_the_same_codes():
    withheld = SCHEMA["properties"]["withheld"]["properties"]
    fields = {name: spec for name, spec in withheld.items() if name != "moods"}
    fields |= {f"moods.{head}": spec for head, spec in withheld["moods"]["properties"].items()}
    for name, spec in fields.items():
        assert set(spec["properties"]["code"]["enum"]) == contract_codes(), name


def test_the_tempo_range_is_the_contracts():
    """The web words the out-of-range reason with the contract's AUDIO_TEMPO_RANGE_BPM."""
    with open(CONTRACT_AUDIO) as f:
        found = re.search(r"AUDIO_TEMPO_RANGE_BPM = \[(\d+), (\d+)\] as const", f.read())
    assert found, "AUDIO_TEMPO_RANGE_BPM not found in packages/contract/src/audio.ts"
    assert (float(found[1]), float(found[2])) == (estimators.MIN_BPM, estimators.MAX_BPM)
