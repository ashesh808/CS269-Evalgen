# src

The `evalgen` package, one module per pipeline stage, enforced by `lint-imports`.

```
evalgen/
├── config.py      config.toml into settings
├── prompts/       jinja prompts
├── llm.py         chat client, reply parsing
├── criteria.py    suggest criteria
├── assertions.py  suggest assertions per criterion
├── grading.py     run assertions, sample outputs
├── alignment.py   coverage, FFR, alignment, selection
├── app.py         FastAPI app
└── web/           page, styles and fonts from kkuroma.github.io
```
