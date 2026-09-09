# The studio starter eval

Reference for the eval that drives this package's own product surface. The
package guide's "Studio starter evals" section is the summary and the commands;
this file is the reasoning behind them, and it is a SIBLING rather than a section
of `CLAUDE.md` because that guide is at 99% of the 120,000-char budget
(`check:claude-md`) and a section pushed out of a full guide is exactly what a
sibling is for. The eval FRAMEWORK — the recording runner, the spread report, the
assertion vocabulary, why a live eval reports rather than gates — is
[`packages/aai-evals/CLAUDE.md`](../aai-evals/CLAUDE.md).

## Five files, and why they are in this package

| File | What it is |
| --- | --- |
| `studio-starter.eval.test.ts` | the case loop: one starter prompt per case, on `aai-evals/register` |
| `studio-eval-target.ts` | the TARGET: create project → broker a sandbox session → stream one chat turn → read the synced workspace |
| `studio-starter-expectations.ts` | what each starter prompt ASKED FOR, as checkable facts |
| `studio-starter-grade.ts` | which checks run, under what label, and the failure taxonomy |
| `studio-template-contract.ts` | the opt-in BEHAVIOUR half: run the template's own eval against the generated workspace |
| `studio-eval-env.ts` | `AAI_EVAL_ORIGIN`, `AAI_EVAL_CONTRACTS`, `AAI_STEP_CAP_HINT` |

They were in `packages/aai-evals/src/` until they were not, and the line that
moved them is what a module is ABOUT rather than what runs it. `aai-evals` names
no product surface: it is a runner, a report and a vocabulary over the session
event stream. Every one of these names the studio in every constant it declares:
its chat route, its per-sandbox token, its step cap, the prose its own tools
write, the eighteen starter prompts and what each asked for. What the old
arrangement cost was legible in the manifests: `aai-evals` depended on
`aai-studio-client` for the starter list, on `undici`, `ai` and
`eventsource-parser` for one target's transport, and carried an
`evals-package-boundary` exception for a subpath one file read. All four moved
here, and that boundary is a total deny again.

The framework is imported, never re-implemented: `aai-evals/gate` for the key
gate and the announce, `/register` for case registration, `/runner` for
`EvalRecorder`, `/report` for `condense`, `/env` for the three env readers.
Nothing goes the other way — `evals-package-boundary` denies `aai-studio-server`
by name, which is what keeps the edge one-way and the workspace acyclic.

## What the case loop replaced

`studio-starter.eval.test.ts` + `studio-eval-target.ts` are
`scripts/starter-eval/run.mjs`'s case loop, verdict and reporter (485 + 175 + 85
= 745 lines, deleted) on the shared runner. The GRADING is a different job —
those checks read generated source rather than behaviour — so it was kept when
the runner was not.

**`run.mjs` could not have run, and porting it is what found that out.** The
chat request belongs to the GUEST and is authenticated by the per-sandbox token
the session broker returns beside the URL; `run.mjs` sent the account's API key
and gets `401 {"error":"Unauthorized"}`. So the harness the guides cite numbers
from had rotted, in the way a second runner nobody exercises does. Verified
against a live studio after the fix: one starter, **100%, 15s**, driving create
project → broker a sandbox session → stream a chat turn → read the synced
workspace.

The port also **dropped one check `run.mjs` never made**: a bare "did it write a
`client.tsx`". That file was recorded as INFORMATION there and kept out of the
`shippable` verdict, because most starters never ask for a UI — asserting it
failed the math-tutor template for shipping exactly what it should. `checkUi` is
the whole UI claim.

**`regrade.mjs`'s job is not reproduced, deliberately.** It re-graded a SAVED run
with today's expectations, because the grader had been corrected four times after
the runs it should have applied to. The cheap version of that is
`studio-starter-expectations.test.ts`, which was a fail-fast block at the top of
`run.mjs` — so it ran only when somebody spent tokens — and is now a UNIT test:
an expectation demanding a tool its prompt never asks for, and a
`builtinDelegation` that passes on prose alone, both fail in the ordinary test
run with no key, no studio and no model.

**The grader must not sit in the eval file.** `gradeStarter` — which chooses
which expectation functions run, under what label, and holds the failure
taxonomy — did, and `*.eval.test.ts` is excluded by this package's
`vitest.config.ts`, so every function it CALLED was unit-tested while the thing
calling them was not. `studio-starter-grade.ts` is the fix, driven by a canned
`StudioTurn`. Same shape one level down is why the corpus left `scripts/`: as
`scripts/starter-eval/expectations.mjs` its eval-only half (`parseLoadedConfig`,
`checkMode`, `checkWorkflowShape`, `checkUi`) was in no coverage report at all.
`check:module-tests` is the floor now — every module under a package's `src/`
owes a co-located spec, and its ratchet refuses to ADD an entry, so a further
module of this eval that ships without one fails in the diff that lands it.

