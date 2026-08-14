# packages/aai-templates — templates guide

Agent templates + the project scaffold (private package). Note
`scaffold/CLAUDE.md` is a PRODUCT artifact — it is scaffolded into every
`aai init` project and embedded in the studio system prompt — not
documentation for this repo.

## Templates

- `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and optional `client.tsx`.
  `scaffold/` has base project files (package.json, tsconfig,
  etc.) layered underneath.

  **They ship inside the `@alexkroman1/aai-cli` tarball**, copied into its
  `dist/` at build time by `aai-cli/bundle-templates.mjs` — the sources stay
  in `aai-templates`, which still owns their tests, typecheck, and lint;
  this is packaging, not a move. `aai init` used to fetch them at run time
  with giget (`github:alexkroman/agent/packages/aai-templates#main`), which
  required a network for every init and pinned templates to `main`
  regardless of the CLI version installed, so a template written against a
  newer SDK could land in a project resolving an older one. Two consequences
  worth knowing:
  - `packages/aai-cli/turbo.json` adds the template sources to the build's
    `inputs`. They live in another package, so the root task's
    package-relative globs cannot see them — without the override, editing a
    template replays a cached CLI build that predates it.
  - Nothing running in-tree can exercise the shipped path: `getMonorepoRoot()`
    keys off the module's own location, so a CLI built at
    `packages/aai-cli/dist` always finds the workspace root and takes the
    monorepo branch. The e2e suite's `detachedCli()` copies `dist/` somewhere
    with no `pnpm-workspace.yaml` above it for that reason, and `aaiEnv()`
    deliberately sets no `AAI_TEMPLATES_DIR` — that override used to pin
    every e2e run to the workspace sources.

## The scaffold pins `^<newest>`, so it must opt out of release-age quarantine

`scripts/sync-scaffold-versions.mjs` resyncs `scaffold/package.json` to the
workspace versions on every `changeset version`, so a scaffolded project always
asks for the SDK release that was just cut. That is correct — the templates are
written against it — but it collides with pnpm's `minimumReleaseAge`, which
holds a version back until it has been on the registry for N minutes (pnpm 11
turns it on by default; an org config can set it far higher). Because this repo
publishes several times a day, EVERY version satisfying `^<newest>` is inside
the window, there is nothing older to fall back to, and `aai init` dies at its
own install step with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Lowering the pin
does not help: the floor has to admit the build the templates need.

`scaffold/pnpm-workspace.yaml` therefore ships
`minimumReleaseAgeExclude: ["@alexkroman1/*"]` — scoped to our own packages, not
`minimumReleaseAge: 0`, so a user's window still covers every third-party
dependency. `templates.test.ts` pins both that key and the
`onlyBuiltDependencies`/`allowBuilds` pair beside it, because **every setting in
that file fails only on a user's machine**: pnpm ignores unknown keys silently,
so a rename or a dropped line is invisible in-tree. Reproduce either failure by
copying `scaffold/` to a temp dir, appending `minimumReleaseAge: 10080`, and
running `pnpm install --lockfile-only`.

Do not confuse this with a stale metadata cache, which fails the same command
with a different error: plain `ERR_PNPM_NO_MATCHING_VERSION` and a
`The latest release … is "X"` line naming a version older than the pin. That one
is client-side (`pnpm cache delete "@alexkroman1/*"`), not ours — the quarantine
error always names the constraint or carries a `published by <date>` clause.

## The templates are where SDK primitives get their worked example

`template-api-coverage.test.ts` already enforces the direction "every public
export is exercised by a template". The converse is the rule to apply while
EDITING one: when the same helper appears in a third template, that is the
signal to extract it into the SDK rather than copy it again. Five came out at
once, and the templates are now their reference use:

