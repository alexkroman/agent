<!-- A SIBLING of packages/aai-templates/CLAUDE.md, read on demand: the guide is
at its 120,000-character cap, and this is the reference account behind its
section "A step can authenticate now, so no template's I/O is a fixture" —
which keeps the rule (the three `/step` exports and the retry vocabulary) and
points here for the argument and the measurements. -->

# A step can authenticate now — the account

## Which duplication each export replaced

This guide used to say the opposite, and it was the reason all three workflow
templates returned hard-coded strings: a step body is handed no `ToolContext`,
so nothing in one could reach a credential. Three exports on
`@alexkroman1/aai/step` close it, and each module's own doc carries its
mechanism — what belongs here is which duplication it replaced:

- **`stepEnv` / `requireStepEnv`** — the agent env, published into the process
  by whatever is serving the workflow. An UNPUBLISHED slot falls back to
  `process.env`, which is what keeps an exported step callable from a spec with
  `vi.stubEnv`; that is how every one of these templates tests its steps.
- **`stepGenerate`** — `research-workflow` and `link-digest` had each hand-rolled
  the same forty lines and had already diverged on two of them (the
  empty-completion case, and which statuses are worth a retry).
- **`stepGenerateJson`** — the same call for a stage whose reply is a SHAPE, with
  the fence stripper, the parse, the non-object rejection and the Standard Schema
  validation each re-derived per template, the stripper already DIVERGED (one
  trimmed, one did not). Taking a schema is the point rather than a convenience:
  the predecessor was `askJson<Action>()`, a value the compiler believed and
  nothing checked, so a model answering with a plausible neighbouring shape
  flowed into the step's logic as if it had obeyed.

**The retry decision is `@alexkroman1/aai/step-errors`, and it is the subpath
that owns the retry VOCABULARY.** `StepGenerateError.retryable` and
`isTransientStatus`/`retryAfter` are the SDK deciding; `FatalError` and
`RetryableError` are what the engine READS. Both classes used to be the Workflow
DevKit's, imported from `workflow` — which `/utils` may not, being the CLI's
zero-dependency startup path — so the mapping between them lived as a snippet in
two module docs that both templates copied out verbatim.
`toStepError` / `throwStepError` / `throwFatalStepError` are that snippet, and
the classes are ours now (`sdk/step-error-classes.ts`).

Three things the templates now demonstrate rather than restate:

- **`toStepError(response, message)`** — the three-way call `transcription-workflow`
  and `link-digest` had hand-written identically. Note the third outcome is not
  "the engine's backoff": a bare `RetryableError` retries in ONE SECOND, which is
  that class's own default (`DEFAULT_RETRY_DELAY_MS`), so a fan-out that all 429s
  together all asks again a second later. Passing the far side's `Retry-After`
  is what drains it.
- **`toStepError` reads `StepGenerateError.retryAfter`, which THREE of the four
  templates did not.** `research-workflow`, `link-digest` and `transcription-workflow`
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

**There is no `ctx.db` at all now** — removed outright, not withheld from steps
— so every `file` step still writes nothing and carries `_`-prefixed parameters
rather than naming a call it cannot make.

**`stepReport()` was the one helper copied three times, and it is the SDK's
now** — `@alexkroman1/aai/step`, used by every workflow template. The objection
recorded here (it needed a writable stream out of the workflow engine, which
that subpath may not import) was answered by the same `Symbol.for` slot
`stepEnv` uses: `createRuntimeServer` publishes a reporter and the helper stays
dependency-free. What forced the question was not the duplication but the second
reader — a step's narration now also reaches the SERVER LOG, with the attempt
number appended past the first, so a retrying fan-out is legible without a page
open. `packages/aai-ui/CLAUDE.md` carries the argument.

The same sweep took two more copies with it: `isTransientStatus` (the
408/429/5xx split each template had spelled out) and `retryAfter`, which is what
lets a rate-limited step throw `RetryableError` with the delay the provider
asked for instead of that class's one-second default. `transcription-workflow` and
`link-digest` are the worked examples. Both are now reached THROUGH
`toStepError` above — the extraction that stopped one function short.

**And the fake LLM gateway is the SDK's too** — `stubGateway`
(`@alexkroman1/aai/testing`), which `research-workflow` and `link-digest` had each
written: record the call, answer `{choices:[{message:{content}}]}`, switch on a
status. It records the `prompt` and `system` separately, which is what the
hand-rolled `promptOf(calls, n)` reach into `body.messages[n].content` was for.

