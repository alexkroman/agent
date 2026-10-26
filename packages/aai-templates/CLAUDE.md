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

**`scaffold/` and `templates/` are shipped PRODUCT.** `scaffold/CLAUDE.md` and
`scaffold/agent-guide/` are the user-facing authoring guide — embedded in the
studio prompt, shipped in the SDK tarball as `AGENT_GUIDE.md` and
`agent-guide/`, and the scaffold files a project gets no copy of
(`PROJECT_GUIDE_POINTER` in `packages/aai/src/host/scaffold-layer.ts`). Never
add repo-docs `CLAUDE.md` files under either tree.

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
because the scaffold ships its own `package.json`. `templates.test.ts` pins this
(see `src/CLAUDE.md`).

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
appending `minimumReleaseAge: 10080`, and running
`pnpm install --lockfile-only`.

Not the same as a stale metadata cache: plain `ERR_PNPM_NO_MATCHING_VERSION`
with a `The latest release … is "X"` line older than the pin is client-side
(`pnpm cache delete "@alexkroman1/*"`). The quarantine error names the
constraint or carries a `published by <date>` clause.

### A template may import only what `scaffold/package.json` declares

The three SDK packages, `zod`, `xstate` and React. Anything else must earn a
place in that manifest first, or the starter fails to build.

### Self-hosting is the scaffold's default

Every project runs on its own with `npm start` (`prestart`/`start` →
`aai start`). The mechanism is the CLI's: see "Self-hosting is the scaffold's
default, and it runs the BUILT worker" in
`packages/aai-cli/SELF-HOSTING-CLAUDE.md`.

## The authoring guide ships inside the SDK

The guide is a CORE (`scaffold/CLAUDE.md`, read first, with a "Read X when Y"
routing table, under a 20,000-char budget) plus topic files in
`scaffold/agent-guide/` (each under 50,000) — layout and budgets in
`scripts/_agent-guide.mjs`. `scripts/sync-agent-guide.mjs` materializes them as
`packages/aai/AGENT_GUIDE.md` and `packages/aai/agent-guide/*.md`, the same
relative layout, so they ship in the `aai` tarball and match the SDK a project
resolves; `layerScaffoldFiles` copies NEITHER into a project and writes a
pointer at the SDK copy as its `CLAUDE.md` instead of a copy that would freeze.
The generated-file banner is part of the compared content. `check:agent-guide`
keeps the copies honest, fails a topic the core does not route to, and
regenerates the `@alexkroman1/aai` subpath list in the core and in the skill
from `SUBPATHS` (which must cover the `exports` map exactly).

- A new topic file needs a routing-table row in the core and a literal line in
  `check-doc-examples.mjs`'s `MARKDOWN_FILES` (both checked).
- The studio prompt inlines every topic after the core (`loadScaffoldGuide`).
- It is a repo-level script, not an `aai` build step, because `aai` may import
  no sibling package (`konsistent.json`).
- `packages/aai/skills/aai/SKILL.md` carries NO API guidance — a skill has no
  version, so it only points at the guide (its subpath list is generated).

## Session state