| Primitive | Demonstrated by |
| --- | --- |
| `sessionSlot()` + `SlotStateOf` | every stateful template — `pizza-ordering` (smallest), `retail` (slot in `store.ts`, view in `shared.ts`, so the seed stays out of the browser bundle) |
| `slot.projection(view)` as `syncState` | `pizza-ordering`, `dispatch-center`, `retail`; `solo-rpg` uses bare `slot.read` (its projection is the identity) |
| `slot.update` (serialized mutation) | `dispatch-center` (every mutating tool, plus an `after` hook that prunes and recalculates the alert level), `retail` (inside `retailTool`, the one caller — which is what keeps `update`'s non-reentrancy unreachable) |
| `slot.updateTool` | `plan-desk` — every mutating tool, and the one place the serialization is load-bearing rather than prudent: a body that awaits a model call and then shifts the plan's head step would, run twice concurrently, do step one twice |
| `slot.tool` (the synchronous half) | `pizza-ordering` (all six), `travel-concierge` (the whole dialog stack and every staged action) |
| `ctx.generate` with a `schema` | `support-line` (five graders and a rewriter over one binary-score schema), `plan-desk` (planner, executor and replanner). `travel-concierge` deliberately uses none — its specialists are prompts, not models |
| `ToolFailure` / `isToolFailure` | `retail` (~40 sites, failures propagating through `store.ts` helpers), `dispatch-center` (six) |
| `pushCapped` | `dispatch-center` (incident timeline), `retail` (activity feed), `solo-rpg` (session log), `infocom-adventure` (command history) |
| `createToolContext` (`@alexkroman1/aai/testing`) | the four suites that test tools directly — `dispatch-center`, `pizza-ordering`, `retail`, `solo-rpg` |
| `useAgentState(fallback)` | `pizza-ordering`, `dispatch-center`, `retail`, `solo-rpg` |
| `AutoScroll` | the three custom-chrome clients — `dispatch-center`, `retail`, `infocom-adventure` |
| `workflow()` + `ctx.workflows` + `isTerminal` | `research-desk` — the handoff: a VOICE template whose tool starts a run, correlates it with `key`, and reads it back (see below); `recap-desk` is the same shape with `cancel` and a live-run check on top |
| `page()` + `createWorkflowApi` + `useWorkflowRun` | `link-digest` — the WORKFLOW APP with the primitives raw: a hand-written `<form>`, its own `useState`, one `createWorkflowApi()` |
| `Form` + `WorkflowFields` + `useWorkflowSubmit` | `transcription-desk` — the same front door with the form layer, plus `WorkflowOutputOf`. Its form is ALL declared, so `FileField` is exercised by no template and sits in the allowlist |
| `TextAreaField` beside `<WorkflowFields>` | `redline` — the MIXED form: three scalars declared by the schema, one array field written by hand in the same `<Form>` and mapped on submit. The case "Forms" in `packages/aai-ui/CLAUDE.md` describes, which no template used to exercise |
| `toStepError` / `throwStepError` / `throwFatalStepError` (`@alexkroman1/aai/step-errors`) | every workflow template — `transcription-desk` and `link-digest` for the HTTP classification each had hand-written identically, `research-desk`/`link-digest`/`redline` for the `.catch(throwStepError)` on a model call, `transcription-desk` for the two `catch`-block fatals, `recap-desk` for both halves of a provider call it also polls |
| `stepGenerateJson` + `stripJsonFence` | `research-desk` (five stages, each with its own zod shape — including the LENIENT ones that replace its hand-rolled `strings()`/`isSource()` coercion), `link-digest` (one), `redline` (the critic's findings) and `recap-desk` (the recap, whose `spoken` field is required rather than defaulted because the announced turn has nothing to read without it). `stripJsonFence` is exercised only through `stepGenerateJson`, which is the intended path |
| `stubGateway` (`@alexkroman1/aai/testing`) | the `research-desk`, `link-digest`, `redline` and `recap-desk` specs — the QUEUE form in the first and last, because their model calls sit in a loop or a chain, and the single-reply form in `link-digest` |
| `mapInBatches`, `stepEnv` / `requireStepEnv`, `stepGenerate`, `stepFetch` / `multipartBody` | the STEP surface, and every workflow template uses it: `transcription-desk` fans its segments out with `stepFetch` + `multipartBody` and reads `ASSEMBLYAI_API_KEY` for the sync STT endpoint, `recap-desk` makes all three of its batch-API calls through `stepFetch` (it POLLS, so one run is many requests); `research-desk`, `link-digest`, `redline` and `recap-desk` call the model with `stepGenerate` (or `stepGenerateJson`, for a reply that has to be a shape), and `recap-desk` reads the same key for the batch transcription endpoint it polls. Imported from `@alexkroman1/aai/utils`, NOT the root: a `workflows/*.ts` module is bundled separately by the WDK builder, so the root barrel's graph would ride into the step bundle. That import path is also why the coverage gate cannot see them — it scans the root specifier — hence their allowlist entries |
| `webSearch` / `visitWebpage` (`@alexkroman1/aai/tools`) | `research-desk`, from inside a `"use step"` function — the demonstration that a step is not a lesser environment than a tool body; `plan-desk`, from an ordinary tool body, which is the case the module was published for |

**`research-desk` is the workflow template, and its shape is dictated by the
Workflow DevKit rather than chosen.** The `"use workflow"` / `"use step"` bodies
live in `workflows/research.ts` because the WDK builder scans that directory at
build time and rewrites what it finds; a body written in `agent.ts` is never
transformed, so it runs inline once with no durability and nothing saying so.
`agent.ts` holds only the declaration (`workflow({ description, input, run })`)
and the two tools that start and read runs.

**Its research is real, and it really searches the web.** Five stages, adapted
from LangChain's `open_deep_research` (MIT — `workflows/prompts.ts` carries the
attribution and a table mapping their stages onto ours): `writeBrief` settles
what the phone request was actually asking, `planAngles` decides the fan-out's
width, `investigate` gives each angle its own researcher step, `findGaps` is the
supervisor's second look, and `writeReport` writes the report and then the two
sentences a phone can carry. That is five to twelve model calls and as many
searches, which is what makes it too slow to answer on the line and therefore
worth a durable run at all. The fan-out's WIDTH comes from a step's journaled
result rather than from anything the body computes, which is the ordinary
determinism rule.

**A step can do what a TOOL can do, and this is the template that shows it.**
`investigate` imports `webSearch` and `visitWebpage` from
`@alexkroman1/aai/tools` — the same implementations behind the model-facing
builtins, with the same URL screening, redirect re-validation and size caps —
and runs a bounded search/read/stop loop on them. A step artifact bundles
everything it imports, so anything a tool body can reach a step can reach; what
it does NOT get is the `ToolContext`, which is why the model call is
`stepGenerate` and the key comes from `requireStepEnv`. Before this the
template's "research" was three model calls asking a model what it already
believed, which is the thing deep research exists not to be.

Three things in the loop are decisions rather than defaults, and each is the
kind a prompt alone does not hold:

- **The budget is the mechanism, not the prompt.** `RESEARCH_BUDGET` bounds the
  actions one researcher may take, because a model told to stop when it has
  enough will sometimes not — and a run whose cost is decided by a model is a
  run nobody can price. The prompt's numbered stop rules (theirs, kept close to
  verbatim) are what makes it stop EARLIER than the budget.
- **The loop is journaled as ONE step result**, not one per iteration. The loop
  is a negotiation with a model and a search engine, and replaying it turn by
  turn would pin a run to decisions that were only ever provisional; what has to
  survive a resume is what the researcher CONCLUDED.
- **A failed search goes back to the researcher, not only to the log.** The next
  turn is chosen from what it has been shown, so a search that quietly returned
  nothing reads as "no such pages exist" and gets run again, differently worded,
  until the budget is gone. Its own spec pins that.

