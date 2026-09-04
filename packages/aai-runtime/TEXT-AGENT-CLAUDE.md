# TEXT-AGENT-CLAUDE.md — driving an agent from text, and the eval surface

A sibling of `CLAUDE.md` rather than a section in it, for the reason that guide
already gives for [`JOURNAL-CLAUDE.md`](JOURNAL-CLAUDE.md): this is REFERENCE —
which subpath an eval imports, what a keyless run gets — rather than a rule that
has to be resident in every agent's context. It moved when the guide crossed the
120,000-char cap; nothing in it changed.

## Driving an agent from text is a published surface

`@alexkroman1/aai-runtime/eval` and `/eval/vitest` are how an agent is measured
rather than merely tested: `openEvalSession` stands up a REAL session — this
runtime, the pipeline transport, the LLM on a live key, the tool executor, `ctx`
and its slots, history trimming, the step budget, the event stream — with the two
speech stages replaced by fakes, and hands back a `say()` that returns the TURN
it provoked.

**It was `aai-evals/session-target.ts` + `stub-speech.ts`, and publishing it is
what the templates forced.** That harness could answer the one question nothing
else in the repo could ("given this utterance, did the agent do the right
thing"), and it could only ever answer it about agents living in this repo. A
user's project — and every template, which IS a user's project — had no way to
ask it at all, and the alternative was each project reimplementing the two
documented harness bugs `eval/stub-speech.ts` and `eval/session.ts` record in
place (a fake TTS that forwards silence turns every case after the greeting into
a barge-in; a `say()` that waits for "a reply" settles on the PREVIOUS one).
`aai-evals` now imports it, so there is one copy of both.

Four decisions worth not relitigating:

- **`say()` returns an `EvalTurn`, not void.** "On that turn" is most of the
  meaning of almost every claim an eval makes, and the run-wide view has a trap
  in it: `agent()` injects a default GREETING, which is a real turn, so
  `said()` already has an entry before a case has spoken. The first draft's own
  unit test caught that.
- **The assertion VOCABULARY is not published, and the READERS are.** `saidIn`,
  `toolCallsInEvents` and `TURN_ENDS` are facts about an event list; `aai-evals`'
  matcher surface (`calledTool`, `toolOrder`, `saidSomething`, the recording
  runner behind them) is a promise about a NOISY instrument and stays private
  until the variance work in that package's guide exists to measure it with. A
  vitest `expect` over a turn is what a template needs, and it is what a
  template gets.
- **`TURN_ENDS` crossed the boundary with the session**, because the two must
  agree by construction: it is what `say()` waits for AND what partitions a run
  into turns for the assertions. It was written out twice once, and a third
  terminator added to one copy makes `say()` return mid-reply while the
  assertions still think the turn is open — the agent reads as misbehaving.
- **An S2S agent is REFUSED by name.** The vendor owns the whole turn there, so
  there is no text seam to drive, and silently running it as a pipeline agent
  would evaluate a configuration nobody deployed.

### A template eval imports from `/eval` and `/eval/vitest`, and NOWHERE else

The root `@alexkroman1/aai-runtime` barrel drags this runtime's node-reaching
module graph into the template's own TypeScript program — three errors in
runtime files no eval ever calls. So `/eval` re-exports what an eval needs to
name, `RunCodeExecutor` among them, rather than letting a template reach past
it for a type.

That rule used to be written down only inside a JSDoc block copied verbatim into
four template evals, and deduplicating those onto `createVmRunCode` is
what left it with no home. Which is the general hazard in a dedupe: the copies
carry prose as well as code, and the prose is the half a diff does not miss.

### A workflow app is evaluated by RUNNING it

`describeWorkflowEval` / `openEvalWorkflows` are the other half, and they exist
because a `workflowApp()` template — six of the shipped ones — has no session for
`openEvalSession` to open, no microphone and no model in its config. Its whole
product is a durable run, and nothing in the SDK could evaluate one: a page
starts a run over HTTP against a DEPLOYED agent, and a spec drove the exported
steps one at a time. `app.run(def, input)` answers an `EvalWorkflowRun` — status,
output, error, plus what the run NARRATED (`reported`), emitted, and slept.

**The engine is the real client over a real key store.** `eval/workflow-engine.ts`
implements the existing `WdkAdapter` seam in memory and `openEvalWorkflows` hands
it to `createWorkflowClient` over `createMemoryKeyStore()` — so the schema
validation, the def→name mapping, the correlation-key index, the snapshot union
and `lastLine`'s tail-first rule are all production code rather than a fake's
approximation of it.

**It is NOT a durability test, and that sentence is load-bearing.** A
`"use workflow"` body is durable only after the DevKit's builder has transformed
it, and an eval imports it through a test runner with no bundler in the path — so
the body runs as an ordinary async function. No journal, no replay, no
suspension, and a step's `maxRetries` is INERT, which has a measured consequence:
a provider 429 that a deployed run would ride out FAILS an eval run (it happened,
on a sixth live run inside three minutes). `sleep()` is RECORDED rather than
taken, which is what lets a case assert `podcast-digest`'s schedule without
waiting a day. Four `WorkflowClient` methods have no honest answer here and say
so. Do not describe a case written on this as covering replay, resume or retry —
`aai-cli`'s `dev-workflow.scenario.test.ts` is the tier that does.

**Three things a workflow eval CANNOT reach, each costing a real case.**
`createHook()` throws untransformed and — unlike `sleep()`, whose slot the
engine publishes into — offers no seam to fill (`@workflow/core`'s
`create-hook.js` throws unconditionally), so `recap-workflow`'s retention gate,
its headline port of Temporal's `expense`, is unevaluable and its eval says so
rather than asserting around it. `wakeUp` answers `0`, so a "send it now" tool
can only ever report that nothing was waiting. And because `sleep` is recorded
rather than taken, an in-flight run is observable only by HOLDING a provider
response — a `Promise.race` against a durable sleep resolves instantly here, so
a case that wants to see a run mid-flight scripts a slow step instead of
sleeping. A `vi.mock("workflow", …)` factory owned by this package, and an
`openEvalWorkflows({ sleeps: "block" })`, are the two shapes that would close
the first and third; neither is built.

**A workflow app's credential gate is a different question**, hence
`evalWorkflowCredentials`: `requiredProviderEnvVars` returns `[]` for a
`page: "static"` agent, so asked alone it reports every workflow app "ready" and
a keyless run goes live and 401s three layers down inside a step. It reads
`requiredEnv` too, which is the only place a workflow app declares what it needs.

### A keyless run gets a SCRIPTED model, not a skip

`describeEval` (on `/eval/vitest`, which is what pulls the optional `vitest`
peer) resolves one of two modes and ANNOUNCES it on every run:

| | model | what it proves |
| --- | --- | --- |
| credential present | live | the agent's BEHAVIOUR — a noisy measurement (see `packages/aai-evals/CLAUDE.md`: identical code has scored 0.56 and 0.60) |
| none, or `AAI_EVAL_STUB` | scripted (`eval/stub-llm.ts`) | the WIRING — `agent.ts` boots, tools resolve, the session reaches a reply, the eval file drives something |

The third state is the interesting one, because the two obvious states leave a
skipped suite indistinguishable from a BROKEN one. A stub run is deterministic,
free, ~1s, and takes the same code path as a live run below the model — the
descriptor is the only thing swapped, and it goes in through `registerLlmKind`
like any provider. That is what makes it worth gating on, and CI does:
`check.yml`'s integration-and-scenario job runs the template evals with
`AAI_EVAL_STUB=1`, set EXPLICITLY so a key reaching that environment cannot turn
a required check into a paid, flaky one. The live eval tier still gates nothing.

`AAI_REQUIRE_EVAL` is the opposite instruction — a missing credential FAILS
rather than downgrading — for a pipeline that means to measure. A case whose
claim no script can honestly satisfy carries `{ live: true }` and is skipped in
stub mode; anything else carries a `stubReply` chosen so the case still passes,
because a case that fails against its own stub measures nothing.

What the stub gate CATCHES, stated because "wiring" is vague: a template whose
`agent.ts` stopped booting, whose `tools/` stopped resolving, whose provider
config no longer validates, or whose eval file stopped driving a session — every
one of which a suite that skips reports as green. `templates/simple` is the
worked example (`packages/aai-templates/CLAUDE.md`), and the two things that
belong to a template rather than to this harness are there: the unit-tier
exclusion for the `.eval.` infix, and a template reading the ENVIRONMENT for a
credential and never a developer's CLI config.

**A template that ships an eval owes two things**, and both are config whose
absence is silent. Its package's unit-tier `exclude` needs the `.eval.` infix —
`aai-templates`' `include` is `templates/*/*.test.ts`, which MATCHES an eval
file, so without it `pnpm test` drives a live model on every developer's key
under a 5s budget it cannot meet. And a template's eval must read the
ENVIRONMENT for a credential and nothing else: no fallback to
`~/.config/aai/config.json`, which `aai-evals`' own gate has, because a template
ships to users and may not read a developer's CLI config — `aai eval` supplies
the key out of the project's `.env`, which is also why `ASSEMBLYAI_API_KEY` is
declared in `check:eval`'s `env` in `turbo.json` (strict env mode strips an
undeclared variable silently, leaving every case scripted with a key exported
right there in the shell).

