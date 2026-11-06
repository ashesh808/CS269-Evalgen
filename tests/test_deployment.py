import importlib.util
import re
import tomllib
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urljoin

import pytest
from fastapi.testclient import TestClient

from conftest import FakeLLM
from evalgen.config import LLMConfig, Settings
from evalgen.prompts import Message

ROOT = Path(__file__).resolve().parents[1]
TEST_KEY = "deployment-test-key-not-a-secret"


@pytest.fixture
def deployed_app(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[TestClient, Settings]]:
    # A conflicting cwd config catches accidental relative-path loading at import time.
    (tmp_path / "config.toml").write_text('[LLM]\nmodel = "wrong-working-directory"\n')
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EVALGEN_API_KEY", TEST_KEY)
    monkeypatch.setattr(
        "evalgen.app.sandbox_status",
        lambda: {"available": False, "backend": None, "reason": "Not needed for deployment tests"},
    )

    def reject_model_call(messages: list[Message]) -> str:
        raise AssertionError("Deployment smoke routes must not call an LLM")

    llm = FakeLLM(reject_model_call)

    def make_client(config: LLMConfig) -> FakeLLM:
        assert config.api_key == TEST_KEY
        return llm

    monkeypatch.setattr("evalgen.llm.LLMClient", make_client)
    spec = importlib.util.spec_from_file_location("evalgen_deployment_entry", ROOT / "app.py")
    assert spec is not None and spec.loader is not None
    entry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry)
    with TestClient(entry.app) as api:
        yield api, entry.settings
    assert not llm.calls


def test_asgi_entrypoint_loads_repository_config_from_another_directory(
    deployed_app: tuple[TestClient, Settings],
) -> None:
    api, settings = deployed_app
    repository_config = tomllib.loads((ROOT / "config.toml").read_text())
    assert settings.llm.model == repository_config["LLM"]["model"]
    assert settings.eval.ffr_threshold == repository_config["Eval"]["ffr_threshold"]
    assert settings.llm.api_key == TEST_KEY
    response = api.get("/api/info")
    assert response.status_code == 200
    assert response.json()["model"] == settings.llm.model
    assert response.json()["python_sandbox"]["available"] is False
    assert TEST_KEY not in response.text


def test_deployed_root_and_referenced_assets_are_served_without_backend_host_label(
    deployed_app: tuple[TestClient, Settings],
) -> None:
    api, _ = deployed_app
    response = api.get("/")
    assert response.status_code == 200 and "EvalGen" in response.text
    assert "text/html" in response.headers["content-type"]
    html = response.text
    paths = set(re.findall(r'(?:src|href)="(/static/[^"]+)"', html))
    assert {"/static/app.js", "/static/app.css"} <= paths
    for path in paths:
        asset = api.get(path)
        assert asset.status_code == 200 and asset.content, path
        assert TEST_KEY not in asset.text
        if path.endswith(".css"):
            assert "text/css" in asset.headers["content-type"]
            for font in re.findall(r"url\(['\"]?([^'\")]+)", asset.text):
                font_response = api.get(urljoin(path, font))
                assert font_response.status_code == 200 and font_response.content, font
        elif path.endswith(".js"):
            assert "javascript" in asset.headers["content-type"]
    javascript = api.get("/static/app.js").text
    assert "server-chip" not in html + javascript
    assert "LLM server" not in html + javascript


def test_deployed_report_and_sampling_routes_work_without_model_access(
    deployed_app: tuple[TestClient, Settings],
) -> None:
    api, _ = deployed_app
    report = api.post(
        "/api/report",
        json={"results": [[[False, True]]], "grades": [False, True], "ffr_threshold": 0.0},
    )
    assert report.status_code == 200
    assert report.json()["criteria"][0]["selected"] == 0
    assert report.json()["selection_complete"]
    assert report.json()["overall"]["alignment"] == 1.0
    sampling = api.post(
        "/api/sampling",
        json={"results": [[[True, None, False]]], "grades": [None, None, None]},
    )
    assert sampling.status_code == 200
    assert sampling.json()["next_index"] == 2
    assert sampling.json()["selectivities"] == [[0.5]]
    assert sampling.json()["confidence"] == [0.0, 0.0, 0.5]
