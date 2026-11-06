# EvalGen Reimplementation with Modern LLMs

Install Python 3.14 and [uv](https://docs.astral.sh/uv/), then install the locked dependencies:

```sh
uv sync --locked
cp .env.example .env
```

Set `EVALGEN_API_KEY` in `.env` to your Vercel AI Gateway key. The file is ignored by Git.
`config.toml` points to `https://ai-gateway.vercel.sh/v1` and defaults to
`openai/gpt-oss-20b` for evaluation. “Model to query” offers four recent models from
different families: GPT-6.1 Terra (default), Gemini 4 Argon, Mistral Large 4, and Mercury 3.
The evaluator selector offers the gateway's full language-model catalog.
See the [Vercel API documentation](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions).

To serve, run

```sh
uv run python scripts/serve.py
```

Open <http://127.0.0.1:8269>. The app loads `.env` automatically.

Each criterion can use an **LLM** grader or **Code**, a generated Python function with
the signature `evaluate(response: str, prompt: str) -> bool`. To enable Code, keep Docker
running and install its official Python runtime once:

```sh
docker pull python:3.14-alpine
```

Locally, the app probes a real isolated container and pins the installed image ID.
Code runs without host mounts, network, filesystem writes, inherited API keys, or child
processes. Containers run as an unprivileged user with a read-only root, dropped
capabilities, 128 MiB memory limit, CPU limits, and bounded output. The Code option is
available only when the probe succeeds; execution never falls back to an ordinary
Python subprocess. Wall-time and concurrency limits are set in `[Eval]`.

On Vercel, Code uses a separate ephemeral Vercel Sandbox microVM with outbound networking
denied. A dedicated unprivileged Python process receives only the candidate and its inputs,
with a 256 MiB process memory limit and a bounded runtime/output. The microVM has its own
writable filesystem; it has no host mounts or application secrets. Vercel project OIDC
authenticates the control plane automatically. Sandbox usage is billed to the Vercel team.

Evaluation results arrive incrementally while you grade. The next ungraded response
alternates between high and low failure-confidence scores. Confidence sums the pass rates
of assertions that explicitly fail that response; estimates use observed verdicts only.
Before results arrive, ties use input order. This follows Appendix A's intended prose:
the printed confidence equation has a conflicting pass/fail polarity.

Unreadable or failed evaluations remain **unknown**, are shown with their errors, and
cannot qualify a candidate for selection. The report and table use the same selected
candidate. Empty selections have unavailable metrics; incomplete selections are labeled
and preserve unknown outcomes instead of displaying reassuring pass scores.

This implements the workflow and mechanisms in
[Who Validates the Validators?](https://people.eecs.berkeley.edu/~bjoern/papers/shankar-validators-uist2024.pdf).
The generation prompts and model choices are modern adaptations. Candidate generation
still completes as a batch before execution; evaluation results stream as they finish.
The original ChainForge host, parameterized datasets, and numerical experiments are
outside this standalone implementation.

Run offline tests with `uv run pytest`. To test live criteria generation and grading
through the configured gateway (uses API credits), run:

```sh
uv run --env-file .env pytest -m slow
```

Offline tests include actual sandbox execution and denial checks when the platform
sandbox is available. No live LLM is used by the default suite.

## Session exports

After generating responses, use **Export JSON** or **Export report** in the Table View
header or the report card. Export is available once generation and evaluation have
finished; human grades and criteria can still be incomplete.

JSON includes the prompt, recorded generation model, responses, human grades and
feedback, enabled/excluded criteria, all candidate implementations and their verdicts
and errors, the selected implementations, and freshly calculated alignment results.
Unknown verdicts remain `null`.

The HTML report is a standalone, readable document with a response table and evaluator
details. Open it in a browser to read or print it. Both downloads capture the session
when you click Export; they do not reset your session or save export files on the server.

Frontend export tests use Node's built-in test runner:

```sh
node --test tests/test_export.cjs
```

## Deployment

The GitHub repository `ashesh808/CS269-Evalgen` is connected to the Vercel project
`808-atoms/cs269-evalgen`. Every push to `main` creates a production deployment.
The Vercel Git integration handles deployments directly; no deploy token is needed in
GitHub Actions. Other branches can receive preview deployments.

The root `app.py` exports the FastAPI application. `vercel.json` selects Python's
native FastAPI framework, bundles configuration, prompts and web assets, and allows
requests to run for up to 300 seconds. Python 3.14 and dependencies come from
`.python-version`, `pyproject.toml`, and `uv.lock`.

`EVALGEN_API_KEY` is configured as a sensitive Vercel environment variable for production
and previews. Update it in the project's Vercel settings when rotating keys. `.env`,
`.vercel/`, test files, and local PDFs are excluded from deployment uploads.

To link another local checkout to this project:

```sh
vercel link --yes --project cs269-evalgen --scope 808-atoms
```

The Vercel project's deployment protection remains in place. Authorized team members can
use `vercel curl /api/info` to verify a protected deployment.
