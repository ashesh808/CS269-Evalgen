"""Image inputs reach the evaluator intact, with missing images remaining unknown."""

import asyncio
import base64
import json
import struct
import zlib
from functools import partial
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import openai
import pytest
from openai import AsyncOpenAI

from conftest import FakeLLM
from evalgen.config import LLMConfig
from evalgen.criteria import GradedOutput, suggest_criteria
from evalgen.grading import run_assertion, run_matrix, run_matrix_detailed
from evalgen.llm import LLMClient
from evalgen.prompts import ContentPart, Message
from evalgen.sandbox import PythonEvaluation

# The SDK annotates its transport with httpx2 while these offline fixtures use
# the same httpx.MockTransport interface as the existing client tests. Limit the
# compatibility casts to the injected test client/request, never production data.


def pixel(red: int, green: int, blue: int) -> str:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
        )

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 1, 1, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes([0, red, green, blue]))) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode()


RED = pixel(255, 0, 0)
GREEN = pixel(0, 255, 0)
SOURCE = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>'


def parts(messages: list[Message]) -> list[ContentPart]:
    content = messages[-1]["content"]
    assert isinstance(content, list)
    return content


def image(messages: list[Message]) -> str:
    urls = [part["image_url"]["url"] for part in parts(messages) if part["type"] == "image_url"]
    assert len(urls) == 1
    return urls[0]


def test_multimodal_wire_sends_source_and_actual_image_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payloads: list[dict[str, object]] = []

    def answer(request: httpx.Request) -> httpx.Response:
        payloads.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "image-verdict",
                "object": "chat.completion",
                "created": 0,
                "model": "image-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "true"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    async def grade() -> object:
        async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http_client:
            monkeypatch.setattr(
                "evalgen.llm.AsyncOpenAI", partial(AsyncOpenAI, http_client=cast(Any, http_client))
            )
            llm = LLMClient(LLMConfig(base_url="https://gateway.test/v1", api_key="test"))
            return await run_assertion(llm, "A red square is visible", "P", SOURCE, 64, RED)

    assert asyncio.run(grade()) is True
    assert len(payloads) == 1
    wire_messages = cast(list[dict[str, object]], payloads[0]["messages"])
    assert "actual pixels" in str(wire_messages[0]["content"])
    user_parts = cast(list[dict[str, object]], wire_messages[-1]["content"])
    assert f"<Response>\n{SOURCE}\n</Response>" in str(user_parts[0]["text"])
    assert "A red square is visible" in str(user_parts[0]["text"])
    assert user_parts[1] == {"type": "image_url", "image_url": {"url": RED, "detail": "high"}}
    assert payloads[0]["max_tokens"] == 64


def test_image_matrix_keeps_order_and_missing_screenshot_does_not_fallback() -> None:
    llm = FakeLLM(lambda messages: "true" if image(messages) == RED else "false")
    result, errors = asyncio.run(
        run_matrix_detailed(
            llm,
            [["A red square is visible"]],
            "P",
            [SOURCE] * 3,
            screenshots=[RED, GREEN, None],
        )
    )
    # Identical source can have different visual verdicts; no LLM call is made without pixels.
    assert result == [[[True, False, None]]]
    assert errors[0][0][:2] == [None, None]
    assert "Screenshot unavailable" in (errors[0][0][2] or "")
    assert len(llm.calls) == 2


def test_source_only_grading_retains_plain_text_messages() -> None:
    def answer(messages: list[Message]) -> str:
        assert isinstance(messages[-1]["content"], str)
        assert "A rendered screenshot" not in str(messages[0]["content"])
        return "true"

    assert asyncio.run(run_matrix(FakeLLM(answer), [["A"]], "P", [SOURCE])) == [[[True]]]


def test_code_grader_receives_only_raw_source_even_in_visual_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    python = AsyncMock(return_value=PythonEvaluation([True, False], [None, None], "test"))
    monkeypatch.setattr("evalgen.grading.evaluate_python_detailed", python)
    llm = FakeLLM(lambda messages: "true" if image(messages) == RED else "false")
    code = "def evaluate(response, prompt): return bool(response)"
    result, errors = asyncio.run(
        run_matrix_detailed(
            llm,
            [["Red square"], [code]],
            "P",
            [SOURCE, "invalid SVG"],
            kinds=["llm", "python"],
            screenshots=[RED, None],
        )
    )
    assert result == [[[True, None]], [[True, False]]]
    assert errors[1] == [[None, None]]
    assert len(llm.calls) == 1
    python.assert_awaited_once_with(code, [SOURCE, "invalid SVG"], "P", 3.0)


