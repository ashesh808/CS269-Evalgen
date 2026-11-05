import pytest

from evalgen.llm import parse_list, parse_verdict


def test_parse_list_keeps_only_list_items() -> None:
    reply = "Criteria:\n\n1. **Under 80 words**\n2) Upbeat tone\n- No invented specs\nThanks!"
    assert parse_list(reply) == ["Under 80 words", "Upbeat tone", "No invented specs"]


def test_parse_list_empty_reply() -> None:
    assert parse_list("") == []


@pytest.mark.parametrize(
    ("reply", "expected"),
    [("true", True), ("False.", False), ("**TRUE**", True), (" yes, it does", True), ("no", False)],
)
def test_parse_verdict(reply: str, expected: bool) -> None:
    assert parse_verdict(reply) is expected


@pytest.mark.parametrize("reply", ["", "The response is fine", "maybe"])
def test_parse_verdict_rejects_unknown(reply: str) -> None:
    with pytest.raises(ValueError):
        parse_verdict(reply)
