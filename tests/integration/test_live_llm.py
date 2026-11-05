import asyncio
from pathlib import Path

import pytest

from evalgen.config import load_settings
from evalgen.criteria import Criterion, suggest_criteria
from evalgen.grading import run_assertion
from evalgen.llm import LLMClient

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.slow
def test_live_server_suggests_and_grades() -> None:
    async def flow() -> tuple[list[Criterion], bool | None]:
        llm = LLMClient(load_settings(ROOT / "config.toml").llm)
        criteria = await suggest_criteria(llm, "Write a haiku about rain.")
        assertion = "If the response has exactly three lines, return True; otherwise, return False."
        verdict = await run_assertion(llm, assertion, "", "Rain on the roof\nsoft\nnight")
        return criteria, verdict

    criteria, verdict = asyncio.run(flow())
    assert criteria
    assert verdict is True