**The INSTALLATION came out too.** This guide used to call the three-line
`vi.stubGlobal` wrapper "the right half to leave behind", on the rule that
`sdk/testing.ts` carries no test-runner dependency — and four templates then
wrote that wrapper, each with the same paragraph explaining why the SDK had not.
`installStubGateway` is on **`@alexkroman1/aai/testing/vitest`**, where `vitest`
is an OPTIONAL peer. The rule that replaced the precedent — anything that
INSTALLS or RESTORES belongs on that subpath — is in the root `AGENTS.md`.

**`link-digest` is the same mechanism at its smallest, and it is the FRONT DOOR
that separates both of these from `research-workflow`.** That one is a voice agent
that HANDS OFF to a run (a caller is on the line, so a tool starts one and
answers the turn); `link-digest` and `transcription-workflow` are declared with
`workflowApp()` and the workflow IS the product — no `stt`/`llm`/`tts`, no
tools, and a `client.tsx` that mounts with `mountPage()` rather than `mountClient()`.
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
mount (`mountClient()` vs `mountPage()`). This is the one front-door claim
konsistent cannot make: its predicates are "must import X" with no "one of", and
no way to read a value out of a SIBLING file to decide which — and a rule that
merely accepted either would pass the exact mistake worth catching, since a
static agent mounted with `mountClient()` renders fine and then opens a
`/websocket` the server declines. `agent-default-export` used to require an
`agent` import for that reason and no longer can, the workflow-app templates
calling `workflowApp` instead.

**konsistent's version is pinned EXACTLY (`1.0.0-beta.4`, the registry's
`latest`) rather than caret-ranged**, and this is where that note lives because
the root guide is at its character cap. A `^` range over a prerelease drifts
onto `1.0.0-beta.6`, which renames the predicates (`export` → `exportValues`,
`import` → `importValues`, `importFrom` → `importValuesFrom`) — so a floating
range turns every convention in `konsistent.json` into a schema error at
install time. Read the predicate catalog from `node_modules/konsistent/docs/`,
not the GitHub README, until that pin moves; the two disagree.

**A `tools/` file IS the tool: it default-exports it, nothing imports it, and
`agent()` takes no `tools` field at all.** Discovery happens where
the bundle is assembled (`aai-cli/worker-bundler.ts` enumerates `tools/*.ts` and
emits static imports), because the guest sandbox is handed one ESM string and has
no directory to scan — the same lowering eve does. `toolRegistry` /`withTools`
(`@alexkroman1/aai/manifest`) own the rules, so the name grammar, the
default-export requirement, the flat-only rule and a duplicate name are one
implementation and each is a build error naming the file.

**All thirteen tool-declaring templates are files now, and the param is GONE.**
For a while six were not — `health-assistant`, `embedded-assets`,
`infocom-adventure`, `night-owl`, `recap-workflow` and `research-workflow`
declared theirs
inline, and this guide's own measurement missed them because it counted only the
templates that already had a `tools/` directory. That is what made the rule
conventional: `agent({ tools })` still worked, so "a tool is a file" was true of
seven templates and of nothing enforcing it. `tools` is now the
`InlineToolsMisuse` message on the parameter shape (a compile error naming the
file to create) AND a throw inside `agent()` — the second half is not belt-and-braces,
it is the only half a user's project ever runs, since neither bundler
type-checks user code.

Three things the conversion taught, each worth copying into the next one:

- **A slot-backed tool gets SHORTER in its own file.** A standalone tool file
  cannot annotate its context with a state shape, which is why session state
  belongs to the SLOT — so `infocom-adventure`'s eight tools are
  `gameSlot.tool()`/`gameSlot.updateTool()` calls with no annotation and no
  opening `slot.get`. That is the case those two were built for, and moving a
  tool out of `agent.ts` is what makes it visible.
- **Module state shared by two tools needs a module** — `health-assistant`'s
  `fda.ts` says so in place, and `konsistent.json`'s
  `template-tool-owns-no-sibling` is why reaching it through the other tool FILE
  is the version that goes wrong quietly.
- **A workflow DECLARATION needs a home that is neither half.** `research-workflow`
  and `recap-workflow` reach a run by passing the definition rather than its name
  (which is what types the input), and four or five tool files each name it, so
  `workflow({ … })` moved from `agent.ts` into `shared.ts`. The BODY stays in
  `workflows/` by convention, so a spec can import the steps without the agent.