**Four seams a case can fill, each one paid for by a template that could not be
evaluated without it.** `runCode` backs the `run_code` builtin, which otherwise
refuses exactly as it does off-platform — correct, and it meant the three tutor
templates' headline feature (the arithmetic the builtin owns) could be asserted
as a CALL and never as an answer. `fetch` keeps a case off the network, because
a scripted `visit_webpage` really visits. `toolTimeoutMs` reaches the session's
per-call deadline, which was unreachable from any caller: a graded retrieval loop
measured at 22-30s against ~10x gateway variance times out at 30s and the case
then measures the deadline instead of the agent. `workflows` supplies
`ctx.workflows`, without which a tool that starts a run cannot execute at all.

**`ctx.generate` answers from the script too**, and that was a hole rather than
a limit: `generateText` calls the fake model's `doGenerate`, which used to
throw, so every tool that reasons with a model — a grader, a planner, a
rewriter, i.e. the central tool of two shipped templates — answered "doGenerate
not implemented" in a scripted run and read as the agent being broken.

Two things in `describeEval`'s SIGNATURE are decided by a linter rather than by
taste, both A/B'd against Biome 2.5 and both invisible until a user's own project
reddens on a file this SDK told them to write: the callback parameter is named
`test` (`noMisplacedAssertion` matches the CALLEE IDENTIFIER, so an `expect`
inside `evalTest(…)` is an error), and a case body takes a DESTRUCTURED context
(`noDoneCallback` reads the first positional parameter of an async test callback
as jest's `done`, so `async (session) => …` is an error where
`async ({ session }) => …` is vitest's own fixture shape). Do not "tidy" either.
