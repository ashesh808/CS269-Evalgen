from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import FakeLLM, Responder
from evalgen.app import create_app
from evalgen.config import load_settings
from evalgen.prompts import Message

ROOT = Path(__file__).resolve().parents[1]


def respond(messages: list[Message]) -> str:
    content = messages[-1]["content"]
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
    assert api.get("/api/info").json()["model"]
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
    outputs = api.post("/api/sample", json={"prompt": "Greet", "count": 2}).json()["outputs"]
    assert outputs == ["a sampled output"] * 2
    assert "EvalGen" in api.get("/").text
    assert api.get("/static/themes.js").status_code == 200
