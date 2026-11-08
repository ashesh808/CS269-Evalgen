"""Sampling keeps public explanations separate from the exact answer being evaluated."""

import asyncio
import json
from collections.abc import Callable

import pytest

from conftest import FakeLLM, Responder
from evalgen.grading import sample_outputs, sample_outputs_detailed
from evalgen.prompts import Message


@pytest.mark.parametrize(
    "source",
    [
        '  Café 雪 🙂\nA "quoted" answer with \\ and <script>text</script>.\n',
        '<svg xmlns="http://www.w3.org/2000/svg"><text>雪 &amp; café</text></svg>\n',
        '<!doctype html>\n<html><script>const a = {x: "</script>"};</script></html>\n',
    ],
)
def test_sampling_decodes_envelope_without_changing_answer(
    fake_llm: Callable[[Responder], FakeLLM], source: str
) -> None:
    reply = json.dumps(
        {"output": source, "explanation": "A concise design choice."}, ensure_ascii=False
    )
    llm = fake_llm(lambda _: reply)
    prompt = "Original task.\nReturn only the requested source.\n"
    sampled = asyncio.run(sample_outputs_detailed(llm, prompt, 1, 0.7))
    assert sampled[0].output == source
    assert sampled[0].explanation == "A concise design choice."
    assert sampled[0].explanation_status == "provided"
    assert len(llm.calls) == 1
    assert llm.calls[0][-1] == {"role": "user", "content": prompt}
    system = llm.calls[0][0]
    assert system["role"] == "system"
    assert '"output"' in system["content"] and '"explanation"' in system["content"]
    assert "1–3 sentences" in system["content"]


@pytest.mark.parametrize("fence", ["```json", "```JSON", "```"])
def test_sampling_accepts_fenced_json_and_ignores_unrequested_fields(
    fake_llm: Callable[[Responder], FakeLLM], fence: str
) -> None:
    reply = json.dumps(
        {
            "output": "answer\n",
            "explanation": "  Public summary.  ",
            "reasoning": "private-field-sentinel",
            "api_key": "unrequested-field-sentinel",
        }
    )
    result = asyncio.run(
        sample_outputs_detailed(fake_llm(lambda _: f"{fence}\n{reply}\n```"), "P", 1, 0.9)
    )[0]
    assert result.output == "answer\n"
    assert result.explanation == "Public summary."
    assert result.explanation_status == "provided"
    assert "sentinel" not in repr(result)


@pytest.mark.parametrize(
    "reply",
    [
        "  Plain answer 雪\n",
        "<svg><text>Raw source, not JSON</text></svg>\n",
        '{"output":"partial",',
        '[{"output":"answer","explanation":"Reason."}]',
        '{"output":"answer"}',
        '{"output":false,"explanation":"Reason."}',
        '{"output":"answer","explanation":[]}',
        '{"output":"first","output":"second","explanation":"Reason."}',
        '```javascript\n{"output":"answer","explanation":"Reason."}\n```',
        '{"output":"answer","explanation":"Reason."}\nExtra prose',
        "[" * 2000 + "]" * 2000,
    ],
)
def test_sampling_preserves_entire_nonconforming_reply_without_inventing_explanation(
    fake_llm: Callable[[Responder], FakeLLM], reply: str
) -> None:
    llm = fake_llm(lambda _: reply)
    result = asyncio.run(sample_outputs_detailed(llm, "P", 1, 0.9))[0]
    assert result.output == reply
    assert result.explanation is None
    assert result.explanation_status == "unavailable"
    assert len(llm.calls) == 1


@pytest.mark.parametrize("explanation", [None, "", " \n\t "])
def test_explicit_envelope_preserves_artifact_when_explanation_is_unavailable(
    fake_llm: Callable[[Responder], FakeLLM], explanation: str | None
) -> None:
    source = '<svg xmlns="http://www.w3.org/2000/svg"><text>雪</text></svg>\n'
    reply = json.dumps({"output": source, "explanation": explanation})
    result = asyncio.run(sample_outputs_detailed(fake_llm(lambda _: reply), "P", 1, 0.9))[0]
    assert result.output == source
    assert result.explanation is None
    assert result.explanation_status == "unavailable"


def test_parallel_sampling_preserves_output_and_explanation_alignment() -> None:
    async def flow() -> None:
        release_first = asyncio.Event()

        class LegacyCompleter:
            """Only the original complete interface, with replies finishing out of order."""

            def __init__(self) -> None:
                self.calls: list[tuple[list[Message], float | None]] = []
                self.finished: list[int] = []

            async def complete(
                self,
                messages: list[Message],
                temperature: float | None = None,
                max_tokens: int | None = None,
            ) -> str:
                index = len(self.calls)
                self.calls.append((messages, temperature))
                if index == 0:
                    await release_first.wait()
                if index == 2:
                    release_first.set()
                self.finished.append(index)
                if index == 1:
                    return "legacy raw reply"
                return json.dumps({"output": f"answer {index}", "explanation": f"Choice {index}."})

        llm = LegacyCompleter()
        sampled = await asyncio.wait_for(sample_outputs_detailed(llm, "P", 3, 0.8), 1.0)
        assert llm.finished == [1, 2, 0]
        assert [item.output for item in sampled] == ["answer 0", "legacy raw reply", "answer 2"]
        assert [item.explanation for item in sampled] == ["Choice 0.", None, "Choice 2."]
        assert [item.explanation_status for item in sampled] == [
            "provided",
            "unavailable",
            "provided",
        ]
        assert len(llm.calls) == 3 and all(temperature == 0.8 for _, temperature in llm.calls)

    asyncio.run(flow())


def test_legacy_sample_outputs_returns_only_answer_strings(
    fake_llm: Callable[[Responder], FakeLLM],
) -> None:
    llm = fake_llm(lambda _: '{"output":"answer","explanation":"Public summary."}')
    assert asyncio.run(sample_outputs(llm, "P", 2, 0.9)) == ["answer", "answer"]
    assert len(llm.calls) == 2
