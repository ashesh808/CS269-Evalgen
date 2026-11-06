"""ASGI entrypoint for Vercel's native FastAPI runtime."""

from pathlib import Path

from evalgen.app import create_app
from evalgen.config import load_settings
from evalgen.llm import LLMClient

settings = load_settings(Path(__file__).resolve().parent / "config.toml")
app = create_app(settings, LLMClient(settings.llm))