## The five regexes are about tool OUTPUT, not about missing events

`aai-runtime`'s `text-agent-events.ts` cites this eval as "the measured
consequence" of a text agent having had no event stream — five REGEXES over
tool-output text. That is the right motivation for the event stream and the wrong
prediction about these five, and the audit is worth recording because it says
where the remaining work actually is.

| | what it reads | replaceable by events? |
| --- | --- | --- |
| `TS_ERROR` | a tool RESULT's text carries a TypeScript diagnostic | **no** |
| `BUILD_FAILED` | `test_agent`'s text says the build failed | **no** |
| `TESTS_FAILED` | `test_agent`'s text says the tests failed | **no** |
| `WRITE_DIAGNOSTIC_PREAMBLE` | strips `formatPostWriteDiagnostics`' fixed instruction | **no** |
| `TEST_AGENT_PREAMBLE` | strips `test_agent`'s success prose | **no** |

All five classify or trim the CONTENT of a tool result, and an event carries
that content as the same string (`tool.completed.result`) — so an in-process
harness would run the identical patterns over `turn.toolCalls`. Two of them are
not even classification: they exist because the excerpt is prose a tool wrote.
What the event stream replaces is the PLUMBING — pairing a call with its result,
ordering, per-tool tallies — and this target never hand-rolled that in the first
place: `readUIMessageStream` does the `toolCallId` → name correlation, and
`aai-evals`' tool arms are what would replace `VERIFYING_TOOLS` + `redChecks` +
`testAgentRuns`. So the honest saving is `StudioTurn` shrinking to its events
plus the two excerpt renderers, and the pattern set staying exactly as it is.

**A projection was available and was not taken.** `foldMessage` could map the
UI message parts into `SessionEvent`s and let `studio-starter-grade.ts` grade
through `eventScope` and the tool arms — and it would be testable, since
`studio-eval-target.test.ts` drives `readTurn` with canned SSE. It is declined on
two grounds. It makes that file a SECOND producer of the union whose fidelity
nothing can check (there is no live studio in CI, and the guest's own events are
not on the wire to compare against), which is the two-vocabularies hazard
inverted. And it buys no measurement: the same patterns, the same verdicts, in a
grading path exercised only by a run holding a live key and a live studio. The
version that pays for itself needs the guest to emit, which is the next
paragraph.

**What WOULD retire them is structured tool results** — `test_agent` and
`check_types` answering JSON a case reads with `toolResultIn(calls, name,
Schema)` instead of prose. That is a change to the studio's tools in
`aai-guest`, not to the eval, and it is the only version of this that removes a
regex rather than moving it.

### Carrying the guest's events to a client: measured, and not worth it

