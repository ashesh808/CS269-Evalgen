"""
Renders the jinja prompt files in this directory into chat messages

Each file holds a system part and a user part split by an END SYSTEM PROMPT line
Undefined template variables raise instead of rendering empty
"""

from functools import cache
from pathlib import Path
from typing import Literal, TypedDict

from jinja2 import StrictUndefined, Template

PROMPT_DIR = Path(__file__).parent
SPLIT_MARKER = "END SYSTEM PROMPT"


class TextPart(TypedDict):
    type: Literal["text"]
    text: str


class ImageURL(TypedDict):
    url: str
    detail: Literal["high"]


class ImagePart(TypedDict):
    type: Literal["image_url"]
    image_url: ImageURL


ContentPart = TextPart | ImagePart


class Message(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str | list[ContentPart]


@cache
def _templates(name: str) -> tuple[Template, Template]:
    text = (PROMPT_DIR / f"{name}.jinja").read_text()
    system, _, user = text.partition(SPLIT_MARKER)
    # Drop the rest of the marker line, the dashes around the marker
    system = system.rstrip("- \n")
    user = user.split("\n", 1)[1] if "\n" in user else ""
    return (
        Template(system, undefined=StrictUndefined),
        Template(user, undefined=StrictUndefined),
    )


def render(name: str, **variables: object) -> list[Message]:
    """
    Renders a prompt file into a system and a user message

    Args:
        name: The prompt file name without the .jinja suffix.
        **variables: Values for the template's placeholders.

    Returns:
        The system message followed by the user message.

    Raises:
        jinja2.UndefinedError: A placeholder has no value.
    """
    system, user = _templates(name)
    return [
        {"role": "system", "content": system.render(**variables).strip()},
        {"role": "user", "content": user.render(**variables).strip()},
    ]
