import asyncio
import json
from functools import partial

import httpx
import pytest
from openai import AsyncOpenAI

from evalgen.config import LLMConfig
from evalgen.llm import LLMClient, parse_list, parse_verdict


@pytest.mark.parametrize("max_tokens", [None, 64])
def test_complete_serializes_optional_token_cap(
    monkeypatch: pytest.MonkeyPatch, max_tokens: int | None
) -> None:
    payloads: list[dict[str, object]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        payloads.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "test-completion",
                "object": "chat.completion",
                "created": 0,
                "model": "test-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "true"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    async def complete() -> str:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http_client:
            monkeypatch.setattr(
                "evalgen.llm.AsyncOpenAI", partial(AsyncOpenAI, http_client=http_client)
            )
            llm = LLMClient(LLMConfig(base_url="https://gateway.test/v1", api_key="test"))
            return await llm.complete(
                [{"role": "user", "content": "Say true"}], max_tokens=max_tokens
            )

    assert asyncio.run(complete()) == "true"
    assert len(payloads) == 1
    if max_tokens is None:
        assert "max_tokens" not in payloads[0]
    else:
        assert payloads[0]["max_tokens"] == max_tokens


def test_list_models_filters_non_language_types(monkeypatch: pytest.MonkeyPatch) -> None:
    models = [
        {"id": "text-model", "type": "language"},
        {"id": "image-model", "type": "image"},
        {"id": "embedding-model", "type": "embedding"},
        {"id": "video-model", "type": "video"},
        {"id": "local-model"},
    ]

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(
            200,
            json={
                "object": "list",
                "data": [
                    {"object": "model", "created": 0, "owned_by": "test", **model}
                    for model in models
                ],
            },
        )

    async def list_models() -> list[str]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http_client:
            monkeypatch.setattr(
                "evalgen.llm.AsyncOpenAI", partial(AsyncOpenAI, http_client=http_client)
            )
            llm = LLMClient(LLMConfig(base_url="https://gateway.test/v1", api_key="test"))
            return await llm.list_models()

    assert asyncio.run(list_models()) == ["text-model", "local-model"]


def test_parse_list_keeps_only_list_items() -> None:
    reply = "Criteria:\n\n1. **Under 80 words**\n2) Upbeat tone\n- No invented specs\nThanks!"
    assert parse_list(reply) == ["Under 80 words", "Upbeat tone", "No invented specs"]


def test_parse_list_empty_reply() -> None:
    assert parse_list("") == []


@pytest.mark.parametrize(
    ("reply", "expected"),
    [("true", True), ("False.", False), ("**TRUE**", True), (" yes, it does", True), ("no", False)],
)
def test_parse_verdict(reply: str, expected: bool) -> None:
    assert parse_verdict(reply) is expected


@pytest.mark.parametrize("reply", ["", "The response is fine", "maybe"])
def test_parse_verdict_rejects_unknown(reply: str) -> None:
    with pytest.raises(ValueError):
        parse_verdict(reply)
