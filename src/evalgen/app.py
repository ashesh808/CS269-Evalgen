"""
Serves the EvalGen web app: a JSON API over the pipeline stages plus the static page

The server is stateless, the page holds the session and sends what each step needs
"""

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import asdict
from pathlib import Path
from typing import Literal, Self

import openai
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictBool, model_validator

from evalgen.alignment import build_report
from evalgen.assertions import EvaluatorKind, suggest_all
from evalgen.config import Settings
from evalgen.criteria import GradedOutput, suggest_criteria
from evalgen.grading import run_matrix_detailed, run_matrix_events, sample_outputs
from evalgen.llm import ModelPool
from evalgen.sampling import sampling_plan
from evalgen.sandbox import sandbox_status

WEB_DIR = Path(__file__).parent / "web"
OutputFormat = Literal["text", "svg", "html"]

FORMAT_INSTRUCTIONS = {
    "svg": (
        "Return a complete, standalone SVG document, with an <svg> root, the SVG namespace, "
        "and a viewBox. Use vector shapes and inline styles. Keep the design self-contained: "
        "do not use external fonts, images, stylesheets, scripts, or other network resources. "
        "Return only the SVG source, without Markdown fences or explanatory prose."
    ),
    "html": (
        "Return one complete, self-contained HTML document for the requested website mockup. "
        "Include a doctype, a responsive viewport, inline CSS in <style>, and any simple "
        "JavaScript interactions in <script>. Use plain HTML/CSS/JavaScript without a build "
        "step, external libraries, remote fonts, images, stylesheets, or network requests. "
        "Return only the HTML source, without Markdown fences or explanatory prose."
    ),
}


def output_prompt(prompt: str, output_format: OutputFormat, *, evaluation: bool = False) -> str:
    """Add the artifact contract while preserving ordinary text requests exactly."""
    if output_format == "text":
        return prompt
    context = (
        f"{prompt}\n\nOutput format: {output_format.upper()}\n"
        f"{FORMAT_INSTRUCTIONS[output_format]}"
    )
    if evaluation:
        context += (
            "\n\nEvaluation context: Responses are artifact source code, not prose. "
            "Evaluate task requirements and properties that can be established from the source. "
            "You do not have a rendered screenshot or browser runtime: do not claim to have "
            "visually inspected the design or executed its interactions. Use human grades and "
            "feedback, when provided, as evidence for visual preferences. Keep generated "
            "criteria and assertions specific and checkable from source or that feedback. "
            "Python evaluators receive the raw source as response, and may parse or inspect it; "
            "they cannot render or execute SVG, HTML, CSS, or JavaScript."
        )
    return context


class ModelChoice(BaseModel):
    model: str | None = None


class PromptRequest(ModelChoice):
    prompt: str
    output_format: OutputFormat = "text"


class GradedItem(BaseModel):
    output: str
    good: StrictBool
    feedback: str = ""


class CriteriaRequest(PromptRequest):
    graded: list[GradedItem] = []
    existing: list[str] = []


class AssertionsRequest(PromptRequest):
    criteria: list[str]
    kinds: list[EvaluatorKind] | None = None

    @model_validator(mode="after")
    def matching_kinds(self) -> Self:
        if self.kinds is not None and len(self.kinds) != len(self.criteria):
            raise ValueError("kinds must contain one evaluator type per criterion")
        return self


class SampleRequest(PromptRequest):
    count: int = Field(default=3, ge=1, le=10)


class EvaluateRequest(PromptRequest):
    assertions: list[list[str]]
    outputs: list[str]
    kinds: list[EvaluatorKind] | None = None

    @model_validator(mode="after")
    def matching_kinds(self) -> Self:
        if self.kinds is not None and len(self.kinds) != len(self.assertions):
            raise ValueError("kinds must contain one evaluator type per assertion group")
        return self


class SamplingRequest(BaseModel):
    results: list[list[list[StrictBool | None]]]
    grades: list[StrictBool | None]
    next_high: StrictBool = True

    @model_validator(mode="after")
    def matching_outputs(self) -> Self:
        if any(len(row) != len(self.grades) for group in self.results for row in group):
            raise ValueError("every candidate must have one verdict per output grade")
        return self


