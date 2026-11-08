"""Execute independent candidates, retaining unknown verdicts and per-output errors."""

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Literal

import openai

from evalgen.assertions import EvaluatorKind
from evalgen.llm import Completer, parse_verdict
from evalgen.prompts import Message, render
from evalgen.sandbox import evaluate_python_detailed

# One retry, since a garbled verdict is usually a one-off formatting slip
VERDICT_ATTEMPTS = 2

Verdict = bool | None

SAMPLE_FORMAT_INSTRUCTIONS = """Complete the user's task and return exactly one JSON object
with two string fields: "output" and "explanation". Put the complete task answer in
"output", preserving its intended text and source formatting through valid JSON escaping.
Any instructions about returning only an answer, SVG, or HTML apply to the value of
"output": include the raw answer or complete artifact source there, without Markdown
fences or extra commentary. In "explanation", give a concise, user-facing rationale
of 1–3 sentences describing the answer or key design choices. Do not include hidden
analysis or private step-by-step reasoning. Do not add other fields or surrounding prose.
"""


@dataclass(frozen=True)
class SampledOutput:
    output: str
    explanation: str | None
    explanation_status: Literal["provided", "unavailable"]


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Do not silently choose between conflicting duplicate envelope fields."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _sampled_output(reply: str) -> SampledOutput:
    """Decode explicit public fields; preserve replies that are not clear envelopes."""
    candidate = reply.strip()
    lines = candidate.splitlines()
    if (
        len(lines) >= 3
        and lines[0].strip().lower() in ("```", "```json")
        and lines[-1].strip() == "```"
    ):
        candidate = "\n".join(lines[1:-1])
    try:
        envelope = json.loads(candidate, object_pairs_hook=_unique_json_object)
    except (ValueError, RecursionError):
        return SampledOutput(reply, None, "unavailable")
    if not isinstance(envelope, dict) or not isinstance(envelope.get("output"), str):
        return SampledOutput(reply, None, "unavailable")
    explanation = envelope.get("explanation")
    if isinstance(explanation, str):
        if explanation.strip():
            return SampledOutput(envelope["output"], explanation.strip(), "provided")
        return SampledOutput(envelope["output"], None, "unavailable")
    if "explanation" in envelope and explanation is None:
        return SampledOutput(envelope["output"], None, "unavailable")
    return SampledOutput(reply, None, "unavailable")


@dataclass(frozen=True)
class EvaluationEvent:
    criterion: int
    assertion: int
    output: int
    verdict: Verdict
    error: str | None = None


async def _llm_verdict(
    llm: Completer,
    assertion: str,
    prompt: str,
    output: str,
    max_tokens: int | None,
    screenshot: str | None = None,
) -> tuple[Verdict, str | None]:
    messages = render(
        "evaluate",
        prompt=prompt,
        response=output,
        assertion=assertion,
        has_screenshot=screenshot is not None,
    )
    if screenshot is not None:
        content = messages[-1]["content"]
        assert isinstance(content, str)
        messages[-1]["content"] = [
            {"type": "text", "text": content},
            {"type": "image_url", "image_url": {"url": screenshot, "detail": "high"}},
        ]
    for _ in range(VERDICT_ATTEMPTS):
        try:
            return parse_verdict(await llm.complete(messages, max_tokens=max_tokens)), None
        except ValueError:
            continue
        except openai.APIError as error:
            if screenshot is not None:
                return None, (
                    "Screenshot evaluation failed. Choose an image-capable evaluator model "
                    f"and retry. Provider error: {error}"
                )[:500]
            return None, f"LLM evaluation failed: {error}"[:500]
    return None, "The grader returned no readable True/False verdict after two attempts."


async def run_assertion(
    llm: Completer,
    assertion: str,
    prompt: str,
    output: str,
    max_tokens: int | None = None,
    screenshot: str | None = None,
) -> Verdict:
    """
    Grades one output against one assertion

    Args:
        llm: The chat client.
        assertion: The grader instruction.
        prompt: The pipeline prompt, shown to the grader for context.
        output: The pipeline output to grade.
        max_tokens: Caps each grader reply, a truncated reply reads as no verdict.

    Returns:
        True when the output passes, False when it fails, None when no verdict was readable.
    """
    verdict, _ = await _llm_verdict(llm, assertion, prompt, output, max_tokens, screenshot)
    return verdict