Note the compression stage's prompt is the counter-intuitive one worth keeping:
it says to REPEAT the relevant text rather than summarize it, because a summary
of a summary is how a long research pass ends in a confident, sourceless
paragraph.

Its spec stubs `ctx.workflows` for the TOOLS rather than driving a real client,
which is the only honest option there: the real client needs a WDK world, and the
bodies are only durable after the build has transformed them. The STEPS are
driven directly against a stubbed `fetch`, because imported through vitest with
no bundler in the path a `"use step"` function is an ordinary async function.

That is also why **`workflow()` does not check for the compiler's
`workflowId`** — `templates.test.ts` imports every
`agent.ts` through vitest with no bundler in the path, so a declaration-time
throw made this template unimportable by its own spec. The check lives at
`ctx.workflows.start`, where the id is actually needed.

Note the template needs `workflow` as a devDependency of THIS package to
resolve at test time; a scaffolded project gets it as a real dependency.

**A search that was REFUSED is not a web with nothing in it, and both templates
that search got that wrong.** `webSearch`/`visitWebpage`/`fetchJson`
(`@alexkroman1/aai/tools`) ANSWER with `{ error }` rather than throwing — the
model-facing contract, so a tool hands something useful back instead of failing
the turn — and they used to be typed `Promise<T>`, which made that invisible.
`research-desk` wrote `(results.results ?? [])` under a `catch` written for
exactly this failure, and a `catch` cannot see a returned value; `plan-desk`
wrote the same line with no failure path at all. Measured 2026-08-13: DuckDuckGo
answered `403` to both its endpoints, so every search in both templates reported
"No results." with the refusal nowhere. The type is `T | ToolFailure` now and
both narrow with `isToolFailure` — and `aai:builtins` epoch 1 was DROPPED over
it, which is the gate recording that a caller who named a shape has to handle the
failure it was already receiving.

**A step's HTTP goes through `stepFetch`, never `fetch`, and that came out of a
load test rather than review.** `transcription-desk` used `fetch` with a
`FormData`, which is the obvious spelling and fails under exactly the concurrency
the template exists to demonstrate: Node's `fetch` offers `h2` in ALPN and the
sync endpoint takes it, so a `mapInBatches` batch of 17.66 MB uploads multiplexes
onto ONE connection. Measured at 8 in flight, `fetch` landed 14 of 16 at p50
8094ms against HTTP/1.1's 16 of 16 at p50 3037ms — and the two it lost are the
point, because a capacity limit on h2 arrives as `NGHTTP2_ENHANCE_YOUR_CALM`, a
stream reset with no HTTP status for `isTransientStatus`/`retryAfter` to read. So
every sibling retried in lockstep into the same reset and the run died on
`TypeError: fetch failed` with the cause two hops down. Over HTTP/1.1 the same
limit is a `503` with `retry-after`, which the template already handled. The
concurrency curve that came out of it is in `SEGMENT_CONCURRENCY`'s own doc;
`sdk/step-fetch.ts` owns the rest, and a spec answers it with `stubStepFetch`
(`@alexkroman1/aai/testing`) rather than stubbing the global — the global stub
passes while testing a path production does not take.

**`transcription-desk` is the second workflow template. It is a WORKFLOW APP —
`workflowApp()`, no `stt`/`llm`/`tts`, no tools — and it is the one that really
calls a provider.** Its three steps are a straight line: `splitRecording` reads
the recording's WAV header and decides where to cut, `transcribeSegment` runs
once per chunk against AssemblyAI's **sync** endpoint, `mergeTranscript` stitches
the chunks back into one transcript.

**The fan-out is forced by the provider, which is what makes it a good example.**
The sync endpoint answers in the request — no job id, no polling, no callback —
and pays for that with a hard 120-second, 40 MB cap. So a two-hour recording is
not one call, it is sixty, and the desk owns the splitting, the retrying and the
reassembly that the BATCH API would have owned for it. That is the work a
journal earns its keep on: a run that dies on segment 27 of 60 resumes having
replayed 1-26 — not re-downloaded, not re-transcribed, not re-billed — and issues
only what is missing.

It used to demonstrate the batch shape instead: a run that parked on
`createWebhook()` and was resumed by the delivery. That is a real and important
mechanism, and it was demonstrated against a STUB provider that called its own
webhook back inside the submit step — i.e. the template's whole subject was
simulated. No template covers `createWebhook()` today — `aai-cli`'s
`dev-workflow.integration.test.ts` does, against a real world and a real HTTP
delivery, which is the only tier that ever could — and a template that simulates
its own subject is worse than one that leaves the mechanism to the tier that can
actually exercise it.

Three things in it are load-bearing:

- **The recording is UPLOADED, and the run carries its id.** A workflow's input
  is journaled and replayed on every resume, so bytes may not travel in one —
  which is why this template asked for a URL for a while, and why its
  `<FileField>` before that described a file nothing ever read. The SDK owns
  both halves now: `uploads: ["recording"]` on the declaration is what makes
  `<WorkflowFields>` render a picker and `useWorkflowSubmit` store the file, and
  each step reads its own window with `readUpload`. Sixty steps therefore move
  the recording once between them, not sixty times. See "Uploads" in
  `packages/aai-ui/CLAUDE.md` for the mechanism; the template contains no upload
  code at all, which is the point.
- **It is linear-PCM WAV only, and it says so by name.** The cutting is
  arithmetic over byte offsets — a sample is a fixed size, so an offset IS a
  timestamp and any frame boundary is a clean cut. An MP3 or M4A frame boundary
  cannot be found that way, and finding it means shipping a decoder into a step,
  so an unsupported file fails the run with the `ffmpeg` line that fixes it.
  `workflows/wav.ts` holds all of that, with no directive in it: the builder
  scans `workflows/` and transforms only what carries one, so an ordinary module
  can sit beside the bodies — and everything in it is a pure function of a
  journaled value, which is what its spec drives.
