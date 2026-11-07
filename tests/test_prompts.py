import jinja2
import pytest

from evalgen.prompts import render


def test_evaluate_renders_assertion_and_response() -> None:
    system, user = render("evaluate", prompt="P", response="R", assertion="A")
    assert isinstance(system["content"], str) and isinstance(user["content"], str)
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


def test_python_generation_prompt_defines_sandbox_and_json_contract() -> None:
    system, user = render(
        "generate_python_assertions", prompt="Write a greeting", criterion="Under 20 words", count=3
    )
    assert isinstance(system["content"], str) and isinstance(user["content"], str)
    assert "evaluate(response: str, prompt: str) -> bool" in system["content"]
    assert "standard library" in system["content"]
    assert '"assertions" array of Python source strings' in system["content"]
    assert "Write a greeting" in user["content"] and "Under 20 words" in user["content"]
    assert "Generate 3 candidates" in user["content"]
    assert "END SYSTEM PROMPT" not in system["content"] + user["content"]
