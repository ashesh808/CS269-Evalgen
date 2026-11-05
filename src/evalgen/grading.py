"""
Runs assertions on pipeline outputs with an LLM grader, and samples outputs to grade

A verdict the grader garbles twice is recorded as None rather than failing the whole run
"""

import asyncio

from evalgen.llm import Completer, parse_verdict
from evalgen.prompts import Message, render

# One retry, since a garbled verdict is usually a one-off formatting slip
VERDICT_ATTEMPTS = 2

Verdict = bool | None


async def run_assertion(
    llm: Completer, assertion: str, prompt: str, output: str, max_tokens: int | None = None
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
    messages = render("evaluate", prompt=prompt, response=output, assertion=assertion)
    for _ in range(VERDICT_ATTEMPTS):
        try:
            return parse_verdict(await llm.complete(messages, max_tokens=max_tokens))
        except ValueError:
            continue
    return None


async def run_matrix(
    llm: Completer,
    assertions: list[list[str]],
    prompt: str,
    outputs: list[str],
    max_tokens: int | None = None,
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
    jobs = [
        run_assertion(llm, assertion, prompt, output, max_tokens)
        for group in assertions
        for assertion in group
        for output in outputs
    ]
    flat = iter(await asyncio.gather(*jobs))
    return [[[next(flat) for _ in outputs] for _ in group] for group in assertions]


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
    messages: list[Message] = [{"role": "user", "content": prompt}]
    jobs = [llm.complete(messages, temperature=temperature) for _ in range(count)]
    return list(await asyncio.gather(*jobs))