- **Segments OVERLAP, and the merge step is what makes that free.** A cut lands
  mid-word, and the decoder on either side then hears half a word and reports
  something plausible and wrong; two seconds of overlap means both sides hear the
  whole word. `stitchTranscript` finds the longest repeated run at each seam and
  drops one copy, comparing on a punctuation-stripped key because the two passes
  punctuate their own edges differently. It prefers the LONGEST match: a missed
  seam repeats a few words, which a reader forgives, while a false one deletes
  speech.

**The DevKit correlates a journal entry to a step call by the ORDER the call was
ISSUED in**, which is why the fan-out is bounded the way it is. `createUseStep`
(`@workflow/core/dist/step.js`) stamps each invocation with
`step_${ctx.generateUlid()}` from a monotonic ULID factory seeded off the run's
`startedAt` and the VM's replay-stable `Math.random`, so the Nth step call in a
run gets the Nth id on the first execution and on every replay. The step's NAME
is only cross-checked against that id, and a mismatch is `ReplayDivergenceError`
rather than a silent re-run.

Two things follow, and they are the fan-out's whole shape:
`Promise.all(batch.map(step))` is safe (every call issued synchronously, in
array order, whatever order they settle in), and **a work-stealing pool is not**
— a worker issues its next call only after its previous one settles, so the
issue order tracks completion order, which differs between a live run and a
replay. Bounded concurrency therefore has to be sequential batches of
`Promise.all`, which costs the tail of each batch and is the only deterministic
option. This is the one piece of the pre-DevKit engine's API that did NOT
survive the port: `ctx.step("chunk-3", …)` let a caller pin identity to a
position, and nothing replaces it.

**That rule is a primitive now rather than a loop in a template.**
`mapInBatches` (`@alexkroman1/aai/utils`) IS those sequential batches, and its
module doc carries the argument above; a template that hand-rolls the loop is
restating a rule whose failure mode is a `ReplayDivergenceError` in production.
Note what makes passing a step to a helper legal at all — the WDK transform
rewrites a step's DECLARATION into a dispatcher rather than rewriting call
sites, so a `"use step"` function handed to another module as a callback still
dispatches a real step. That is a claim about the transform, so it is tested
against a real one: `aai-cli`'s `dev-workflow.integration.test.ts` fans a
fixture flow out through `mapInBatches` with steps that settle in reverse issue
order.

The fan-out's WIDTH is derived from a STEP'S RESULT (the parsed header), not
re-probed by the body — the ordinary determinism rule: a replay has to produce
the same list in the same order, and a URL whose content changed underneath the
run would otherwise hand the Nth journal entry to a different call.

**Its `client.tsx` is the form layer's worked example**, and the split with
`link-digest` is deliberate: that one shows the primitives raw (a hand-written
`<form>`, its own `useState`, one `createWorkflowApi()`), and this one shows the
same page with `useWorkflowSubmit` and `<Form>` over them. There is no field
markup in it at all — `<WorkflowFields>` renders a control per SCALAR property of
the workflow's own input schema, and this workflow's input is scalars all the way
down, so the URL box and the language picker exist because `agent.ts` declares
them and the `z.enum` is what makes the second a `<SelectField>`. See "Forms" in
`packages/aai-ui/CLAUDE.md` for the mixed case.

Its spec exercises the exported STEPS and the pure helpers directly rather than
the body, which is where the honest line is: imported through vitest with no
bundler in the path, a `"use step"` function is an ordinary async function and
its retries, its `FatalError` guards and its HTTP handling are all testable,
while durability, suspension and replay are not. The spec says so in place,
because a body test that looked like a durability test would be the worse
failure. The WAV half carries its own weight there: a cut that lands mid-frame,
or an off-by-one in the RIFF chunk walk, produces audio the decoder happily
transcribes into confident nonsense rather than anything that fails.

## Five templates are ports of LangChain/LangGraph agents

The reference agents people already know are the best starters this repo can
ship: an author arriving with a LangGraph mental model gets a working voice
version of the thing they have already read, and the DIFFERENCES are where the
voice-specific lessons live. Each port carries its attribution and a
their-name → our-name table in the module that holds the prompts, so nothing has
to be re-derived from memory.

| Source | Template | Front door | What the port had to change |
| --- | --- | --- | --- |
| `open_deep_research` | `research-desk` | voice, handing off to a run | a durable workflow, because five to twelve model calls cannot answer on the line (see above) |
| customer-support tutorial (Swiss Airlines) | `travel-concierge` | voice | the specialist's prompt becomes a tool RESULT; `interrupt_before` becomes a spoken confirmation |
| self-RAG + CRAG | `support-line` | voice | lexical retrieval instead of a vectorstore, and the graders are the thing that makes that fine |
| plan-and-execute | `plan-desk` | voice | the execute→replan loop is driven by the CALLER, one step per tool call |
| reflection (the essay assistant) | `redline` | **page over a durable run** (`workflowApp()`) | the loop's exit becomes a step's journaled VERDICT, so a replay takes the same branch |

**Which front door a port gets is decided by one question: can it answer
inside a turn?** A caller will hold the line for a tool call and a sentence
back; they
will not hold it for seven long-form model calls in sequence, and what a
reflection loop produces is a piece of prose to READ rather than two sentences
to hear. So `redline` is a workflow app, exactly like `transcription-desk`, and
the three above it are voice agents. Getting that wrong in either direction is
the expensive mistake: a voice agent that goes silent for ninety seconds, or a
page for work that a caller could simply have been told.

