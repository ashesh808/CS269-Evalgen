"""
Shared fixtures: a scripted LLM stand-in so stage tests never touch the network
"""

from collections.abc import Callable

import pytest

from evalgen.prompts import Message

Responder = Callable[[list[Message]], str]


class FakeLLM:
    """
    Answers each request with a function of its messages and records every call
    """

    def __init__(self, respond: Responder) -> None:
        self.respond = respond
        self.calls: list[list[Message]] = []
        self.models: list[str | None] = []

    async def complete(
        self,
        messages: list[Message],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        self.calls.append(messages)
        return self.respond(messages)

    def with_model(self, model: str | None) -> FakeLLM:
        self.models.append(model)
        return self

    async def list_models(self) -> list[str]:
        return ["small", "large"]


@pytest.fixture
def fake_llm() -> Callable[[Responder], FakeLLM]:
    return FakeLLM