**A tool that touches session state is `slot.tool` or `slot.updateTool`, never a
`tool()` that opens with `slot.get(ctx)`.** The declaration makes "does this
write?" visible and the wrong answer a compile error (what a read receives is
frozen). The declaration carries the rest of the shape too, so none of it is
hand-forwarded in the body: `require` is the precondition (a `ToolFailure` off
the frozen value, run before `prepare` and again before the window), `prepare`
is the await a mutating body needs first (its answer is `execute`'s THIRD
argument, ahead of `ctx`), and `dialog`/`when`/`send` is the gate
(`SlotToolDef`, `packages/aai/src/sdk/session-slot-types.ts`). A plain `tool()`
that must await and then write uses
`slot.transact(ctx, { require, prepare, commit })`; only a tool where ONE branch
writes stays a `tool()` calling `slot.update` in that branch
(`tabletop-rpg-agent`'s oracle), since a window on a branch that stores nothing
is the wrong declaration.

**A derived field belongs in the slot's `after` hook, which runs on EVERY store;
a tool that REPORTS it declares `report`.** `after` runs on the default, on
`set`, on `reset` and on the empty projected frame as well as after `update`, so
a default never precomputes one (`SessionSlotOptions.after`). A result built in
the body still carries the pre-`after`, pre-`caps` draft, so
`report: (stored, partial) => …` reads it off the stored value instead
(`SlotUpdateToolDef.report`).

**A pure helper over slot state takes `SlotValueOf<typeof slot>`, a mutator
takes `SlotDraftOf<typeof slot>`** — never a per-template `Frozen*` alias over
`DeepReadonly<T>`. `slot.get`/`slot.tool` hand out a deep-readonly value and
`readonly string[]` does not satisfy `string[]`; a mutable draft still satisfies
the value type. When the widening is awkward, make the lookup generic
(`emergency-dispatch-agent`'s `findIncident`) or copy the array into a fresh
result. A client renders what the projection produces.

**The LLM loop runs one step's tool calls CONCURRENTLY**, so a read-modify-write
tool body over non-slot state needs `createKeyedLock`/`withLock`
(`@alexkroman1/aai/utils`). Not inside `slot.update`, which is already atomic.

**A template's spec is what makes its exemplar code true** — an unexercised tool
can be wrong for releases. Drive every tool you add.

## The templates are where SDK primitives get their worked example

- **Extract on the third copy.** When the same helper appears in a third
  template, move it into the SDK instead of copying it again.
- **Every public export needs a template use or an allowlist entry**
  (`template-api-coverage.test.ts`). Removing a template's use of an export may
  owe an allowlist entry — see "The last remover pays" in `src/CLAUDE.md`.
- The table of which template demonstrates what is in
  [`EXEMPLARS-CLAUDE.md`](EXEMPLARS-CLAUDE.md).

Rules the table carries that apply to any template:

- A slot whose `create()` pulls a seed declares `empty` beside `view`
  (`SessionSlotOptions.empty`), so `useAgentState(slot.projected)` renders the
  empty shape and the seed never ships to the browser; a slot with a `view` is
  declared `sync: true` — `agent({ syncState })` is not a field.
- A slot's default is a plain value (cloned per install) unless it is computed;
  a factory exists for the seed, not for the clone.
- Do not call `spokenOrdinal` beside `resolveOne`; it consults it internally.
- Name a subagent in code when the tool IS the choice; put it on
  `agent({ roster })` when the caller's words are. Give every speaker an
  `expectedOutput`. Reach for `SpeakerDef.guardrail` only when a `schema` cannot
  express the check; an unaccepted result stays a field on the tool result, not
  a `ToolFailure`.
- `ToolDef.onError` is a classifier: re-throw to make a failure fatal instead of
  a model retry loop.
- `agent({ outputGuardrails })` is pipeline-only; `agent({ listing })` is for
  humans choosing the agent, not the model (`description` is its deprecated
  alias on `agent()`; on a tool it is the model's).
- A per-outcome instruction to the model is `withInstruction(value, "…")`, never
  an invented `message`/`say`/`guidance` field the prompt begs the model to
  read.
- A tool's icon and label are `tool({ ui })`, served with the declaration;
  `mountClient()` has no `tools` map (and no `name`) to restate them in.
- A tool reads the clock and the turn from `ctx.now()` and `ctx.turn`, never
  `Date.now()` or a counter kept in a slot; a module a tool hands the clock to
  takes it as an argument (`roadside-assistance-agent`'s `reserveTruck`). A
  count the PAGE renders (`text-adventure-agent`'s `moves`) is slot state
  written by a hook, which is a different thing from a tool asking how old the
  session is.
- A no-argument tool omits `inputSchema` rather than writing `z.object({})`.
- Step code imports from `@alexkroman1/aai/step` (zero-zod), not the root.
- `@alexkroman1/aai/tools` functions return `T | ToolFailure` — narrow with
  `isToolFailure`; a `catch` cannot see a refused search, and an unhandled one
  reads as "no results".
- Specs: open with `describeAgent(agentDef, (run) => …)` and call tools through
  the DEF (`run(toolDef, args)`), never a per-spec wrapper or a restated result
  schema; read eval results with `toolResultIn(calls, toolDef)` and
  `lastStateIn(events, slot.projected)`; assert refusals with
  `expectDialogRefused`/`dialogRefusalPattern`, never a regex on the sentence;
  the three slot invariants are one `expectSlotContract(slot, { write })` (the
  caps come off the handle, so a spec restates none); stub step I/O with
  `installStubWorld`, which also seeds `ASSEMBLYAI_API_KEY` (so no `vi.stubEnv`
  for it; `apiKey: false` for the missing-key spec), never `globalThis.fetch`.

## A flow is WHERE A CONVERSATION IS, and a board is not one

A dialog position is a fact about the CONVERSATION, not the world. Per-entity
status stays on the entity (`Incident.status`), gated tools stay addressed by
id, and a per-entity constraint is a `ToolFailure` from the lookup, not a flow.
Do not read a position as a summary of the data. Reading order and each
template's account: `EXEMPLARS-CLAUDE.md`, "Dialog templates".

- **A tool legal in EVERY state omits `when`** and keeps `dialog`/`send`: it
  never refuses, still answers the `{ ...position, result }` envelope, and the
  SDK sends for it — never spread `dialog.send(ctx, …)` into a result by hand
  (`DialogGate.when`).
- **`sendFrom` is where "did this actually do the thing" lives**: send nothing
  when nothing happened. Three spellings, no source-order rule: the callback,
  the field name (`sendFrom: "next"`, a key holding the event type or
  `undefined`), or the second argument `flow.tool(def, { sendFrom })`
  (`DialogSendOptions`).
- **A side effect a phase change owns is the state's `onEnter`** — clearing a
  scratch slot, stamping a time — not a transition plus an `events.ts`; it may
  write other slots and never sends its own dialog (`DialogStateSpec.onEnter`).
- **A `final` state delivers no events**, so restarting is `dialog.reset`, or
  `reset: true` on the setup tool that begins a fresh pass.
- **A refusal short-circuits before the tool body**, including any bookkeeping a
  per-agent wrapper does; say so at the wrapper.
- **A state with a `timeout` must not transition on chatter** unless you want
  every turn to re-arm it: the deadline runs from the dialog's last MOVE.

### A per-agent wrapper is rarely needed, and copies the SDK's signature

A gated slot tool is one
`slot.updateTool({ dialog, when, require, prepare, report, send })` declaration,
so the wrapper that forwarded a gate and a precondition by hand is gone. Where
one survives (an activity log), it copies the SDK's signature, not its
`Exclude`: declare `execute: (…) => R | ToolFailure` and let union inference
subtract the failure arm; a `summary` takes `NoInfer<R>`, since
`Exclude<NoInfer<R>, ToolFailure>` does not distribute over a non-naked type
parameter. With `NoInfer` a `sendFrom` reading a missing field is a compile
error, not silence: delete absorbing guards (`"x" in result &&`) rather than
adding them, and use the field form of `sendFrom` when a union's arms would
otherwise each need `field: undefined`.

### A dialog is a plain state map now

No `setup({ types })`, no `xstate` import, no `meta: { instruction }`;
`final: true`, not `type: "final"`. **The spec goes in `as const`** — the event
union is synthesized from the `on` keys. `packages/aai/src/sdk/CLAUDE.md` has
the rationale.

- **A tool that reports its position declares `dialog` with no `when`** and
  returns its own result; the envelope's `state`/`done`/`instruction` keys are
  the SDK's, so the model reads its position under one key set.
- **A spec pins the POSITION as well as the refusal** — that it moved, and did
  not move on a failure — using `expectToolOk`/`expectDialogOk`.

### A dialog can describe a CALL

Everything a dialog does when no tool is running — session events, deadlines,
the active `instruction` on every turn, per-state `interruption`/`toolChoice`/
`temperature` — requires `agent({ dialogs: [callFlow] })`; without it the dialog
still gates and moves on `send`. `packages/aai-runtime/DIALOG-CLAUDE.md` owns
the wiring; `roadside-assistance-agent` is the example.

- A self transition on `@userTranscript.committed` is a silence ladder; no
  chatter transition makes the deadline wall clock from entry.
- A `timeout` needs a state to LAND in (a different instruction). A committed
  turn, not a partial, restarts the clock, so a deadline leads to a nudge, never
  to anything irreversible.
- `interruption: "off"` applies per step, so the tool that SPEAKS the protected
  sentence must not advance the dialog; advance with a second tool a turn later.
- Pin `toolChoice` only where the tool needs nothing the caller has not said,
  and only on idempotent tools — a pin fires on every later step.
- Do not declare `voice` or `keyterms` on a state: no transport implements them.
- Declare shared exits (the hang-up) once on a parent state.

### A rule the model can skip is not a rule

When prose ("confirm every change out loud") and the tool surface disagree, fix
the tool surface: changing tools STAGE a pending action, one gated
`confirm_change` applies it, and the confirming state is reachable only by
staging. **Validate at STAGE time** — every apply must be total, since "yes"
followed by a refusal is what the gate prevents — and stage ids and amounts, not
store references a persisted session cannot carry. Beware a self-transition on a
parent with children: it re-enters and resets the child. `retail-orders-agent`
is the example.

## Workflow templates

### Every template with a `workflows/` directory drives its body DURABLY

A `describe("the run is DURABLE")` block calling `runWorkflow`
(`@alexkroman1/aai-runtime/testing`) and asserting the template's OWN claim.
`template-durability-gate.test.ts` enforces it; see `src/CLAUDE.md`.

### Where the declaration and body go

`workflows/<name>.ts` default-exports the def
(`workflow({ description, input, output }).body(flow)` — the two-phase form, so
the body may name `WorkflowInputOf<typeof def>` in the same module) and is
REGISTERED as `<name>` by `aai build`, `aai dev` and `virtual:aai/agent`
(`workflowRegistry`, `packages/aai/src/sdk/manifest-workflows.ts`). A voice
agent declares nothing and its tools import `../workflows/<name>.ts` directly —
no `shared.ts` detour for the def; a `workflowApp()` imports the def into its
required `workflows` map. A `workflows/` file with no default def is a helper
and is skipped. `template-layout-gate.test.ts` enforces placement.

### A tool reaches a run by the session's key, and the SDK speaks the status

`ctx.workflows.start(def, input)` keys the run by the session
(`StartOptions.key` defaults to `"session"`), and `latest(def)` / `live(def)`
read it back; a hand-written `request/status/progress/cancel` quartet is the
`workflow_status`/`workflow_progress`/`workflow_cancel` builtins plus
`describeRun`/`cancelNote` on the def. A signal is `ctx.waitForSignal(label)` in
the body and `ctx.workflows.signalRun(def, "session", label, payload)` in the
tool — no module of token strings two files must agree on
(`packages/aai/src/sdk/workflow-signals.ts`).

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

### Transcribing an upload from a body is one call, and a poll is `ctx.poll`

The async leg (upload, submit, poll on a durable sleep) is
`transcribeUploadDurably(ctx, uploadId)` (`@alexkroman1/aai/step`): it journals
`TRANSCRIBE_DURABLY_STEPS` as three steps of the body's own `ctx`, so a resumed
run replays the upload and the submit and polls the same job (`batch.ts`,
`spoken-summary-workflow`). Where the body owns the poll — a batch of jobs
(`podcast-digest-workflow`) or the sync endpoint — use
`stepTranscribeUpload`/`Submit`/`Poll` and `stepTranscribeSync` wrapped in
`orFail` (`orFail(stepTranscribeSubmit)`, which turns `TranscribeError`'s
`retryable`/`retryAfter` into the engine's verdict), and keep upload and submit
as separate steps so a submit retry does not re-upload the file.

- `stepTranscribePoll` returns the transcript; do not fetch it again.
- `stepTranscribeUpload` resolves `{ audioUrl, source, size }`; report the
  `source` (the upload's `label`), never the id.

Any other submit-then-check shape is
`ctx.poll(name, check, { everyMs, maxMs, done, first, slowAfterMs })`, never a
hand-rolled `for (poll < MAX)` with a `ctx.sleep` inside; narration between
steps is `ctx.report`.

### A run can be the SCHEDULE

A durable `sleep()` in the body is the scheduler (`podcast-digest-workflow`).
Then: storage is required (a multi-day sleep does not survive in memory, and a
minute-interval test hides it); the run takes a stop condition as input
(`daysToRun`) and its page pairs `cancel` with `wake`; batch polling carries a
SHRINKING pending set, and an episode that never finishes becomes a stated
reason in the digest rather than a failed run.

### A step that SPEAKS returns an id

`spoken-summary-workflow`: speak and store in ONE step — `stepSpeakToUpload`
(`/step-files`), which is the step result (a step is journaled by its return
value, so an id replays and bytes do not); ask the model for a required `spoken`
field; derive voices from `ASSEMBLYAI_TTS_VOICES`, since a wrong id fails
silently in band. The ffmpeg shell (materialize → probe → run → store) is
`transcodeUpload` on the same subpath. See `STEP-IO-CLAUDE.md`.

### A `system:` string never restates the JSON shape

`stepGenerateJson` and `ctx.generate({ schema })` append the schema themselves,
so "Reply with JSON only: {…}" prose beside a `schema:` is a second copy that
drifts; per-field guidance is `.describe()` on the schema field, and an array
cap is `.transform((a) => a.slice(0, N))` in the schema (`guard-invariants` rule
39).

### ffmpeg is what lets a desk cut a recording where a HUMAN would

See [`FFMPEG-CLAUDE.md`](FFMPEG-CLAUDE.md). The test environment has no ffmpeg,
so an ffmpeg flow's durability is the scenario tier's.

## Every template ships an EVAL

`templates/*/agent.eval.test.ts`, required by `konsistent.json`'s
`template-eval-spec`, gated in CI against a scripted model. The harness and what
a template owes: "Driving an agent from text is a published surface" in
`packages/aai-runtime/CLAUDE.md`.

## Ports

Each port carries its attribution and a their-name → our-name table in the
module that holds the prompts. Per-template accounts:
[`PORTS-CLAUDE.md`](PORTS-CLAUDE.md).

**Which front door a port gets depends on one question: can it answer inside a
turn?** If yes, a voice agent; if the work is many long model calls or produces
prose to READ, a `workflowApp()` page, or a voice agent that hands off to a run.

### Six templates are ports of LangChain/LangGraph agents

| Source                    | Template                    | Front door                  | What the port changed                                                                     |
| ------------------------- | --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `open_deep_research`      | `research-handoff-agent`    | voice, handing off to a run | a durable workflow — too many model calls for the line                                    |
| customer-support tutorial | `travel-concierge-agent`    | voice                       | specialist prompt becomes a tool RESULT; `interrupt_before` becomes a spoken confirmation |
| self-RAG + CRAG           | `technical-support-agent`   | voice                       | lexical retrieval; the graders make that fine                                             |
| plan-and-execute          | `research-planner-agent`    | voice                       | the CALLER drives execute→replan, one step per tool call                                  |
| reflection                | `document-redline-workflow` | `workflowApp()`             | the loop's exit is a step's journaled VERDICT                                             |
| Executive AI Assistant    | `executive-inbox-agent`     | voice                       | drafting tools become agent tools; the inbox interrupt becomes four gated tools           |

### One template is a port of a CrewAI flow

`applicant-screening-agent` is `lead-score-flow` (`crews.ts` has attribution). A
crew task's OUTPUT decides its primitive: `output_pydantic` →
`ctx.generate({ schema })` through `mapConcurrent`; prose with rules →
`speaker()` with `expectedOutput` and `guardrail`. The feedback loop is bounded
(`MAX_FEEDBACK_ROUNDS`), and a score is stored under the id the desk asked
about, not the id the model echoed.

### Two templates are ports of the other voice frameworks' largest samples

| Source                                | Template                | What the port changed                                                                                                                                                                 |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LiveKit `examples/hotel_receptionist` | `hotel-reception-agent` | `AgentTask` sub-agents become `when` gates on one `booking` dialog; speech-owed counter becomes two states left on `@userTranscript.committed`; the DB becomes a seeded `sessionSlot` |
| Pipecat `word-wrangler-gemini-live`   | `word-game-agent`       | the second model becomes `ctx.generate` in one tool; the timer becomes `playing`'s `timeout`; filters become a referee function                                                       |

A sub-agent is a dialog state (instructions) plus a gate (tool set); a model
that must not hear the first is a tool boundary. Neither needs a second session.

### `meeting-recap-agent` is where the Temporal patterns were ported

Saga, polling, timers, a timeout-or-user-action gate, signals, queries and a
live-run mutex, against the real batch API. Table and account:
`EXEMPLARS-CLAUDE.md`. Cancellation is NOT cooperative on this engine
(`ctx.workflows.cancel` runs no compensations); a tool that cancels must say so
in its result.

## `system-prompt.md` IS the system prompt

A document goes in a file, a value stays in the call: `greeting` and `sttPrompt`
stay fields, and text computed beside the file — a menu, a status block, a
per-request line over a slot — is `agent({ promptContext })`, appended under it
(`AgentPromptContext`, `packages/aai/src/sdk/agent-instructions.ts`).
`agent({ systemPrompt })` is not a field in any mode (`FrameworkOwnedField`):
the file is the only prompt. **No template imports `system-prompt.md?raw`**, not
even a spec — a spec asserting on the prompt reads it off `virtual:aai/agent`'s
lowered def. `withSystemPrompt` (`@alexkroman1/aai/manifest`) owns the rules and
its module doc the argument; an empty file is a build error — a silently ignored
prompt produces an agent that behaves plausibly and wrongly. `_discovery.ts`
resolves prompts for `templates.test.ts`.

**`coding-agent` is TEXT-mode** (`mode: "text"`), so `createRuntime` refuses it
and it ships its own front door, `chat.ts` — the only entry point in
`templates/`. `shared.ts` explains why its nine `tools/` files share one
`createCodingTools` registry.
