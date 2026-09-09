# packages/aai-guest — testing the studio coding agent

How the studio's coding agent is tested, all five tiers of it. A SIBLING of
`packages/aai-guest/CLAUDE.md` rather than a second package guide: Claude Code
auto-loads only `CLAUDE.md`, and this is REFERENCE — read once you are already
writing or reading a test for this agent, never something an agent needs
resident to act at all. The guide's own "The coding agent is an ordinary
`agent()`" section is what you want first; this is the layer above it.

It is here because that guide reached 95% of the 120,000-character cap with
these two sections in it. Repo-wide conventions and the tier table live in the
root `AGENTS.md`; `packages/aai-guest/CLAUDE.md`'s "Testing this package"
still owns `_test-utils.ts`, the tier violations and the scenario-tier split.

## The coding agent is tested at the AGENT level too

Three suites tested the coding agent from both ends and nothing in the middle,
which is the gap `studio-agent-turns.test.ts` closes with the SDK's own
framework — `runTextAgent` + `scriptedTextModel`
(`@alexkroman1/aai-runtime/testing`):

| | what it drives |
| --- | --- |
| `studio-agent.test.ts` | what the DEFINITION declares |
| `studio-tools.test.ts` | the studio's own half of the tool set through `runTool` — the syntax gate, the post-write diagnostics, the scrubbed `bash` env, `test_agent`. The nine workspace tools are the SDK's and are covered there (`coding-tools.test.ts`) |
| `studio-chat.scenario.test.ts` | the HTTP SURFACE, over a real port and real disk |
| **`studio-agent-turns.test.ts`** | **one TURN of `createTextAgent` over the real definition** |
| `studio-agent.eval.test.ts` | a LIVE model over a real workspace |

**`runTextAgent` had no caller in the repo before this**, and the coding agent
is the only text agent there is — its own doc says it "builds a fresh text agent
per call and mandates a script", which "is right for a SPEC: one turn, no
carry-over, the provider socket the only fake". What the middle row owns is the
loop: argument coercion, Standard Schema validation, the `ctx` a tool is handed,
the reserved final-answer step, and the event stream. Four claims, and two of
them could not be made anywhere else:

- **The step budget reserves a final ANSWERING step, tools off.** The one
  behaviour that CHANGED when this agent moved onto the SDK, and nothing pinned
  it for this definition: with `maxSteps: 1` and a script that would keep
  calling tools, the turn runs TWO steps and the second one speaks. Before, a
  capped turn ended wherever the budget ran out — including straight after a
  tool result with nothing said — and it ended *successfully*, so the user saw
  the agent simply stop.
- **A turn is a `SessionEvent` stream the eval readers take unchanged**
  (`toolCallsInEvents`, `saidIn`, one terminator). That bridge is what makes
  the eval file possible at all, and it is now asserted against a script — no
  key, no model, no tokens — rather than only where finding out costs money.
- An argument the schema rejects reaches the model as a REPAIRABLE result rather
  than killing the turn, which matters here rather than theoretically: the
  studio's model regularly emits a whole source file inside a JSON string.
- The tool the model chose runs through the real executor and its result is what
  the next step reads.

**It stays in the UNIT tier by choice of TOOL.** `todo_write` is the one studio
tool that closes over nothing and touches no disk, so every claim is made in
memory and the session fixture points at a path that does not exist —
`createStudioAgent` performs no I/O, and a real directory there would invite a
disk-touching claim into a 5s budget. A turn that writes files belongs to the
scenario tier, where `studio-chat.scenario.test.ts` already drives one.

**And the definition now makes the claim every shipped template opens with**:
`expectDeployable` (`@alexkroman1/aai/testing`) in `studio-agent.test.ts`. It
runs `toAgentConfig` — the conversion `aai build` runs — and asserts per derived
MODE; for a text agent that is "no audio path", which is the one worth having,
because this is the repo's only definition assembled in CODE rather than
authored in an `agent.ts`. A `voice:` or an `stt` added here has no author
reviewing an agent file, and `createTextAgent` would accept the def anyway,
leaving a config carrying a stage text mode cannot use.

That test also pins an asymmetry that is surprising enough to have cost a
wrong assertion while it was being written: **the conversion carries
`builtinTools` and NOT the nineteen declared tools.** There is no `toolSchemas`
on the config — a tool registry is extracted where the bundle is assembled —
which is exactly why `test_agent` reports its tool list off the loaded bundle's
own `__aaiConfig` rather than off anything reachable from this definition.

## The coding agent has an eval of its own

`studio-agent.eval.test.ts` + `_studio-eval-harness.ts`. Nine cases that drive
`createStudioAgent` over a REAL workspace and ask the question none of this
package's other suites can: given this instruction and this tree, did the agent
reach for the right tool, in the right order, and leave something that
compiles. `studio-agent.test.ts` asserts what the definition DECLARES,
`studio-tools.test.ts` drives each tool directly, `studio-chat.scenario.test.ts`
drives the HTTP surface with a scripted model — all three are about parts, and
the whole was unmeasured on this side of the boundary.

