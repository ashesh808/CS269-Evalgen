"""
Synthesizes candidate LLM prompts or sandboxed Python functions for each criterion
"""

import asyncio
import json
from typing import Literal

from evalgen.llm import Completer, parse_list
from evalgen.prompts import render

EvaluatorKind = Literal["llm", "python"]


def parse_python_candidates(reply: str, count: int) -> list[str]:
    """Read JSON-wrapped Python candidates without evaluating generated text."""
    text = reply.strip()
    if text.startswith("```") and text.endswith("```"):
        _, separator, fenced = text.partition("\n")
        if not separator:
            raise ValueError("The model returned an empty Python candidate block.")
        text = fenced.rsplit("```", 1)[0].strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("The model did not return valid JSON Python candidates.") from error
    candidates = payload.get("assertions") if isinstance(payload, dict) else payload
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("The model returned no Python candidates.")
    if any(not isinstance(item, str) or not item.strip() for item in candidates):
        raise ValueError("Every Python candidate must be a nonempty source string.")
    return [item.strip() for item in candidates[:count]]


async def suggest_assertions(
    llm: Completer, prompt: str, criterion: str, count: int, kind: EvaluatorKind = "llm"
) -> list[str]:
    """
    Asks the LLM for candidate assertions that implement one criterion

    Args:
        llm: The chat client.
        prompt: The pipeline prompt, giving the assertions context.
        criterion: The criterion to implement.
        count: How many candidates to request.

    Returns:
        The candidates, each an instruction a grader answers True or False.
    """
    template = "generate_python_assertions" if kind == "python" else "generate_assertions"
    messages = render(template, prompt=prompt, criterion=criterion, count=count)
    reply = await llm.complete(messages)
    return parse_python_candidates(reply, count) if kind == "python" else parse_list(reply)[:count]


async def suggest_all(
    llm: Completer,
    prompt: str,
    criteria: list[str],
    count: int,
    kinds: list[EvaluatorKind] | None = None,
) -> list[list[str]]:
    """
    Requests candidates for every criterion concurrently

    Args:
        llm: The chat client.
        prompt: The pipeline prompt.
        criteria: The criteria to implement.
        count: Candidates requested per criterion.

    Returns:
        One candidate list per criterion, in the order given.
    """
    kinds = ["llm"] * len(criteria) if kinds is None else kinds
    jobs = [
        suggest_assertions(llm, prompt, criterion, count, kind)
        for criterion, kind in zip(criteria, kinds, strict=True)
    ]
    return list(await asyncio.gather(*jobs))
