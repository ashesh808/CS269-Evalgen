# tests

Unit tests use a fake LLM; `integration/` hits the live server and is marked `slow`.

```
uv run pytest           # unit, under a second
uv run pytest -m slow   # live server from config.toml
```