**`travel-concierge` — the two mechanisms, and the honest limit.** Their graph
gives each specialist node its own bound tool set and swaps the assistant's
prompt as `dialog_state` is pushed and popped. A voice session has ONE model
with ONE tool list and a system prompt fixed at connect, so the port splits the
difference: the stack is real state (`routing.ts`, projected to the sidebar), and
the specialist's brief arrives as the delegation tool's return value, which is
the last thing the model reads before it speaks. The narrowing is therefore
asked for rather than enforced, and `agent.ts` says so in place — do not "fix"
that by pretending otherwise.

The half that IS enforced is the confirmation gate, and it is the bit worth
copying into any agent that can spend someone's money. Every sensitive tool
STAGES a `PendingAction` and mutates nothing; `confirm_action` is the only code
path that applies one. That is `interrupt_before` with a better interface —
a caller cannot type "y", but asking out loud and hearing "yes" is the same
gate — and it is the reason `stageAction` is one helper rather than a pattern
each tool repeats: the next sensitive tool is otherwise the one that forgets.
Its spec asserts, per tool, that calling it changes nothing.

**`support-line` — the graders are the product.** Retrieval is idf-weighted term
overlap over `knowledge.json`, not embeddings, because the SDK has no vector
store; the argument in `shared.ts` is that this makes CRAG's corrective loop MORE
valuable rather than less, since a weaker retriever is exactly what its query
rewriter was designed for. The knowledge base is BAITED to prove it — "cancelling
your contract" and "cancelling an engineer visit" are two documents, two fees and
one word apart, and a spec pins that the neighbour ranks FIRST for a caller's
phrasing. Three decisions in the loop are not defaults:

- **An ungrounded answer is never spoken.** One regeneration, then the answer is
  withheld and the run ends `exhausted`. A grounded-but-not-useful answer, by
  contrast, IS returned, with its verdict, because it is still true.
- **`exhausted` is a reachable state with somewhere to go** — `log_ticket`. An
  agent that cannot say "I don't have that documented" will eventually say
  something worse, so the exit has to exist before the grading is worth anything.
- **There is no web-search fallback**, which CRAG has. A support line answering
  from the open web about a private product is the exact failure its grader
  exists to prevent; `plan-desk` is where real search lives.

**`plan-desk` — the loop belongs to the caller.** Their notebook runs
plan→execute→replan to completion and prints the answer. A phone line cannot go
quiet for ninety seconds, so one `work_next_step` call is exactly one
execute-then-replan turn: the desk reports, and the pause that creates is what
makes `revise_plan` reachable at all — a replanner driven by the person rather
than by a step result, which their version has no way to express. Two more
things are decisions:

- **`Act = Union[Response, Plan]` became one discriminated object.** A union is
  `anyOf` in JSON Schema and provider support for it varies; a model that emits
  `{"steps": …}` when it meant to respond leaves a plan looping forever.
  `normalizeAct` then treats every malformed act as an ANSWER, because a desk
  that never stops is the failure that matters on a call.
- **The search is real and therefore injected.** `executeStep` takes a
  `SearchFn`; the tool passes `liveSearch` (`webSearch`, DuckDuckGo-backed, no
  key) and the spec passes its own. A template spec that depended on the live web
  would be a flake with a stranger's rate limit attached.

**`redline` — a loop whose exit is data, and the mixed form.** Two things in it
are worth reading for, and neither exists elsewhere in `templates/`:

- **The `while` is legal because the verdict is journaled.** `transcription-desk`
  derives its fan-out's WIDTH from a step's result; this derives a LOOP EXIT from
  one. `critiqueDraft` returns `ship` or `revise`, the body breaks on it, and a
  replay reads that verdict back out of the journal and takes the same branch —
  where a clock, a random draw or a re-read of anything outside the run would let
  a replay diverge into a `ReplayDivergenceError`. Their `should_continue` stops
  on a message COUNT, which spends the same money on a draft that was already
  good; letting the critic stop the loop is the one real addition, and it is
  possible only because the decision is a step result.
- **Its page is the MIXED form**, which the guide has described for a while with
  no template behind it. `<WorkflowFields>` renders the three scalars (the
  `z.enum` becoming a `<SelectField>` is the schema doing the work), and
  `mustCover` is an ARRAY, which it deliberately renders nothing for — so
  `client.tsx` writes that one field itself in the same `<Form>` and maps the
  textarea into `string[]` in one exported function. `transcription-desk` stays
  the all-declared example.

One smaller thing it settles: neither writer step carries an empty-reply guard,
because `stepGenerate` already refuses an empty completion as a RETRYABLE
failure. The first draft of the template had both, and both were dead code
re-deriving an SDK decision — worth checking for before adding a guard to a step.

Both LLM-driven VOICE ports are tested by SCRIPTING `ctx.generate` on the
system prompt each node carries — the fake switches on `options.system` and
records the
transcript, so what a spec asserts is WHICH NODES RAN, which is the part of a
graph port that can actually regress. One mechanical note for the next one:
`GenerateFn`'s schema overload declares `object` as required, so every branch of
such a fake must return one (`object: null` on the text-only nodes) or the whole
function is unassignable.

## `recap-desk` is where the Temporal patterns were ported

The same idea as the LangChain ports above, from the other tradition — and the
one template whose SUBJECT is the patterns rather than the work. It is
`research-desk`'s shape (a voice agent whose tool hands off to a run) carrying
the Temporal TypeScript samples that survive translation to this engine, each
against real I/O. Both files carry the mapping table; this is the summary and
the rationale for the two judgement calls in it.

