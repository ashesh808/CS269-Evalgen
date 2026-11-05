"""
Launches the EvalGen web app against the LLM server named in config.toml
"""

import argparse
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

from evalgen.app import create_app
from evalgen.config import load_settings
from evalgen.llm import LLMClient

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    """
    Parses the config path, loads .env secrets, and serves the app until interrupted
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config.toml")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    settings = load_settings(args.config)
    app = create_app(settings, LLMClient(settings.llm))
    print(f"EvalGen on http://{settings.server.host}:{settings.server.port}")
    uvicorn.run(app, host=settings.server.host, port=settings.server.port)


if __name__ == "__main__":
    main()
