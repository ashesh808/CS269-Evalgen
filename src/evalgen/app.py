"""
Serves the EvalGen web app: a JSON API over the pipeline stages plus the static page

The server is stateless, the page holds the session and sends what each step needs
"""

from dataclasses import asdict
from pathlib import Path

import openai
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from evalgen.alignment import build_report
from evalgen.assertions import suggest_all
from evalgen.config import Settings
from evalgen.criteria import GradedOutput, suggest_criteria
from evalgen.grading import run_matrix, sample_outputs
from evalgen.llm import ModelPool

WEB_DIR = Path(__file__).parent / "web"


class ModelChoice(BaseModel):
    model: str | None = None


class GradedItem(BaseModel):
    output: str
    good: bool
    feedback: str = ""


class CriteriaRequest(ModelChoice):
    prompt: str
    graded: list[GradedItem] = []
    existing: list[str] = []


class AssertionsRequest(ModelChoice):
    prompt: str
    criteria: list[str]


class SampleRequest(ModelChoice):
    prompt: str
    count: int = Field(default=3, ge=1, le=10)


class EvaluateRequest(ModelChoice):
    prompt: str
    assertions: list[list[str]]
    outputs: list[str]


class ReportRequest(BaseModel):
    results: list[list[list[bool | None]]]
    grades: list[bool | None]
    ffr_threshold: float = Field(ge=0.0, le=1.0)
    active: list[bool] | None = None


def create_app(settings: Settings, llm: ModelPool) -> FastAPI:
    """
    Builds the app around an LLM client

    Args:
        settings: The loaded config, for model name and evaluation defaults.
        llm: The chat client every stage calls, switched per request to the model it names.

    Returns:
        The FastAPI app, ready for uvicorn.
    """
    app = FastAPI(title="EvalGen")

    @app.exception_handler(openai.APIError)
    async def llm_error(_: Request, error: openai.APIError) -> JSONResponse:
        detail = f"LLM server at {settings.llm.base_url} failed: {error}"
        return JSONResponse(status_code=502, content={"detail": detail})

    @app.get("/api/info")
    async def info() -> dict[str, object]:
        return {
            "model": settings.llm.model,
            "base_url": settings.llm.base_url,
            "assertions_per_criterion": settings.eval.assertions_per_criterion,
            "ffr_threshold": settings.eval.ffr_threshold,
        }

    @app.get("/api/models")
    async def models() -> dict[str, object]:
        return {"models": await llm.list_models(), "default": settings.llm.model}

    @app.post("/api/criteria")
    async def criteria(body: CriteriaRequest) -> dict[str, list[dict[str, str]]]:
        graded = [GradedOutput(item.output, item.good, item.feedback) for item in body.graded]
        found = await suggest_criteria(
            llm.with_model(body.model), body.prompt, graded, body.existing
        )
        return {"criteria": [asdict(item) for item in found]}

    @app.post("/api/assertions")
    async def assertions(body: AssertionsRequest) -> dict[str, list[list[str]]]:
        count = settings.eval.assertions_per_criterion
        client = llm.with_model(body.model)
        return {"assertions": await suggest_all(client, body.prompt, body.criteria, count)}

    @app.post("/api/sample")
    async def sample(body: SampleRequest) -> dict[str, list[str]]:
        temperature = settings.llm.sample_temperature
        client = llm.with_model(body.model)
        return {"outputs": await sample_outputs(client, body.prompt, body.count, temperature)}

    @app.post("/api/evaluate")
    async def evaluate(body: EvaluateRequest) -> dict[str, list[list[list[bool | None]]]]:
        cap = settings.llm.verdict_max_tokens
        client = llm.with_model(body.model)
        results = await run_matrix(client, body.assertions, body.prompt, body.outputs, cap)
        return {"results": results}

    @app.post("/api/report")
    async def report(body: ReportRequest) -> dict[str, object]:
        report = build_report(body.results, body.grades, body.ffr_threshold, body.active)
        return asdict(report)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app
