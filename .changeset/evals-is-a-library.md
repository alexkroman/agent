---
"aai-evals": patch
"aai-studio-server": patch
---

Make `aai-evals` a pure eval library, and move the studio starter eval into the package it is about.

`packages/aai-evals` held two things: an eval FRAMEWORK — a recording runner, a spread report, an assertion vocabulary over the session event stream, a key gate — and the STUDIO's starter eval, which drives this product's HTTP surface and grades the source its coding agent generates. Six modules and their specs move to `aai-studio-server`:

| was | is |
| --- | --- |
| `aai-evals/src/studio-target.ts` | `aai-studio-server/src/studio-eval-target.ts` |
| `aai-evals/src/starter-expectations.ts` | `aai-studio-server/src/studio-starter-expectations.ts` |
| `aai-evals/src/starter-grade.ts` | `aai-studio-server/src/studio-starter-grade.ts` |
| `aai-evals/src/starter.eval.test.ts` | `aai-studio-server/src/studio-starter.eval.test.ts` |
| `aai-evals/src/template-contract.ts` | `aai-studio-server/src/studio-template-contract.ts` |
| `_gate.ts`'s `evalOrigin`/`evalContracts`, `_env.ts`'s `evalStepCapHint` | `aai-studio-server/src/studio-eval-env.ts` |

**The line is what a module is ABOUT, not what runs it.** What stayed names no product surface, no HTTP route, no prompt and no tool. What moved named the studio in every constant it declared — its chat route, its per-sandbox token, its step cap, the prose its own tools write, the eighteen starter prompts and what each asked for.

What that arrangement had cost was legible in the manifests, and all four items are now gone from `aai-evals`: a dependency on `aai-studio-client` for the starter list, `undici` + `ai` + `eventsource-parser` for one target's transport, and an `evals-package-boundary` exception for a subpath one file read. That boundary is a total deny again — including `aai-studio-client/*`, which is the half worth keeping, because a package that MAY import the studio's starter list is where the next studio-shaped eval lands.

`aai-evals` is importable now: five subpath exports (`/runner`, `/report`, `/gate`, `/register`, `/env`), `@dev/source` only since nothing there builds — exactly what the one consumer resolves, with `assertions.ts` and `tool-assertions.ts` deliberately left off until a case outside the package needs the vocabulary. `aai-studio-server` takes the framework from them rather than carrying a second runner — which is the same rule that let `scripts/starter-eval/run.mjs`'s 745 lines be deleted in the first place. The edge is one-way and closes no cycle: `aai-evals` depends on `@alexkroman1/aai` and `@alexkroman1/aai-runtime` and on nothing else in the workspace, and `evals-package-boundary` denies `aai-studio-server` by name.

Three mechanical consequences:

- **`_gate.ts`, `_register.ts` and `_env.ts` lost their underscores.** The prefix means "not part of the public API, never import cross-package"; a subpath export pointing at one would say the opposite.
- **`aai-studio-server` declares `test:eval` / `check:eval`**, and its `vitest.config.ts` excludes the `.eval.` infix like every other package with a slow tier. The eval env vars are already declared on the `check:eval` TASK in `turbo.json`, so they reach the new package with no further wiring — `AAI_EVAL_ORIGIN`, `AAI_EVAL_CONTRACTS` and `AAI_STEP_CAP_HINT` are now read only by it.
- **`eval-case-registration` and `eval-gate-is-not-unit-tier` each gained a studio-side twin.** Two conventions rather than one widened `paths`, because konsistent matches an import SPECIFIER literally and `./register.ts` and `aai-evals/register` are two strings for one module — a single rule could require only one and would exempt the other package.

One latent bug fixed on the way: `.gitignore` named `packages/aai-evals/.eval-workspaces/`, one directory above where `new URL("./.eval-workspaces/", import.meta.url)` ever resolved, so the template-contract scratch tree had never actually been ignored. The entry now names the real path, and the package's vitest `exclude` keeps a leaked tree — the module removes it in a `finally`, so only a killed run leaves one — from being collected as tests.

The reasoning that moved with the code is `packages/aai-studio-server/STARTER-EVAL-CLAUDE.md`, a sibling rather than a section because that package's guide is at 99% of the agent-context budget (1,582 chars left). The root `AGENTS.md` gains the one row that sibling owes it — `claude-md-limit.test.ts` asserts the root guide names every package guide and sibling, so a new one that nobody lists there fails.
