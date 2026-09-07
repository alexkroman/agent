---
"@alexkroman1/aai-cli": minor
"aai-templates": minor
"aai-evals": minor
"aai-studio-client": minor
"aai-studio-server": patch
---

Remove three templates that were near-duplicates of ones that stay, taking `aai init`'s catalog from 31 to 28. The picker lists bare directory names with no hints, so four indistinguishable spellings of one starter cost an author real attention at the moment of choice.

- **`embedded-assets`** — its whole subject was a knowledge base bundled as a JSON asset import, which `support-line` does with the identical `with { type: "json" }` import over a real IDF-weighted retriever with graders on top (and `hiring-desk` and `retail` import JSON assets too). It exercised no SDK export nothing else does.
- **`math-buddy`** — `code-interpreter` (the same `run_code`, the same never-do-mental-arithmetic prompt) plus the one-line LLM stage swap that `pipeline-simple` exists for. Its one distinct claim, that a declared stage's `options` survive the conversion and not just its `kind`, moves to `pipeline-simple`'s spec, where the swap lives.
- **`personal-finance`** — `code-interpreter`'s prompt with the `fetch_json` builtin added and no code of its own. That builtin lands on `health-assistant` instead, with a job the two `tools/` files cannot do: they read openFDA's LABEL endpoint, so what people actually REPORT (`/drug/event.json`, a counting query) is the model's to compose. Its spec gains the starter invariants it never had — `expectDeployable`, the builtins surviving into the config, and the prompt↔`builtinTools` pairing.

The studio's hero catalog drops the three matching starter buttons, so `aai-studio-server` is named alongside it: the starters are front-end source a DEPLOY carries, and a bump to a carrier is what arms one.

`commandedBuiltins` (`@alexkroman1/aai/testing`) loses its only exerciser and becomes a template-API allowlist entry: `expectPromptBuiltinsDeclared` already returns the commanded list, so a second call would be the contrived use the allowlist exists to avoid.
