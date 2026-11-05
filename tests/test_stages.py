import asyncio
from collections.abc import Callable

from conftest import FakeLLM, Responder
from evalgen.assertions import suggest_all
from evalgen.criteria import Criterion, GradedOutput, parse_criterion, suggest_criteria
from evalgen.grading import run_matrix
from evalgen.prompts import Message


def test_suggest_criteria_parses_reply(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    llm = fake_llm(lambda _: "1. Short: Under 80 words.\n2. Upbeat")
    graded = [GradedOutput("too long text", good=False, feedback="rambles")]
    found = asyncio.run(suggest_criteria(llm, "Describe a bottle", graded, ["Tone"]))
    assert found == [Criterion("Short", "Under 80 words."), Criterion("Upbeat", "")]
    user = llm.calls[0][1]["content"]
    assert "Describe a bottle" in user
    assert '<Response grade="bad">' in user and "rambles" in user and "- Tone" in user


def test_parse_criterion_without_description() -> None:
    assert parse_criterion("Ratio: ") == Criterion("Ratio:", "")


def test_suggest_all_keeps_criterion_order(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    def respond(messages: list[Message]) -> str:
        return "1. about short" if "Short" in messages[1]["content"] else "1. about upbeat"

    result = asyncio.run(suggest_all(fake_llm(respond), "P", ["Short", "Upbeat"], 1))
    assert result == [["about short"], ["about upbeat"]]


def test_run_matrix_shape_and_retry(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    def respond(messages: list[Message]) -> str:
        content = messages[1]["content"]
        if "garbled" in content:
            return "I think so"
        return "true" if "good" in content else "false"

    llm = fake_llm(respond)
    assertions = [["A1", "A2"], ["garbled"]]
    results = asyncio.run(run_matrix(llm, assertions, "P", ["good text", "bad text"]))
    assert results == [[[True, False], [True, False]], [[None, None]]]
    # 4 clean calls plus 2 attempts for each garbled verdict
    assert len(llm.calls) == 8
