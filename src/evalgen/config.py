"""
Loads config.toml into typed settings that entrypoints pass inward

The API key comes from the environment, never from the config file
"""

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LLMConfig:
    base_url: str = "http://localhost:11434/v1"
    model: str = "GPT-OSS-20B"
    temperature: float = 0.0
    sample_temperature: float = 0.9
    timeout: float = 300.0
    max_retries: int = 1
    verdict_max_tokens: int = 2048
    max_concurrency: int = 4
    api_key: str = "local"


@dataclass(frozen=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8269


@dataclass(frozen=True)
class EvalConfig:
    assertions_per_criterion: int = 3
    ffr_threshold: float = 0.4


@dataclass(frozen=True)
class Settings:
    llm: LLMConfig
    server: ServerConfig
    eval: EvalConfig


def load_settings(path: Path) -> Settings:
    """
    Reads a config.toml, falling back to defaults for any missing key

    Args:
        path: The config.toml to read.

    Returns:
        The parsed settings, with the API key taken from EVALGEN_API_KEY.

    Raises:
        TypeError: The file holds a key the settings do not define.
    """
    raw = tomllib.loads(path.read_text())
    api_key = os.environ.get("EVALGEN_API_KEY", "local")
    return Settings(
        llm=LLMConfig(**raw.get("LLM", {}), api_key=api_key),
        server=ServerConfig(**raw.get("Server", {})),
        eval=EvalConfig(**raw.get("Eval", {})),
    )
