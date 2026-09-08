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
| `templates/<name>/` | 28 complete agent projects, each self-contained |
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
| `agent.ts` | the entry, default-exporting `agent()` or `workflowApp()` | 28 |
| `tools/<tool_name>.ts` | **one file IS one tool** — it default-exports it, nothing imports it, and `agent()` takes no `tools` field | 18 templates |
| `workflows/` | durable workflow bodies | 8 templates |
| `client.tsx` | the browser half; mounts with `mountClient()` (voice) or `mountPage()` (workflow app) | 19 templates |
| `system-prompt.md` | imported with Vite's `?raw`; **it IS the system prompt** | 18 templates |
| `shared.ts` | the session slot, its projection, and anything both ends need | most |
| `agent.test.ts` | unit tests, run by `pnpm test` | 28 templates |
| `agent.eval.test.ts` | a behaviour eval, live or against a scripted model | 28 templates |

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
| `quickstart-agent` | voice | a bare voice agent on the default AssemblyAI pipeline — nine lines, and where to start |
| `custom-pipeline-agent` | voice | the same agent with one pipeline stage swapped — an Anthropic LLM between AssemblyAI's STT and TTS |
| `web-research-agent` | voice | a researcher that answers from the open web — `web_search` + `visit_webpage`, the smallest builtin-tool agent |
| `code-interpreter-agent` | voice | a problem solver that answers by writing and running code — the `run_code` builtin |
| `medication-safety-agent` | voice | a drug-interaction checker over openFDA — the smallest custom tool on a live REST API, beside `web_search`, `run_code` and `fetch_json` |
| `entertainment-picks-agent` | voice | a late-night picker for movies, music and books — a slot beside `useEvent`, with a synced recommendation log |
| `pizza-ordering-agent` | voice | a pizza counter that keeps a real cart — the smallest stateful agent: one `sessionSlot`, six tools, one projection |
| `text-adventure-agent` | voice | a spoken text adventure — the world lives in a slot, custom chrome renders it |
| `tabletop-rpg-agent` | voice | a solo tabletop narrator — game state in a slot, a nested dialog and a final one |
| `emergency-dispatch-agent` | voice | a 911-style dispatch desk — incidents, units, and a live board projection that keeps caller PII server-side |
| `retail-orders-agent` | voice | a retail support line that manages real orders — the largest: fifteen tools over a seeded catalog, an auth gate, and a call's dialog ending in a terminal state |
| `travel-concierge-agent` | voice | a phone travel concierge (LangGraph's customer-support tutorial) — a dialog stack and a confirmation gate |
| `executive-inbox-agent` | voice | an assistant you phone about your inbox (LangChain's EAIA) — triage, drafts in your voice, a calendar subagent, the Agent Inbox's four answers as gated tools, and a memory that rewrites its own prompts from your corrections |
| `roadside-assistance-agent` | voice | a roadside assistance desk — the dialog that describes a CALL rather than a form: a silence ladder, an uninterruptible fee disclosure, per-phase LLM knobs |
| `technical-support-agent` | voice | a support line that grades its own retrieval before it speaks (self-RAG / CRAG) — and the reference for a knowledge base bundled as a JSON asset import |
| `research-planner-agent` | voice | a planning desk that really searches (LangGraph's plan-and-execute) — the execute→replan loop, driven one step per tool call by the caller |
| `topic-briefing-agent` | voice | a briefing desk that puts several researchers on one topic at once — the `ctx.delegate` example |
| `applicant-screening-agent` | voice | a hiring desk that screens a stack of applicants (CrewAI's `lead-score-flow`) — one crew scores them through `ctx.generate`, a human-in-the-loop router becomes a dialog with a bounded feedback loop, and the other crew writes every email as a guarded subagent |
| `hotel-reception-agent` | voice | a hotel front desk (LiveKit Agents' `hotel_receptionist`) — a seeded hotel in one slot, verification the TOOLS run, a booking dialog whose read-back is owed until the caller's next turn, a dispute engine, and the walk procedure: forty-one tools |
| `word-game-agent` | voice | a three-way phone word game (Pipecat's) — the host is the agent, the A.I. player is `ctx.generate` on its own context, the referee is a function, and the two-minute clock is a dialog `timeout` |
| `research-handoff-agent` | voice + workflow | a research desk that hands off — a tool starts a durable run, answers the turn, and the finished run speaks back |
| `meeting-recap-agent` | voice + workflow | a recap desk that transcribes and writes up a recording — the Temporal patterns (cancel, signal, compensate) over a phone call |
| `link-digest-workflow` | workflow app | a URL in, a digest out — the smallest one; read it before the other five |
| `transcription-workflow` | workflow app | a transcription desk for an uploaded recording — split it, transcribe each piece in its own step, stitch |
| `spoken-summary-workflow` | workflow app | a recording summarized and read back aloud — audio in, audio out |
| `call-audit-workflow` | workflow app | an audit of a recorded call — ffmpeg on both sides of the model |
| `document-redline-workflow` | workflow app | a document redliner you submit work to (LangGraph's reflection agent) — write, critique, revise |
| `podcast-digest-workflow` | workflow app | a podcast digest posted to a channel — a **scheduled** run that sleeps for days, wakes, and posts |

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
pnpm test:eval:templates                         # the 28 template evals, live
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
