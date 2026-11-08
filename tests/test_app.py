import json
from collections.abc import Callable
from pathlib import Path

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM, Responder
from evalgen.app import create_app
from evalgen.config import load_settings
from evalgen.prompts import Message
from evalgen.sandbox import sandbox_status

ROOT = Path(__file__).resolve().parents[1]
PYTHON_ASSERTION = (
    "import re\n"
    "def evaluate(response: str, prompt: str) -> bool:\n"
    "    return len(re.findall(r'\\S+', response)) <= 2\n"
)


def respond(messages: list[Message]) -> str:
    content = messages[-1]["content"]
    if "Python functions" in messages[0]["content"]:
        return json.dumps({"assertions": [PYTHON_ASSERTION]})
    if "<Assertion>" in content:
        return "false" if "rude" in content else "true"
    if "Evaluation Criterion" in content:
        return "1. If the response is polite, return True; otherwise, return False."
    if "Evaluation Criteria" in content:
        return "1. Polite: The response should be polite."
    return "a sampled output"


def client(llm: FakeLLM) -> TestClient:
    return TestClient(create_app(load_settings(ROOT / "config.toml"), llm))


def test_full_flow(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    api = client(fake_llm(respond))
    info = api.get("/api/info").json()
    assert info["model"] and info["sampling_policy"] == "alternating"
    assert isinstance(info["python_sandbox"]["available"], bool)
    assert {"backend", "reason"} <= info["python_sandbox"].keys()
    found = api.post("/api/criteria", json={"prompt": "Greet"}).json()["criteria"]
    assert found == [{"title": "Polite", "description": "The response should be polite."}]
    criteria = [f"{c['title']}: {c['description']}" for c in found]
    groups = api.post("/api/assertions", json={"prompt": "Greet", "criteria": criteria})
    assertions = groups.json()["assertions"]
    outputs = ["hello there", "go away, rude"]
    body = {"prompt": "Greet", "assertions": assertions, "outputs": outputs}
    results = api.post("/api/evaluate", json=body).json()["results"]
    assert results == [[[True, False]]]
    body = {"results": results, "grades": [True, False], "ffr_threshold": 0.4}
    report = api.post("/api/report", json=body).json()
    assert report["criteria"][0]["selected"] == 0
    assert report["overall"]["alignment"] == 1.0
    assert report["criteria"][0]["scores"][0]["confusion"]["bad_failed"] == 1


def test_model_choice_reaches_the_client(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    llm = fake_llm(respond)
    api = client(llm)
    listing = api.get("/api/models").json()
    assert listing["models"] == ["small", "large"] and listing["default"]
    api.post("/api/criteria", json={"prompt": "Greet", "model": "large"})
    api.post("/api/sample", json={"prompt": "Greet", "count": 1})
    assert llm.models == ["large", None]


def test_sample_and_static(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    api = client(fake_llm(respond))
    sampled = api.post("/api/sample", json={"prompt": "Greet", "count": 2}).json()
    assert sampled == {
        "outputs": ["a sampled output"] * 2,
        "output_details": [{"explanation": None, "explanation_status": "unavailable"}] * 2,
    }
    assert "EvalGen" in api.get("/").text
    assert api.get("/static/themes.js").status_code == 200


@pytest.mark.parametrize(
    ("output_format", "source"),
    [
        ("text", '  Café 雪 🙂 says "hello".\n'),
        ("svg", '<svg xmlns="http://www.w3.org/2000/svg"><text>雪</text></svg>\n'),
        ("html", '<!doctype html>\n<html><body><script>const x={a:"雪"}</script></body></html>\n'),
    ],
)
def test_sample_explanations_are_parallel_metadata_not_evaluation_input(
    fake_llm: Callable[[Responder], FakeLLM], output_format: str, source: str
) -> None:
    explanation = "Distinctive public explanation, not evaluation evidence."

    def respond_with_envelope(messages: list[Message]) -> str:
        if "<Assertion>" in messages[-1]["content"]:
            assert source in messages[-1]["content"]
            assert explanation not in messages[-1]["content"]
            return "true"
        return json.dumps(
            {
                "output": source,
                "explanation": explanation,
                "reasoning": "private-sentinel",
                "credentials": "secret-sentinel",
            },
            ensure_ascii=False,
        )

    llm = fake_llm(respond_with_envelope)
    api = client(llm)
    response = api.post(
        "/api/sample",
        json={"prompt": "Original request", "count": 2, "output_format": output_format},
    )
    assert response.status_code == 200
    sampled = response.json()
    assert sampled == {
        "outputs": [source, source],
        "output_details": [
            {"explanation": explanation, "explanation_status": "provided"},
            {"explanation": explanation, "explanation_status": "provided"},
        ],
    }
    assert "sentinel" not in response.text
    assert len(llm.calls) == 2
    evaluation = api.post(
        "/api/evaluate",
        json={
            "prompt": "Original request",
            "output_format": output_format,
            "assertions": [["Check the answer/source"]],
            "outputs": sampled["outputs"],
        },
    )
    assert evaluation.status_code == 200
    assert evaluation.json()["results"] == [[[True, True]]]
    assert len(llm.calls) == 4


def test_mixed_code_and_llm_flow(fake_llm: Callable[[Responder], FakeLLM]) -> None:
    status = sandbox_status()
    if not status["available"]:
        pytest.skip(str(status["reason"]))
    llm = fake_llm(respond)
    api = client(llm)
    generation = api.post(
        "/api/assertions",
        json={"prompt": "Greet", "criteria": ["Polite", "Short"], "kinds": ["llm", "python"]},
    )
    assert generation.status_code == 200
    assertions = generation.json()["assertions"]
    assert assertions[1] == [PYTHON_ASSERTION.strip()]
    evaluation = api.post(
        "/api/evaluate",
        json={
            "prompt": "Greet",
            "assertions": assertions,
            "outputs": ["hello there", "go away, rude"],
            "kinds": ["llm", "python"],
        },
    )
    assert evaluation.status_code == 200
    assert evaluation.json() == {
        "results": [[[True, False]], [[True, False]]],
        "errors": [[[None, None]], [[None, None]]],
    }
    # Two generation calls and two LLM verdicts; Python execution never asks the LLM.
    assert len(llm.calls) == 4


def test_unavailable_sandbox_rejects_python_without_model_calls(
    fake_llm: Callable[[Responder], FakeLLM], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "evalgen.app.sandbox_status",
        lambda: {"available": False, "backend": None, "reason": "No isolation backend"},
    )
    llm = fake_llm(respond)
    api = client(llm)
    requests = [
        ("/api/assertions", {"prompt": "P", "criteria": ["Short"], "kinds": ["python"]}),
        (
            "/api/evaluate",
            {
                "prompt": "P",
                "assertions": [[PYTHON_ASSERTION]],
                "outputs": ["R"],
                "kinds": ["python"],
            },
        ),
    ]
    for route, body in requests:
        response = api.post(route, json=body)
        assert response.status_code == 503
        assert response.json()["detail"] == "No isolation backend"
    assert not llm.calls


def test_evaluation_api_isolates_provider_errors_and_streams_indexed_events(
    fake_llm: Callable[[Responder], FakeLLM],
) -> None:
    def respond_with_error(messages: list[Message]) -> str:
        if "<Response>\nbroken\n</Response>" in messages[-1]["content"]:
            raise openai.APIError(
                "one response was rejected",
                request=httpx.Request("POST", "https://test.invalid"),
                body=None,
            )
        return "true"

    api = client(fake_llm(respond_with_error))
    body = {"prompt": "P", "assertions": [["A"]], "outputs": ["healthy", "broken"]}
    response = api.post("/api/evaluate", json=body)
    assert response.status_code == 200
    data = response.json()
    assert data["results"] == [[[True, None]]]
    assert data["errors"][0][0][0] is None
    assert "one response was rejected" in data["errors"][0][0][1]

    streamed = api.post("/api/evaluate/stream", json=body)
    assert streamed.status_code == 200
    assert streamed.headers["content-type"].startswith("application/x-ndjson")
    events = [json.loads(line) for line in streamed.text.splitlines()]
    assert events[-1] == {"done": True}
    cells = {
        (event["criterion"], event["assertion"], event["output"]): event for event in events[:-1]
    }
    assert set(cells) == {(0, 0, 0), (0, 0, 1)}
    assert cells[(0, 0, 0)]["verdict"] is True
    assert cells[(0, 0, 0)]["error"] is None
    assert cells[(0, 0, 1)]["verdict"] is None
    assert "one response was rejected" in cells[(0, 0, 1)]["error"]


def test_report_api_excludes_unknown_candidate_and_leaves_empty_set_unavailable(
    fake_llm: Callable[[Responder], FakeLLM],
) -> None:
    api = client(fake_llm(respond))
    response = api.post(
        "/api/report",
        json={"results": [[[False, None]]], "grades": [False, True], "ffr_threshold": 0.4},
    )
    assert response.status_code == 200
    report = response.json()
    assert report["criteria"][0]["selected"] is None
    assert report["criteria"][0]["scores"][0]["unknown_count"] == 1
    assert report["set_fails"] == [None, None]
    assert report["overall"]["coverage"] is report["overall"]["ffr"] is None
    assert report["overall"]["alignment"] is None
    assert not report["selection_complete"]


def test_sampling_api_returns_adaptive_plan_and_requested_polarity(
    fake_llm: Callable[[Responder], FakeLLM],
) -> None:
    api = client(fake_llm(respond))
    body: dict[str, object] = {"results": [[[True, None, False]]], "grades": [None, None, None]}
    high = api.post("/api/sampling", json=body)
    assert high.status_code == 200
    assert high.json() == {
        "selectivities": [[0.5]],
        "confidence": [0.0, 0.0, 0.5],
        "known_counts": [1, 0, 1],
        "next_index": 2,
        "next_high": True,
    }
    body.update({"grades": [None, None, False], "next_high": False})
    low = api.post("/api/sampling", json=body).json()
    assert low["next_index"] == 0 and low["next_high"] is False


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("/api/assertions", {"prompt": "P", "criteria": ["C"], "kinds": []}),
        ("/api/evaluate", {"prompt": "P", "assertions": [["A"]], "outputs": [], "kinds": []}),
        ("/api/evaluate", {"prompt": "P", "assertions": [["A"]], "outputs": [], "kinds": ["code"]}),
        ("/api/report", {"results": [[[True]]], "grades": [False, True], "ffr_threshold": 0.4}),
        (
            "/api/report",
            {"results": [[[True]]], "grades": [True], "ffr_threshold": 0.4, "active": []},
        ),
        ("/api/report", {"results": [[[1]]], "grades": [True], "ffr_threshold": 0.4}),
        ("/api/report", {"results": [[[True]]], "grades": ["false"], "ffr_threshold": 0.4}),
        ("/api/sampling", {"results": [[[True]]], "grades": [None], "next_high": "true"}),
    ],
)
def test_api_rejects_malformed_shapes_and_coerced_booleans(
    fake_llm: Callable[[Responder], FakeLLM], route: str, body: dict[str, object]
) -> None:
    llm = fake_llm(respond)
    response = client(llm).post(route, json=body)
    assert response.status_code == 422
    assert not llm.calls