**It is the templates' eval suite, not a second one.** Everything above the
model comes from `@alexkroman1/aai-runtime/eval`, the subpath the twenty-five
shipped template evals drive: `openEvalTextAgent` for the conversation,
`EvalTurn` for a turn, `turnCalling` / `toolNames` / `describeTurn` for the
claims, `resolveEvalMode` for the credential gate and `installStubLlm` for the
scripted fallback. Tier membership is the `.eval.` infix, so `test:eval` selects
it and the unit config excludes it, exactly as `.scenario.` works one tier down.

**`describeEval` itself is the one piece that could not be reused, and it is
structural.** That function stands up `openEvalSession` → `createRuntime`,
which REFUSES `text: true` by name — a text agent fills no pipeline stages, so
there is nothing for the fake speech pair to stand between. `openEvalTextAgent`
is the sibling harness for exactly that, and its module doc names where the
announce then belongs ("`describeEval` for a template, `_gate.ts` for
`aai-evals`"); `describeStudioEval` is that third owner and adds only per-case
lifetime.

**Why here and not in `aai-evals`.** That package's guide argued it before this
existed ("A SECOND, in-process studio eval belongs in `aai-guest`, not here"):
`createStudioAgent` returns a plain `AgentDef` with `text: true`, which is what
`openEvalTextAgent` takes — but `StudioSession` carries a real workspace `dir`
and `StudioAgentDeps` is `HarnessBundleAccess & { typecheck }`, all of which
live here, and `evals-package-boundary` denies that package this one by name.

**It replaces nothing.** The HTTP starter eval in `aai-evals` measures the
DEPLOYED path — the broker, the per-sandbox token, the guest chat route, the
end-of-turn workspace sync — which is precisely where the harness it replaced
had rotted (`run.mjs` sent the account key and got a 401, so it could not have
run at all). This one measures the agent. Keep both; convert neither.

### What is real in a case, and the one thing that is not

Real: `initStudioSession` (so the tree is materialized, completed by
`ensureProjectShape`, and its declared dependencies reified), the four tool
families and three web builtins, the SDK's tool executor with its `ctx` and the
120s `STUDIO_TOOL_TIMEOUT_MS`, the reserved final-answer step,
`typecheckWorkspaceDir` behind the post-write diagnostics, `HARD_TURN_MS` as the
turn deadline, and `test_agent`'s real build → bundle load → trial.

**Not real: the system prompt**, and this is the honest limit of an eval on this
side of the boundary. The shipped one is `studioSystemPrompt(kind)` in
`packages/aai-studio-server/src/prompts/`, which `guest-package-boundary` denies
this package — correctly, since the guest must not link against the host. A case
runs on `STUDIO_EVAL_PROMPT` plus the real, guest-owned
`toolchainPromptSection()` that `initStudioSession` appends. So these cases
adjudicate the tool set, the tool DESCRIPTIONS, each tool's own result prose and
the model; the studio's prompt is graded by the HTTP starter eval and by nothing
here, and **no result from this file may be reported as covering it.**

`STUDIO_EVAL_PROMPT` is deliberately thin in one direction: it says nothing that
would pre-answer a case. A base prompt telling the agent to copy templates
verbatim, or not to delete a failing spec, would turn the corresponding case
into a measurement of that constant. Those instructions belong to the guest's
own surfaces, which are the thing under eval — and the template one really is
there, in `toolchainPromptSection()`, which is what makes that case fair.

Also absent: `studio-chat.ts`'s turn shaping — the wall-clock `stopWhen`,
compaction's `prepareStep`, the mid-turn checkpoints and the end-of-turn sync.
Those belong to the HTTP surface and `studio-chat.scenario.test.ts` exercises
them.

### GROUND TRUTH is what makes these cases worth running

Four of the nine end by asking the workspace rather than the transcript:
`ctx.typecheck()` runs the same compiler the post-write diagnostics run, and
`ctx.runTests()` runs the workspace's own specs the way `test_agent` does —
both called by the CASE, so the claim is about the tree on disk and not about
what a tool result said about it. **That is the one class of assertion a model
cannot satisfy with prose**, and it is why "adds what it was asked for" is a
real case rather than a keyword search over the reply.

The corollary is the repair loop, which is asserted per OCCURRENCE: every write
whose result carried `Type errors after writing <file>` must be followed by
another write to that same file. Vacuous when nothing came back red — correctly,
because the ground-truth typecheck already covers the agent that got it right
first time. Two claims sharpened the same way rather than judging prose: the
template case compares agent.ts BYTE FOR BYTE against the shipped template (a
retyped file passes every structural check the starter eval makes and is a
different file), and the failing-spec case requires `agent.test.ts` to be
unchanged byte for byte, because editing the assertion to match the code makes
the tests pass while destroying the only record of what was wanted.

### Five cases are live, four are scripted, and the split is not about cost

The four scripted ones are REFUSALS, and a refusal can only be observed if
something calls the refused thing: a competent model does not write unparsable
TypeScript, address a path outside its workspace, or ask for a template that
does not exist. That is the same three-case need `EvalCaseOptions.scripted`
records upstream, arriving here by the same route — each one cost a red live run
and got weakened before the marker existed. What they grade is the guest's
ANSWER: whether the sentence the tool sends back is one a model can act on (the
syntax rejection has to say nothing was saved, not to run `test_agent` first,
and to stop over-escaping; an unknown template has to list the real names).

**The harness has a spec of its own** (`_studio-eval-harness.test.ts`), which
`check:module-tests` obliges and which turns out to be the right place for the
one regression nothing else could catch: it asserts that `STUDIO_EVAL_PROMPT`
mentions neither templates, nor tests, nor deleting, nor type-checking. A
well-meaning edit adding any of those is exactly how the template case and the
failing-spec case would stop measuring the agent and start measuring that
string — silently, both still green. It also pins that `credentialProbe()` is
`createStudioAgent`'s real output rather than a look-alike (a gate reading a
different definition than the run announces the wrong mode while holding the key
the run would have used), and that the refusing `fetch` names the URL it turned
down.

