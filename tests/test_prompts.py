import jinja2
import pytest

from evalgen.prompts import render


def test_evaluate_renders_assertion_and_response() -> None:
    system, user = render("evaluate", prompt="P", response="R", assertion="A")
    assert system["role"] == "system" and "END SYSTEM PROMPT" not in system["content"]
    assert not system["content"].endswith("-")
    assert "<Response>\nR\n</Response>" in user["content"]
    assert "<Assertion>\nA\n</Assertion>" in user["content"]


def test_evaluate_omits_empty_prompt() -> None:
    _, user = render("evaluate", prompt="", response="R", assertion="A")
    assert "<Prompt>" not in user["content"]


def test_missing_variable_raises() -> None:
    with pytest.raises(jinja2.UndefinedError):
        render("evaluate", prompt="P", response="R", criteria="A")
