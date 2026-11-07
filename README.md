# EvalGen Reimplementation with Modern LLMs

Install Python 3.14 and [uv](https://docs.astral.sh/uv/) **0.13.5 or newer**, then install the locked dependencies:

```sh
uv sync --locked
cp .env.example .env
```

The minimum uv version matches the project's `uv_build` backend requirement. Older
uv releases can fail while extracting its source archives with a misleading checksum
error. For a standalone uv installation, upgrade with `uv self update`; for other
installations, use your package manager. See [uv's upgrade instructions](https://docs.astral.sh/uv/getting-started/installation/#upgrading-uv).

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

## Output formats

Choose an **Output format** in the Prompt Node before running your prompt:

- **Text** keeps the existing text-response workflow.
- **Logo / vector · SVG** generates a standalone SVG for logos and other vector designs.
- **Website · HTML/CSS/JS** generates a self-contained website mockup with inline CSS and JavaScript.

SVG and HTML responses have **Preview** and **Source** views in the table and grading
screen, plus a download button for the individual `.svg` or `.html` artifact. HTML
previews support simple JavaScript interactions. Previews run in isolated frames
with external resources blocked; use inline styles, scripts, SVG, or embedded
assets instead of external libraries and fonts.

For SVG and HTML, **Grading input → Source + screenshot** sends the response source
and an actual browser-rendered image to an image-capable LLM evaluator. The model
selector automatically offers models that advertise image input in the gateway
catalog. **Source only** keeps the original workflow. Code graders always receive
the original source string.

Screenshots are captured once per response from a fresh initial render at a
960 × 640 CSS-pixel viewport, including page content up to 2000 pixels tall. Use
**Capture screenshots** and the **Screenshot** tab to inspect the exact image sent
to the evaluator. A screenshot does not include clicks or edits in the interactive
preview, and cannot prove that an interaction works. Human grades and visual
feedback still guide criteria suggestions. Capture or image-model failures remain
explicit errors or unknown verdicts; visual grading never silently becomes
source-only grading.

Local screenshot capture requires Node.js 22.17 or newer, npm, and Chrome or
Chromium. Set `EVALGEN_CHROMIUM_EXECUTABLE` if the browser is not found automatically.
The first capture installs the checked-in browser runtime lockfile into
`~/.cache/evalgen-renderer/`. On Vercel, screenshots use an ephemeral Sandbox microVM
with project OIDC authentication. Only npm is reachable during trusted setup;
network access is denied before generated source is uploaded and rendered. No
application environment or host files are exposed to the renderer.

The recorded output format stays with the sampled responses when you change the
selector for a later run. Changing grading input invalidates earlier evaluator
implementations so their results cannot be mixed across modes.

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

Live visual tests also render red and blue SVG/HTML designs and verify different
image-based verdicts. They use GPT-6.1 Terra by default; set `EVALGEN_VISION_MODEL`
to another model that advertises image input if needed.

Offline tests include actual sandbox execution and denial checks when the platform
sandbox is available. No live LLM is used by the default suite.

## Session exports

After generating responses, use **Export JSON** or **Export report** in the Table View
header or the report card. Export is available once generation and evaluation have
finished; human grades and criteria can still be incomplete.

JSON includes the prompt, recorded output format and generation model, response source, human grades and
feedback, enabled/excluded criteria, all candidate implementations and their verdicts
and errors, the selected implementations, and freshly calculated alignment results.
Unknown verdicts remain `null`.

Screenshot sessions also retain the captured PNGs, viewport, source hashes, capture
times, capture errors, and the grading input used by each candidate. The HTML report
includes these images as embedded data, while generated source remains inert text.

The HTML report is a standalone, readable document with response source and evaluator
details. SVG and HTML source is escaped so report files remain script-free. Open the
report in a browser to read or print it. Both downloads capture the session
when you click Export; they do not reset your session or save export files on the server.

Frontend artifact and export tests use Node's built-in test runner:

```sh
node --test tests/test_*.cjs
```

## Deployment

Build the source distribution and wheel with:

```sh
uv build
```

Both files are written to `dist/`. The default command builds the wheel from the
source distribution, checking that the source archive can be extracted and rebuilt.

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
