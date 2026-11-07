# src

The `evalgen` package, one module per pipeline stage, enforced by `lint-imports`.

```
evalgen/
├── config.py      config.toml into settings
├── prompts/       jinja prompts
├── llm.py         chat client, reply parsing
├── criteria.py    suggest criteria
├── assertions.py  suggest assertions per criterion
├── sandbox.py     isolated Python execution and runtime availability
├── vercel_sandbox.py  remote offline microVM execution on Vercel
├── grading.py     stream LLM/Code verdicts, sample outputs
├── sampling.py    selectivity, confidence, alternating grading policy
├── alignment.py   coverage, FFR, alignment, selection
├── app.py         FastAPI app
├── rendering.py   local / isolated Vercel screenshot capture
├── render_preview.cjs  network-blocked browser runner using the same preview document
├── screenshot/    pinned browser runtime dependencies and lockfile
└── web/           page, styles and fonts from kkuroma.github.io
```
