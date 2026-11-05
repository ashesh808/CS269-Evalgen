"""
Talks to an OpenAI-compatible chat server and parses its replies into lists and verdicts

The parsers are lenient as local models wrap answers in markdown and stray punctuation
"""

import asyncio
import copy
import re
from typing import Protocol, cast

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from evalgen.config import LLMConfig
from evalgen.prompts import Message

LIST_ITEM = re.compile(r"^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$")

VERDICTS = {
    "true": True,
    "yes": True,
    "correct": True,
    "pass": True,
    "1": True,
    "y": True,
    "false": False,
    "no": False,
    "incorrect": False,
    "fail": False,
    "0": False,
    "n": False,
}


class Completer(Protocol):
    async def complete(
        self,
        messages: list[Message],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str: ...


class ModelPool(Protocol):
    def with_model(self, model: str | None) -> Completer: ...

    async def list_models(self) -> list[str]: ...


class LLMClient:
    """
    Chat client that caps how many requests are in flight at once, across all models
    """

    def __init__(self, config: LLMConfig) -> None:
        self._client = AsyncOpenAI(
            base_url=config.base_url,
            api_key=config.api_key,
            timeout=config.timeout,
            max_retries=config.max_retries,
        )
        self._model = config.model
        self._temperature = config.temperature
        self._limit = asyncio.Semaphore(config.max_concurrency)

    async def complete(
        self,
        messages: list[Message],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        Sends one chat request and returns the reply text

        Args:
            messages: The chat messages, system first.
            temperature: Overrides the configured temperature when set.
            max_tokens: Caps the reply length, reasoning included, when set.

        Returns:
            The reply content, empty when the server sent none.

        Raises:
            openai.APIError: The server is unreachable or rejected the request.
        """
        async with self._limit:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=cast("list[ChatCompletionMessageParam]", messages),
                temperature=self._temperature if temperature is None else temperature,
                max_tokens=max_tokens,
            )
        return response.choices[0].message.content or ""

    def with_model(self, model: str | None) -> LLMClient:
        """
        Returns a client for another model sharing this one's connections and concurrency cap

        Args:
            model: The model name, the configured one when None or empty.

        Returns:
            This client when the model is unchanged, otherwise a view on it.
        """
        if not model or model == self._model:
            return self
        view = copy.copy(self)
        view._model = model
        return view

    async def list_models(self) -> list[str]:
        """
        Lists the models the server offers

        Returns:
            The model names, in server order.

        Raises:
            openai.APIError: The server is unreachable or has no model listing.
        """
        page = await self._client.models.list()
        return [model.id for model in page.data]


def parse_list(text: str) -> list[str]:
    """
    Extracts the items of a numbered or bulleted list, ignoring any other line

    Args:
        text: The model reply.

    Returns:
        The item texts in order, with markdown bold markers removed.
    """
    items = []
    for line in text.splitlines():
        match = LIST_ITEM.match(line)
        if match:
            item = match.group(1).replace("**", "").strip()
            if item:
                items.append(item)
    return items


def parse_verdict(text: str) -> bool:
    """
    Reads a true or false answer from the first word of a reply

    Args:
        text: The model reply.

    Returns:
        True when the assertion holds.

    Raises:
        ValueError: The first word is not a known verdict.
    """
    words = re.findall(r"[a-z0-9]+", text.lower())
    if not words or words[0] not in VERDICTS:
        raise ValueError(f"Invalid verdict: {text!r}")
    return VERDICTS[words[0]]