It replaced 62 map entries whose whole content was
`snake_case_name: camelCaseImport`; `konsistent.json`'s
`template-tools-not-imported` is the no-importer half of the rule and carries
why the line count was never the reason.

**A spec has no bundler in its path, so the same lowering has to happen
somewhere else** — over the same `toolRegistry`, from the same
`import.meta.glob`. Under vitest it happens in the PLUGIN: `aaiAgentPlugin()`
(`@alexkroman1/aai/testing/vite`, registered in this package's
`vitest.config.ts` and in every scaffolded project's) expands the glob against
the importing spec's own directory and serves the result, so each affected
template's spec is one import:

```ts no-check
// `no-check`: `virtual:aai/agent` is an ambient module the scaffold's
// global.d.ts declares — it resolves in a template, not in a doc example.
import agentDef from "virtual:aai/agent";
```

`retail`'s `registry.test.ts` is the one template that still writes the lowering
out, with **`deployedAgent`** (`@alexkroman1/aai/testing`) over its own glob and
a `?raw` read of `system-prompt.md`. That is deliberate: the tool registry is
that file's subject, and it is the worked example for a project whose runner
cannot register a Vite plugin. **`withDiscoveredTools`, the tools-only half this
section used to name, is not exported** — a spec that lowered the tools and
forgot the prompt measured the framework default and reported green, so the two
halves are one call now.

**The glob belongs to the importing file rather than to a shared helper, and
that is the whole lesson of the bug it replaced.** Five specs imported
`../../_discovery.ts` — this package's own helper — which resolves in-tree
and **does not exist in a scaffolded project**, so `aai test`, `aai build` (it
type-checks) and `npm start` were all broken for anyone who scaffolded
`pizza-ordering`, `plan-and-execute`, `retail`, `support-line` or `travel-concierge`,
while `check:template-types`, `templates.test.ts` and each template's own spec
stayed green — every gate in the repo runs IN the repo. `guard-invariants.mjs`
**rule 13** closes it: a template file may not import a path that escapes its own
template directory, resolved rather than pattern-matched (`../shared.ts` from
`tools/a.ts` is fine, `../../shared.ts` from the same file is not, and both spell
the same number of dots as a legal import one level up). Anything shared has to
be IN the template or on a published subpath.

`_discovery.ts` survives for `templates.test.ts` alone, which needs every
template at once and so needs a repo-wide literal pattern — `import.meta.glob`
is expanded at transform time and cannot take a variable. That file never ships,
so it is the one place the helper shape is still right.

It is deliberately not a `readdir` + `import()` either way — that would load the
tools through NODE's resolver instead of the test runner's, giving them a second
copy of the SDK, so a slot's module state would differ between the tool under
test and the agent holding it.

**Those are the only two ways in, and there are exactly two.** The other loader
with no bundler was `scaffold/server.mjs`, which now boots the BUILT worker — so
every path to a tool goes through a bundler or through a glob, and there is no
runtime directory scan in the repo (see "Self-hosting is the scaffold's default"
below).

Note what this DROPS: a `tools:` map checked each tool's assignability against
the agent's state type, so a tool whose state shape disagreed was a compile error
at the map. `toolRegistry` checks shape at build time and no state type at all —
the slot is what carries that guarantee now, which is most of why `sessionSlot()`
exists, and there is no per-agent state type left for a map to have checked.

The one thing a template may still hand-roll here is a **fallback that would
cost the browser bundle**: `retail`'s client builds its empty view from a
seedless `emptyRetailState()` rather than from the projection, because the
slot's factory pulls a 107 KB `seed.json` and importing it would ship the whole
catalog to the browser. It says so in place.

That is now the ONE exception to the rule the other six follow: **compose the
projection in the module that declares the slot, and import it at both ends** —
`syncState: cartProjection` on the agent, `useAgentState(cartProjection)` in
the client. It used to be composed twice, once per end, with the client
deriving its empty frame by calling it with `undefined` and restating the view's
type a third time on the hook. Nothing checked that the two compositions named
the same view. Note the LINE COUNT barely moved (measured: net +4 code lines
across the six, most of that a Biome import reflow) — this is a
single-source-of-truth change and a memoization fix, not a volume one, which is
the honest shape of most remaining wins at this seam.