async def run_matrix_events(
    llm: Completer,
    assertions: list[list[str]],
    prompt: str,
    outputs: list[str],
    max_tokens: int | None = None,
    kinds: list[EvaluatorKind] | None = None,
    python_timeout: float = 3.0,
    python_limit: asyncio.Semaphore | None = None,
    screenshots: Sequence[str | None] | None = None,
) -> AsyncIterator[EvaluationEvent]:
    """Publish completed verdicts; a broken candidate never discards unrelated results."""
    kinds = ["llm"] * len(assertions) if kinds is None else kinds
    python_limit = asyncio.Semaphore(2) if python_limit is None else python_limit
    if screenshots is not None and len(screenshots) != len(outputs):
        raise ValueError("screenshots must contain one image or null per output")

    async def llm_job(c: int, a: int, o: int, assertion: str) -> list[EvaluationEvent]:
        screenshot = screenshots[o] if screenshots is not None else None
        if screenshots is not None and not screenshot:
            return [
                EvaluationEvent(
                    c, a, o, None, "Screenshot unavailable for this response. Capture it and retry."
                )
            ]
        verdict, error = await _llm_verdict(
            llm, assertion, prompt, outputs[o], max_tokens, screenshot
        )
        return [EvaluationEvent(c, a, o, verdict, error)]

    async def python_job(c: int, a: int, assertion: str) -> list[EvaluationEvent]:
        async with python_limit:
            result = await evaluate_python_detailed(assertion, outputs, prompt, python_timeout)
        return [
            EvaluationEvent(c, a, o, verdict, error)
            for o, (verdict, error) in enumerate(zip(result.results, result.errors, strict=True))
        ]

    tasks: list[asyncio.Task[list[EvaluationEvent]]] = []
    for c, (group, kind) in enumerate(zip(assertions, kinds, strict=True)):
        for a, assertion in enumerate(group):
            if kind == "python":
                tasks.append(asyncio.create_task(python_job(c, a, assertion)))
            else:
                tasks.extend(
                    asyncio.create_task(llm_job(c, a, o, assertion)) for o in range(len(outputs))
                )
    try:
        for task in asyncio.as_completed(tasks):
            for event in await task:
                yield event
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def run_matrix_detailed(
    llm: Completer,
    assertions: list[list[str]],
    prompt: str,
    outputs: list[str],
    max_tokens: int | None = None,
    kinds: list[EvaluatorKind] | None = None,
    python_timeout: float = 3.0,
    python_limit: asyncio.Semaphore | None = None,
    screenshots: Sequence[str | None] | None = None,
) -> tuple[list[list[list[Verdict]]], list[list[list[str | None]]]]:
    results: list[list[list[Verdict]]] = [
        [[None] * len(outputs) for _ in group] for group in assertions
    ]
    errors: list[list[list[str | None]]] = [
        [[None] * len(outputs) for _ in group] for group in assertions
    ]
    async for event in run_matrix_events(
        llm,
        assertions,
        prompt,
        outputs,
        max_tokens,
        kinds,
        python_timeout,
        python_limit,
        screenshots,
    ):
        results[event.criterion][event.assertion][event.output] = event.verdict
        errors[event.criterion][event.assertion][event.output] = event.error
    return results, errors


async def run_matrix(
    llm: Completer,
    assertions: list[list[str]],
    prompt: str,
    outputs: list[str],
    max_tokens: int | None = None,
    screenshots: Sequence[str | None] | None = None,
) -> list[list[list[Verdict]]]:
    """
    Grades every output against every assertion of every criterion concurrently

    Args:
        llm: The chat client.
        assertions: Candidate assertions grouped by criterion.
        prompt: The pipeline prompt.
        outputs: The pipeline outputs.
        max_tokens: Caps each grader reply.

    Returns:
        Verdicts indexed as [criterion][assertion][output].
    """
    results, _ = await run_matrix_detailed(
        llm, assertions, prompt, outputs, max_tokens, screenshots=screenshots
    )
    return results


async def sample_outputs(llm: Completer, prompt: str, count: int, temperature: float) -> list[str]:
    """
    Runs the prompt through the LLM to produce pipeline outputs to grade

    Args:
        llm: The chat client.
        prompt: The pipeline prompt, sent as the user message.
        count: How many outputs to sample.
        temperature: Sampling temperature, high enough that samples differ.

    Returns:
        The sampled outputs.
    """
    return [item.output for item in await sample_outputs_detailed(llm, prompt, count, temperature)]


async def sample_outputs_detailed(
    llm: Completer, prompt: str, count: int, temperature: float
) -> list[SampledOutput]:
    """Sample answers and concise explanations together, without a second model call.

    The task prompt is unchanged. Only the extracted answer is used as an evaluation
    response. A clear envelope can retain its answer without a usable explanation;
    replies that do not match the envelope remain available in full. Clients need
    only support the existing text completion interface.
    """
    messages: list[Message] = [
        {"role": "system", "content": SAMPLE_FORMAT_INSTRUCTIONS},
        {"role": "user", "content": prompt},
    ]
    jobs = [llm.complete(messages, temperature=temperature) for _ in range(count)]
    return [_sampled_output(reply) for reply in await asyncio.gather(*jobs)]
