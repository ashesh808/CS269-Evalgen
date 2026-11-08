"""Artifact formats retain raw source and carry the same contract through each stage."""

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM, Responder
from evalgen.app import create_app
from evalgen.config import load_settings
from evalgen.prompts import Message
from evalgen.sandbox import PythonEvaluation

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="8"/></svg>',
    "html": "<!doctype html><html><head><style>button{color:red}</style></head>"
    '<body><button id="go">Go</button><script>go.onclick=()=>go.textContent="Done"</script>'
    "</body></html>",
}


def client(llm: FakeLLM) -> TestClient:
    return TestClient(create_app(load_settings(ROOT / "config.toml"), llm))


@pytest.mark.parametrize("output_format", ["svg", "html"])
def test_sampling_requests_self_contained_artifacts_and_preserves_source(
    fake_llm: Callable[[Responder], FakeLLM], output_format: str
) -> None:
    source = SOURCES[output_format]
    llm = fake_llm(lambda _: source)
    response = client(llm).post(
        "/api/sample",
        json={"prompt": "Design a bright identity", "count": 2, "output_format": output_format},
    )
    assert response.status_code == 200
    assert response.json() == {
        "outputs": [source, source],
        "output_details": [
            {"explanation": None, "explanation_status": "unavailable"},
            {"explanation": None, "explanation_status": "unavailable"},
        ],
    }
    assert len(llm.calls) == 2
    for messages in llm.calls:
        prompt = messages[-1]["content"]
        assert isinstance(prompt, str)
        assert prompt.startswith("Design a bright identity\n\nOutput format:")
        assert f"Output format: {output_format.upper()}" in prompt
        assert "self-contained" in prompt
        assert "without Markdown fences" in prompt
        assert "Evaluation context:" not in prompt
    if output_format == "svg":
        assert "viewBox" in prompt and "SVG namespace" in prompt
    else:
        assert "<style>" in prompt and "<script>" in prompt
        assert "without a build step" in prompt


@pytest.mark.parametrize("output_format", [None, "text"])
def test_text_sampling_preserves_the_original_prompt_exactly(
    fake_llm: Callable[[Responder], FakeLLM], output_format: str | None
) -> None:
    llm = fake_llm(lambda _: "text reply")
    prompt = "Write a greeting.\nKeep these instructions.\n"
    body: dict[str, object] = {"prompt": prompt, "count": 1}
    if output_format is not None:
        body["output_format"] = output_format
    response = client(llm).post("/api/sample", json=body)
    assert response.status_code == 200
    assert len(llm.calls) == 1
    assert llm.calls[0][-1] == {"role": "user", "content": prompt}
    assert llm.calls[0][0]["role"] == "system"


@pytest.mark.parametrize("output_format", ["svg", "html"])
def test_artifact_contract_and_human_feedback_reach_criteria_and_assertions(
    fake_llm: Callable[[Responder], FakeLLM], output_format: str
) -> None:
    def respond(messages: list[Message]) -> str:
        if "Evaluation Criterion" in messages[-1]["content"]:
            return "1. Return true if the design contains a red shape; otherwise return false."
        return "1. Red shape: The source must define a red shape."

    llm = fake_llm(respond)
    api = client(llm)
    body = {
        "prompt": "Design a bright identity",
        "output_format": output_format,
        "graded": [{"output": SOURCES[output_format], "good": False, "feedback": "Too busy"}],
    }
    criteria = api.post("/api/criteria", json=body)
    assert criteria.status_code == 200
    assert criteria.json()["criteria"][0]["title"] == "Red shape"
    assert SOURCES[output_format] in llm.calls[0][-1]["content"]
    assert "Too busy" in llm.calls[0][-1]["content"]
    assertions = api.post(
        "/api/assertions",
        json={
            "prompt": body["prompt"],
            "output_format": output_format,
            "criteria": ["Red shape"],
        },
    )
    assert assertions.status_code == 200
    assert assertions.json()["assertions"][0]
    for messages in llm.calls:
        context = messages[-1]["content"]
        assert f"Output format: {output_format.upper()}" in context
        assert "not prose" in context
        assert "do not claim to have visually inspected" in context
        assert "human grades and feedback" in context
        assert "cannot render or execute" in context


@pytest.mark.parametrize("route", ["/api/evaluate", "/api/evaluate/stream"])
@pytest.mark.parametrize("output_format", ["svg", "html"])
def test_artifact_evaluation_uses_source_without_claiming_browser_access(
    fake_llm: Callable[[Responder], FakeLLM], route: str, output_format: str
) -> None:
    llm = fake_llm(lambda _: "true")
    source = SOURCES[output_format]
    response = client(llm).post(
        route,
        json={
            "prompt": "Design a bright identity",
            "output_format": output_format,
            "assertions": [["The source is self-contained"]],
            "outputs": [source],
        },
    )
    assert response.status_code == 200
    if route.endswith("/stream"):
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[0]["verdict"] is True
        assert events[-1] == {"done": True}
    else:
        assert response.json()["results"] == [[[True]]]
    context = llm.calls[0][-1]["content"]
    assert f"<Response>\n{source}\n</Response>" in context
    assert f"Output format: {output_format.upper()}" in context
    assert "do not claim to have visually inspected" in context


def test_python_artifact_evaluators_receive_raw_source_without_an_llm_call(
    fake_llm: Callable[[Responder], FakeLLM], monkeypatch: pytest.MonkeyPatch
) -> None:
    source = SOURCES["html"]
    code = "def evaluate(response, prompt):\n    return '<style>' in response"
    captured: list[tuple[str, list[str], str]] = []

    async def evaluate_source(
        candidate: str, outputs: list[str], prompt: str, timeout: float
    ) -> PythonEvaluation:
        captured.append((candidate, outputs, prompt))
        return PythonEvaluation([True], [None], "test")

    monkeypatch.setattr("evalgen.grading.evaluate_python_detailed", evaluate_source)
    monkeypatch.setattr(
        "evalgen.app.sandbox_status",
        lambda: {"available": True, "backend": "test", "reason": ""},
    )
    llm = fake_llm(lambda _: "unused")
    response = client(llm).post(
        "/api/evaluate",
        json={
            "prompt": "Design a bright identity",
            "output_format": "html",
            "assertions": [[code]],
            "outputs": [source],
            "kinds": ["python"],
        },
    )
    assert response.status_code == 200
    assert response.json() == {"results": [[[True]]], "errors": [[[None]]]}
    assert captured[0][:2] == (code, [source])
    assert "Output format: HTML" in captured[0][2]
    assert not llm.calls


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("/api/sample", {"count": 1}),
        ("/api/criteria", {}),
        ("/api/assertions", {"criteria": ["C"]}),
        ("/api/evaluate", {"assertions": [["A"]], "outputs": ["R"]}),
        ("/api/evaluate/stream", {"assertions": [["A"]], "outputs": ["R"]}),
    ],
)
def test_unsupported_output_formats_are_rejected_before_model_calls(
    fake_llm: Callable[[Responder], FakeLLM], route: str, body: dict[str, object]
) -> None:
    llm = fake_llm(lambda _: "unused")
    response = client(llm).post(route, json={**body, "prompt": "P", "output_format": "image"})
    assert response.status_code == 422
    assert not llm.calls
