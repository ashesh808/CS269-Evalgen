# tests

Unit tests use a fake LLM; `integration/` hits the live server and is marked `slow`.
Sandbox tests run real isolated Python and test resource limits, host-file/network denial,
and environment isolation; they skip when no supported sandbox is available.

```
uv run pytest                           # offline unit, API, sampler, sandbox tests
uv run --env-file .env pytest -m slow     # live server from config.toml
node --test tests/test_*.cjs              # artifact previews and session exports
```
