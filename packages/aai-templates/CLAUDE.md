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
| `ToolFailure` / `isToolFailure` | `retail` (~40 sites, failures propagating through `store.ts` helpers), `dispatch-center` (six) |
| `pushCapped` | `dispatch-center` (incident timeline), `retail` (activity feed), `solo-rpg` (session log), `infocom-adventure` (command history) |
| `createToolContext` (`@alexkroman1/aai/testing`) | the four suites that test tools directly — `dispatch-center`, `pizza-ordering`, `retail`, `solo-rpg` |
| `useAgentState(fallback)` | `pizza-ordering`, `dispatch-center`, `retail`, `solo-rpg` |
| `AutoScroll` | the three custom-chrome clients — `dispatch-center`, `retail`, `infocom-adventure` |
| `workflow()` + `ctx.workflows` + `isTerminal` | `research-desk` — the handoff: a VOICE template whose tool starts a run, correlates it with `key`, and reads it back (see below) |
| `page()` + `createWorkflowApi` + `useWorkflowRun` | `link-digest` — the WORKFLOW APP with the primitives raw: a hand-written `<form>`, its own `useState`, one `createWorkflowApi()` |
| `Form` + `WorkflowFields` + `useWorkflowSubmit` | `transcription-desk` — the same front door with the form layer, plus `WorkflowOutputOf`. Its form is ALL declared, so `FileField` is exercised by no template and sits in the allowlist; the mixed case (declared scalars beside a hand-written control) is documented under "Forms" in `packages/aai-ui/CLAUDE.md` |
| `mapInBatches`, `stepEnv` / `requireStepEnv`, `stepGenerate` | the STEP surface, and all three workflow templates use it: `transcription-desk` fans its segments out and reads `ASSEMBLYAI_API_KEY` for the sync STT endpoint; `research-desk` and `link-digest` call the model with `stepGenerate`. Imported from `@alexkroman1/aai/utils`, NOT the root: a `workflows/*.ts` module is bundled separately by the WDK builder, so the root barrel's graph would ride into the step bundle. That import path is also why the coverage gate cannot see them — it scans the root specifier — hence their allowlist entries |

**`research-desk` is the workflow template, and its shape is dictated by the
Workflow DevKit rather than chosen.** The `"use workflow"` / `"use step"` bodies
live in `workflows/research.ts` because the WDK builder scans that directory at
build time and rewrites what it finds; a body written in `agent.ts` is never
transformed, so it runs inline once with no durability and nothing saying so.
`agent.ts` holds only the declaration (`workflow({ description, input, run })`)
and the two tools that start and read runs.

**Its research is real**: `planAngles` asks the model for the angles worth
pursuing, `investigate` runs one step per angle through `mapInBatches`, and
`synthesize` reduces the notes to something a voice agent can read aloud — three
model calls deep, which is what makes it too slow to answer on the line and
therefore worth a durable run at all. The fan-out's WIDTH comes from a step's
journaled result rather than from anything the body computes, which is the
ordinary determinism rule.

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

**`StepGenerateError.retryable` is where the SDK stops and the template
decides.** The DevKit retries a step that throws, so a caller has to choose
between letting it (a rate limit, a 5xx) and refusing (a bad key, a rejected
request) — and `FatalError` belongs to `workflow`, which the SDK cannot import
onto the CLI's startup path. Both LLM templates therefore carry the same
three-line `stopOrRetry`, and it is a plain function rather than a `throw` inside
a `catch` for a mechanical reason worth knowing: `FatalError` takes only a
message, so constructing one in a catch block trips `useErrorCause` with no way
to satisfy it.

**`ctx.db` is still out of reach**, so every `file` step still writes nothing and
carries `_`-prefixed parameters rather than naming a call it cannot make. That is
the one remaining half of a tool context a step does not get.

**`report()` was the one helper copied three times, and it is the SDK's now** —
`@alexkroman1/aai/utils`, used by all three templates. The objection recorded
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
`link-digest` are the worked examples.

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
