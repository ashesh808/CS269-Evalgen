"""Visual grading keeps pixels aligned with source and fails closed on missing evidence."""

import base64
import json
import struct
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM
from evalgen.app import create_app
from evalgen.config import load_settings

ROOT = Path(__file__).resolve().parents[1]
PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8A"
    "AwMCAO+aUdoAAAAASUVORK5CYII="
)
SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>'


@pytest.fixture
def visual(monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, FakeLLM]:
    llm = FakeLLM(lambda _: "true")
    monkeypatch.setattr(
        llm, "list_vision_models", AsyncMock(return_value=["vision"]), raising=False
    )
    monkeypatch.setattr(
        "evalgen.app.renderer_status",
        lambda: {"available": True, "backend": "test", "reason": ""},
    )
    return TestClient(create_app(load_settings(ROOT / "config.toml"), llm)), llm


def request_body() -> dict[str, object]:
    return {
        "prompt": "Design a clean logo",
        "output_format": "svg",
        "evaluation_mode": "screenshot",
        "model": "vision",
        "assertions": [["The mark is clearly visible in the screenshot"]],
        "outputs": [SOURCE],
        "screenshots": [PNG],
    }


@pytest.mark.parametrize("route", ["/api/evaluate", "/api/evaluate/stream"])
def test_actual_pixels_and_source_reach_the_selected_vision_evaluator(
    visual: tuple[TestClient, FakeLLM], route: str
) -> None:
    api, llm = visual
    response = api.post(route, json=request_body())
    assert response.status_code == 200
    if route.endswith("stream"):
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[0]["verdict"] is True and events[-1] == {"done": True}
    else:
        assert response.json()["results"] == [[[True]]]
    assert llm.models == ["vision"]
    content = llm.calls[0][-1]["content"]
    assert isinstance(content, list)
    assert any(
        part["type"] == "image_url" and part["image_url"]["url"] == PNG for part in content
    )
    assert any(SOURCE in part.get("text", "") for part in content)
    assert any("fresh initial render" in part.get("text", "") for part in content)


def test_missing_image_is_unknown_without_a_source_only_model_call(
    visual: tuple[TestClient, FakeLLM],
) -> None:
    api, llm = visual
    body = {**request_body(), "outputs": [SOURCE, SOURCE], "screenshots": [PNG, None]}
    response = api.post("/api/evaluate", json=body)
    assert response.status_code == 200
    assert response.json()["results"] == [[[True, None]]]
    assert response.json()["errors"][0][0][1]
    assert len(llm.calls) == 1


def test_text_only_model_is_rejected_before_evaluation(visual: tuple[TestClient, FakeLLM]) -> None:
    api, llm = visual
    response = api.post("/api/evaluate", json={**request_body(), "model": "text-only"})
    assert response.status_code == 422
    assert "image-capable" in response.json()["detail"]
    assert not llm.calls


@pytest.mark.parametrize(
    "change",
    [
        {"screenshots": []},
        {"screenshots": None},
        {"screenshots": ["https://example.com/private.png"]},
        {"screenshots": ["data:image/svg+xml;base64,PHN2Zy8+"]},
        {"screenshots": ["data:image/png;base64,not-base64"]},
        {"screenshots": ["data:image/png;base64," + base64.b64encode(b"not PNG").decode()]},
        {"output_format": "text"},
        {"evaluation_mode": "source"},
    ],
)
def test_bad_visual_evidence_is_rejected_before_provider_calls(
    visual: tuple[TestClient, FakeLLM], change: dict[str, object]
) -> None:
    api, llm = visual
    assert api.post("/api/evaluate", json={**request_body(), **change}).status_code == 422
    assert not llm.calls


def test_oversized_image_dimensions_are_rejected(visual: tuple[TestClient, FakeLLM]) -> None:
    api, llm = visual
    raw = bytearray(base64.b64decode(PNG.split(",", 1)[1]))
    raw[16:24] = struct.pack(">II", 960, 2001)
    image = "data:image/png;base64," + base64.b64encode(raw).decode()
    response = api.post("/api/evaluate", json={**request_body(), "screenshots": [image]})
    assert response.status_code == 422
    assert not llm.calls


def test_visual_criteria_receive_graded_images_and_feedback(
    visual: tuple[TestClient, FakeLLM],
) -> None:
    api, llm = visual
    llm.respond = lambda _: "1. Legible: The logo is legible in the screenshot."
    response = api.post(
        "/api/criteria",
        json={
            "prompt": "Design a clean logo",
            "output_format": "svg",
            "evaluation_mode": "screenshot",
            "model": "vision",
            "graded": [
                {"output": SOURCE, "good": False, "feedback": "Too faint", "screenshot": PNG}
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["criteria"][0]["title"] == "Legible"
    content = llm.calls[0][-1]["content"]
    assert isinstance(content, list)
    assert any(
        part["type"] == "image_url" and part["image_url"]["url"] == PNG for part in content
    )
    assert any("Too faint" in part.get("text", "") for part in content)


def test_visual_graded_examples_cannot_silently_omit_images(
    visual: tuple[TestClient, FakeLLM],
) -> None:
    api, llm = visual
    response = api.post(
        "/api/criteria",
        json={
            "prompt": "Design a logo",
            "output_format": "svg",
            "evaluation_mode": "screenshot",
            "model": "vision",
            "graded": [{"output": SOURCE, "good": False}],
        },
    )
    assert response.status_code == 422
    assert not llm.calls


@pytest.mark.parametrize("output_format", ["svg", "html"])
def test_capture_keeps_source_provenance_and_per_output_failure(
    visual: tuple[TestClient, FakeLLM], monkeypatch: pytest.MonkeyPatch, output_format: str
) -> None:
    api, _ = visual
    images = [
        {
            "data_url": PNG,
            "width": 1,
            "height": 1,
            "viewport": {"width": 960, "height": 640},
            "source_hash": "a" * 64,
        },
        {"error": "Render timed out", "source_hash": "b" * 64},
    ]
    render = AsyncMock(return_value=images)
    monkeypatch.setattr("evalgen.app.render_previews", render)
    response = api.post(
        "/api/screenshots", json={"output_format": output_format, "outputs": [SOURCE, "bad source"]}
    )
    assert response.status_code == 200
    assert response.json()["screenshots"] == images
    render.assert_awaited_once_with([SOURCE, "bad source"], output_format)


def test_unavailable_renderer_does_not_fake_a_capture(
    visual: tuple[TestClient, FakeLLM], monkeypatch: pytest.MonkeyPatch
) -> None:
    api, _ = visual
    render = AsyncMock()
    monkeypatch.setattr("evalgen.app.render_previews", render)
    monkeypatch.setattr(
        "evalgen.app.renderer_status", lambda: {"available": False, "reason": "Install the browser"}
    )
    response = api.post("/api/screenshots", json={"output_format": "svg", "outputs": [SOURCE]})
    assert response.status_code == 503
    assert response.json()["detail"] == "Install the browser"
    render.assert_not_awaited()


def test_browser_and_vision_capabilities_are_discoverable(
    visual: tuple[TestClient, FakeLLM],
) -> None:
    api, _ = visual
    assert api.get("/api/models").json()["vision_models"] == ["vision"]
    assert api.get("/api/info").json()["screenshot_renderer"]["available"] is True
