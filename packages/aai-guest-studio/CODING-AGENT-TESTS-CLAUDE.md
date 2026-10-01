---
summary: >-
  Testing the studio coding agent: the agent-level unit spec through
  `runTextAgent`, and the agent's own EVAL — what is real in a case, the one
  thing that is per-case (the system prompt), and why it lives in
  `aai-guest-studio` rather than `aai-evals`
read_when: >-
  testing or evaluating the studio coding agent
---

# packages/aai-guest-studio — testing the studio coding agent

How the studio's coding agent is tested. Read "The coding agent is an ordinary
`agent()`" in `packages/aai-guest-studio/CLAUDE.md` first; this is the layer
above it. The tier table is in the root `AGENTS.md`;
`packages/aai-guest-core/CLAUDE.md`'s "What `test-utils.ts` owes" owns the
shared helpers, and `packages/aai-guest-studio/CLAUDE.md`'s "Testing notes" the
scenario-tier split. Paths below are under `packages/aai-guest-studio/src/`.

## The coding agent is tested at the AGENT level too

|                           | what it drives                                                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.test.ts`           | what the DEFINITION declares                                                                                                                                                                                                        |
| `tools.test.ts`           | the studio's own half of the tool set through `runTool` — the syntax gate, the post-write diagnostics, the scrubbed `bash` env, `test_agent`. The nine workspace tools are the SDK's and are covered there (`coding-tools.test.ts`) |
| `chat.scenario.test.ts`   | the HTTP SURFACE, over a real port and real disk                                                                                                                                                                                    |
| **`agent-turns.test.ts`** | **one TURN of `createTextAgent` over the real definition**, via `runTextAgent` + `scriptedTextModel` (`@alexkroman1/aai-runtime/testing`)                                                                                           |
| `agent.eval.test.ts`      | a LIVE model over a real workspace                                                                                                                                                                                                  |

`agent-turns.test.ts` owns the loop — argument coercion, Standard Schema
validation, the `ctx` a tool is handed, the reserved final-answer step, the
event stream — and makes four claims:

- **The step budget reserves a final ANSWERING step, tools off**: with
  `maxSteps: 1` and a script that keeps calling tools, the turn runs TWO steps
  and the second one speaks.
- **A turn is a `SessionEvent` stream the eval readers take unchanged**
  (`toolCallsInEvents`, `saidIn`, one terminator), asserted against a script.
- An argument the schema rejects reaches the model as a REPAIRABLE result
  rather than killing the turn (the studio's model regularly emits a whole
  source file inside a JSON string).
- The tool the model chose runs through the real executor, and its result is
  what the next step reads.

**It stays in the UNIT tier by choice of TOOL**: `todo_write` closes over
nothing and touches no disk, and the session fixture points at a path that does
not exist (`createStudioAgent` performs no I/O). A turn that writes files
belongs in `chat.scenario.test.ts`.

**`agent.test.ts` runs `expectDeployable`** (`@alexkroman1/aai/testing`), i.e.
`toAgentConfig` per derived MODE — for a text agent, "no audio path". This is
the repo's only definition assembled in CODE, so a `voice:` or `stt` added here
has no agent file to review. The same test pins an asymmetry: **the conversion
carries `builtinTools` and NOT the declared tools** (there is no `toolSchemas`
on the config), which is why `test_agent` reports its tool list off the loaded
bundle's own `__aaiConfig`.

## The coding agent has an eval of its own

`agent.eval.test.ts` + `_eval-harness.ts`: cases that drive `createStudioAgent`
over a REAL workspace and ask whether the agent reached for the right tool, in
the right order, and left something that compiles.

- **It is the templates' eval suite, not a second one.** Everything above the
  model comes from `@alexkroman1/aai-runtime/eval`: `openEvalTextAgent`,
  `EvalTurn`, `turnCalling` / `toolNames` / `describeTurn`, `resolveEvalMode`
  and `installStubLlm`. Tier membership is the `.eval.` infix.
- **`describeEval` cannot be reused, structurally**: it stands up
  `openEvalSession` → `createRuntime`, which REFUSES `mode: "text"`.
  `describeStudioEval` is the third announce owner beside `describeEval` (a
  template) and `gate.ts` in `aai-evals`, and adds only per-case lifetime.
- **Why here and not in `aai-evals`**: `StudioSession` carries a real workspace
  `dir` and `StudioAgentDeps` is `HarnessBundleAccess & { typecheck }`, all
  defined in the guest packages, and `evals-package-boundary` denies them to
  `aai-evals`.
- **It replaces nothing.** The HTTP starter eval
  (`packages/aai-studio-server/STARTER-EVAL-CLAUDE.md`) measures the DEPLOYED
  path — broker, per-sandbox token, guest chat route, end-of-turn sync. This one
  measures the agent. Keep both.

### What is real in a case, and what is per-case

Real: `initStudioSession` (the tree materialized, completed by
`ensureProjectShape`, dependencies reified), the four tool families and three
web builtins, the SDK's tool executor with its `ctx` and the 120s
`STUDIO_TOOL_TIMEOUT_MS`, the reserved final-answer step,
`typecheckWorkspaceDir` behind the post-write diagnostics, `HARD_TURN_MS` as the
turn deadline, and `test_agent`'s real build → bundle load → trial.

**The system prompt is a PER-CASE choice.** The shipped prompt is
`studioSystemPrompt(kind)` in `packages/aai-studio-server/src/prompts/`, which
this package may not import (`guest-package-boundary`, and a task-graph cycle).
`_eval-prompt.ts` reads the copies `scripts/sync-studio-prompt.mjs` commits per
kind under `studio-prompts/` (held current by `check:studio-prompt`):

| A case with…                            | runs on              | and therefore grades                                                             |
| --------------------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| no `studioPrompt` (the default)         | `STUDIO_EVAL_PROMPT` | the tool set, the tool DESCRIPTIONS, each tool's own result prose, and the model |
| `studioPrompt: "agent"` \| `"workflow"` | the shipped text     | the studio's PROMPT, plus all of the above                                       |

Either way the guest-owned `toolchainPromptSection()` that `initStudioSession`
appends is present, as in production.

- **Report a result against the CASE's prompt, never the file's.**
  `shippedStudioPrompt` THROWS on a missing copy rather than falling back.
- **`STUDIO_EVAL_PROMPT` says nothing that would pre-answer a case** (copy
  templates, don't delete a failing spec) — those belong to the guest's own
  surfaces under eval. That is also why the shipped prompt is opted into per
  CASE, not per file.
- **A starter's prompt is read, not retyped**: `studioStarter(kind, label)`
  reads the synced catalog and throws naming the real labels. Most starters are
  one sentence naming a template, so grading them means grading the shipped
  prompt.
- **`workflow.md` is committed and no case reads it** — only
  `_eval-prompt.test.ts` reaches `shippedStudioPrompt("workflow")`; the "Build a
  workflow app" starters are the obvious next cases.
- Not exercised here: `chat.ts`'s turn shaping (wall-clock `stopWhen`,
  compaction's `prepareStep`, mid-turn checkpoints, end-of-turn sync) —
  `chat.scenario.test.ts` covers those.

### GROUND TRUTH is what makes these cases worth running

Cases end by asking the workspace rather than the transcript: `ctx.typecheck()`
runs the post-write diagnostics' compiler and `ctx.runTests()` runs the
workspace's own specs as `test_agent` does, both called by the CASE. **That is
the one class of assertion a model cannot satisfy with prose.**

- The repair loop is asserted per OCCURRENCE: every write whose result carried
  `Type errors after writing <file>` must be followed by another write to that
  file (vacuous when nothing came back red).
- The template case compares agent.ts BYTE FOR BYTE against the shipped
  template; the failing-spec case requires `agent.test.ts` unchanged byte for
  byte (editing the assertion destroys the only record of what was wanted).

### Live and scripted cases

**The scripted cases are REFUSALS**: a competent model does not write
unparsable TypeScript, address a path outside its workspace, or ask for a
template that does not exist, so something has to call the refused thing
(`EvalCaseOptions.scripted`). They grade the guest's ANSWER — whether the tool's
sentence is one a model can act on (the syntax rejection says nothing was saved,
not to run `test_agent` first, and to stop over-escaping; an unknown template
lists the real names).

**The harness has its own spec** (`_eval-harness.test.ts`): it asserts
`STUDIO_EVAL_PROMPT` mentions neither templates, tests, deleting, nor
type-checking (an edit adding one silently turns two cases into measurements of
that string), that `credentialProbe()` is `createStudioAgent`'s real output, and
that the refusing `fetch` names the URL it turned down.

Adding a case:

- **A helper may not call `expect`** — `noMisplacedAssertion` matches lexical
  position. Shared claims THROW, with a sentence naming the abandoned file.
- **The web builtins get a REFUSING `fetch` by default**; pass `fetch` in the
  case options to grade one that must really answer.
- **`test_agent` dominates the stub-mode wall clock** (two real in-guest
  rolldown passes, two bundle loads, a vitest run, a trial) — a case calling it
  twice doubles the tier.
- **Live wall clock varies ±40% per case run to run.** Cases are pass/fail, so
  a case that starts flipping wants `AAI_EVAL_REPEAT` and a look at the spread,
  not a nudged assertion.

### `AAI_EVAL_STUDIO_MODEL`, and the literal it overrides

A live case runs on a model literal in `_eval-harness.ts`, because the shipped
default is `studioLlmModelId()` in `aai-studio-server`, which this package may
not import. **That literal drifts when the studio changes model**; the announce
line prints it on every run. The override is declared in `check:eval`'s `env`
in `turbo.json` — strict env mode strips an undeclared variable silently.

`check:eval` here is outside the merge path: `scripts/check.mjs` and `check.yml`
run `check:eval` filtered to `aai-templates`. `pnpm test:eval`
(`scripts/run-evals.mjs`) runs it, resolving the key and setting
`AAI_REQUIRE_EVAL=1` so a scripted fallback fails instead of passing quietly.

```sh
pnpm test:eval --filter aai-guest-studio                    # live; spends tokens, spawns compilers
AAI_EVAL_STUB=1 pnpm --filter aai-guest-studio test:eval    # wiring + the tools' own answers
pnpm --filter aai-guest-studio test:eval -- -t "type-clean" # one case (vitest's own filter)
```

### `studioBundleAccess` is the real loader + trial pair

`bundle-access.ts` (with its own spec) holds the two rules `HarnessBundleAccess`
does not: an inspection load carries an EMPTY env, and a trial answers in PROSE
(`Tool error: …`, `(no result)`, `agent not loaded`) because a model reads it.
It reads `state.agent` at CALL time — the access object is built once per
session, and `test_agent` loads then trials inside one tool call.