def test_criteria_images_are_labeled_with_correct_response_grade_and_feedback() -> None:
    llm = FakeLLM(lambda _: "1. Contrast: The logo must be clearly visible.")
    graded = [
        GradedOutput("first source", False, "Not a logo"),
        GradedOutput(SOURCE, True, "Good red contrast", RED),
        GradedOutput("third source", False, "Too green", GREEN),
    ]
    found = asyncio.run(suggest_criteria(llm, "Design a logo", graded))
    assert found[0].title == "Contrast"
    message_parts = parts(llm.calls[0])
    first = message_parts[0]
    assert first["type"] == "text"
    text = first["text"]
    assert all(value in text for value in ["first source", SOURCE, "third source", "Too green"])
    labels = [part["text"] for part in message_parts[1:] if part["type"] == "text"]
    assert "response 2 (good)" in labels[0]
    assert "response 3 (bad)" in labels[1]
    urls = [part["image_url"]["url"] for part in message_parts if part["type"] == "image_url"]
    assert urls == [RED, GREEN]
    assert "actual pixels" in str(llm.calls[0][0]["content"])


def test_image_provider_rejection_is_unknown_with_model_guidance() -> None:
    def reject(_: list[Message]) -> str:
        raise openai.APIError(
            "This model cannot accept image input",
            request=cast(Any, httpx.Request("POST", "https://test")),
            body=None,
        )

    llm = FakeLLM(reject)
    result, errors = asyncio.run(
        run_matrix_detailed(llm, [["A"]], "P", [SOURCE], screenshots=[RED])
    )
    assert result == [[[None]]]
    assert "image-capable evaluator model" in (errors[0][0][0] or "")
    assert len(llm.calls) == 1
    assert image(llm.calls[0]) == RED


def test_garbled_visual_verdict_retry_keeps_the_same_screenshot() -> None:
    attempts = 0

    def answer(messages: list[Message]) -> str:
        nonlocal attempts
        assert image(messages) == RED
        attempts += 1
        return "perhaps" if attempts == 1 else "true"

    llm = FakeLLM(answer)
    assert asyncio.run(run_assertion(llm, "A", "P", SOURCE, screenshot=RED)) is True
    assert len(llm.calls) == 2
    assert llm.calls[0] == llm.calls[1]


def test_misaligned_images_are_rejected_before_provider_calls() -> None:
    llm = FakeLLM(lambda _: "true")
    with pytest.raises(ValueError, match="one image or null per output"):
        asyncio.run(run_matrix_detailed(llm, [["A"]], "P", [SOURCE], screenshots=[]))
    assert not llm.calls


def test_model_capabilities_require_explicit_image_input_and_text_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    models = [
        {"id": "text", "type": "language", "modalities": {"input": ["text"]}},
        {
            "id": "vision",
            "type": "language",
            "modalities": {"input": ["text", "image"], "output": ["text"]},
        },
        {"id": "legacy", "architecture": {"input_modalities": ["text", "image"]}},
        {"id": "custom", "input_modalities": ["image"], "output_modalities": ["text"]},
        {
            "id": "image-generator",
            "type": "image",
            "modalities": {"input": ["image"], "output": ["image"]},
        },
        {"id": "image-only", "modalities": {"input": ["image"], "output": ["image"]}},
        {"id": "name-vision", "tags": ["vision"]},
        {"id": "malformed", "modalities": {"input": "image"}},
    ]

    def answer(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
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

    async def catalog() -> tuple[list[str], list[dict[str, str | bool]], list[str]]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http_client:
            monkeypatch.setattr(
                "evalgen.llm.AsyncOpenAI", partial(AsyncOpenAI, http_client=cast(Any, http_client))
            )
            llm = LLMClient(LLMConfig(base_url="https://gateway.test/v1", api_key="test"))
            return (
                await llm.list_models(),
                await llm.list_model_capabilities(),
                await llm.list_vision_models(),
            )

    names, capabilities, vision = asyncio.run(catalog())
    assert "image-generator" not in names
    assert vision == ["vision", "legacy", "custom"]
    assert {model["id"]: model["vision"] for model in capabilities}["name-vision"] is False
    assert calls == 1, "model and capability lookups share the same metadata response"
