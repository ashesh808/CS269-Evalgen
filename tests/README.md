# tests

Unit tests use a fake LLM; `integration/` hits the live server and is marked `slow`.
Sandbox tests run real isolated Python and test resource limits, host-file/network denial,
and environment isolation; they skip when no supported sandbox is available.

```
uv run pytest                           # offline unit, API, sampler, sandbox tests
uv run --env-file .env pytest -m slow     # live server from config.toml
node --test tests/test_*.cjs              # artifact/screenshot viewers and session exports
```

Visual grading API and pipeline tests use scripted models and PNG fixtures. Renderer
tests mock process and microVM boundaries; no live model or paid sandbox is used by
the default suite.
