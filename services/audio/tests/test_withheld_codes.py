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


# The same list as the web's (apps/web/src/constants.test.ts): a reason names the check that
# fired, never an instrument or a kind of source the check does not test.
SOURCE_WORDS = re.compile(
    r"\b(drums?|percussion|noise|speech|spoken|talk\w*|voices?|vocals?|sing\w*|cowbells?|bells?"
    r"|hum|bass|guitars?|piano|synth\w*|instruments?|tones?|whine|drones?|sources?)\b",
    re.IGNORECASE,
)


def _text(node: ast.AST, names: dict[str, ast.AST]) -> str | None:
    """A reason's text: a constant, an f-string with its fields as "X", or a module constant."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "X" for v in node.values)
    if isinstance(node, ast.Name) and node.id in names:
        return _text(names[node.id], names)
    return None


def service_reasons() -> dict[str, str]:
    """
    Every reason text the service can send, by where it is written: Withheld(text, ...),
    _reason(code, text), and the text of a {"code": ..., "reason": ...} literal. A reason built
    at run time from another one (not_music) is made of these. Fails on a text it cannot read.
    """
    reasons = {}
    for name in SOURCES:
        with open(os.path.join(SERVICE, name)) as f:
            tree = ast.parse(f.read())
        names = {
            target.id: node.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            for target in node.targets
            if isinstance(target, ast.Name)
        }
        for node in ast.walk(tree):
            text_node = None
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id == "Withheld" and node.args:
                    text_node = node.args[0]
                elif node.func.id == "_reason" and len(node.args) > 1:
                    text_node = node.args[1]
            elif isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values, strict=True):
                    if isinstance(key, ast.Constant) and key.value == "reason":
                        text_node = value
            if text_node is None:
                continue
            text = _text(text_node, names)
            if text is None and isinstance(text_node, ast.Name | ast.Attribute):
                continue  # passed on from a reason read here (not_music, entry())
            assert text is not None, (name, node.lineno, ast.dump(text_node))
            reasons[f"{name}:{node.lineno}"] = text
    return reasons


def test_every_reason_names_the_check_never_a_source():
    reasons = service_reasons()
    assert len(reasons) >= 30, reasons  # the scan finds them
    named = {where: text for where, text in reasons.items() if SOURCE_WORDS.search(text)}
    assert named == {}
    assert all(text.strip() for text in reasons.values())