The events the guest emits are emitted IN-PROCESS inside the Modal sandbox, so
this target — which drives create-project → broker a session → stream one chat
turn over real HTTP — cannot read them. The obvious fix is a frame on the chat
SSE stream (a `data-*` part in the AI SDK's UI message stream, which the client
would ignore). Of the seven events a text agent emits, **five are already on
that stream in the SDK's own vocabulary**: the user message is the request's
own, `tool.called`/`tool.completed` are the tool parts, the reply is the text
parts, and the terminator is the stream ending. The two that would add
information are `custom.emitted` (a tool's `ctx.send`) and
`error.reported` with `code: "tool"` (a tool that THREW rather than returning a
failure). Neither is something a starter eval grades, and the cost is a new
versioned wire surface plus a second encoding of arguments and results already
on the stream. **Recommendation: do not.** Revisit if a case needs to grade a
`ctx.send` or an uncaught tool throw from outside the sandbox.

## The SECOND, in-process studio eval is in `aai-guest`

`packages/aai-guest/src/studio-agent.eval.test.ts`, nine cases on
`_studio-eval-harness.ts`. It could not be built from here or from `aai-evals`:
`createStudioAgent(session, deps)` returns a plain `AgentDef` with `text: true`,
exactly what `openEvalTextAgent` takes — but `StudioSession` carries a real
workspace `dir` and `StudioAgentDeps` is `HarnessBundleAccess & { typecheck }`,
all of which live in `aai-guest`, which every boundary in this direction denies.

Two predictions the argument for it made, and how they came out:

- **"An in-process eval without an installed toolchain measures tool CHOICE and
  not the verification loop."** Correct, and the reason it was built with one:
  the cases run `initStudioSession` and hand `createStudioAgent` the real
  `typecheckWorkspaceDir`, so the post-write diagnostics are a real compiler and
  four cases end by asking the workspace — `typecheck()` and `runTests()`,
  called by the CASE — rather than reading a tool result. That is the class of
  assertion a model cannot satisfy with prose, and it is what the five regexes
  above are a substitute for.
- **"It would not replace the HTTP target; keep both, convert nothing."** Held.
  `studio-starter.eval.test.ts` measures the DEPLOYED path — the broker, the
  per-sandbox token, the guest chat route, the end-of-turn workspace sync —
  which is where the harness it replaced had rotted. Nothing was converted.

**One thing that argument missed, and it is the limit on everything the guest-side
eval reports: the system prompt.** `studioSystemPrompt(kind)` is THIS package's,
and `guest-package-boundary` denies the guest that import. So the guest-side eval
runs on a harness prompt plus the real, guest-owned `toolchainPromptSection()`,
and adjudicates the tool set, the tool descriptions, each tool's own result prose
and the model. **The shipped prompt is graded by the HTTP target here and by
nothing there** — a stronger reason to keep both than the deployed-path one, and
the reason a prompt change still has to be measured through a live studio. See
"The coding agent has an eval of its own" in `packages/aai-guest/CLAUDE.md`.

Note which package sees both halves: only this one, over HTTP, sees prompt AND
tools together. Nothing in the workspace can import both.

## The template behaviour contract (opt-in)

`studio-template-contract.ts`. The starter eval grades generated SOURCE — does a
tool whose name or description carries "cancel" exist, is the mode pipeline, is
there a client that reads live state. Every one of those is a question about
STRUCTURE, and a generated retail desk can answer all of them while
authenticating nobody. `aai-evals` grades BEHAVIOUR, and for a long time nothing
ran it against generated code: the two halves sat disjoint, and the starter
eval's verdict stopped exactly where the interesting question started.

```sh
AAI_EVAL_CONTRACTS=1 AAI_EVAL_ONLY=retail pnpm --filter aai-studio-server test:eval
```

**The contract is the TEMPLATE'S OWN `agent.eval.test.ts`, and three facts make
that work.** Twelve of the eighteen starter prompts say "use the `<name>`
template", which makes the template the ask rather than an illustration —
`checkCapabilities` already special-cases them for it. Twenty-five of the
twenty-six templates ship an eval. And those files were written to drive a
DEPLOYED agent rather than their own directory: they import `virtual:aai/agent`,
which `aaiAgentPlugin` resolves against the IMPORTER's directory, so dropping one
into a materialized workspace drives that workspace's agent. They also assert
MECHANISMS — a refusal sentence, a tool result, the projection sent to the
browser — never the words the model chose, which is what lets a
different-but-valid implementation pass.

**The canonical copy always wins.** `use_template` copies template files
verbatim, eval file included, so a workspace can arrive holding a contract the
coding agent was then free to edit. `contractWorkspace` overwrites it with the
copy read from `packages/aai-templates/`. That is the whole non-gameability
argument, and it is the same one `studio-starter-expectations.ts` rests on: the
prompt is ours, the contract is ours, and the only thing the agent controls is
the agent.

**Why the scratch directory is inside this package.** A contract imports
`@alexkroman1/aai/protocol`, `@alexkroman1/aai-runtime/eval`, `vitest` and `zod`,
and Node resolution walks UPWARD — a directory under `packages/aai-studio-server/`
resolves all four with nothing installed, where one in `tmpdir()` resolves none.
This package declares all four, which is what let the module move without the
constraint changing. It is `src/.eval-workspaces/`, gitignored, and removed in a
`finally`: a leak here is a tree that `git status`, `biome check` and `tsc` all
walk into — and, now that it is under `src/`, one this package's own vitest
config has to exclude from collection. The `.gitignore` entry was corrected on
the way: it named `packages/aai-evals/.eval-workspaces/`, one level above the
directory the module's `new URL("./.eval-workspaces/", import.meta.url)` ever
resolved to, so it had matched nothing for as long as it existed.

**Off by default, and that is a cost decision rather than a doubt.** A contract
run is a live model session on top of a codegen turn that already takes minutes,
so making it unconditional would roughly double the tier's wall clock and spend
to answer a question most runs are not asking. A starter naming no template, or
naming one that ships no eval, records NOTHING rather than a passing check — a
check that cannot fail is one more line saying "green" for no reason.

**What is NOT verified: the live path.** The selection, the overwrite, the
materialization, the cleanup and the subprocess plumbing all have unit tests
(`studio-template-contract.test.ts`, 23 of them, with the vitest spawn faked and
`spawnCommand` driven through `node -e`). What no test here reaches is one real
`npx vitest run` against a real generated workspace, because that needs a live
studio, a key and a model. Treat the first `AAI_EVAL_CONTRACTS=1` run as the
validation it has not had — and note that a contract failing for want of the
template's DATA files, rather than for behaviour, is the failure mode to watch:
`use_template` copies them, but only if the agent asked for them.
