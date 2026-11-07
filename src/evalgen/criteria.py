"""
Suggests binary evaluation criteria for a prompt, the first EvalGen stage

Grades and feedback given before suggestion steer it, as in the paper's Grade First path
"""

from collections.abc import Sequence
from dataclasses import dataclass

from evalgen.llm import Completer, parse_list
from evalgen.prompts import ContentPart, render


@dataclass(frozen=True)
class Criterion:
    title: str
    description: str


@dataclass(frozen=True)
class GradedOutput:
    output: str
    good: bool
    feedback: str = ""
    screenshot: str | None = None


def parse_criterion(item: str) -> Criterion:
    """
    Splits a "Title: description" list item, keeping the whole item as title when there is no colon

    Args:
        item: One list item from the model reply.

    Returns:
        The criterion.
    """
    title, colon, description = item.partition(":")
    if not colon or not title.strip() or not description.strip():
        return Criterion(item.strip(), "")
    return Criterion(title.strip(), description.strip())


async def suggest_criteria(
    llm: Completer,
    prompt: str,
    graded: Sequence[GradedOutput] = (),
    existing: Sequence[str] = (),
) -> list[Criterion]:
    """
    Asks the LLM for criteria that a good response to the prompt would meet

    Args:
        llm: The chat client.
        prompt: The pipeline prompt whose outputs are being evaluated.
        graded: Outputs the user already graded, with optional feedback.
        existing: Titles of criteria the user already has, so they are not repeated.

    Returns:
        The suggested criteria.
    """
    screenshots = [(index, item) for index, item in enumerate(graded) if item.screenshot]
    messages = render(
        "generate_criteria",
        prompt=prompt,
        graded=graded,
        existing=existing,
        has_screenshots=bool(screenshots),
    )
    if screenshots:
        content = messages[-1]["content"]
        assert isinstance(content, str)
        parts: list[ContentPart] = [{"type": "text", "text": content}]
        for index, item in screenshots:
            assert item.screenshot is not None
            parts.extend(
                [
                    {
                        "type": "text",
                        "text": (
                            f"Rendered screenshot for graded response {index + 1} "
                            f"({'good' if item.good else 'bad'}), corresponding to that "
                            "response's source and human feedback above."
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": item.screenshot, "detail": "high"}},
                ]
            )
        messages[-1]["content"] = parts
    return [parse_criterion(item) for item in parse_list(await llm.complete(messages))]