| Temporal sample | Ported as |
| --- | --- |
| `saga` (`openAccount`) | `recapFlow`'s compensation stack, unwound by `compensate` |
| `polling` (infrequent) | `awaitTranscript` — one step plus one durable `sleep`, bounded by attempts |
| `timer-examples` (`processOrderWorkflow`) | the `Promise.race` against `PATIENCE`, then the "still going" note |
| `expense` (`timeoutOrUserAction`) | the RETENTION GATE: a hook raced against a `sleep`, three outcomes, safe default |
| `signals-queries` (Signal) | `keep_transcript`, answering that gate over `ctx.workflows.signal` |
| `signals-queries` (Query + Cancellation) | `recap_status` and `cancel_recap` |
| workflow-id reuse / `mutex` | the live-run check in `request_recap` |

**The subject is real because the provider's BATCH API is real.** A polling port
needs something that genuinely takes minutes, and `POST /v2/transcript` answers
with a job id in milliseconds and finishes later — so the wait belongs to the
provider rather than to a `setTimeout` the template chose. The compensation is
the same argument: `DELETE /v2/transcript/:id` really removes the transcript,
which is what makes "a failed run leaves nothing on the account" a claim rather
than a stub. That is the line this guide draws for `transcription-desk`'s
removed webhook demo, applied forwards — and it is also the split between the
two: `transcription-desk` takes the SYNC endpoint (answers in the request, hard
cap, therefore a fan-out), this one takes the batch endpoint (job id, therefore
a poll).

**A phone caller cannot read a URL aloud, so the desk supplies its own.**
`SAMPLE_RECORDING` is the provider's documented public sample, and it exists so
the template transcribes something on the first call instead of asking for input
the medium cannot carry. A real desk swaps it for a lookup against its own
recording store; the tool still accepts a URL when one is somehow available.

**This template is why the SDK grew `ctx.workflows.signal()`**, and that is the
argument for porting from another engine at all: `expense` is the most
voice-native sample Temporal ships — a run that waits for a person to say yes —
and writing it here found a hole rather than a workaround. The DevKit's only
reachable waitpoint was `createWebhook()`, whose URL is minted for a THIRD PARTY
with a callback to make; the caller is not that. `wakeUp` is not it either — it
ends a `sleep`, where a signal carries a payload, and a body that races a hook
against a `sleep` needs both and means different things by them. The method's
own doc carries the token rules; `workflows/tokens.ts` is this template's one
derivation of one, and the reason it is a shared function rather than a template
literal typed twice.

**One thing still does NOT port, and saying so is the point of having ported the
rest.** Cancellation is not cooperative: Temporal delivers cancellation INTO the
workflow, so the saga's `catch` runs and the compensations fire, while
`ctx.workflows.cancel` marks the run cancelled and stops replaying it — a
cancelled recap leaves its transcript behind. `cancel_recap` says that in its own
tool result rather than implying a rollback that does not happen, and its spec
pins the sentence. The gate is what a cooperative stop would be built from (a
hook the body races alongside its work, signalled instead of cancelled); the
template deliberately stops at ONE hook, because racing a stop into every wait is
a second lesson and would cost this one its shape.