Two mechanical notes for whoever adds the tenth case:

- **A helper may not call `expect`** — `noMisplacedAssertion` matches lexical
  position, not the call graph (the same trap `studio-chat.test.ts` hit). Both
  shared claims here THROW instead, which is also the convention the published
  readers follow: the finding is a sentence naming the file that was abandoned,
  and a `toBe(true)` over a boolean loses it.
- **The web builtins get a REFUSING `fetch` by default**, so a case cannot
  silently spend a live web search. Pass `fetch` in the case options to grade
  one that must really answer.

### `AAI_EVAL_STUDIO_MODEL`, and the literal it overrides

A live case runs the coding agent on `gpt-5.5`, a literal in
`_studio-eval-harness.ts`, because the shipped default is `studioLlmModelId()`
in `aai-studio-server` and this package may not import it. **That literal will
drift when the studio changes model**, and it is the cheaper of the two failures
available: a drifted default measures the coding agent on a model the studio no
longer serves, which the announce line prints on every run, where a dynamic
import across the boundary would make the guest link against the host in order
to run a test. The override is declared in `check:eval`'s `env` in `turbo.json`,
not in `globalPassThroughEnv` — strict env mode strips an undeclared variable
silently.

`check:eval` here is deliberately outside the merge path: `scripts/check.mjs`
and `check.yml` both run `check:eval` filtered to `aai-templates`, so adding the
task to this package changed nothing either of them does. `pnpm test:eval` (i.e.
`scripts/run-evals.mjs`) is what runs it, resolving the key and setting
`AAI_REQUIRE_EVAL=1` so a scripted fallback fails instead of passing quietly.

```sh
pnpm test:eval --filter aai-guest                    # live; spends tokens, spawns compilers
AAI_EVAL_STUB=1 pnpm --filter aai-guest test:eval    # wiring + the tools' own answers
pnpm --filter aai-guest test:eval -- -t "type-clean" # one case (vitest's own filter)
```

**Measured, on the day it landed.** Scripted: 4 cases run, 5 skipped, **38s**,
of which the `test_agent` case alone is **34s** — two real in-guest rolldown
passes, two bundle loads, a real vitest run and one trial call. So the tier's
wall clock here is its build passes and everything else is noise, which is worth
knowing before adding a case that calls `test_agent` twice.
The five live cases' FIXTURES and both ground-truth readers were validated
separately against scripted runs that drive the same tools (the broken tool
really fails `tsc` and the diagnostic really reaches the write result; the
failing spec really fails and an edit to `agent.ts` really makes it pass; a
copied template really is byte-identical); what has not been observed is a live
model's behaviour against them, so treat the first live run as the validation
those five have not had.

### `studioBundleAccess` exists because this eval wanted the real one

`harness.ts` built the studio's loader + trial executor as an inline object.
`HarnessBundleAccess` was the one declaration of its SHAPE; the two rules inside
it had none — an inspection load carries an EMPTY env, and a trial answers in
PROSE (`Tool error: …`, `(no result)`, `agent not loaded`) because its consumer
is a model reading a tool result. A second caller wanting the REAL pair rather
than a double is where an inline object becomes a copy, so it is
`studio-bundle-access.ts` now, with its own spec. The one thing that spec pins
which a reader would not guess: it reads `state.agent` at CALL time, because the
access object is built once per session and `test_agent` loads and then trials
inside one tool call.
