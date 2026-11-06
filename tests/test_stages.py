import asyncio
import json
from collections.abc import Callable

import httpx
import openai
import pytest

from conftest import FakeLLM, Responder
from evalgen.assertions import parse_python_candidates, suggest_all
from evalgen.criteria import Criterion, GradedOutput, parse_criterion, suggest_criteria
from evalgen.grading import run_matrix, run_matrix_detailed, run_matrix_events
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


def test_mixed_generation_routes_python_to_json_and_preserves_order(
    fake_llm: Callable[[Responder], FakeLLM],
) -> None:
    code = "def evaluate(response, prompt):\n    return len(response) < 20"

    def respond(messages: list[Message]) -> str:
        if "Python functions" in messages[0]["content"]:
            return json.dumps({"assertions": [code]})
        return "1. Check politeness\n2. Extra candidate"

    result = asyncio.run(
        suggest_all(fake_llm(respond), "Greet", ["Short", "Polite"], 1, ["python", "llm"])
    )
    assert result == [[code], ["Check politeness"]]


@pytest.mark.parametrize(
    "reply",
    [
        "not JSON",
        "{}",
        "[]",
        '{"assertions": []}',
        '{"assertions": [1]}',
        '{"assertions": [null]}',
        '{"assertions": [""]}',
        '{"assertions": "source"}',
    ],
)
def test_python_candidate_parser_rejects_bad_json_and_non_sources(reply: str) -> None:
    with pytest.raises(ValueError):
        parse_python_candidates(reply, 3)


def test_python_candidate_parser_accepts_fenced_json_and_limits_count() -> None:
    source = "def evaluate(response, prompt):\n    return True"
    reply = "```json\n" + json.dumps({"assertions": [source, source + "\n"]}) + "\n```"
    assert parse_python_candidates(reply, 1) == [source]


def test_matrix_keeps_healthy_cells_when_one_provider_call_fails(
    fake_llm: Callable[[Responder], FakeLLM],
) -> None:
    def respond(messages: list[Message]) -> str:
        content = messages[-1]["content"]
        if "broken" in content:
            raise openai.APIError(
                "rejected one call",
                request=httpx.Request("POST", "https://test.invalid"),
                body=None,
            )
        return "unreadable" if "garbled" in content else "true"

    results, errors = asyncio.run(
        run_matrix_detailed(fake_llm(respond), [["A"]], "P", ["healthy", "broken", "garbled"])
    )
    assert results == [[[True, None, None]]]
    assert errors[0][0][0] is None
    provider_error, parse_error = errors[0][0][1:]
    assert provider_error is not None and "rejected one call" in provider_error
    assert parse_error is not None and "two attempts" in parse_error


def test_matrix_events_yield_fast_verdict_before_slow_call_is_released() -> None:
    async def flow() -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        class ControlledLLM:
            async def complete(
                self,
                messages: list[Message],
                temperature: float | None = None,
                max_tokens: int | None = None,
            ) -> str:
                if "<Response>\nslow\n</Response>" in messages[-1]["content"]:
                    started.set()
                    await release.wait()
                    return "false"
                return "true"

        stream = run_matrix_events(ControlledLLM(), [["A"]], "P", ["slow", "fast"])
        try:
            first = await asyncio.wait_for(anext(stream), timeout=1.0)
            assert started.is_set() and not release.is_set()
            assert (first.criterion, first.assertion, first.output, first.verdict) == (
                0,
                0,
                1,
                True,
            )
            release.set()
            second = await asyncio.wait_for(anext(stream), timeout=1.0)
            assert (second.output, second.verdict) == (0, False)
            with pytest.raises(StopAsyncIteration):
                await anext(stream)
        finally:
            release.set()
            await stream.aclose()

    asyncio.run(flow())