Its spec runs three tiers and is explicit about which one proves what: the tools
against a stubbed `ctx.workflows`, the steps directly, and — new here — the
body's HELPERS (`awaitTranscript`, `compensate`, `askWhetherToKeep`) with `sleep`
and `createHook` stubbed via `importActual` plus two overrides. That third tier
asserts ORDERING and BRANCHING, which is ordinary logic worth pinning (the poll's
exit conditions, the unwind's direction, that a failing undo does not strand the
ones behind it, and the gate's three outcomes with its safe default), and asserts
nothing about durability. `recapFlow` itself is still not driven, for the reason
every other workflow template gives.

Two mechanical notes on stubbing a hook, both learned by getting them wrong. The
fake is built by hanging the hook's members on a REAL promise
(`Object.assign(settled, { token, getConflict, … })`) rather than by writing a
`then` property — a `Hook` IS a thenable, and a hand-written `then` is both a
biome finding (`noThenProperty`) and a worse model of the thing. And the
window's `sleep` must NOT resolve in the tests that exercise an answer: with both
settled, which one `Promise.race` picks comes down to microtask order rather than
to the branch under test, so the mocked `sleep` returns a never-resolving promise
except in the timeout case.

## A step can authenticate now, so no template's I/O is a fixture

This guide used to say the opposite, and it was the reason all three workflow
templates returned hard-coded strings: a `"use step"` function is bundled and
dispatched separately from the agent bundle and is handed no `ToolContext`, so
nothing in one could reach a credential. Two SDK exports close it, both on
`@alexkroman1/aai/utils`:

- **`stepEnv` / `requireStepEnv`** (`packages/aai/sdk/step-env.ts`) — the agent
  env, published into the process by whatever is serving the workflow (the guest
  at bundle load, `aai dev` on every rebuild). The slot is a `Symbol.for` global
  rather than a module-level `let` precisely because the step bundle carries its
  own copy of the SDK, so the publisher and the reader are two module instances.
  Two rules come with it: once an env is published there is no per-key fallback,
  so what a step can read is exactly what `.env` and `aai secret put` declare;
  and an UNPUBLISHED slot falls back to `process.env`, which is what keeps an
  exported step callable from a spec with `vi.stubEnv` — which is how every one
  of these templates tests its steps.
- **`stepGenerate`** (`packages/aai/sdk/step-generate.ts`) — `ctx.generate`'s
  counterpart for a step: one `fetch` to the AssemblyAI LLM Gateway, on the same
  key and the same default model an agent's own pipeline resolves. It exists
  because `research-desk` and `link-digest` had each hand-rolled the same forty
  lines and had already diverged on two of them (the empty-completion case, and
  which statuses are worth a retry). It is deliberately not the AI SDK: a step
  artifact bundles everything but the DevKit, so `ai` plus a provider would be
  megabytes on every deploy for one chat completion.

- **`stepGenerateJson`** (`packages/aai/sdk/step-generate-json.ts`) — the same
  call for a stage whose reply is a SHAPE, which is what both LLM templates
  actually wanted. It unwraps the ```` ```json ```` fence, parses, rejects a
  non-object and validates against a Standard Schema, and each of those four was
  re-derived per template — with the fence stripper already DIVERGED (one
  trimmed, one did not). Taking a schema is the point rather than a convenience:
  the predecessor was `askJson<Action>()`, a value the compiler believed and
  nothing checked, so a model answering with a plausible neighbouring shape
  flowed into the step's logic as if it had obeyed. It stays on the zod-free
  `/utils` because VALIDATION is a `~standard.validate` call and only JSON Schema
  CONVERSION needs zod — hence `sdk/standard-schema.ts`, the dependency-free half
  of `sdk/schema.ts`.

**The retry decision is `@alexkroman1/aai/step-errors`, and it is the one
subpath that reaches the DevKit.** `StepGenerateError.retryable` and
`isTransientStatus`/`retryAfter` are the SDK deciding; `FatalError` and
`RetryableError` are what the DevKit READS, and they belong to `workflow`, which
`/utils` may not import (the CLI's zero-dependency startup path). So the mapping
between them was left as a snippet in two module docs — and both templates that
needed it copied the snippet out of the doc, verbatim and character-identical.
`toStepError` / `throwStepError` / `throwFatalStepError` are that snippet, on a
subpath of their own so `workflow` is only in the graph of a caller that asked
for it (and a step artifact externalizes it anyway).

Three things the templates now demonstrate rather than restate:

- **`toStepError(response, message)`** — the three-way call `transcription-desk`
  and `link-digest` had hand-written identically. Note the third outcome is not
  "the DevKit's backoff": a bare `RetryableError` retries in ONE SECOND, which is
  that class's own default, so a fan-out that all 429s together all asks again a
  second later. Passing the far side's `Retry-After` is what drains it.
- **`toStepError` reads `StepGenerateError.retryAfter`, which THREE of the four
  templates did not.** `research-desk`, `link-digest` and `transcription-desk`
  re-threw the error unchanged, so a rate-limited model call fell back to the
  default with the gateway's own number sitting unread on it. `redline` is the
  exception and worked the extra line out independently — which is the argument
  for extracting rather than a reason not to: the fourth author to meet a
  problem should not have to be the first to get it right.
- **`throwFatalStepError` is for the `catch` block specifically**, and the
  reason is mechanical: `FatalError` takes only a message — no `cause` — so
  constructing one inside a `catch` trips `useErrorCause` with no way to satisfy
  it. Taking the cause as an ARGUMENT is what fixes that. A `throw new
  FatalError(…)` that is NOT in a catch block stays exactly as it was —
  `link-digest`'s no-readable-text case is the worked example, and says so in
  place.

**`ctx.db` is still out of reach**, so every `file` step still writes nothing and
carries `_`-prefixed parameters rather than naming a call it cannot make. That is
the one remaining half of a tool context a step does not get.

**`report()` was the one helper copied three times, and it is the SDK's now** —
`@alexkroman1/aai/utils`, used by every workflow template. The objection recorded
here (it imports `getWritable` from `workflow`, which that subpath may not) was
answered by the same `Symbol.for` slot `stepEnv` uses: `createServer` publishes
a reporter and the helper stays dependency-free. What forced the question was
not the duplication but the second reader — a step's narration now also reaches
the SERVER LOG, with the attempt number appended past the first, so a retrying
fan-out is legible without a page open. `packages/aai-ui/CLAUDE.md` carries the
argument.

The same sweep took two more copies with it: `isTransientStatus` (the
408/429/5xx split each template had spelled out) and `retryAfter`, which is what
lets a rate-limited step throw `RetryableError` with the delay the provider
asked for instead of the DevKit's default backoff. `transcription-desk` and
`link-digest` are the worked examples. Both are now reached THROUGH
`toStepError` above — the extraction that stopped one function short.

**And the fake LLM gateway is the SDK's too** — `stubGateway`
(`@alexkroman1/aai/testing`), which `research-desk` and `link-digest` had each
written: record the call, answer `{choices:[{message:{content}}]}`, switch on a
status. It returns a `fetch` rather than installing one, so the module keeps its
no-test-runner-dependency rule and the spec keeps control of the stub's lifetime;
what stays in each template is the three-line `vi.stubGlobal` wrapper, which is
the right half to leave behind. It records the `prompt` and `system` separately,
which is what the hand-rolled `promptOf(calls, n)` reach into
`body.messages[n].content` was for.

**`link-digest` is the same mechanism at its smallest, and it is the FRONT DOOR
that separates both of these from `research-desk`.** That one is a voice agent
that HANDS OFF to a run (a caller is on the line, so a tool starts one and
answers the turn); `link-digest` and `transcription-desk` are declared with
`workflowApp()` and the workflow IS the product — no `stt`/`llm`/`tts`, no
tools, and a `client.tsx` that mounts with `page()` rather than `client()`.
Those fields are not merely omitted there: `StaticAgentParams` refuses them, so
a `systemPrompt` addressed to a model that never runs — which `link-digest`
shipped — no longer type-checks.

**`link-digest` really reads the page too.** `fetchArticle` fetches the URL and
reduces the HTML to text — crudely, on purpose, since a real extractor is a
readability implementation and a dependency; what it MUST do is drop `<script>`
and `<style>` CONTENT rather than just their tags, because stripping tags alone
leaves a page's JavaScript in the prompt, which is both expensive and a way to
smuggle instructions past the reader. `summarize` then asks for JSON and
validates the shape, and a reply that ignored the format throws PLAINLY where a
401 is fatal — a model may well obey on the next attempt.

The two steps are split because they fail differently: a rate-limited model call
replays the fetch from the journal instead of hammering a stranger's server
again. That is also why the article text is CAPPED — it is the rare case where
the payload really does have to cross the queue.

`link-digest`'s spec asserts the DECLARATION as well as those steps, and the
declaration half is what carries the template's shape: the `page` field, the
workflow's NAME (the page starts a run by that string, so a rename is a runtime
400 rather than a compile error), the input schema (both the call-site validation
and the JSON Schema `GET /workflows` serves), and `requiredEnv` — which is
load-bearing here in a way it is not for a voice agent, since a workflow app
declares no providers and so nothing else in its config names a credential.

**`template-page-mount.test.ts` correlates BOTH ends of the front door with the
agent that declares it** — the helper (`agent()` vs `workflowApp()`) and the
mount (`client()` vs `page()`). konsistent asserts only what every template
shares (a default export from `agent.ts`, the stylesheet import in
`client.tsx`): its predicates are "must import X" with no "one of", and no way
to read a value out of a SIBLING file to decide which — and a rule that merely
accepted either would pass the exact mistake worth catching, since a static
agent mounted with `client()` renders fine and then opens a `/websocket` the
server declines. `agent-default-export` used to require an `agent` import for
that reason and no longer can, the workflow-app templates calling `workflowApp`
instead.

The one thing a template may still hand-roll here is a **fallback that would
cost the browser bundle**: `retail`'s client builds its empty view from a
seedless `emptyRetailState()` instead of `retailSlot.projection(storeView)
(undefined)`, because the slot's factory pulls a 107 KB `seed.json` and
importing it would ship the whole catalog to the browser. It says so in place.

**There is deliberately no TEXT-mode template, and the allowlist records
it.** A template is a starter the platform DEPLOYS — `templates.test.ts` loads
each `agent.ts` and validates the config a voice session is built from, and the
studio's `use_template` copies one into a workspace that gets deployed next.
`agent({ text: true })` has no session to deploy (`createRuntime` refuses it by
name), so a text template would be a starter nothing downstream can run.
`TextAgentParams` therefore sits in `template-api-allowlist.json` beside
`PipelineAgentParams` and `S2sAgentParams`, which are unexercised for a
narrower reason — they are the union arms `agent()` derives from, and an author
never names one. `createTextAgent`'s worked example is the studio's own coding
agent (`packages/aai-guest/CLAUDE.md`), which is a better one than a template
could be: it is a real agent doing real work, on the same SDK it builds with.

## What `tsconfig.json` includes is what gets type-checked

A test file is imported by nothing, so tsc only sees it if `include` names
it — a package guide's worth of files can be silently unchecked. This one had
three: `escape-hatch-scope.test.ts`, `template-api-coverage.test.ts` and
`test-assertion-gate.test.ts` were listed nowhere and type-checked by nothing,
under a comment that describes exactly that failure mode. `include` now globs
`*.ts` (this directory only — `scaffold/` is checked separately by
`check:template-types`, under the scaffold's own looser tsconfig). Verify with
`tsc --noEmit --listFiles`, which prints the program's real file list, or by
injecting a type error into a file you expect to be covered.

## Self-hosting is the scaffold's default

`scaffold/server.mjs` plus `"start": "node server.mjs"` ship in every project,
so **any** project runs on its own with `npm start`: no CLI at run time, no
bundler, no platform account. It is deliberately a FILE rather than a CLI
command — a command is something you have to know exists, and the whole gap it
closes was that `createAgentServer` already made self-hosting one call and
nothing put that call in front of anyone. `aai eject` (see
`packages/aai-cli/CLAUDE.md`) copies this same file into projects that predate
it; that command must never grow its own copy of the contents.

Three things in it are load-bearing, and all three were found by running it:

- **The agent is imported DYNAMICALLY.** Static `import` statements are hoisted
  and evaluated before any statement in the file, so an
  `import agent from "./agent.ts"` at the top would load the agent — and every
  `?raw` import inside it — before `registerHooks` had run.
- **It registers module hooks for `?raw` and attribute-less `.json`.** Those
  are bundler conventions Node does not implement: `?raw` is a Vite thing (Node
  looks for a file literally named `system-prompt.md?raw`) and a bare JSON
  import needs `with { type: "json" }` (TypeScript's `resolveJsonModule` does
  not). Nine templates import `./system-prompt.md?raw` and `retail/store.ts`
  imports `./seed.json` bare, so without the hooks `npm start` worked for four
  templates out of fourteen. An import that DOES carry the attribute is passed
  to Node, whose own handling is correct. **`.ts` needs no hook** — Node strips
  the types itself, which is why there is no build step and no second copy of
  the agent in JavaScript.
- **`ctx.env` and provider credentials come from different places, on purpose.**
  `env` is declared keys only (`.env`, plus `.env.example` as a declaration so a
  container with no `.env` still works, with real environment variables winning
  per key) — the same rule `aai dev` follows, so an agent cannot come to depend
  on a `PATH`-style variable that will not exist after deploy. Provider
  credentials go through `withHostCredentialFallback`, which is what lets
  `docker run -e ASSEMBLYAI_API_KEY=…` work without the key becoming `ctx.env`.
  An empty declared value is DROPPED rather than passed through: a provider
  would authenticate with `""` instead of reporting the credential absent, and
  `.env.example` is full of empty values by design.

`packages/aai-cli/e2e.test.ts` boots `npm start` against a real installed
project (`math-buddy`, chosen for its `?raw` import) and probes
`/health`, `/client-config` and `/`. That tier is the only one that can prove
it: the entrypoint resolves `@alexkroman1/aai-ui`'s prebuilt client through a
real INSTALL and imports `agent.ts` through Node's own type stripping, neither
of which an in-tree test exercises.