class ReportRequest(SamplingRequest):
    ffr_threshold: float = Field(ge=0.0, le=1.0)
    active: list[StrictBool] | None = None

    @model_validator(mode="after")
    def matching_active(self) -> Self:
        if self.active is not None and len(self.active) != len(self.results):
            raise ValueError("active must contain one inclusion flag per criterion")
        return self


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
    python_limit = asyncio.Semaphore(settings.eval.python_max_concurrency)

    def require_sandbox(kinds: list[EvaluatorKind] | None) -> None:
        python_sandbox = sandbox_status()
        if kinds and "python" in kinds and not python_sandbox["available"]:
            raise HTTPException(status_code=503, detail=python_sandbox["reason"])

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
            "python_sandbox": sandbox_status(),
            "sampling_policy": "alternating",
            "output_formats": ["text", "svg", "html"],
        }

    @app.get("/api/models")
    async def models() -> dict[str, object]:
        return {"models": await llm.list_models(), "default": settings.llm.model}

    @app.post("/api/criteria")
    async def criteria(body: CriteriaRequest) -> dict[str, list[dict[str, str]]]:
        graded = [GradedOutput(item.output, item.good, item.feedback) for item in body.graded]
        found = await suggest_criteria(
            llm.with_model(body.model),
            output_prompt(body.prompt, body.output_format, evaluation=True),
            graded,
            body.existing,
        )
        return {"criteria": [asdict(item) for item in found]}

    @app.post("/api/assertions")
    async def assertions(body: AssertionsRequest) -> dict[str, list[list[str]]]:
        require_sandbox(body.kinds)
        count = settings.eval.assertions_per_criterion
        client = llm.with_model(body.model)
        try:
            groups = await suggest_all(
                client,
                output_prompt(body.prompt, body.output_format, evaluation=True),
                body.criteria,
                count,
                body.kinds,
            )
        except ValueError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        return {"assertions": groups}

    @app.post("/api/sample")
    async def sample(body: SampleRequest) -> dict[str, list[str]]:
        temperature = settings.llm.sample_temperature
        client = llm.with_model(body.model)
        return {
            "outputs": await sample_outputs(
                client, output_prompt(body.prompt, body.output_format), body.count, temperature
            )
        }

    @app.post("/api/evaluate")
    async def evaluate(body: EvaluateRequest) -> dict[str, object]:
        require_sandbox(body.kinds)
        cap = settings.llm.verdict_max_tokens
        client = llm.with_model(body.model)
        results, errors = await run_matrix_detailed(
            client,
            body.assertions,
            output_prompt(body.prompt, body.output_format, evaluation=True),
            body.outputs,
            cap,
            body.kinds,
            settings.eval.python_timeout,
            python_limit,
        )
        return {"results": results, "errors": errors}

    @app.post("/api/evaluate/stream")
    async def evaluate_stream(body: EvaluateRequest) -> StreamingResponse:
        require_sandbox(body.kinds)

        async def events() -> AsyncIterator[str]:
            async for event in run_matrix_events(
                llm.with_model(body.model),
                body.assertions,
                output_prompt(body.prompt, body.output_format, evaluation=True),
                body.outputs,
                settings.llm.verdict_max_tokens,
                body.kinds,
                settings.eval.python_timeout,
                python_limit,
            ):
                yield json.dumps(asdict(event)) + "\n"
            yield json.dumps({"done": True}) + "\n"

        return StreamingResponse(
            events(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"}
        )

    @app.post("/api/sampling")
    async def sampling(body: SamplingRequest) -> dict[str, object]:
        return asdict(sampling_plan(body.results, body.grades, body.next_high))

    @app.post("/api/report")
    async def report(body: ReportRequest) -> dict[str, object]:
        report = build_report(body.results, body.grades, body.ffr_threshold, body.active)
        return asdict(report)

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app
