"""
Synthesizes candidate grader assertions that implement each criterion

Code-based assertions from the paper are left out, since running LLM-written code needs a sandbox
"""

import asyncio

from evalgen.llm import Completer, parse_list
from evalgen.prompts import render


async def suggest_assertions(llm: Completer, prompt: str, criterion: str, count: int) -> list[str]:
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
    messages = render("generate_assertions", prompt=prompt, criterion=criterion, count=count)
    return parse_list(await llm.complete(messages))


async def suggest_all(
    llm: Completer, prompt: str, criteria: list[str], count: int
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
    jobs = [suggest_assertions(llm, prompt, criterion, count) for criterion in criteria]
    return list(await asyncio.gather(*jobs))
