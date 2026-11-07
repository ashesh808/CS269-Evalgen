"""Opt-in pixel capture and actual image-model grading through the configured gateway."""

import asyncio
import os
from pathlib import Path
from typing import Literal

import pytest

from evalgen.config import load_settings
from evalgen.grading import run_matrix_detailed
from evalgen.llm import LLMClient
from evalgen.rendering import render_previews, renderer_status

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.slow
@pytest.mark.parametrize("output_format", ["svg", "html"])
def test_rendered_red_and_blue_squares_receive_different_visual_grades(
    output_format: Literal["svg", "html"],
) -> None:
    if not renderer_status()["available"]:
        pytest.skip("Screenshot renderer is unavailable")
    if output_format == "svg":
        sources = [
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">'
            '<rect width="600" height="400" fill="white"/>'
            f'<rect x="150" y="50" width="300" height="300" fill="{color}"/></svg>'
            for color in ("red", "blue")
        ]
    else:
        sources = [
            "<!doctype html><html><head><style>body{margin:0;min-height:100vh;"
            "display:grid;place-items:center;background:white}.mark{width:300px;"
            f"height:300px;background:{color}"
            '}</style></head><body><div class="mark"></div></body></html>'
            for color in ("red", "blue")
        ]

    async def verify() -> None:
        llm = LLMClient(load_settings(ROOT / "config.toml").llm)
        model = os.environ.get("EVALGEN_VISION_MODEL", "openai/gpt-6.1-terra")
        if model not in await llm.list_vision_models():
            pytest.skip("The configured vision model does not advertise image input")
        captures = await render_previews(sources, output_format)
        assert all("data_url" in image for image in captures), captures
        screenshots = [str(image["data_url"]) for image in captures]
        results, errors = await run_matrix_detailed(
            llm.with_model(model),
            [["The large square in the screenshot is red. Judge the attached image pixels."]],
            "Assess the rendered design.",
            sources,
            2048,
            screenshots=screenshots,
        )
        assert results == [[[True, False]]]
        assert errors == [[[None, None]]]

    asyncio.run(verify())
