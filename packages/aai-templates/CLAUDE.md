---
summary: >-
  Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product
  artifact, not repo docs
read_when: >-
  adding or changing a template, or anything `aai init` copies
---

# packages/aai-templates — templates guide

Agent templates (`templates/`, each self-contained with its own `agent.ts` and
optional `client.tsx`) and the project scaffold (`scaffold/`, base files layered
underneath). Private package.

**`scaffold/` and `templates/` are shipped PRODUCT.** `scaffold/CLAUDE.md` is
the user-facing authoring guide — embedded in the studio prompt, shipped in the
SDK tarball as `AGENT_GUIDE.md`, and the one scaffold file a project gets no
copy of (`PROJECT_GUIDE_POINTER` in `packages/aai/src/host/scaffold-layer.ts`).
Never add repo-docs `CLAUDE.md` files under either tree.

## Directory guides and references

- `src/CLAUDE.md` — the gate specs: API coverage and its allowlist ("the last
  remover pays"), the durability and layout gates, `templates.test.ts`'s
  scaffold pins, prompt discovery, what `tsconfig.json` type-checks.
- [`EXEMPLARS-CLAUDE.md`](EXEMPLARS-CLAUDE.md) — which template demonstrates
  which SDK primitive, and the per-template accounts (dialog templates,
  `research-handoff-agent`, `transcription-workflow`, `meeting-recap-agent`).
- [`PORTS-CLAUDE.md`](PORTS-CLAUDE.md) — what each ported template kept and
  changed.
- [`STEP-IO-CLAUDE.md`](STEP-IO-CLAUDE.md) — step I/O: auth, model calls,
  retries, speech and uploads from a step.
- [`FFMPEG-CLAUDE.md`](FFMPEG-CLAUDE.md) — `call-audit-workflow` and
  `@alexkroman1/aai/ffmpeg`.

## Templates ship inside the CLI tarball

`aai-cli/bundle-templates.mjs` copies them into `@alexkroman1/aai-cli`'s `dist/`
at build time, so a template always matches the CLI's SDK version; sources,
tests, typecheck and lint stay here.

- `packages/aai-cli/turbo.json` adds the template sources to the build's
  `inputs` — without it, editing a template replays a stale cached CLI build.
- Nothing in-tree exercises the shipped path: `getMonorepoRoot()` always finds
  the workspace. The e2e suite's `detachedCli()` copies `dist/` outside the
  workspace for that reason, and `aaiEnv()` deliberately sets no
  `AAI_TEMPLATES_DIR`.

## The scaffold

### The scaffold is LINTED

`biome.json` must not exclude `scaffold/` — it is the one tree that lands in
someone else's project. `noUndeclaredDependencies` does not misfire there
because the scaffold ships its own `package.json`. `templates.test.ts` pins
this (see `src/CLAUDE.md`).

### `check:scaffold` exists because the sync ran only during a release

`scripts/sync-scaffold-versions.mjs --check` asserts `scaffold/package.json`
matches the workspace. The script resolves `catalog:` and refuses any workspace
protocol left in the shipped manifest, because npm has neither and `aai init`
would fail at its install step. `check:publish-protocols` cannot catch this —
the file is DATA in the aai-cli tarball, not a packed manifest.
`sharedDepSources` is hand-kept: a dependency outside it is synced by nothing.
After a dependency bump, run `pnpm sync:scaffold`.

### The scaffold pins `^<newest>`, so it must opt out of release-age quarantine

Every `changeset version` resyncs the scaffold to the just-cut SDK, and this
repo publishes several times a day, so every version matching `^<newest>` is
inside pnpm's `minimumReleaseAge` window and `aai init` fails with
`ERR_PNPM_NO_MATURE_MATCHING_VERSION`. `scaffold/pnpm-workspace.yaml` therefore
ships `minimumReleaseAgeExclude: ["@alexkroman1/*"]` — scoped, so third-party
deps keep the user's window. Never lower the pin instead: the floor must admit
the build the templates need. Reproduce by copying `scaffold/` to a temp dir,
appending `minimumReleaseAge: 10080`, and running `pnpm install
--lockfile-only`.

Not the same as a stale metadata cache: plain `ERR_PNPM_NO_MATCHING_VERSION`
with a `The latest release … is "X"` line older than the pin is client-side
(`pnpm cache delete "@alexkroman1/*"`). The quarantine error names the
constraint or carries a `published by <date>` clause.

### A template may import only what `scaffold/package.json` declares

The three SDK packages, `zod`, `xstate` and React. Anything else must earn a
place in that manifest first, or the starter fails to build.

### Self-hosting is the scaffold's default

Every project runs on its own with `npm start` (`prestart`/`start` → `aai
start`). The mechanism is the CLI's: see "Self-hosting is the scaffold's
default, and it runs the BUILT worker" in `packages/aai-cli/CLAUDE.md`.

## The authoring guide ships inside the SDK

`scaffold/CLAUDE.md` is the one source of truth for writing an agent.
`scripts/sync-agent-guide.mjs` materializes it as `packages/aai/AGENT_GUIDE.md`
so it ships in the `aai` tarball and matches the SDK a project resolves;
`layerScaffold` writes a pointer to that path as a project's `CLAUDE.md`
instead of a copy that would freeze. The generated-file banner is part of the
compared content. `check:agent-guide` keeps the copy honest.

- It is a repo-level script, not an `aai` build step, because `aai` may import
  no sibling package (`konsistent.json`).
- `packages/aai/skills/aai/SKILL.md` carries NO API guidance — a skill has no
  version, so it only points at the guide.

## Session state

**A tool that touches session state is `slot.tool` or `slot.updateTool`, never a
`tool()` that opens with `slot.get(ctx)`.** The declaration makes "does this
write?" visible and the wrong answer a compile error (what a read receives is
frozen). A tool where only ONE branch writes stays a plain `tool()` and calls
`slot.update` in that branch (`tabletop-rpg-agent`'s `oracle` `chaos_check`):
`updateTool` bodies must be synchronous and would open a mutation window on
branches that store nothing.

**A derived field belongs in the slot's `after` hook; a tool that REPORTS it
reads a PREDICATE.** `update()` runs `mutate(draft)` and only then
`after(draft)`, so a result built in the body carries the pre-recalculation
value. Put a predicate beside the writer (`isGameOver`/`inCrisis`) and let
`after` own the write.

**A pure helper over slot state takes `DeepReadonly<T>`, aliased once per
template** (`FrozenGameState`, `FrozenOrderState`, …). `slot.get`/`slot.tool`
hand out a deep-readonly value and `readonly string[]` does not satisfy
`string[]`; a mutable draft still satisfies the alias. When the widening is
awkward, make the lookup generic (`emergency-dispatch-agent`'s `findIncident`)
or copy the array into a fresh result (`resourceBrief`). A client renders
`DeepReadonly<State>` — what the projection produces.

**The LLM loop runs one step's tool calls CONCURRENTLY**, so a read-modify-write
tool body over non-slot state needs `createKeyedLock`/`withLock`
(`@alexkroman1/aai/utils`). Not inside `slot.update`, which is already atomic.

**A template's spec is what makes its exemplar code true** — an unexercised
tool can be wrong for releases. Drive every tool you add.

## The templates are where SDK primitives get their worked example

- **Extract on the third copy.** When the same helper appears in a third
  template, move it into the SDK instead of copying it again.
- **Every public export needs a template use or an allowlist entry**
  (`template-api-coverage.test.ts`). Removing a template's use of an export may
  owe an allowlist entry — see "The last remover pays" in `src/CLAUDE.md`.
- The table of which template demonstrates what is in
  [`EXEMPLARS-CLAUDE.md`](EXEMPLARS-CLAUDE.md).

Rules the table carries that apply to any template:

- A slot whose `create()` pulls a seed uses `useAgentState(fallback)`, not the
  projection overload, or the seed ships to the browser.
- Do not call `spokenOrdinal` beside `resolveOne`; it consults it internally.
- Name a subagent in code when the tool IS the choice; put it on
  `agent({ subagents })` when the caller's words are. Give every subagent an
  `expectedOutput`. Reach for `SubagentDef.guardrail` only when a `schema`
  cannot express the check; an unaccepted result stays a field on the tool
  result, not a `ToolFailure`.
- `ToolDef.onError` is a classifier: re-throw to make a failure fatal instead
  of a model retry loop.
- `agent({ outputGuardrails })` is pipeline-only; `agent({ description })` is
  for humans choosing the agent, not the model.
- Step code imports from `@alexkroman1/aai/step` (zero-zod), not the root.
- `@alexkroman1/aai/tools` functions return `T | ToolFailure` — narrow with
  `isToolFailure`; a `catch` cannot see a refused search, and an unhandled one
  reads as "no results".
- Specs: use `toolRunner(agentDef)` rather than a per-spec wrapper; assert
  refusals with `expectDialogRefused`/`dialogRefusalPattern`, never a regex on
  the sentence; wrap a lone `expectDeployable` in `expect(…).not.toThrow()`;
  stub step HTTP with `installStubStepFetch`/`stubStepFetch`, never
  `globalThis.fetch`.

## A flow is WHERE A CONVERSATION IS, and a board is not one

A dialog position is a fact about the CONVERSATION, not the world. Per-entity
status stays on the entity (`Incident.status`), gated tools stay addressed by
id, and a per-entity constraint is a `ToolFailure` from the lookup, not a flow.
Do not read a position as a summary of the data. Reading order and each
template's account: `EXEMPLARS-CLAUDE.md`, "Dialog templates".

- **A tool legal in EVERY state is not a flow tool.** Keep it an ordinary
  `tool()`/`slot.updateTool` that calls `dialog.send` itself.
- **`sendFrom` goes BELOW `execute`** (next section). It is also where "did
  this actually do the thing" lives: send nothing when nothing happened.
- **A `final` state delivers no events**, so restarting is `dialog.reset`.
- **A refusal short-circuits before the tool body**, including any bookkeeping
  a per-agent wrapper does; say so at the wrapper.
- **A state with a `timeout` must not transition on chatter** unless you want
  every turn to re-arm it: the deadline runs from the dialog's last MOVE.

### A `sendFrom` goes BELOW `execute`

Declare `sendFrom` after `execute`. Real tool bodies are contextually typed
inline arrows whose return type is inferred after `sendFrom` is checked, so
written first, `result` is `unknown` and you get `TS18046` (the same for a body
ending in a generic call like `planSlot.update`). `dialog.test-d.ts` uses an
annotated function reference and so does not show this. With `NoInfer` it is a
compile error, not silence: delete absorbing guards (`"x" in result &&`,
`isToolFailure(result) ? … : …` in a `summary`) rather than adding them.

- **A per-agent wrapper copies the SDK's signature, not its `Exclude`:**
  declare `execute: (…) => R | ToolFailure` and let union inference subtract
  the failure arm; `summary` takes `NoInfer<R>`. `Exclude<NoInfer<R>,
  ToolFailure>` does not distribute over a non-naked type parameter.
- **Every arm of the result union must have the field `sendFrom` reads.** A
  return through a declared type or an inner union gains no `?: never` keys;
  add `field: undefined` at that return.

### A dialog is a plain state map now

No `setup({ types })`, no `xstate` import, no `meta: { instruction }`;
`final: true`, not `type: "final"`. **The spec goes in `as const`** — the event
union is synthesized from the `on` keys. `packages/aai/src/sdk/CLAUDE.md` has
the rationale.

- **An ungated tool reports its position by SPREADING it:**
  `return { incidentId: id, ...callFlow.send(ctx, { type: "LOGGED" }) }` —
  never rename `state`/`done`/`instruction`, or the model reads its position
  under two key sets.
- **A spec pins the POSITION as well as the refusal** — that it moved, and did
  not move on a failure — using `expectToolOk`/`expectDialogOk`.

### A dialog can describe a CALL

Everything a dialog does when no tool is running — session events, deadlines,
the active `instruction` on every turn, per-state `bargeIn`/`toolChoice`/
`temperature` — requires `agent({ dialogs: DIALOGS })`; without it the dialog
still gates and moves on `send`. `packages/aai-runtime/DIALOG-CLAUDE.md` owns
the wiring; `roadside-assistance-agent` is the example.

- A self transition on `@user-transcript.committed` is a silence ladder; no
  chatter transition makes the deadline wall clock from entry.
- A `timeout` needs a state to LAND in (a different instruction). A committed
  turn, not a partial, restarts the clock, so a deadline leads to a nudge,
  never to anything irreversible.
- `bargeIn: "off"` applies per step, so the tool that SPEAKS the protected
  sentence must not advance the dialog; advance with a second tool a turn later.
- Pin `toolChoice` only where the tool needs nothing the caller has not said,
  and only on idempotent tools — a pin fires on every later step.
- Do not declare `voice` or `keyterms` on a state: no transport implements them.
- Declare shared exits (the hang-up) once on a parent state.

### A rule the model can skip is not a rule

When prose ("confirm every change out loud") and the tool surface disagree,
fix the tool surface: changing tools STAGE a pending action, one gated
`confirm_change` applies it, and the confirming state is reachable only by
staging. **Validate at STAGE time** — every apply must be total, since "yes"
followed by a refusal is what the gate prevents — and stage ids and amounts,
not store references a persisted session cannot carry. Beware a
self-transition on a parent with children: it re-enters and resets the child.
`retail-orders-agent` is the example.

## Workflow templates

### Every template with a `workflows/` directory drives its body DURABLY

A `describe("the run is DURABLE")` block calling `runWorkflow`
(`@alexkroman1/aai-runtime/testing`) and asserting the template's OWN claim.
`template-durability-gate.test.ts` enforces it; see `src/CLAUDE.md`.

### Where the declaration and body go

A `workflowApp()` declares its workflow in `agent.ts`; a voice agent whose tools
start, poll or cancel the run declares it in `shared.ts`, because a tool cannot
import `agent.ts` (`virtual:aai/agent` imports every `tools/` file). The body
and its steps go in `workflows/*.ts` by convention, so a spec can import the
steps alone. `template-layout-gate.test.ts` enforces placement.

### A step can authenticate now, so no template's I/O is a fixture

Steps get no `ToolContext`: use `stepEnv`/`requireStepEnv`, `stepGenerate` and
`stepGenerateJson` (`@alexkroman1/aai/step`); map provider answers onto
`FatalError`/`RetryableError` with `@alexkroman1/aai/step-errors`. A step can
call anything a tool body can (e.g. `@alexkroman1/aai/tools`). Details:
[`STEP-IO-CLAUDE.md`](STEP-IO-CLAUDE.md).

**A step's HTTP goes through `stepFetch`, never `fetch`.** Node's `fetch`
negotiates h2 and multiplexes a concurrent upload window onto one connection,
where a capacity limit arrives as a stream reset with no status to retry on;
`sdk/step-fetch.ts` has the rest.

### Fan-out

Every fan-out goes through `mapConcurrent` (`@alexkroman1/aai/step`). A step's
journal entry is found by NAME plus occurrence count, and nothing checks it is
the same work, so (rule stated in `sdk/map-concurrent.ts`'s module doc):

- **The callback issues exactly one step call per item, synchronously** — no
  await before it, no second call. Two steps per item means two fan-outs.
- **The fan-out's WIDTH comes from a STEP'S RESULT**, never re-probed by the
  body.

**A workflow input carries an upload id, never bytes** — inputs are journaled
and replayed. Declare `uploads: [...]` and read windows with `stepReadUpload`.

### A transcription step is the SDK's; the boundaries are the template's

Use `stepTranscribeUpload`/`Submit`/`Poll` and `stepTranscribeSync` via their
`*OrFail` forms (which turn `TranscribeError`'s `retryable`/`retryAfter` into
the engine's verdict). The SDK cannot ship a step — a step is what a body wraps
in `ctx.step(name, fn)` — so the template owns which steps exist, i.e. what is
journaled and what a retry repeats.

- Keep upload and submit as separate steps, so a submit retry does not
  re-upload the file.
- `stepTranscribePoll` returns the transcript; do not fetch it again.
- `meeting-recap-agent` keeps its hand-written poll on purpose (its status is a
  value its Query port and saga read); do not convert it.

### A run can be the SCHEDULE

A durable `sleep()` in the body is the scheduler (`podcast-digest-workflow`).
Then: storage is required (a multi-day sleep does not survive in memory, and a
minute-interval test hides it); the run takes a stop condition as input
(`daysToRun`) and its page pairs `cancel` with `wake`; batch polling carries a
SHRINKING pending set, and an episode that never finishes becomes a stated
reason in the digest rather than a failed run.

### A step that SPEAKS returns an id

`spoken-summary-workflow`: speak and store in ONE step (a step is journaled by
its return value, so an id replays and bytes do not); ask the model for a
required `spoken` field; derive voices from `ASSEMBLYAI_TTS_VOICES`, since a
wrong id fails silently in band. See `STEP-IO-CLAUDE.md`.

### ffmpeg is what lets a desk cut a recording where a HUMAN would

See [`FFMPEG-CLAUDE.md`](FFMPEG-CLAUDE.md). The test environment has no ffmpeg,
so an ffmpeg flow's durability is the scenario tier's.

## Every template ships an EVAL

`templates/*/agent.eval.test.ts`, required by `konsistent.json`'s
`template-eval-spec`, gated in CI against a scripted model. The harness and
what a template owes: "Driving an agent from text is a published surface" in
`packages/aai-runtime/CLAUDE.md`.

## Ports

Each port carries its attribution and a their-name → our-name table in the
module that holds the prompts. Per-template accounts:
[`PORTS-CLAUDE.md`](PORTS-CLAUDE.md).

**Which front door a port gets depends on one question: can it answer inside a
turn?** If yes, a voice agent; if the work is many long model calls or produces
prose to READ, a `workflowApp()` page, or a voice agent that hands off to a run.

### Six templates are ports of LangChain/LangGraph agents

| Source | Template | Front door | What the port changed |
| --- | --- | --- | --- |
| `open_deep_research` | `research-handoff-agent` | voice, handing off to a run | a durable workflow — too many model calls for the line |
| customer-support tutorial | `travel-concierge-agent` | voice | specialist prompt becomes a tool RESULT; `interrupt_before` becomes a spoken confirmation |
| self-RAG + CRAG | `technical-support-agent` | voice | lexical retrieval; the graders make that fine |
| plan-and-execute | `research-planner-agent` | voice | the CALLER drives execute→replan, one step per tool call |
| reflection | `document-redline-workflow` | `workflowApp()` | the loop's exit is a step's journaled VERDICT |
| Executive AI Assistant | `executive-inbox-agent` | voice | drafting tools become agent tools; the inbox interrupt becomes four gated tools |

### One template is a port of a CrewAI flow

`applicant-screening-agent` is `lead-score-flow` (`crews.ts` has attribution).
A crew task's OUTPUT decides its primitive: `output_pydantic` →
`ctx.generate({ schema })` through `mapConcurrent`; prose with rules →
`subagent()` with `expectedOutput` and `guardrail`. The feedback loop is
bounded (`MAX_FEEDBACK_ROUNDS`), and a score is stored under the id the desk
asked about, not the id the model echoed.

### Two templates are ports of the other voice frameworks' largest samples

| Source | Template | What the port changed |
| --- | --- | --- |
| LiveKit `examples/hotel_receptionist` | `hotel-reception-agent` | `AgentTask` sub-agents become `when` gates on one `booking` dialog; speech-owed counter becomes two states left on `@user-transcript.committed`; the DB becomes a seeded `sessionSlot` |
| Pipecat `word-wrangler-gemini-live` | `word-game-agent` | the second model becomes `ctx.generate` in one tool; the timer becomes `playing`'s `timeout`; filters become a referee function |

A sub-agent is a dialog state (instructions) plus a gate (tool set); a model
that must not hear the first is a tool boundary. Neither needs a second session.

### `meeting-recap-agent` is where the Temporal patterns were ported

Saga, polling, timers, a timeout-or-user-action gate, signals, queries and a
live-run mutex, against the real batch API. Table and account:
`EXEMPLARS-CLAUDE.md`. Cancellation is NOT cooperative on this engine
(`ctx.workflows.cancel` runs no compensations); a tool that cancels must say so
in its result.

## `system-prompt.md` IS the system prompt

A document goes in a file, a value stays in the call: `greeting` and
`sttPrompt` stay fields. `withSystemPrompt` (`@alexkroman1/aai/manifest`) owns
the rules and its module doc the argument. A `system-prompt.md` alongside a
different prompt STRING in `agent.ts` is a build error, and so is an empty
file — a silently ignored prompt produces an agent that behaves plausibly and
wrongly. The check compares VALUES, so composing a string from the file passes,
and a `systemPrompt` RESOLVER passes unchecked (it closes over its own `?raw`
import). `_discovery.ts` resolves prompts for `templates.test.ts`.

**`coding-agent` is TEXT-mode** (`text: true`), so `createRuntime` refuses it
and it ships its own front door, `chat.ts` — the only entry point in
`templates/`. `shared.ts` explains why its nine `tools/` files share one
`createCodingTools` registry.
