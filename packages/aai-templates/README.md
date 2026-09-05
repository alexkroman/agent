# aai-templates

The agent **templates** `aai init` scaffolds from, the project **scaffold**
layered underneath them, and the **gate specs** that hold this repo's quality
gates to their contracts. Private — nothing here is published to npm.

The templates are the repo's reference consumers of the SDK. Every published
authoring export is expected to have a worked example in one of them, and
`src/template-api-coverage.test.ts` is what says so: a new public export that no
template exercises fails the suite until a template uses it or
`template-api-allowlist.json` records why it does not.

## How it reaches a user

Nothing here is fetched at run time. `packages/aai-cli/bundle-templates.mjs`
copies `templates/` into the CLI's `dist/` at build time, so they ship inside
the `@alexkroman1/aai-cli` tarball — `aai init` works offline, and the templates
a user gets are the ones their pinned CLI was built with. The studio's coding
agent reads the same copy out of its toolchain `node_modules`.

The sources stay here: this package owns their tests, typecheck and lint. That
is packaging, not a move — `packages/aai-cli/turbo.json` adds these sources to
the CLI build's `inputs` so editing a template invalidates that build.

## Layout

| Path | What it is |
| --- | --- |
| `templates/<name>/` | 26 complete agent projects, each self-contained |
| `scaffold/` | the base project files layered under any template — `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `global.d.ts`, `pnpm-workspace.yaml`, `.gitignore`, `.env.example` — plus `CLAUDE.md`, which is the guide rather than a project file |
| `src/` | this package's suites: the template gates, plus the gates that guard the repo's gates |
| `template-api-allowlist.json` | the coverage ratchet's baseline — published exports no template exercises |

`scaffold/CLAUDE.md` is a **product artifact**, not repo documentation: it is
embedded in the studio system prompt and materialized as
`packages/aai/AGENT_GUIDE.md` so it ships inside the SDK tarball and cannot
describe a different release than the SDK beside it.

**It is also the one file in `scaffold/` that a scaffolded project does not get
a copy of.** `layerScaffold` filters it and writes a ~30-line pointer at
`node_modules/@alexkroman1/aai/AGENT_GUIDE.md` instead — the version-matched
copy the SDK's own skill has always named as authoritative. The 120KB snapshot
went stale on the project's next `pnpm update`, and Claude Code loads a
project-root `CLAUDE.md` in full at launch against a documented 200-line target,
so every session in a user's agent project paid ~30k tokens for guidance its
publisher told agents not to trust. See `PROJECT_GUIDE_POINTER` in
`packages/aai-cli/src/_templates.ts`.

The `prestart`/`start` pair (`aai build --skip-tests` then `aai start`) means
every scaffolded project self-hosts with `npm start` — no platform account
required. This used to be a scaffolded `server.mjs`; the CLI owns the entrypoint
now, and only the `deno` build target still emits a file by that name.

## Anatomy of a template

| File | Role | Count |
| --- | --- | --- |
| `agent.ts` | the entry, default-exporting `agent()` or `workflowApp()` | 26 |
| `tools/<tool_name>.ts` | **one file IS one tool** — it default-exports it, nothing imports it, and `agent()` takes no `tools` field | 14 templates |
| `workflows/` | durable workflow bodies | 8 templates |
| `client.tsx` | the browser half; mounts with `mountClient()` (voice) or `mountPage()` (workflow app) | 15 templates |
| `system-prompt.md` | imported with Vite's `?raw`; **it IS the system prompt** | 16 templates |
| `shared.ts` | the session slot, its projection, and anything both ends need | most |
| `agent.test.ts` | unit tests, run by `pnpm test` | 22 templates |
| `agent.eval.test.ts` | a behaviour eval, live or against a scripted model | 25 templates |

Tool discovery happens where the bundle is assembled — the guest sandbox is
handed one ESM string and has no directory to scan — so `tools/` is enumerated
by `aai-cli/worker-bundler.ts` in a build and by `src/_discovery.ts` (Vite's
`import.meta.glob`) in a spec. One set of rules, two ways in.

## The catalog

Six are **workflow apps** (`workflowApp()`, a form rather than a microphone, no
session and no voice pipeline); the rest are voice agents, two of which hand
work off to a durable workflow.

| Template | Kind | What it is |
| --- | --- | --- |
| `simple` | voice | the whole default AssemblyAI pipeline in nine lines — start here |
| `pipeline-simple` | voice | the same pipeline with one stage swapped for an Anthropic LLM |
| `web-researcher` | voice | Scout — `web_search` + `visit_webpage`, the smallest builtin-tool agent |
| `code-interpreter` | voice | Coda — answers by writing and running code (`run_code`) |
| `math-buddy` | voice | a tutor that delegates every calculation to `run_code`, on a faster, cheaper LLM |
| `personal-finance` | voice | Penny — conversions, live prices, bill splitting |
| `health-assistant` | voice | Dr. Sage — web search and code over health questions |
| `embedded-assets` | voice | an FAQ bot whose knowledge base is a bundled asset import |
| `night-owl` | voice | movie picks and sleep timing, with a synced recommendation log |
| `pizza-ordering` | voice | the smallest stateful agent: a cart in one `sessionSlot`, six tools, one projection |
| `infocom-adventure` | voice | a spoken text adventure; the world lives in a slot, custom chrome renders it |
| `solo-rpg` | voice | a solo tabletop narrator — game state in a slot, a nested dialog and a final one |
| `dispatch-center` | voice | an emergency dispatch board: incidents, units, and a live dashboard projection that keeps caller PII server-side |
| `retail` | voice | the largest — fifteen tools over a seeded catalog, an auth gate, and a call's dialog ending in a terminal state |
| `travel-concierge` | voice | LangGraph's customer-support tutorial as a phone concierge: a dialog stack and a confirmation gate |
| `support-line` | voice | a support line that grades its own retrieval before it speaks (self-RAG / CRAG) |
| `plan-and-execute` | voice | a planning desk that really searches — plan-and-execute with the caller in the loop |
| `briefing-desk` | voice | phone a desk, it puts several subagents on a topic at once — the `ctx.delegate` example |
| `research-workflow` | voice + workflow | the **handoff**: a tool starts a durable run, answers the turn, and the finished run speaks back |
| `recap-workflow` | voice + workflow | transcribe and write up a recording — the Temporal patterns (cancel, signal, compensate) over a phone call |
| `link-digest` | workflow app | the smallest one: a URL in, a digest out. Read this before the other five |
| `transcription-workflow` | workflow app | a real transcription pipeline — split a recording, transcribe each piece in its own step, stitch |
| `spoken-summary` | workflow app | audio in, audio out: upload a recording, get a summary you can listen to |
| `call-audit` | workflow app | audits a recorded call with ffmpeg on both sides of the model |
| `redline` | workflow app | LangGraph's reflection agent as something you submit work to |
| `podcast-digest` | workflow app | a **scheduled** run that sleeps for days, wakes, and posts a digest to a channel |

## Running things

```sh
pnpm test:templates                              # this package's suites, from the repo root
pnpm --filter aai-templates test                 # the same
pnpm vitest run --project aai-templates retail   # one template
pnpm --filter aai-templates typecheck
pnpm --filter aai-templates lint
```

Evals are the slow tier and are **not** run by `pnpm test` — a live one spends
real tokens on your own key:

```sh
pnpm test:eval:templates                         # the 25 template evals, live
pnpm --filter aai-templates test:eval
```

Four repo-level gates read this package and are worth knowing about before
touching the scaffold:

| Gate | What it holds |
| --- | --- |
| `pnpm check:template-types` | every template type-checks under the **scaffold's** tsconfig — the one a user actually gets — not the repo's stricter one |
| `pnpm check:scaffold` | `scaffold/package.json` still matches the workspace's dependency versions (`pnpm sync:scaffold` fixes it) |
| `pnpm check:agent-guide` | `packages/aai/AGENT_GUIDE.md` is the current copy of `scaffold/CLAUDE.md` (`pnpm sync:agent-guide` fixes it) |
| `pnpm check:konsistent` | the `agent-templates` convention: an `agent.ts` with a default export, and a `client.tsx` that imports the stylesheet |

## `src/` is also where the repo's gates are guarded

Most of what is in `src/` is not about templates at all. A gate whose whole
output is a count prints the same checkmark when its scan has gone blind as when
the tree is clean, so the gates carry specs — and they live here because this is
the package whose suites already read files outside their own directory
(`turbo.json` hashes those extra inputs, so a gate spec is not served from cache
exactly when the file it checks changes).

`claude-md-limit`, `escape-hatch-scope`, `file-length-gate`,
`test-assertion-gate`, `guard-invariants-gate`, `konsistent-config`,
`ci-gate-job`, `ship-workflow-gate` and the rest each pin one gate: that it is
wired into `scripts/check.mjs` **and** CI, that its patterns still match what
they claim to, and that it cannot pass by measuring nothing.

The template-specific ones are `templates.test.ts` (every template's config
survives the real `aai build` validation path), `template-api-coverage.test.ts`
(the ratchet above), `template-page-mount.test.ts` (an agent's `page` field and
its client's mount agree at both ends) and `template-durability-gate.test.ts` (a
template with a `workflows/` directory must exercise its body durably, through
`runWorkflow`).

## More

`CLAUDE.md` in this directory carries the arguments — which SDK primitive each
template is the worked example for, the extract-on-the-third-copy rule, why a
flow is where a conversation is, the five LangChain/LangGraph ports, and what a
new template owes.
