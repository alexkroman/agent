# testing

`@alexkroman1/aai-runtime/testing` — the PURE testing door of an agent
project: every fake, recorder and reader a spec needs that installs nothing,
and the drivers that run an agent's own machinery for real — a DURABLE
workflow run and a TEXT agent turn.

A test file imports from two places: this subpath, and
`@alexkroman1/aai-runtime/testing/vitest` for everything that INSTALLS or
RESTORES (and for the eval suites). This one carries every public name of
`@alexkroman1/aai/testing` — `createToolContext`, `runTool`, `expectToolOk`,
`stubGenerate`, `createWorkflowContext`, … — re-exported as the SAME
declarations, so a type from either package is one type.

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const approve = workflow({
  description: "Hold a draft until a reviewer answers.",
  run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval:1"),
});

const run = await runWorkflow(approve, { draft: "…" }, { name: "approve" });
console.log(run.status); // "running" — parked on the reviewer

await run.signal("approval:1", { approved: true });
console.log(run.status); // "completed"
```

## The CONTEXT and the ENGINE

`createWorkflowContext` (declared in the SDK) hands a workflow body a `ctx`
that RECORDS — the right tool for asserting what a body asked for, and
explicitly not a durability test. `runWorkflow` runs the real engine over the
memory journal, so a spec can assert that a run slept, resumed, retried, was
answered, and survived a dead worker.

`scriptedTextModel` and `runTextAgent` are the same idea one mode over: the
script is a step — what the model says, what it calls — and the text agent
underneath is the real one.

```ts
import { agent } from "@alexkroman1/aai";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";

const run = await runTextAgent(
  agent({ name: "Desk", mode: "text", systemPrompt: "Be brief." }),
  "where is order 7?",
  { script: [{ text: "It shipped yesterday." }] },
);
console.log(run.text); // "It shipped yesterday."
```

## Why the SDK's helpers are re-exported HERE

`@alexkroman1/aai` never imports this package (the dependency runs one way),
and the engine is runtime — so the one door has to be on the runtime, and
the SDK's helpers are re-exported in this direction. They stay DECLARED (and
versioned, as `aai:testing`) in the SDK; here they are owned by this
package's `eval-stubs` and `testing-stubs` capabilities, because dropping
one from this door would be this package's break.

## Runner-agnostic, deliberately

Nothing here installs a global or owns a lifetime a runner has to unwind —
the workflow driver injects its own dispatcher, so no timer is ever armed —
which is this repo's rule for what may stay off a `/vitest` subpath
(konsistent `published-testing-split`). It does not import vitest.

Exports are enumerated explicitly (no `export *`) so the public surface is
deliberate: a new symbol in one of these modules does not ship as public API
until it is added here.

## Functions

### createMemoryJournal()

```ts
function createMemoryJournal(): WorkflowJournal;
```

A run journal in this process's memory, for a host that must hold one across
a runtime rebuild.

`aai dev` is the reason it exists: it rebuilds the runtime on every file save,
and the engine's own default is a FRESH journal per build — so every save
discarded the runs. Build one per PROCESS and hand the same handle to each
runtime. It does not survive a restart; a deployment that owns a database
gets the Postgres journal from `RuntimeOptions.db` instead, and a supplied
memory journal never outranks it.

#### Returns

[`WorkflowJournal`](#workflowjournal)

***

### createRouteContext()

```ts
function createRouteContext(overrides?: RouteContextOverrides): RouteContext;
```

Build a [RouteContext](../aai/index.md#routecontext) for calling a route handler in isolation.

Defaults are inert: an empty `env`, a `workflows` client whose every method
rejects naming itself (`createStubWorkflows`), a `clientTranscript` that
answers no sessions, a `sessionTranscript` that answers no lines, a `speech`
that finds no live session, and a `signal` that never aborts. Override any of
them — most specs pass `env` and a `workflows` fake of their own.

A hand-built literal has to restate every field, and it is the field the
runtime gained LAST that it leaves out: five shipped specs each carried one,
and `sessionTranscript` was missing from all five.

#### Parameters

##### overrides?

[`RouteContextOverrides`](#routecontextoverrides)

#### Returns

[`RouteContext`](../aai/index.md#routecontext)

#### Example

```ts
import { type RouteHandler, type RouteRequest, routeError } from "@alexkroman1/aai";
import { createRouteContext, createStubWorkflows } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";

const getCall: RouteHandler = async (req, ctx) => {
  const [run] = await ctx.workflows.find("call", req.params.id ?? "", { limit: 1 });
  if (run === undefined) throw routeError(404, `No call ${req.params.id}.`);
  return run;
};

const request: RouteRequest = {
  method: "GET",
  path: "/calls/c_1",
  params: { id: "c_1" },
  query: {},
  headers: {},
  body: undefined,
};

test("GET /calls/:id is a 404 for a call nobody placed", async () => {
  const workflows = createStubWorkflows({ find: () => Promise.resolve([]) });
  const ctx = createRouteContext({ env: { CALLS_API_KEY: "k" }, workflows });
  await expect(getCall(request, ctx)).rejects.toMatchObject({ status: 404 });
});
```

***

### createRunSnapshot()

#### Call Signature

```ts
function createRunSnapshot<R = unknown>(overrides?: RunSnapshotOverrides<R>): WorkflowRunSnapshot<R>;
```

Build a [WorkflowRunSnapshot](../aai/workflow-api.md#workflowrunsnapshot) — the right arm of the union, without a
cast.

Defaults to a `running` run, which is the state a tool that has just started
one reads back.

##### Type Parameters

###### R

`R` = `unknown`

##### Parameters

###### overrides?

[`RunSnapshotOverrides`](#runsnapshotoverrides)\<`R`\>

##### Returns

[`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)\<`R`\>

##### Example

```ts
import { createRunSnapshot, createStubWorkflows } from "@alexkroman1/aai/testing";

const workflows = createStubWorkflows({
  find: () => Promise.resolve([createRunSnapshot({ status: "failed", error: "gateway down" })]),
});
```

#### Call Signature

```ts
function createRunSnapshot<R>(workflow: AnyWorkflowDef<R>, overrides?: RunSnapshotOverrides<R>): WorkflowRunSnapshot<R>;
```

Build a [WorkflowRunSnapshot](../aai/workflow-api.md#workflowrunsnapshot) of a run of `workflow`, with `output`
TYPED by the def.

The def carries `R` — what its body returns, or what its `output` schema
declares — so `createRunSnapshot(recap, { status: "completed", output })`
checks `output` against it, where the bare form takes whatever `R` the
caller names. A fixture whose output stopped matching the body is then a
compile error in the spec rather than a page that renders `undefined`.

The def names the run too, when it can: `workflow` is the key the def was
declared under (`workflowNameOf`, recorded when the agent is lowered — a
`virtual:aai/agent` import, `withWorkflows`, `workflowRegistry`), the
overrides' `workflow` winning, and `"workflow"` for a def no agent declares.

##### Type Parameters

###### R

`R`

##### Parameters

###### workflow

[`AnyWorkflowDef`](../aai/workflow-api.md#anyworkflowdef)\<`R`\>

###### overrides?

[`RunSnapshotOverrides`](#runsnapshotoverrides)\<`R`\>

##### Returns

[`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)\<`R`\>

##### Example

```ts no-check
import { recap } from "./shared.ts";

const done = createRunSnapshot(recap, {
  status: "completed",
  output: { headline: "…", points: [] }, // typed by `recap`
}); // `workflow` is "recap" once the agent declaring it has been imported
```

***

### createSlotStore()

```ts
function createSlotStore(): SlotStore;
```

A fresh, empty, REAL slot store — one session's, with no backend: a durable
write is checked and frozen exactly as a deployed session's is.

What `createToolContext()` puts on `ctx.slots` by default; named so a spec
can hand ONE store to two contexts (a tool and an event handler sharing a
session), or build a `SlotHolder` without a whole context.

#### Returns

[`SlotStore`](../aai/index.md#slotstore)

#### Example

```ts
import { createSlotStore, createToolContext } from "@alexkroman1/aai/testing";

const slots = createSlotStore();
const first = createToolContext({ slots });
const second = createToolContext({ slots, sessionId: first.sessionId });
```

***

### createStubWorkflows()

```ts
function createStubWorkflows(overrides?: Partial<WorkflowClient>): WorkflowClient;
```

A `ctx.workflows` for testing a tool that starts or reads durable runs: every
method rejects by default, and `overrides` replaces the ones the test drives.

**The alternative is a cast, and the cast is what goes wrong.** A complete
`WorkflowClient` is eight methods, of which a tool's test usually drives one or
two, so the hand-rolled version is a literal with `as WorkflowClient` — which
keeps compiling when the client GAINS a method and leaves that method
`undefined`. Two shipped templates had exactly that, and adding `wakeUp` and
`stream` to the client is what surfaced it: the casts still compiled.

Rejecting rather than no-op defaults, for the reason `createUnusedDb` rejected
before it went away with `ctx.db` — a tool that reaches for a method the test
did not stub should say so, not silently receive `undefined`. `listing` is the exception and returns `[]`,
because it is synchronous and an empty list is a truthful answer.

```ts
import { createStubWorkflows, createToolContext } from "@alexkroman1/aai/testing";

const workflows = createStubWorkflows({ start: async () => "wrun_1" });
const ctx = createToolContext({ workflows });
```

#### Parameters

##### overrides?

`Partial`\<[`WorkflowClient`](../aai/index.md#workflowclient)\>

#### Returns

[`WorkflowClient`](../aai/index.md#workflowclient)

***

### createToolContext()

```ts
function createToolContext(overrides?: ToolContextOverrides): TestToolContext;
```

Build a [ToolContext](../aai/index.md#toolcontext) for testing a tool's `execute` in isolation.

Defaults are chosen so the context is inert: empty `env`, an empty slot store,
`workflows`, `generate` and `delegate` that reject with a message naming
themselves, a `signal` that never aborts, and a `send` that records.
Override any of them.

**`generate` and `delegate` also take a SCRIPT**, which is the way in for a
tool that calls a model: pass `stubGenerate`'s own argument and the fake is
built here, installed, and handed back on `ctx.model` (`ctx.desk` for
`delegate`).

**Each call is a distinct session.** `sessionId` auto-increments, which is
what makes the two-context isolation test — the same tool run against two
contexts must not share state — read the way it does. Pass `sessionId`
explicitly when a test needs two contexts to be the SAME session (a
reconnect, a keyed lock).

**An override may be `undefined`**, which means "I do not have one" and
leaves the default in place — see [ToolContextOverrides](#toolcontextoverrides) for why that
is not `Partial<ToolContext>`.

There is no state type parameter, because there is no `ctx.state` bag to
type: a slot types its own value in the module that declares it, and reading
the slot back is how a spec asserts what a tool wrote.

#### Parameters

##### overrides?

[`ToolContextOverrides`](#toolcontextoverrides)

#### Returns

[`TestToolContext`](#testtoolcontext)

#### Examples

```ts no-check
// `no-check`: the tool under test is in another file, which is the point.
import { createToolContext } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import { cartSlot } from "./shared.ts";
import addItem from "./tools/add_item.ts";

test("add_item appends to this session's cart", async () => {
  const ctx = createToolContext();
  await addItem.execute({ item: "apple" }, ctx);
  expect(cartSlot.get(ctx).items).toEqual(["apple"]);
});
```

**Asserting on what a tool sent**

```ts no-check
import { createToolContext } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import { recommend } from "./tools/recommend.ts";

test("recommend pushes its picks to the client", async () => {
  const ctx = createToolContext();
  await recommend.execute({ mood: "chill" }, ctx);
  expect(ctx.sent).toEqual([{ event: "recommendations", data: expect.anything() }]);
});
```

**Scripting the model in the same call**

```ts
import { createToolContext } from "@alexkroman1/aai/testing";

// `{ reply }` answers every call; `{ routes }`, keyed by system prompt,
// answers a tool that plays more than one model role.
const ctx = createToolContext({ generate: { reply: "A short summary." } });
// … run the tool, then assert on what it asked:
// expect(ctx.model.calls.map((call) => call.prompt)).toEqual([…]);
```

***

### createWorkflowContext()

```ts
function createWorkflowContext(options?: WorkflowContextOptions): WorkflowContextRecorder;
```

Build a `WorkflowContext` that runs a body and records what it asked for.

#### Parameters

##### options?

[`WorkflowContextOptions`](#workflowcontextoptions)

#### Returns

[`WorkflowContextRecorder`](#workflowcontextrecorder)

#### Example

```ts no-check
const ctx = createWorkflowContext();
const output = await digestFlow({ url: "https://example.com/a" }, ctx);

expect(output.headline).toBe("…");
expect(ctx.steps.map((s) => s.name)).toEqual(["fetchArticle", "summarize", "file"]);
expect(ctx.slept).toEqual([{ label: "settle", until: 10_000 }]);
```

***

### deployedAgent()

```ts
function deployedAgent<D extends ToolBearingAgent & {
  systemPrompt: AgentSystemPrompt;
}>(authored: D, project: ProjectFiles): D;
```

The def a DEPLOYED agent runs: the one `agent.ts` exports, plus the tools its
`tools/` directory declares, plus what its `system-prompt.md` says.

**This is one call because forgetting HALF of it is the failure it exists to
prevent, and that failure is silent.** Neither lowering is applied by
`agent()` — both are applied by the BUILD (`aai build` enumerates `tools/`
and resolves the prompt file) — so a spec or an eval driving the raw default
export measures an agent with NO TOOLS and the FRAMEWORK-DEFAULT system
prompt. Nothing fails: the model answers plausibly out of its own knowledge,
every case that asserts a sentence still passes, and the suite reports green
on a different agent than the one anybody deploys. It produced four bogus
green eval results in one day, and the two nested wrappers it replaces — a
tools lowering inside a prompt lowering, written out in seventeen template
evals — are exactly the shape where one of the two goes missing under an edit.

**Under vitest, prefer `import agentDef from "virtual:aai/agent"`**, which is
this call made for you against the importing spec's own directory (see the
module doc). Reach for this one when the runner is not vitest, or when the
lowering itself is the subject of the spec.

**An EMPTY `tools` glob throws.** That is the same bug wearing its other
face: `import.meta.glob("./tool/*.ts")` (or a `tools/` directory that moved)
matches nothing, and lowering nothing onto the def is indistinguishable from
not lowering at all. A project with no tools omits the field instead, which
is a statement rather than an accident.

```ts no-check
// `no-check`: two of these imports are files YOU own — `./agent.ts` and
// `./system-prompt.md?raw` — which exist in your project and in no tree of
// ours, so nothing here can resolve them. (`import.meta.glob` is not the
// blocker: the doc-example gate compiles with Vite's client types, as the
// scaffold's `@alexkroman1/aai/tsconfig` preset does.)
import { deployedAgent } from "@alexkroman1/aai/testing";
import authored from "./agent.ts";
import systemPrompt from "./system-prompt.md?raw";

const agentDef = deployedAgent(authored, {
  tools: import.meta.glob("./tools/*.ts", { eager: true }),
  systemPrompt,
});
```

Every rule the build applies applies here too, and each is an error naming
the file: the tool-name grammar, the default-export requirement, no nested
files, a name declared twice, an empty prompt file, and a
`system-prompt.md` that exists while `agent.ts` declares a different prompt
STRING — the "I edited the prompt and nothing changed" failure.

**Bounded by the two fields it lowers ONTO, not by `AgentDef`.** An `agent()`
def satisfies it and comes back as its own type, so a template keeps its
exported workflow types; the bound says what the function reads, and keeps
`AgentDef` and everything behind it off `@alexkroman1/aai/testing`'s contract.

#### Type Parameters

##### D

`D` *extends* [`ToolBearingAgent`](#toolbearingagent) & \{
  `systemPrompt`: [`AgentSystemPrompt`](../aai/index.md#agentsystemprompt);
\}

#### Parameters

##### authored

`D`

##### project

[`ProjectFiles`](#projectfiles)

#### Returns

`D`

***

### endSessionCalls()

```ts
function endSessionCalls(ctx: Pick<ToolContext, "sessionId">): readonly {
  afterReply: boolean;
}[];
```

Every `endSession(ctx, …)` a tool made on a [createToolContext](#createtoolcontext)
context's session, in call order, with its options resolved (`afterReply`
defaults to `true`). Empty when the tool never ended the session.

A function of the context rather than a field on `TestToolContext`, for the
reason `endSession` is one: it reads the session, which `ctx.sessionId` names.

```ts
import { endSession, tool } from "@alexkroman1/aai";
import { createToolContext, endSessionCalls } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import { z } from "zod";

const endCall = tool({
  description: "Hang up.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ ended: endSession(ctx) }),
});

test("end_call hangs up after the goodbye", async () => {
  const ctx = createToolContext();
  await endCall.execute({}, ctx);
  expect(endSessionCalls(ctx)).toEqual([{ afterReply: true }]);
});
```

#### Parameters

##### ctx

`Pick`\<[`ToolContext`](../aai/index.md#toolcontext), `"sessionId"`\>

#### Returns

readonly \{
  `afterReply`: `boolean`;
\}[]

***

### expectDeployable()

```ts
function expectDeployable<D extends {
  llm?: unknown;
  name: unknown;
  stt?: unknown;
  tts?: unknown;
}>(def: D): DeployedConfig;
```

Run the invariants a deployable agent owes, and hand back the RESOLVED config
so a spec can go on to assert its own specifics — a chosen model, a declared
builtin — without converting twice.

Three invariants, each thrown by name:

- **The config passes manifest validation** — the same `toAgentConfig` that
  `aai build` and `aai deploy` run, so an invalid provider combination or
  tuning fails here rather than at the first live session.
- **The platform can name it** — there IS a name, and the conversion carries
  it through. Not the literal: renaming the agent is the first edit a starter
  invites, and the studio lists a deployed agent by exactly this string.
- **Every stage its mode needs is filled, declared or defaulted** — asserted
  per MODE so it survives a swap. A pipeline agent has an `stt`, `llm` and
  `tts` kind, each declared stage surviving as declared and each unset one
  filled by `defaultProviders`; a text agent has no audio stage (its `llm`
  may be absent — `createTextAgent` defaults the one stage it has); an `s2s`
  agent has an `s2s` kind and NO cascade, since speech-to-speech replaces the
  pipeline rather than joining it — the one thing that must never happen by
  fallthrough.

`toAgentConfig` already refuses most of the states the second and third
invariants describe (a blank name, `s2s` beside a pipeline stage). They are
checked here anyway, and BEFORE or AFTER the conversion as the message needs,
because the value of this helper is the sentence: a spec that failed on
"expected function not to throw" has to re-run the conversion by hand to
learn which invariant went.

```ts
import { agent } from "@alexkroman1/aai";
import { expectDeployable } from "@alexkroman1/aai/testing";

const config = expectDeployable(agent({ name: "Desk", builtinTools: ["run_code"] }));
// The invariants held; now the template's own claim.
console.log(config.builtinTools); // ["run_code"]
```

#### Type Parameters

##### D

`D` *extends* \{
  `llm?`: `unknown`;
  `name`: `unknown`;
  `stt?`: `unknown`;
  `tts?`: `unknown`;
\}

#### Parameters

##### def

`D`

The agent under test — an `agent()` definition, or the raw
  default export of an `agent.ts`. Structural: only `name` is required of
  the TYPE, because validating the rest is this helper's job at run time —
  the same `toAgentConfig` a deploy runs. Generic only so a spread literal
  carrying a field this type does not name (`{ ...def, maxSteps: 0 }`) is
  not an excess-property error.

#### Returns

[`DeployedConfig`](#deployedconfig)

The config a deploy carries, mode derived and defaults injected —
  see [DeployedConfig](#deployedconfig) for the fields it names.

#### Throws

Naming the invariant that failed, and — for the validation one — the
  sentence `toAgentConfig` wrote about the field.

***

### expectDialogOk()

#### Call Signature

```ts
function expectDialogOk<R>(result: R): [Exclude<R, ToolFailure>] extends [DialogToolResult<V>] ? DialogToolResult<V> : DialogToolResult<unknown>;
```

The dialog envelope a gated tool answered, keeping WHERE the dialog landed.

The half a spec needs when the assertion is about the conversation rather
than about the tool's own value — that a call advanced the machine into
`quote.pending`, that a final state reports `done`. Unlike
[expectToolOk](#expecttoolok), which passes a plain tool's value through, this THROWS
on anything that is not a dialog envelope: keeping a position claims there is
one.

**Typed by INFERENCE**, as [expectToolOk](#expecttoolok) is: handed a typed envelope
(`runTool(theTool, …)`, `theTool.execute(…)`) it keeps the type under
`result`; the name form answers `unknown`, where the claimed overload below
takes the type the spec asserts.

##### Type Parameters

###### R

`R`

What was handed in, inferred — never written.

##### Parameters

###### result

`R`

##### Returns

\[`Exclude`\<`R`, [`ToolFailure`](../aai/index.md#toolfailure)\>\] *extends* \[[`DialogToolResult`](../aai/index.md#dialogtoolresult)\<`V`\>\] ? [`DialogToolResult`](../aai/index.md#dialogtoolresult)\<`V`\> : [`DialogToolResult`](../aai/index.md#dialogtoolresult)\<`unknown`\>

##### Throws

When the tool refused, quoting the refusal, as [expectToolOk](#expecttoolok) does.

##### Throws

When the value is not a dialog envelope — a plain `tool()` has no
  position to keep; use [expectToolOk](#expecttoolok) for it.

##### Example

```ts no-check
import { expectDialogOk, runTool } from "@alexkroman1/aai/testing";

const answered = expectDialogOk<{ quoted: number }>(
  await runTool(agentDef, "quote", {}, ctx),
);
expect(answered.state).toBe("quote.pending");
expect(answered.result.quoted).toBe(42);
```

#### Call Signature

```ts
function expectDialogOk<T>(result: unknown): DialogToolResult<T>;
```

The dialog envelope a gated tool answered — the CLAIMED form, for a result
typed `unknown` (`runTool(agent, "name", …)`, a `toolRunner`): `T` is what
the spec says is under `result`, unchecked at runtime, as
[expectToolOk](#expecttoolok)'s claimed form is.

##### Type Parameters

###### T

`T`

The type the spec claims for the tool's own value.

##### Parameters

###### result

`unknown`

##### Returns

[`DialogToolResult`](../aai/index.md#dialogtoolresult)\<`T`\>

***

### expectDialogRefused()

```ts
function expectDialogRefused(result: unknown, state?: string): ToolFailure;
```

The refusal a gated tool answered with, or a throw saying the gate did NOT hold.

The mirror of [expectDialogOk](#expectdialogok), for the spec whose subject is that a
tool was REFUSED: called before the dialog reached its state, or after it
left. Six template specs had written the other half by hand — an
`isToolFailure` check, a `toBe(true)`, and a regex for the sentence the gate
writes — and a success slipped through that shape as three assertions that
never ran, because each sat inside the `if` the guard opened.

With a `state`, the refusal must also NAME it: that the tool was refused is
half the claim, and that the conversation was where the spec thinks it was is
the half a gate on the wrong state hides in. Matched with
[dialogRefusalPattern](eval/vitest.md#dialogrefusalpattern), so a spec never spells the sentence.

#### Parameters

##### result

`unknown`

What `runTool` / `toolOf(...).execute(...)` answered.

##### state?

`string`

The position the refusal must name, as `DialogPosition.state`
  spells it. Omit to accept a refusal at any state.

#### Returns

[`ToolFailure`](../aai/index.md#toolfailure)

#### Throws

When the tool was NOT refused — a dialog envelope is reported with the
  state it landed in, since that is the fact the spec got wrong.

#### Throws

When it was refused for some other reason, or at some other state,
  quoting the refusal.

#### Example

```ts
import { expectDialogRefused } from "@alexkroman1/aai/testing";

const refused = expectDialogRefused(
  { error: 'Not available yet: this conversation is at "idle". Call start_plan first.' },
  "idle",
);
refused.error.includes("start_plan"); // true — the instruction the model recovers from
```

***

### expectPromptBuiltinsDeclared()

```ts
function expectPromptBuiltinsDeclared(def: {
  builtinTools?: readonly BuiltinTool[];
  systemPrompt?: AgentSystemPrompt;
  tools?: Readonly<Record<string, unknown>>;
}): BuiltinTool[];
```

Every builtin the prompt commands is one `builtinTools` declares — or a throw
naming the ones that are not.

The pairing a prompt-driven template is made of: the prose holds the rules
("you MUST use `run_code` for arithmetic", "look rates up with `fetch_json`"),
and `agent.ts` holds the array that makes those tools exist. The failure is
silent in both directions and shows up in a diff of neither file — a prompt
commanding `fetch_json` at an agent that never declared it produces a model
apologizing for a tool it cannot see, and a builtin dropped from `agent.ts`
alone leaves an endpoint list addressed to nothing.

**A prompt commanding NO builtin is a failure, not a pass.** Non-vacuity earns
its keep twice: a loop over nothing asserts nothing, and it is also the state a
template lands in when `system-prompt.md` was not applied — the framework
default names no builtin, so "I edited the prompt and nothing changed" fails
here instead of passing quietly with the template's rules nowhere in its
context. A spec whose prompt legitimately describes its tools rather than
naming them does not want this helper; it asserts on `builtinTools` directly.

The converse is deliberately NOT asserted: declaring a builtin the prompt never
mentions is an ordinary edit, and the model learns about it from its own tool
schema rather than from the prose.

**A custom tool of the same NAME declares it too.** An agent may replace a
builtin with its own `tools/text_me.ts` — a different channel, a different
recipient rule — and the prompt's "text it with `text_me`" is then addressed
to that tool, which the model sees under exactly that name. The claim is "the
model has a tool called this", and `def.tools` answers it as well as
`builtinTools` does. That is why `tools` is read, and why a def lowered with
`deployedAgent` (or imported from `virtual:aai/agent`) is the one to pass: the
authored `./agent.ts` carries no `tools`.

**A RESOLVER is CALLED, and refused when it cannot be.** `systemPrompt` may be
a function, and `toAgentConfig` drops one rather than putting it on the wire —
so scanning the converted config would read the FRAMEWORK's default prompt and
report on a prompt this agent never sends. That is the one outcome a check may
not have: the default names no builtin, so scanning it fails for the wrong
reason — pointing at an unapplied `system-prompt.md` that is not the problem —
and PASSES the day the default happens to name one. So the resolver is
called with a bare [createToolContext](#createtoolcontext) — a fresh session id, no env, an
empty slot store — and its answer is what gets scanned. That is enough for the
prose half, which is a `?raw` import closed over by the function and does not
vary with session state. A resolver that cannot answer from a bare context
(it reads an env var, or a slot it expects seeded) THROWS, and this refuses by
name rather than falling back to the default: seed a context, call the
resolver yourself and pass its text as the `systemPrompt` of the def this
takes, or assert on `builtinTools` directly.

```ts
import { agent } from "@alexkroman1/aai";
import { expectPromptBuiltinsDeclared } from "@alexkroman1/aai/testing";

const commanded = expectPromptBuiltinsDeclared(
  agent({
    name: "Coda",
    systemPrompt: "Answer every sum by calling run_code.",
    builtinTools: ["run_code"],
  }),
);
console.log(commanded); // ["run_code"]
```

#### Parameters

##### def

The agent under test — only its `systemPrompt`, `builtinTools`
  and the KEYS of `tools` are read, so an `agent()` def passes as it is. Whether the
  WHOLE def converts is [expectDeployable](#expectdeployable)'s claim, not this one's.

###### builtinTools?

readonly [`BuiltinTool`](../aai/index.md#builtintool)[]

###### systemPrompt?

[`AgentSystemPrompt`](../aai/index.md#agentsystemprompt)

###### tools?

`Readonly`\<`Record`\<`string`, `unknown`\>\>

#### Returns

[`BuiltinTool`](../aai/index.md#builtintool)[]

The commanded builtins, for a spec that wants to say more about them.

#### Throws

When the prompt names no builtin, when it names one `builtinTools`
lacks, or when a `systemPrompt` resolver cannot answer from a bare context.

***

### expectSlotContract()

```ts
function expectSlotContract<K extends string, T, V>(slot: SessionSlot<K, T, V>, options?: SlotContractOptions<T>): void;
```

Assert the three invariants of `slot`'s declaration — see the module doc.

#### Type Parameters

##### K

`K` *extends* `string`

##### T

`T`

##### V

`V`

#### Parameters

##### slot

[`SessionSlot`](../aai/index.md#sessionslot)\<`K`, `T`, `V`\>

##### options?

[`SlotContractOptions`](#slotcontractoptions)\<`T`\>

#### Returns

`void`

#### Throws

Naming the invariant that failed, and for a cap the key.

#### Example

```ts
import { sessionSlot } from "@alexkroman1/aai";
import { expectSlotContract } from "@alexkroman1/aai/testing";

const log = sessionSlot("log", () => ({ lines: [] as string[], total: 0 }), {
  caps: { lines: 50 },
  view: (value) => ({ count: value.lines.length }),
});

expectSlotContract(log, {
  write: (draft) => {
    draft.lines.push("hello");
  },
  caps: { lines: 50 },
});
```

***

### expectToolOk()

#### Call Signature

```ts
function expectToolOk<R>(result: R): R extends DialogToolResult<V> ? V : Exclude<R, ToolFailure>;
```

What a tool answered, minus the refusal — or a throw quoting the refusal.

Takes ANY tool's result. A `dialog()` tool's envelope ([DialogToolResult](../aai/index.md#dialogtoolresult))
is unwrapped to the author's own value under `result`; a plain `tool()`'s
value comes back as it is. Either way a `ToolFailure` throws HERE, naming it,
rather than as an `undefined` read off the failure several assertions later.

**Typed by INFERENCE**: handed a typed result — `runTool(theTool, …)`, or
`theTool.execute(…)` directly — it answers that type minus `ToolFailure`
(for a dialog tool, the type under `result`), so no type argument is needed.
The name form (`runTool(agent, "name", …)`, a `toolRunner`) answers
`unknown`, because a name is a string; there, say the type you expect —
`expectToolOk<Order>(…)` — which is unchecked at runtime, like any claim about
a value crossing an `unknown` boundary.

Use [expectDialogOk](#expectdialogok) to keep WHERE a dialog landed, and
[expectDialogRefused](#expectdialogrefused) when the refusal is the subject.

##### Type Parameters

###### R

`R`

What was handed in, inferred — never written. The CLAIMED form
  below takes the type a spec asserts instead.

##### Parameters

###### result

`R`

What a tool's `execute`, `runTool` or a `toolRunner` answered.

##### Returns

`R` *extends* [`DialogToolResult`](../aai/index.md#dialogtoolresult)\<`V`\> ? `V` : `Exclude`\<`R`, [`ToolFailure`](../aai/index.md#toolfailure)\>

##### Throws

When the tool refused (`ToolFailure`), quoting the refusal —
  which for a `dialog()` tool is the sentence naming the state the
  conversation is actually in and what has to happen first.

##### Example

```ts
import { tool } from "@alexkroman1/aai";
import { expectToolOk, runTool } from "@alexkroman1/aai/testing";
import { toolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";

// In a spec this is `import placeOrder from "./tools/place_order.ts"`.
const placeOrder = tool({
  description: "Place the order",
  inputSchema: z.object({ item: z.string() }),
  execute: async ({ item }) => (item ? { id: "ord_1" } : toolFailure("Name an item.")),
});
const order = expectToolOk(await runTool(placeOrder, { item: "pizza" }));
console.log(order.id); // typed: the failure arm is subtracted
```

#### Call Signature

```ts
function expectToolOk<T>(result: unknown): T;
```

What a tool answered, minus the refusal — the CLAIMED form, for a result
typed `unknown` (`runTool(agent, "name", …)`, a `toolRunner`).

`T` is what the spec says the tool answers, unchecked at runtime. Behaves as
the inferred form does: a dialog envelope is unwrapped, a plain value passes
through, a `ToolFailure` throws quoting the refusal.

##### Type Parameters

###### T

`T`

The type the spec claims for the tool's own value.

##### Parameters

###### result

`unknown`

##### Returns

`T`

##### Example

```ts no-check
import { expectToolOk, toolRunner } from "@alexkroman1/aai/testing";

const run = toolRunner(agentDef);
const order = expectToolOk<{ id: string }>(await run("place_order", { item: "pizza" }));
```

***

### fireEvent()

```ts
function fireEvent(
   agent: {
  dialogs?: readonly AnyDialog[];
  events?: SessionEventHandlers;
  name?: string;
}, 
   event: SessionEvent, 
   ctx?: SessionEventContext
): Promise<FiredEvent>;
```

Drive the agent's dialogs and `events` handlers with one event, the way the
session dispatches it: every declared dialog is offered the event FIRST
(`dialog.receive`, so a `"@session.timedOut"` transition fires), then the
handler declared for `event.type`, then `"*"`, each handed the same context.
Dialogs first because a dialog is part of the session's state and moves
before any observer sees the effect — the order `aai-runtime`'s session
keeps (`session-controls.ts`).

Two deliberate differences from the runtime's dispatch, both because a SPEC
is reading the outcome rather than a live call surviving it:

- **A throw PROPAGATES.** The session catches a handler's throw per handler
  and logs it, so a broken audit hook does not end a phone call; a spec
  wants the throw, because a handler that threw is the finding.
- **A promise is AWAITED.** The session does not wait on an async handler
  (the caller is mid-turn); a spec asserting on what the handler wrote has to.

`ctx` is a [SessionEventContext](../aai/index.md#sessioneventcontext) — the four fields a handler reads
(`sessionId`, `env`, `slots`, `speech`) — and a `createToolContext()`
satisfies it, which is the point: a slot the handler wrote is read back with
`slot.get(ctx)` through the same context, and what it said is on
`ctx.said`. Defaults to a fresh one, i.e. a DISTINCT session; pass one
explicitly wherever a second event is meant to see the first's writes.

#### Parameters

##### agent

###### dialogs?

readonly [`AnyDialog`](../aai/index.md#anydialog)[]

###### events?

[`SessionEventHandlers`](../aai/index.md#sessioneventhandlers)

###### name?

`string`

##### event

[`SessionEvent`](../aai/index.md#sessionevent)

##### ctx?

[`SessionEventContext`](../aai/index.md#sessioneventcontext)

#### Returns

`Promise`\<[`FiredEvent`](#firedevent)\>

#### Throws

When the agent declares neither `events` nor `dialogs` — there is
  nothing to drive, and a spec that fired into nothing would pass against
  nothing.

#### Example

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";
import { createToolContext, fireEvent, sessionEvent } from "@alexkroman1/aai/testing";

const heard = sessionSlot("heard", () => ({ lines: [] as string[] }));
const def = agent({
  name: "Listener",
  events: {
    "userTranscript.committed": (event, ctx) => {
      heard.update(ctx, (draft) => {
        draft.lines.push(event.text);
      });
    },
  },
});

const ctx = createToolContext();
await fireEvent(def, sessionEvent("userTranscript.committed", { text: "hello" }), ctx);
heard.get(ctx).lines; // ["hello"]
```

***

### parseSchemaInput()

```ts
function parseSchemaInput<T = Record<string, unknown>>(
   schema: 
  | StandardSchemaV1<unknown, unknown>
  | undefined, 
   value: unknown, 
   what?: string
): Promise<T>;
```

Validate `value` against `schema`, or throw naming every issue.

#### Type Parameters

##### T

`T` = `Record`\<`string`, `unknown`\>

What the schema produces. Defaults to
  `Record<string, unknown>`, which is what a tool input schema is declared as.

#### Parameters

##### schema

  \| [`StandardSchemaV1`](../aai/index.md#standardschemav1)\<`unknown`, `unknown`\>
  \| `undefined`

A Standard Schema, or `undefined` — the shape
  `tool.inputSchema` and `workflow.input` both have. `undefined` is an ERROR
  rather than a pass, because "this declares no schema" is a different fact
  from "the schema accepted it" and a spec asserting the second must not be
  satisfied by the first.

##### value

`unknown`

##### what?

`string`

How the schema is named in a failure. Defaults to
  `"the schema"`; pass the tool or workflow name where one is at hand.

#### Returns

`Promise`\<`T`\>

#### Throws

When the schema refuses `value`, with the issues rendered as one line
  (`quantity: too small; size: invalid enum value`) — which is what makes the
  failure readable at all, since a raw issue array prints as `[Object]`.

#### Example

```ts no-check
import { parseSchemaInput } from "@alexkroman1/aai/testing";

const parsed = await parseSchemaInput<{ voice: string }>(myWorkflow.input, {
  recording: "upl_1",
  voice: "jane",
});
expect(parsed.voice).toBe("jane");
```

***

### parseToolInput()

```ts
function parseToolInput<T = Record<string, unknown>>(
   agent: ToolBearingAgent, 
   name: string, 
   value: unknown
): Promise<T>;
```

Validate `value` against the input schema of the tool `name`.

[parseSchemaInput](#parseschemainput) with the lookup done — including `toolOf`'s "no such
tool" sentence, which names the tools that DO exist, since a lookup that
misses is nearly always a rename.

#### Type Parameters

##### T

`T` = `Record`\<`string`, `unknown`\>

What the schema produces.

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

##### name

`string`

##### value

`unknown`

#### Returns

`Promise`\<`T`\>

#### Throws

When the agent declares no tool called `name` (see `toolOf`), when
  that tool declares no `inputSchema`, or when the schema refuses `value`.

#### Example

```ts
import agentDef from "virtual:aai/agent";
import { parseToolInput } from "@alexkroman1/aai/testing";
import { expect } from "vitest";

const parsed = await parseToolInput<{ quantity: number }>(agentDef, "add_pizza", {
  size: "small",
  crust: "thin",
  toppings: [],
});
// The schema's own default, which is the thing worth asserting here.
expect(parsed.quantity).toBe(1);
```

***

### routeHandlerOf()

```ts
function routeHandlerOf(value: 
  | StubStepAnswer
  | FetchRouteHandler): FetchRouteHandler;
```

A table's value as a handler: a handler is itself; a fixed answer is given
to every request it is asked, a `Response` CLONED per request — a body is
read once, and the second request would otherwise find it consumed.

#### Parameters

##### value

  \| [`StubStepAnswer`](#stubstepanswer)
  \| [`FetchRouteHandler`](#fetchroutehandler)

#### Returns

[`FetchRouteHandler`](#fetchroutehandler)

***

### routeOf()

```ts
function routeOf(routes: 
  | Readonly<Record<string, 
  | StubStepAnswer
  | FetchRouteHandler>>
  | readonly FetchRouteHandler[]): FetchRouteHandler;
```

`routes` as ONE handler — a table matched by specificity, a list tried in
order — that DECLINES (`undefined`) a request no route answers, so it can be
one leg of a list or the `otherwise` of another fake. The same matching
[stubFetchRoutes](#stubfetchroutes-1) does, without installing anything.

#### Parameters

##### routes

  \| `Readonly`\<`Record`\<`string`, 
  \| [`StubStepAnswer`](#stubstepanswer)
  \| [`FetchRouteHandler`](#fetchroutehandler)\>\>
  \| readonly [`FetchRouteHandler`](#fetchroutehandler)[]

#### Returns

[`FetchRouteHandler`](#fetchroutehandler)

***

### runGuardrail()

```ts
function runGuardrail(
   def: SpeakerDef, 
   text: string, 
   answer?: Partial<DelegateAnswer>
): GuardrailVerdict;
```

Run `def`'s guardrail over one answer and return its verdict.

The answer is `text` with a ZERO cost report — one step, no tool calls —
because that is what most guardrails read; a guardrail that judges the cost
(`toolCalls.length === 0`, say) is handed it through `answer`, which is
spread over the defaults.

**Throws when the def declares no guardrail**, rather than returning `true`:
a spec calling this is asserting that a check exists, and a def that lost its
guardrail should fail here, not pass by default. **Throws when the guardrail
returns a promise**: this helper is for the SYNCHRONOUS guardrail, which is
the ordinary one, and an async guardrail's spec awaits `def.guardrail(answer)`
itself — the verdict is then a promise a test can `await`, and nothing here
would add to that.

#### Parameters

##### def

[`SpeakerDef`](../aai/index.md#speakerdef)

##### text

`string`

##### answer?

`Partial`\<[`DelegateAnswer`](../aai/index.md#delegateanswer)\>

#### Returns

[`GuardrailVerdict`](../aai/index.md#guardrailverdict)

#### Example

```ts
import { speaker } from "@alexkroman1/aai";
import { runGuardrail } from "@alexkroman1/aai/testing";

const checker = speaker({
  name: "fact-checker",
  systemPrompt: "Open with Confirmed:, Contradicted: or Unclear:.",
  guardrail: ({ text }) => /^(Confirmed|Contradicted|Unclear):/.test(text) || "Open with a verdict word.",
});

runGuardrail(checker, "Confirmed: the figure is 12%."); // true
runGuardrail(checker, "It seems prices fell."); // "Open with a verdict word."
```

***

### runTextAgent()

```ts
function runTextAgent(
   def: AgentDef, 
   input: string | readonly ModelMessage[], 
   options: RunTextAgentOptions
): Promise<TextAgentTestRun>;
```

Run one turn of `def` against `script`, and hand back what it did.

`def` must declare `mode: "text"` — `createTextAgent` refuses a voice agent by
name, and this makes no exception, so a spec cannot accidentally measure an
agent whose `greeting` and voice tuning are being silently dropped.

#### Parameters

##### def

[`AgentDef`](../aai/index.md#agentdef)

The agent definition, exactly as a deployment runs it.

##### input

`string` \| readonly `ModelMessage`[]

The conversation, or a string standing for one user message.

##### options

[`RunTextAgentOptions`](#runtextagentoptions)

#### Returns

`Promise`\<[`TextAgentTestRun`](#textagenttestrun)\>

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";

const desk = agent({ name: "Desk", mode: "text", systemPrompt: "Be brief." });

const run = await runTextAgent(desk, "where is order 7?", {
  script: [
    { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
    { text: "It shipped yesterday." },
  ],
});

console.log(run.text); // "Let me check.It shipped yesterday."
console.log(run.toolCalls[0]?.name, run.toolCalls[0]?.args);
```

#### Throws

whatever ended the model stream, rather than reporting a turn that
  silently produced nothing. A scripted stream fails only when something under
  it is broken, and a harness that swallowed that would report the broken path
  as an agent with nothing to say.

***

### runTool()

#### Call Signature

```ts
function runTool<T extends {
  execute: (...args: never[]) => unknown;
}>(
   tool: T, 
   argsOrCtx?: 
  | ToolContext
  | Parameters<T["execute"]>[0], 
   ctx?: ToolContext
): Promise<Awaited<ReturnType<T["execute"]>>>;
```

Run a tool — the tool DEF itself, or by the name the model calls it by.

**Handed the tool, it is TYPED end to end**: the arguments are checked
against what `execute` takes and the result is what it returns, so
`await runTool(addItem, { item: "apple" }, ctx)` needs no cast. The name
form below answers `unknown`, because a name is a string and nothing can
type what it looks up; a spec reading fields off that result used to cast it
(`(await run("add_item", ctx)) as { added: string }`), which is an unchecked
claim that stops meaning anything the day the tool's return changes. A tool
FILE's default export is the very object a deployed agent registers under its
name, so importing it runs the same code the name would reach.

Matched on `execute` alone rather than on `ToolDef`, so any tool shape —
`tool()`, `slot.tool()`, `dialog.tool()` — is accepted and keeps its own
result type.

##### Type Parameters

###### T

`T` *extends* \{
  `execute`: (...`args`: `never`[]) => `unknown`;
\}

##### Parameters

###### tool

`T`

###### argsOrCtx?

  \| [`ToolContext`](../aai/index.md#toolcontext)
  \| `Parameters`\<`T`\[`"execute"`\]\>\[`0`\]

###### ctx?

[`ToolContext`](../aai/index.md#toolcontext)

##### Returns

`Promise`\<`Awaited`\<`ReturnType`\<`T`\[`"execute"`\]\>\>\>

##### Example

```ts
import { tool } from "@alexkroman1/aai";
import { createToolContext, runTool } from "@alexkroman1/aai/testing";
import { z } from "zod";

// In a spec this is `import addItem from "./tools/add_item.ts"`.
const addItem = tool({
  description: "Add an item",
  inputSchema: z.object({ item: z.string() }),
  execute: async ({ item }) => ({ added: item }),
});
const { added } = await runTool(addItem, { item: "apple" }, createToolContext());
console.log(added.toUpperCase()); // typed: `added` is a string
```

#### Call Signature

```ts
function runTool(
   agent: ToolBearingAgent, 
   name: string, 
   argsOrCtx?: 
  | Record<string, unknown>
  | ToolContext, 
   ctx?: ToolContext
): Promise<unknown>;
```

Run a tool by the name the model calls it by.

`args` is unvalidated on purpose: the runtime parses a model's arguments
against `inputSchema` BEFORE `execute` sees them, so a spec that pre-validated
would be testing a path the tool never runs on. Pass the arguments the tool
body expects to receive. (To test the SCHEMA itself, which is a different
question, use `parseToolInput` / `toolInputIssues`.)

The def to pass is the one a DEPLOYED agent runs — `virtual:aai/agent` under
vitest, or `deployedAgent` under any other runner, since a tool is a file and
`agent.ts`'s default export carries none. See [toolOf](#toolof), which this is
built on.

**A tool that takes no arguments may say so by leaving them out**, passing the
context in their place: `runTool(agentDef, "view_order", ctx)`. A no-argument
tool is common — one shipped template has thirteen — and the `{}` those calls
were obliged to pass appeared 66 times across seven template specs, always
between the two values a reader actually cares about. Both spellings are one
signature rather than an overload pair, so a bound runner forwards either
shape without restating the union — which is what [toolRunner](#toolrunner-1) is, and
how every template reaches this.

The two are told apart by SHAPE, and the probe is narrow enough to be safe:
a `ToolContext` is a record carrying a string `sessionId`, a `slots` store and
a `send` function, and tool arguments arrive as JSON from a model, which
cannot contain a function. A context is never a plausible argument object.

##### Parameters

###### agent

[`ToolBearingAgent`](#toolbearingagent)

###### name

`string`

###### argsOrCtx?

  \| `Record`\<`string`, `unknown`\>
  \| [`ToolContext`](../aai/index.md#toolcontext)

###### ctx?

[`ToolContext`](../aai/index.md#toolcontext)

The context. Defaults to a fresh [createToolContext](#createtoolcontext) — so
  an omitted context is a DISTINCT SESSION with empty slots, which is what a
  stateless tool wants and never what two calls sharing state want. Pass one
  explicitly wherever the second call is supposed to see the first call's
  work.

##### Returns

`Promise`\<`unknown`\>

##### Example

```ts
import agentDef from "virtual:aai/agent";
import { createToolContext, runTool } from "@alexkroman1/aai/testing";
import { expect } from "vitest";

expect(await runTool(agentDef, "add_item", { item: "apple" }, createToolContext())).toEqual({
  added: "apple",
});

// No arguments, one session shared across the two calls.
const ctx = createToolContext();
await runTool(agentDef, "add_item", { item: "apple" }, ctx);
expect(await runTool(agentDef, "view_order", ctx)).toEqual({ items: ["apple"] });
```

***

### runWorkflow()

#### Call Signature

```ts
function runWorkflow<P extends ToolInputSchema, R>(
   def: WorkflowDef<P, R>, 
   input: Record<string, unknown>, 
   options?: RunWorkflowOptions
): Promise<WorkflowTestHandle<R>>;
```

Start `def` with `input` and drive it until it finishes or parks.

Resolves a handle carrying the run's status, output and journaled steps, with
four methods for the things only a durable run can do — end a wait, answer a
hook, survive a restart, and shut down.

The input is validated against `def.input` when the declaration has one, which
is what `ctx.workflows.start` does on every real path: a body is written
against a validated input, so handing it an unvalidated one tests a call that
cannot happen.

**Two forms.** Handed a DEF, the run is named by `options.name`, else by the
name the def was declared under (`workflowNameOf`, recorded when the agent
declaring it was lowered — a `virtual:aai/agent` import), else `"workflow"`.
Handed the AGENT and a workflow's name — `runWorkflow(agentDef, "digest",
input)`, with `agentDef` from `virtual:aai/agent` — the def is the one the
agent declares (or the build discovered in `workflows/`) under that name,
and the run carries that name, so a body that reads `ctx.workflow`, starts a
sibling by name or is found by `ctx.workflows.find` sees what a deployment
would. An unknown name throws, listing the ones the agent has.

##### Type Parameters

###### P

`P` *extends* [`ToolInputSchema`](../aai/index.md#toolinputschema)

###### R

`R`

What the body returns, taken from the declaration.

##### Parameters

###### def

[`WorkflowDef`](../aai/index.md#workflowdef)\<`P`, `R`\>

###### input

`Record`\<`string`, `unknown`\>

###### options?

[`RunWorkflowOptions`](#runworkflowoptions)

##### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### Examples

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const digest = workflow({
  description: "Summarize a link, then file it once it has settled.",
  run: async (input, ctx) => {
    const text = await ctx.step("read", () => `the page at ${String(input.url)}`);
    await ctx.sleep("settle", 10_000);
    return { text, filedAt: await ctx.step("file", () => "ok") };
  },
});

const run = await runWorkflow(digest, { url: "https://example.com/a" }, {
  name: "digest",
});

// It slept rather than blocking, and said for how long.
console.log(run.status, run.wakeAt);

// And it resumes off the journal without re-running what it already did.
await run.advanceSleep();
console.log(run.status, run.output, run.deliveries);
```

**The agent form, from a project's own spec**

```ts no-check
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import agentDef from "virtual:aai/agent";

const run = await runWorkflow(agentDef, "digest", { url: "https://example.com/a" });
```

#### Call Signature

```ts
function runWorkflow<App extends WorkflowAppLike, Name extends string>(
   agent: App, 
   name: Name, 
   input: Record<string, unknown>, 
   options?: Omit<RunWorkflowOptions, "name">
): Promise<WorkflowTestHandle<WorkflowOutputOf<WorkflowDefOf<App, Name>>>>;
```

Start `def` with `input` and drive it until it finishes or parks.

Resolves a handle carrying the run's status, output and journaled steps, with
four methods for the things only a durable run can do — end a wait, answer a
hook, survive a restart, and shut down.

The input is validated against `def.input` when the declaration has one, which
is what `ctx.workflows.start` does on every real path: a body is written
against a validated input, so handing it an unvalidated one tests a call that
cannot happen.

**Two forms.** Handed a DEF, the run is named by `options.name`, else by the
name the def was declared under (`workflowNameOf`, recorded when the agent
declaring it was lowered — a `virtual:aai/agent` import), else `"workflow"`.
Handed the AGENT and a workflow's name — `runWorkflow(agentDef, "digest",
input)`, with `agentDef` from `virtual:aai/agent` — the def is the one the
agent declares (or the build discovered in `workflows/`) under that name,
and the run carries that name, so a body that reads `ctx.workflow`, starts a
sibling by name or is found by `ctx.workflows.find` sees what a deployment
would. An unknown name throws, listing the ones the agent has.

##### Type Parameters

###### App

`App` *extends* [`WorkflowAppLike`](../aai/workflow-api.md#workflowapplike)

###### Name

`Name` *extends* `string`

##### Parameters

###### agent

`App`

###### name

`Name`

###### input

`Record`\<`string`, `unknown`\>

###### options?

`Omit`\<[`RunWorkflowOptions`](#runworkflowoptions), `"name"`\>

##### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<[`WorkflowOutputOf`](../aai/index.md#workflowoutputof)\<[`WorkflowDefOf`](../aai/workflow-api.md#workflowdefof)\<`App`, `Name`\>\>\>\>

##### Examples

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const digest = workflow({
  description: "Summarize a link, then file it once it has settled.",
  run: async (input, ctx) => {
    const text = await ctx.step("read", () => `the page at ${String(input.url)}`);
    await ctx.sleep("settle", 10_000);
    return { text, filedAt: await ctx.step("file", () => "ok") };
  },
});

const run = await runWorkflow(digest, { url: "https://example.com/a" }, {
  name: "digest",
});

// It slept rather than blocking, and said for how long.
console.log(run.status, run.wakeAt);

// And it resumes off the journal without re-running what it already did.
await run.advanceSleep();
console.log(run.status, run.output, run.deliveries);
```

**The agent form, from a project's own spec**

```ts no-check
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import agentDef from "virtual:aai/agent";

const run = await runWorkflow(agentDef, "digest", { url: "https://example.com/a" });
```

***

### schemaInputIssues()

```ts
function schemaInputIssues(
   schema: 
  | StandardSchemaV1<unknown, unknown>
  | undefined, 
   value: unknown, 
   what?: string
): Promise<
  | readonly StandardSchemaIssue[]
| undefined>;
```

The issues `schema` found in `value`, or `undefined` when it accepted it.

The negative half of [parseSchemaInput](#parseschemainput), and `undefined`-on-success is
deliberate: `expect(await schemaInputIssues(…)).toBeUndefined()` is the
accepting case and `…toBeDefined()` the refusing one, which is the pair every
hand-rolled site was already writing against `.issues`.

#### Parameters

##### schema

  \| [`StandardSchemaV1`](../aai/index.md#standardschemav1)\<`unknown`, `unknown`\>
  \| `undefined`

As [parseSchemaInput](#parseschemainput): `undefined` throws rather than
  reporting "no issues", which would make a negative test pass for a schema
  that does not exist.

##### value

`unknown`

##### what?

`string`

How the schema is named in that error.

#### Returns

`Promise`\<
  \| readonly [`StandardSchemaIssue`](../aai/index.md#standardschemaissue)[]
  \| `undefined`\>

#### Example

```ts no-check
import { schemaInputIssues } from "@alexkroman1/aai/testing";

expect(await schemaInputIssues(myWorkflow.input, { voice: "not-a-voice" })).toBeDefined();
```

***

### scriptedTextModel()

```ts
function scriptedTextModel(steps: readonly ScriptedTextStep[]): LanguageModel;
```

A `LanguageModel` that answers one scripted step per model call.

Hand it to `createTextAgent({ model })` — or to anything else that takes a
resolved model, which is what the studio's own coding-agent specs do — and the
turn takes the production path with nothing faked below the provider socket:
the real tool executor, the real `ctx`, the real step budget.

Past the end of the script it answers with an EMPTY step rather than throwing,
for the reason `createScriptedOneShotModel` gives: a turn that took one step
more than a spec expected should fail on the assertion that names the
difference, not on a fake running dry.

#### Parameters

##### steps

readonly [`ScriptedTextStep`](#scriptedtextstep)[]

One entry per model call, in order.

#### Returns

`LanguageModel`

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { createTextAgent } from "@alexkroman1/aai-runtime";
import { scriptedTextModel } from "@alexkroman1/aai-runtime/testing";

const chat = createTextAgent({
  agent: agent({ name: "Desk", mode: "text", systemPrompt: "Be brief." }),
  model: scriptedTextModel([
    { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
    { text: "It shipped yesterday." },
  ]),
});

const turn = chat.stream({ messages: [{ role: "user", content: "where is order 7?" }] });
for await (const delta of turn.textStream) console.log(delta);
```

***

### sessionEvent()

```ts
function sessionEvent<K extends SessionEventType>(type: K, ...rest: SessionEventRest<K>): SessionEvent<K>;
```

Build a well-formed session event of `type`, envelope included.

`meta.id` is minted as `evt_test_<n>` (the `evt_` prefix is what the wire
schema requires; the counter is per process and only has to be distinct) and
`meta.at` is a FIXED instant, for the reason `createRunSnapshot` fixes its
`createdAt`: a fixture that read the clock would not replay. Pass `meta` to
pin either.

The fields are TYPED by the name: `sessionEvent("tool.called", { … })` needs
`toolName`, `toolCallId` and `args`, and a misspelled field is a compile
error here rather than a handler reading `undefined`. An event that is only
its envelope takes no fields.

#### Type Parameters

##### K

`K` *extends* [`SessionEventType`](../aai/index.md#sessioneventtype)

#### Parameters

##### type

`K`

##### rest

...[`SessionEventRest`](#sessioneventrest)\<`K`\>

#### Returns

[`SessionEvent`](../aai/index.md#sessionevent)\<`K`\>

#### Example

```ts
import { sessionEvent } from "@alexkroman1/aai/testing";

const committed = sessionEvent("userTranscript.committed", { text: "two pizzas" });
committed.type; // "userTranscript.committed"
committed.meta.id.startsWith("evt_"); // true
// `sessionEvent("reply.completed").text` is a compile error: the event has no `text`.
```

***

### stubClientInbox()

```ts
function stubClientInbox(options?: StubClientInboxOptions): StubClientInbox;
```

Publish an inbox whose device records every notice and answers it.

#### Parameters

##### options?

[`StubClientInboxOptions`](#stubclientinboxoptions)

#### Returns

[`StubClientInbox`](#stubclientinbox)

***

### stubClientTranscript()

```ts
function stubClientTranscript(answer?: StubClientTranscriptAnswer): StubClientTranscript;
```

Publish a reader that answers every `stepClientTranscript` with `answer` —
a fixed transcript, or one computed per call (e.g. honouring the cursor).
Omitted, every client has said nothing.

#### Parameters

##### answer?

[`StubClientTranscriptAnswer`](#stubclienttranscriptanswer)

#### Returns

[`StubClientTranscript`](#stubclienttranscript)

***

### stubDelegate()

```ts
function stubDelegate(script: StubDelegateScript): StubDelegate;
```

Build a fake `ctx.delegate` from a script: one reply, or routes keyed by
subagent name.

Pass `{ reply }` to answer every delegation the same way, which is what a
one-subagent tool wants.

#### Parameters

##### script

[`StubDelegateScript`](#stubdelegatescript)

#### Returns

[`StubDelegate`](#stubdelegate)

#### Example

**Two subagents, one queue**

```ts
import { createToolContext, stubDelegate } from "@alexkroman1/aai/testing";

const findings = ["Rain on Tuesday.", "Clear on Wednesday."];
const desk = stubDelegate({
  routes: {
    researcher: () => ({ text: findings.shift() ?? "Nothing found.", steps: 3 }),
    "fact-checker": "Both claims check out.",
  },
});
const ctx = createToolContext({ delegate: desk.delegate });
// … run the tool, then assert on who was asked what:
// expect(desk.calls.map((call) => call.subagent.name)).toEqual([…]);
```

***

### stubFetchRoutes()

```ts
function stubFetchRoutes(routes: 
  | Readonly<Record<string, 
  | StubStepAnswer
  | FetchRouteHandler>>
  | readonly FetchRouteHandler[], options?: FetchRoutesOptions): StubFetchRoutes;
```

Install one router as the global `fetch` (and, by default, the published
step fetch), and return its log. Call `restore` when the test ends — in a
vitest spec, `onTestFinished(net.restore)` right after the call.

#### Parameters

##### routes

  \| `Readonly`\<`Record`\<`string`, 
  \| [`StubStepAnswer`](#stubstepanswer)
  \| [`FetchRouteHandler`](#fetchroutehandler)\>\>
  \| readonly [`FetchRouteHandler`](#fetchroutehandler)[]

A [FetchRouteTable](#fetchroutetable), or a list of handlers tried in
  order (the first that answers wins, and later ones are not consulted; a
  handler that throws is left alone). A catch-all leg goes LAST in a list.

##### options?

[`FetchRoutesOptions`](#fetchroutesoptions)

#### Returns

[`StubFetchRoutes`](#stubfetchroutes)

#### Example

```ts
import { stubFetchRoutes } from "@alexkroman1/aai/testing";

const net = stubFetchRoutes({
  "GET supabase.test": (req) => ({ body: req.searchParams.get("id") ? [{ id: 1 }] : [] }),
  "POST supabase.test": { status: 201 },
  "https://api.mem0.ai/v3/memories/": { body: { results: [] } },
});
await fetch("https://supabase.test/rest/v1/calls", { method: "POST", body: "{}" });
console.log(net.to("POST supabase.test").length); // 1
net.restore();
```

***

### stubGateway()

```ts
function stubGateway(replies: string | readonly string[], options?: StubGatewayOptions): StubGateway;
```

Build a fake LLM gateway answering `replies` in order, as a `fetch` for the
caller to install on the GLOBAL `fetch`.

Three names, one fake, picked by SEAM:

| You need | Use |
| --- | --- |
| the global `fetch`, installed and undone for you (vitest) | `installStubGateway` (`@alexkroman1/aai/testing/vitest`) |
| the global `fetch`, installed by you (any runner) | `stubGateway` — this |
| a published `stepFetch` that other fakes share (a page, a transcription) | [stubGatewayRoute](eval/vitest.md#stubgatewayroute-1), composed into `installStubStepFetch` |

The LAST reply repeats once the list runs out, so a spec names only the turns
it cares about — which is what makes this usable for a step whose model call
sits in a LOOP: a stub that says the same thing every turn can only ever drive
such a loop into its budget, and one that runs out mid-loop fails on the stub
rather than on the code.

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order. A bare string is one reply.

##### options?

[`StubGatewayOptions`](#stubgatewayoptions)

#### Returns

[`StubGateway`](#stubgateway)

#### Example

```ts no-check
// `no-check`: the step under test is in another file, which is the point.
import { stubGateway } from "@alexkroman1/aai/testing";
import { expect, test, vi } from "vitest";
import { summarize } from "./workflows/digest.ts";

test("summarize sends the article and returns the headline", async () => {
  const gateway = stubGateway(['{"headline":"Otters use tools"}']);
  vi.stubGlobal("fetch", gateway.fetch);
  vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");

  expect(await summarize("Otters use tools.")).toEqual({ headline: "Otters use tools" });
  expect(gateway.calls[0]?.prompt).toContain("Otters use tools.");
});
```

***

### stubGenerate()

```ts
function stubGenerate(script: StubGenerateScript): StubGenerate;
```

Build a fake `ctx.generate` from a script: one reply, or routes keyed by
system prompt.

A call whose system prompt names no route throws, naming it — an unscripted
model call is a spec that has drifted from the tool, not a case to paper over.
Pass `{ reply }` to answer every call the same way, which is what a one-model
tool wants.

#### Parameters

##### script

[`StubGenerateScript`](#stubgeneratescript)

#### Returns

[`StubGenerate`](#stubgenerate)

#### Examples

**Two model roles, one queue**

```ts
import { createToolContext, stubGenerate } from "@alexkroman1/aai/testing";

const verdicts = ["yes", "no"];
const model = stubGenerate({
  routes: {
    "You grade documents.": () => ({ object: { score: verdicts.shift() ?? "yes" } }),
    "You answer questions.": "The documented answer.",
  },
});
const ctx = createToolContext({ generate: model.generate });
// … run the tool, then assert on the roles it played:
// expect(model.calls.map((call) => call.system)).toEqual([…]);
```

**One model role**

```ts
import { stubGenerate } from "@alexkroman1/aai/testing";

const model = stubGenerate({ reply: { object: { steps: ["Only step"] } } });
const answerer = stubGenerate({ reply: "The documented answer." });
```

***

### stubPlaceCall()

```ts
function stubPlaceCall(options?: StubPlaceCallOptions): StubPlaceCall;
```

Publish a Twilio whose Calls API records every dial and answers it.

#### Parameters

##### options?

[`StubPlaceCallOptions`](#stubplacecalloptions)

#### Returns

[`StubPlaceCall`](#stubplacecall)

#### Example

```ts
import { stubPlaceCall } from "@alexkroman1/aai/testing";

const twilio = stubPlaceCall({ status: (call) => (call.polls < 2 ? "ringing" : "completed") });
// … run the workflow, then read what it dialled, as the answering session sees it:
console.log(twilio.calls[0]?.parameters.call);
twilio.restore(); // in an `afterEach`
```

***

### stubReporter()

```ts
function stubReporter(): StubReporter;
```

Capture what a step narrates and emits.

`stepReport()` and `stepEmit()` both go through a published slot, and with nothing
published they fall back to the console — which is right for a step under test
that nobody is asserting on, and useless the moment the narration IS the
subject. It is for a step whose partial results are part of its contract: a
fan-out that emits each segment as it lands has a page depending on the shape
of those chunks, and nothing else in a spec can see them.

The two are separated the way the streams are, so a spec asserting a chunk
never has to filter the sentences out of it.

```ts no-check
const reported = stubReporter();
afterEach(reported.restore);

await transcribeSegment(uploadId, format, segment);
expect(reported.emitted).toEqual([
  { namespace: "transcript", chunk: { index: 0, text: "hello there" } },
]);
```

Publishing REPLACES, so a spec that forgets to restore leaves this one
answering the next file's steps — the same rule [stubStepFetch](#stubstepfetch) follows,
and the same remedy.

#### Returns

[`StubReporter`](#stubreporter)

***

### stubSpeech()

```ts
function stubSpeech(options?: StubSpeechOptions): StubSpeech;
```

Publish a synthesizer that records what it was asked to say and answers with
silence.

Silence rather than a tone, because nothing downstream of a step listens: a
spec asserts on the TEXT that was spoken, the duration, and where the bytes
went. Generating audible audio would only make the fixtures bigger.

#### Parameters

##### options?

[`StubSpeechOptions`](eval/vitest.md#stubspeechoptions)

#### Returns

[`StubSpeech`](eval/vitest.md#stubspeech)

***

### stubStepDelegate()

```ts
function stubStepDelegate(script: StubDelegateScript): StubStepDelegate;
```

PUBLISH a fake runner, so an exported step that calls `stepDelegate` can be
driven without a host.

`stubDelegate` with the slot filled in, and deliberately nothing more: the
step-side and tool-side capabilities have the same signature because they are
the same runner bound differently, so a spec routes them the same way and a
template that moves a subagent from a tool into a step rewrites no fake.

An unpublished slot THROWS rather than degrading (see `sdk/step-delegate.ts`),
which is what makes this the ONE way to test such a step — and why the failure
an author meets first names this function.

#### Parameters

##### script

[`StubDelegateScript`](#stubdelegatescript)

#### Returns

[`StubStepDelegate`](eval/vitest.md#stubstepdelegate)

#### Example

```ts
import { stubStepDelegate } from "@alexkroman1/aai/testing";

const desk = stubStepDelegate({ routes: { researcher: "Prices fell 12% in 2025." } });
try {
  // … call the exported step, then assert on `desk.calls`
} finally {
  desk.restore();
}
```

***

### stubStepFetch()

```ts
function stubStepFetch(answer?: (request: StubStepRequest) => 
  | StubStepAnswer
  | Promise<StubStepAnswer>): StubStepFetch;
```

Publish a fake `stepFetch`, so a step's HTTP can be asserted
without a server and without stubbing a global.

A step's outbound call goes through a process-wide slot rather than
`globalThis.fetch` (see `stepFetch` on `@alexkroman1/aai/step` for why —
HTTP/1.1 pinning, and a fan-out that breaks on HTTP/2 stream resets), so this is the honest way to
intercept it. `vi.stubGlobal("fetch", …)` still works, because an unpublished
slot falls back to the global; it just tests a path production does not take,
and it cannot see the request BODY as bytes.

`answer` may return a `Response`, or a `{ status, body, headers }` shorthand,
or throw — a throw is what a connection failure looks like, and `stepFetch`
wraps it in a `StepTransportError` exactly as it would in production.

Returns `restore`, and calling it in an `afterEach` is not optional — a fetch
left published makes the next file's steps answer to this one's handler.
`installStubStepFetch` (`@alexkroman1/aai/testing/vitest`) is the same fake
with that registration already done.

#### Parameters

##### answer?

(`request`: [`StubStepRequest`](#stubsteprequest)) => 
  \| [`StubStepAnswer`](#stubstepanswer)
  \| `Promise`\<[`StubStepAnswer`](#stubstepanswer)\>

Called per request with the recorded request. Defaults to an
  empty `200`.

#### Returns

[`StubStepFetch`](eval/vitest.md#stubstepfetch)

#### Example

```ts no-check
// `no-check`: the assertion is the point, and a doc example may not import a
// test runner — the same reason `createToolContext`'s example opts out.
import { stubStepFetch } from "@alexkroman1/aai/testing";

const sync = stubStepFetch(() => ({ body: { text: "hello there" } }));
// … call the step …
expect(sync.calls[0]?.headers.Authorization).toBe("sk-test");
sync.restore();
```

***

### stubStepInfo()

```ts
function stubStepInfo(step: {
  attempt?: number;
  maxAttempts?: number;
  name?: string;
}): {
  restore: () => void;
};
```

Answer `stepInfo()` for the step under test, so a body's RETRY branch is
reachable from a spec.

A step that degrades on its last attempt has two paths and a spec could only
ever take one: outside a run `stepInfo()` answers `undefined`, which a body
reads as "not retrying". So the branch that exists precisely for the case that
goes wrong was the branch no test could enter — and it is the one whose
failure is quiet, since a body that mis-reads the ceiling degrades early on
every run and still returns an answer.

```ts
import { stubStepInfo } from "@alexkroman1/aai/testing";
import { onTestFinished, expect, test } from "vitest";

declare function summarizeChapter(text: string): Promise<string>;

test("falls back to the cheap model on the last attempt", async () => {
  const stub = stubStepInfo({ attempt: 3, maxAttempts: 3 });
  onTestFinished(stub.restore);
  expect(await summarizeChapter("…")).toContain("…");
});
```

`isLastAttempt` is DERIVED from the two numbers rather than accepted, for the
reason the real reader derives it: a fake that let a spec set `attempt: 1` and
`isLastAttempt: true` would let a body pass against a state no run can be in.

Publishing REPLACES, so a spec that forgets to restore leaves this answering
the next file's steps — the same rule [stubReporter](#stubreporter-1) follows, and the
same remedy.

#### Parameters

##### step

###### attempt?

`number`

1-based. Defaults to 1.

###### maxAttempts?

`number`

Defaults to whichever is larger of 3 (the SDK's own default) and `attempt`.

###### name?

`string`

Defaults to `"step"`.

#### Returns

```ts
{
  restore: () => void;
}
```

##### restore

```ts
() => void
```

***

### stubTranscribe()

```ts
function stubTranscribe(options?: StubTranscribeOptions): StubTranscribe;
```

Answer AssemblyAI's transcription endpoints in memory, and record what was
sent.

Covers all four calls — the async trio (`stepTranscribeUpload`,
`stepTranscribeSubmit`, `stepTranscribePoll`) and `stepTranscribeSync` — so a
workflow that uploads, submits, polls and reads is testable end to end without
naming `upload_url`, `audio_duration` or `status: "completed"` anywhere in the
spec.

What it does NOT do is stand in for the upload STORE: `stepTranscribeUpload`
streams the recording out of the app's own store, so a spec still publishes
one with `stubUploads`. The two fakes fill different slots and compose.

#### Parameters

##### options?

[`StubTranscribeOptions`](eval/vitest.md#stubtranscribeoptions)

#### Returns

[`StubTranscribe`](eval/vitest.md#stubtranscribe)

#### Examples

**A whole async job, in one line of setup**

```ts no-check
// `no-check`: the workflow under test is in another file, which is the point.
import { stubTranscribe, stubUploads } from "@alexkroman1/aai/testing";

const uploads = stubUploads({ upl_1: new Uint8Array(5000) });
const provider = stubTranscribe({ text: "we ship tuesday", durationSec: 42 });

expect(await transcribeRecording("upl_1")).toBe("we ship tuesday");
// The file really streamed: `stubStepFetch` drains the body into bytes.
expect(provider.calls.find((call) => call.leg === "upload")?.body).toBeInstanceOf(Uint8Array);

provider.restore();
uploads.restore();
```

**A rate limit, classified by the SDK rather than by the fake**

```ts no-check
const provider = stubTranscribe({
  failure: { leg: "sync", status: 429, retryAfterSeconds: 30 },
});
// `toStepError` reads `retryable` and `retryAfter` off the real TranscribeError.
await expect(transcribeSegment("upl_1", segment)).rejects.toBeInstanceOf(RetryableError);
```

***

### stubUploads()

```ts
function stubUploads(files: Readonly<Record<string, StubUpload>>, options?: StubUploadsOptions): StubUploads;
```

Publish an in-memory upload store, so a step that calls
`stepReadUpload` can be tested without a server.

A step reads uploads through a process-wide slot rather than dialling
anything, which is what makes this possible at all: a spec supplies its own
bytes and the step under test is unchanged.

Returns a [StubUploads](eval/vitest.md#stubuploads) — `restore`, plus what a step WROTE. Calling
`restore` in an `afterEach` is not optional; a store left published makes the
next file's steps read this one's bytes, which is the kind of cross-file leak
that presents as a passing test somewhere else.

#### Parameters

##### files

`Readonly`\<`Record`\<`string`, [`StubUpload`](#stubupload)\>\>

Keyed by upload id — the same string a run input would carry.

##### options?

[`StubUploadsOptions`](eval/vitest.md#stubuploadsoptions)

#### Returns

[`StubUploads`](eval/vitest.md#stubuploads)

#### Examples

```ts
import { stubUploads } from "@alexkroman1/aai/testing";

const uploads = stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
// … call the step …
uploads.restore();

// A streamed upload mid-flight: `stepReadUpload` comes back short and
// `stepUploadInfo(...).complete` is false, which is what a polling body sees.
const firstHalf = new Uint8Array([1, 2]);
stubUploads({ upl_2: { bytes: firstHalf, complete: false } }).restore();
```

**What a step wrote, without reading it back through the slot**

```ts no-check
const uploads = stubUploads({}, { writable: true });
// … call the step …
expect(uploads.writes.map((one) => one.name)).toEqual(["summary.wav"]);
```

***

### toolInputIssues()

```ts
function toolInputIssues(
   agent: ToolBearingAgent, 
   name: string, 
   value: unknown
): Promise<
  | readonly StandardSchemaIssue[]
| undefined>;
```

The issues the tool `name`'s input schema found in `value`, or `undefined`.

The negative half of [parseToolInput](#parsetoolinput) — the assertion behind "a mood
outside the enum is refused by the schema", which is the one thing standing
between an LLM's untyped tool call and the tool body.

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

##### name

`string`

##### value

`unknown`

#### Returns

`Promise`\<
  \| readonly [`StandardSchemaIssue`](../aai/index.md#standardschemaissue)[]
  \| `undefined`\>

#### Throws

When the agent declares no such tool, or when it declares no
  `inputSchema`. A tool that takes no arguments accepts anything, and saying
  so out loud beats answering `undefined` — which reads as "accepted".

#### Example

```ts no-check
import { toolInputIssues } from "@alexkroman1/aai/testing";

expect(await toolInputIssues(agentDef, "recommend", { mood: "melancholy" })).toBeDefined();
```

***

### toolNameOf()

```ts
function toolNameOf(def: ToolDef<ToolInputSchema>): string;
```

The name the model calls `def` by — the `tools/<name>.ts` file it was
discovered from.

Only a def a DEPLOYED agent registered has one: import the agent as
`virtual:aai/agent` under vitest, or lower it with `deployedAgent`, before
reading a tool by its def. A def built inline in a spec has never been a
file, so it has no name, and the throw says so.

#### Parameters

##### def

[`ToolDef`](../aai/index.md#tooldef)\<[`ToolInputSchema`](../aai/index.md#toolinputschema)\>

#### Returns

`string`

#### Throws

When `def` was never registered by a deployed agent.

#### Example

```ts no-check
import agentDef from "virtual:aai/agent";
import placeOrder from "./tools/place_order.ts";
import { toolNameOf } from "@alexkroman1/aai/testing";

void agentDef; // importing the deployed agent is what records the names
toolNameOf(placeOrder); // "place_order"
```

***

### toolOf()

```ts
function toolOf(agent: ToolBearingAgent, name: string): ToolDef;
```

The tool `name` is declared under, or a throw naming the ones that are.

Three names for three jobs: `toolOf` hands back the DEF, to assert on what
the agent declares (its description, its schema); [runTool](#runtool) CALLS a
tool, gated as the runtime gates it; [toolRunner](#toolrunner-1) is `runTool` with the
agent bound, the `run(name, …)` a spec calls throughout. All three resolve
through one lookup (`resolveEntry`), by name or by the def's identity.

A tool is a FILE, so `agent.ts`'s default export declares no tools at all —
import the agent as DEPLOYED, exactly as this example does and as every
shipped template's spec does: `virtual:aai/agent` under vitest, or
`deployedAgent` (`@alexkroman1/aai/testing`) under any other runner. Handing
this the authored def directly is the common mistake, and it fails with
"(none)".

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

##### name

`string`

#### Returns

[`ToolDef`](../aai/index.md#tooldef)

#### Example

```ts
import agentDef from "virtual:aai/agent";
import { toolOf } from "@alexkroman1/aai/testing";
import { expect } from "vitest";

expect(toolOf(agentDef, "add_item").description).toContain("cart");
```

***

### toolRunner()

```ts
function toolRunner(agent: ToolBearingAgent): ToolRunner;
```

[runTool](#runtool) bound to one agent — the `run(...)` a spec actually calls.

A spec drives one agent, so `agentDef` is the same in every call and the name
is the thing that varies. Every shipped template therefore opened with the
same wrapper:

```ts no-check
const run = (name: string, argsOrCtx?: Record<string, unknown> | ToolContext, ctx?: ToolContext) =>
  runTool(agentDef, name, argsOrCtx, ctx);
```

Ten of them, and [runTool](#runtool)'s own documentation named that wrapper as how
every template reaches it — which is the point at which the wrapper is part of
the API and belongs in it. `const run = toolRunner(agentDef);` is the same
thing in one line.

**The union is what is worth removing, not the line.** A spec that writes the
signature out has to restate `Record<string, unknown> | ToolContext` to
forward both of `runTool`'s shapes — arguments, or the context in their place
for a tool that takes none — and a spec that narrows it to
`(name: string, args: Record<string, unknown>)` has quietly given up the
second shape. Four templates had; three of those then passed `{}` by hand
where the whole point of the shorter form is not having to. Binding the agent
keeps the union in one place, where it stays right.

The runner is stateless and holds only the agent, so one per spec file at the
top level is the shape: each call still defaults to a FRESH context, i.e. a
distinct session with empty slots. Pass a context explicitly wherever the
second call is meant to see the first call's work — see [runTool](#runtool).

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

#### Returns

[`ToolRunner`](#toolrunner)

#### Example

```ts
import agentDef from "virtual:aai/agent";
import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
import { expect } from "vitest";

const run = toolRunner(agentDef);

expect(await run("add_item", { item: "apple" })).toEqual({ added: "apple" });

// No arguments, one session shared across the two calls.
const ctx = createToolContext();
await run("add_item", { item: "apple" }, ctx);
expect(await run("view_order", ctx)).toEqual({ items: ["apple"] });
```

**Handed the tool's DEF instead of its name, the run is TYPED.** The def is
the tool file's default export — the object the deployed agent registered —
so it is found in the table by identity and the result keeps the type its
`execute` declares, gate included:

```ts no-check
import addItem from "./tools/add_item.ts";

const { added } = await run(addItem, { item: "apple" }); // typed: `added` is a string
```

**A runner over an agent with NO tools is refused HERE**, rather than at the
first `run(...)`. A tool is a file, so `agent.ts`'s default export declares an
empty table and every call through such a runner fails identically — the
mistake is the argument on this line, and reporting it at a call site several
dozen lines away names the symptom instead. It is the one shape that cannot be
a legitimate runner: a runner exists to reach tools by name, and there are no
names to reach. Reach for [toolOf](#toolof) or [runTool](#runtool) directly if a spec
really means to assert on an empty table.

## Interfaces

### DeployedConfig

**`Sealed`**

What [expectDeployable](#expectdeployable) hands back: the RESOLVED config a deploy
carries, narrowed to the fields a starter spec asserts on.

Not the whole `AgentConfig`, on purpose. That type is inferred from the
canonical config SCHEMA, so returning it put the schema — every serializable
agent field, each with its own validation shape — into this subpath's
contract, and a new agent field moved a TEST helper's hash. These are the
fields the shipped specs read; the object returned is the real config, so a
spec that needs one more can read it off `toAgentConfig`
(`@alexkroman1/aai/manifest`) directly.

`mode` is always present: [expectDeployable](#expectdeployable) refuses a conversion that
derived none.

#### Properties

##### builtinTools?

```ts
readonly optional builtinTools?: readonly BuiltinTool[];
```

The builtins the agent declares (absent: the default surface).

##### llm?

```ts
readonly optional llm?: DeployedStage;
```

The LLM stage — declared, or the injected default in pipeline mode.

##### mcpServers?

```ts
readonly optional mcpServers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
```

The MCP servers whose tools join the agent's own, by key.

##### mode

```ts
readonly mode: AgentMode;
```

The agent's mode, as the deploy carries it.

##### name

```ts
readonly name: string;
```

The name the platform lists the agent under.

##### requiredEnv?

```ts
readonly optional requiredEnv?: readonly string[];
```

The env var names a deploy preflights.

##### s2s?

```ts
readonly optional s2s?: DeployedStage;
```

The speech-to-speech descriptor, for an s2s agent.

##### stt?

```ts
readonly optional stt?: DeployedStage;
```

The STT stage — declared, or the injected default in pipeline mode.

##### systemPrompt

```ts
readonly systemPrompt: string;
```

The system prompt a deploy carries — the author's string, or the framework
default when there is none. A RESOLVER is not carried (it cannot be
serialized), so an agent with one reads the default here.

##### tts?

```ts
readonly optional tts?: DeployedStage;
```

The TTS stage — declared, or the injected default in pipeline mode.

##### turnTaking?

```ts
readonly optional turnTaking?: {
  detection?: string;
};
```

Pipeline turn-taking — `detection: "manual"` is push-to-talk.

###### detection?

```ts
readonly optional detection?: string;
```

##### usageLimits?

```ts
readonly optional usageLimits?: {
  totalTokens?: number;
};
```

The session's token budget, when it declares one.

###### totalTokens?

```ts
readonly optional totalTokens?: number;
```

***

### DeployedStage

**`Sealed`**

One provider stage of a [DeployedConfig](#deployedconfig) — the descriptor as it will be
deployed: its `kind`, and its `options` exactly as serialized.

#### Properties

##### kind

```ts
readonly kind: string;
```

The provider the stage resolves through, e.g. `"assemblyai"`.

##### options?

```ts
readonly optional options?: Readonly<Record<string, unknown>>;
```

The descriptor's options, as they cross the wire.

***

### SaidLine

**`Sealed`**

One `ctx.speech.say` a [createToolContext](#createtoolcontext) context recorded.

#### Properties

##### interrupt

```ts
readonly interrupt: boolean;
```

Whether it asked to cut the agent off first (`{ interrupt: true }`).

##### interruptible

```ts
readonly interruptible: boolean;
```

`false` when it asked not to be cut off by the caller (`{ interruptible: false }`).

##### record

```ts
readonly record: boolean;
```

`false` when it asked to stay out of history (`{ record: false }`).

##### text

```ts
readonly text: string;
```

The text, exactly as passed.

***

### SentEvent

**`Sealed`**

One `ctx.send(event, data)` call that would REACH the client, as recorded by
[createToolContext](#createtoolcontext) — see the `send` default for what is left out.

#### Properties

##### data

```ts
data: unknown;
```

##### event

```ts
event: string;
```

***

### StubDelegate

**`Sealed`**

A fake `ctx.delegate`: the function to pass, and what it was asked.

#### Properties

##### calls

```ts
calls: StubDelegateCall[];
```

Every call, in order.

##### delegate

```ts
delegate: DelegateFn;
```

Pass as `delegate` to `createToolContext`.

***

### StubDelegateCall

**`Sealed`**

One `ctx.delegate` call, as recorded by [stubDelegate](#stubdelegate-1).

#### Properties

##### options

```ts
options: DelegateOptions;
```

The whole options object, for asserting `context` and `maxSteps`.

##### subagent

```ts
subagent: SpeakerDef;
```

The subagent that was asked.

##### task

```ts
task: string;
```

The task it was given.

***

### StubGateway

**`Sealed`**

A fake gateway: the `fetch` to install, and what it was asked.

#### Properties

##### calls

```ts
calls: StubGatewayCall[];
```

Every request, in call order.

##### fetch

```ts
fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
```

Install with `vi.stubGlobal("fetch", gateway.fetch)`.

###### Parameters

###### url

`string` \| `URL` \| `Request`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

***

### StubGatewayCall

**`Sealed`**

One request a [StubGateway](#stubgateway) answered.

#### Properties

##### body

```ts
body: Record<string, unknown>;
```

The whole decoded request body, for asserting model, temperature, …

##### headers

```ts
headers: Record<string, string>;
```

The request headers, lower-cased.

Worth asserting rather than assuming: the gateway is OpenAI-compatible and
takes the key as a `Bearer`, where AssemblyAI's streaming sockets take it
raw — and getting that backwards is a 401 that reads like a wrong key.

##### prompt

```ts
prompt: string;
```

The user message — what the step actually asked.

##### system

```ts
system: string | undefined;
```

The system instruction, or `undefined` when the step sent none.

##### url

```ts
url: string;
```

The endpoint the call went to, so a spec can assert the gateway URL.

***

### StubGatewayOptions

**`Input`**

Options for [stubGateway](#stubgateway-1).

#### Properties

##### headers?

```ts
optional headers?: Record<string, string>;
```

Extra response headers — `Retry-After` is the one specs reach for.

##### status?

```ts
optional status?: number;
```

HTTP status to answer with. Defaults to 200. A non-2xx answers with an
error body, which is what `stepGenerate` (`@alexkroman1/aai/step`)
quotes back in its `StepGenerateError`.

***

### StubGenerate

**`Sealed`**

A fake `ctx.generate`: the function to pass, and what it was asked.

#### Properties

##### calls

```ts
calls: StubGenerateCall[];
```

Every call, in order.

##### generate

```ts
generate: GenerateFn;
```

Pass as `generate` to `createToolContext`.

***

### StubGenerateCall

**`Sealed`**

One `ctx.generate` call, as recorded by [stubGenerate](#stubgenerate-1).

#### Properties

##### options

```ts
options: GenerateOptions;
```

The whole options object, for asserting `llm`, `temperature`, `schema`, …

##### prompt

```ts
prompt: string;
```

The user prompt — what the tool actually asked.

##### system

```ts
system: string | undefined;
```

The system instruction, or `undefined` when the call carried none.

***

### TextAgentOptions

**`Input`**

Session-fixed configuration for `createTextAgent`.

The fields every way of running an agent shares are [HostAgentOptions](eval.md#hostagentoptions).
Here: `agent` must declare `mode: "text"`; `providerEnv` defaults to `env`, split
for the reason `RuntimeOptions` splits them (a host-fallback env may resolve a
model and must never become `ctx.env`); an absent `workflows` substitutes a
client that rejects with the reason; `fetch` is for tests (see
`BuiltinToolOptions`); `logger` defaults to `consoleLogger`; and a text agent
whose tools install packages or type-check a workspace wants a larger
`toolTimeoutMs` than the 30s voice-turn default.

#### Extends

- [`HostAgentOptions`](eval.md#hostagentoptions)

#### Properties

##### agent

```ts
agent: AgentDef;
```

The agent to run — an ordinary `agent()` definition.

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`agent`](eval.md#agent-2)

##### db?

```ts
optional db?: Db;
```

Accepted and currently UNUSED — a text agent's tools receive no database.
There is no `ctx.db`: the context this builds carries the same eleven
fields a voice session's tools get, none of them a SQL handle. Kept on the
options bag so a caller that already passes one still compiles.

##### env?

```ts
optional env?: AgentEnv;
```

Tenant-owned env: what tool code reads as `ctx.env`, and — unless
`providerEnv` overrides it — where the LLM credential is read from.

##### fetch?

```ts
optional fetch?: {
  (input: URL | RequestInfo, init?: RequestInit): Promise<Response>;
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
};
```

The `fetch` the builtin web tools use (web_search, visit_webpage,
get_page_design, fetch_json). Defaults to an SSRF-screened fetch. Pass one
to keep a spec or an eval case off the network.

###### Call Signature

```ts
(input: URL | RequestInfo, init?: RequestInit): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

###### Parameters

###### input

`URL` \| `RequestInfo`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

###### Call Signature

```ts
(input: string | URL | Request, init?: RequestInit): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

###### Parameters

###### input

`string` \| `URL` \| `Request`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`fetch`](eval.md#fetch-2)

##### logger?

```ts
optional logger?: Logger;
```

Structured logger. Each entry point documents its own default.

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`logger`](eval.md#logger-2)

##### model?

```ts
optional model?: LanguageModel;
```

Pre-resolved model, bypassing descriptor resolution entirely. For a
caller that already holds a `LanguageModel` (and for tests, which is the
majority use — a text agent's whole observable behaviour is what it
sends the model).

##### onEvent?

```ts
optional onEvent?: (event: SessionEvent) => void;
```

Where this conversation's typed events go — the same [SessionEvent](../aai/index.md#sessionevent)
stream a voice session emits, narrowed to what a text agent can honestly
report, so every reader in `@alexkroman1/aai-runtime/eval` and every
assertion built on them works over a text turn unchanged.

ADDITIVE, and deliberately so: [TextAgent.stream](https://github.com/alexkroman/agent/tree/main/packages/aai-runtime#readme) still returns the
vendor's `StreamTextResult` and nothing about it changes. A chat surface
consumes that; this is for whoever is GRADING or auditing the agent.
`text-agent/events.ts` carries which events are emitted, which eleven are
not, and why the turn terminator fires exactly once.

**Conversation-scoped, and the envelope carries no turn coordinate** (see
`protocol-events.ts`, which argues that absence), so two overlapping
`stream()` calls on ONE text agent interleave into one stream with nothing
to tell them apart. A caller that needs them separate builds a text agent
per turn — which is what `runTextAgent` does.

###### Parameters

###### event

[`SessionEvent`](../aai/index.md#sessionevent)

###### Returns

`void`

##### providerEnv?

```ts
optional providerEnv?: ProviderEnv;
```

Where provider credentials (STT/TTS/LLM) are resolved from, when that is
not the agent's own env.

Exists so a host can let shell-exported credentials reach the provider
resolvers without also placing them in `ctx.env`, where agent tool code
could read them and come to depend on host-level variables that do not
exist in production. Each entry point documents its own default.

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`providerEnv`](eval.md#providerenv-2)

##### runCode?

```ts
optional runCode?: RunCodeExecutor;
```

Isolated executor for the `run_code` builtin: the guest's in-sandbox one on
the platform, or the zero-permission Deno one `aai dev`/`aai start` pass
under `AAI_RUN_CODE=deno`. Without one the builtin is registered and
permanently refuses — nothing here evaluates code in the host process.

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`runCode`](eval.md#runcode-2)

##### sessionId?

```ts
optional sessionId?: string;
```

Conversation identity for `ctx.sessionId` and the session's `slots`.
Defaults to a fresh id per text agent — one instance is one conversation,
which is what makes a slot mean the same thing here as in a session.

##### toolTimeoutMs?

```ts
optional toolTimeoutMs?: number;
```

Per-tool-call deadline. Defaults to `TOOL_EXECUTION_TIMEOUT_MS` (30s),
which is a VOICE-turn budget: a caller waiting on speech has left by then.
A tool whose work legitimately outruns it — a graded retrieval loop making
eleven model calls, measured at 22-30s — needs this raised, and that is the
caller's trade to make.

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`toolTimeoutMs`](eval.md#tooltimeoutms-2)

##### workflows?

```ts
optional workflows?: WorkflowClient;
```

`ctx.workflows`, supplied rather than built — what a tool that starts a
durable run calls.

Absent, a workflow-declaring agent gets the client the runtime assembles
itself, which is what every deployment wants. An eval supplies the
in-process client `openEvalWorkflows` builds, because a `"use workflow"`
body imported through a test runner was never through the compiler's
transform and the real engine cannot start it.

###### Inherited from

[`HostAgentOptions`](eval.md#hostagentoptions).[`workflows`](eval.md#workflows-2)

***

### TextTurnOptions

**`Input`**

Per-turn parameters for [TextAgent.stream](https://github.com/alexkroman/agent/tree/main/packages/aai-runtime#readme).

#### Properties

##### maxSteps?

```ts
optional maxSteps?: number;
```

Overrides the agent's `maxSteps` for this turn.

##### messages

```ts
messages: ModelMessage[];
```

The conversation so far, in AI SDK `ModelMessage` form.

##### onStepFinish?

```ts
optional onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
```

Fires after each completed step, with that step's result.

###### Parameters

###### step

`StepResult`\<`ToolSet`\>

###### Returns

`void` \| `Promise`\<`void`\>

##### prepareStep?

```ts
optional prepareStep?: PrepareStepFunction<ToolSet>;
```

Per-step hook, composed WITH this module's own: whatever it returns is
applied first, and the forced final answer is layered over the result, so
a caller may rewrite the step's messages (compaction, an injected notice)
without being able to hand the model tools on the step the budget
reserved for answering.

##### signal?

```ts
optional signal?: AbortSignal;
```

Aborts the LLM stream and every in-flight tool call.

##### stopWhen?

```ts
optional stopWhen?: readonly (options: {
  steps: readonly StepResult<ToolSet>[];
}) => boolean | PromiseLike<boolean>[];
```

Extra stop conditions, ANDed into the step budget as alternatives — a
wall-clock deadline is the usual one, since a step cap says nothing
about how long a caller waits.

##### systemPrompt?

```ts
optional systemPrompt?: string;
```

Overrides the agent's `systemPrompt` for this turn.

##### temperature?

```ts
optional temperature?: number;
```

Overrides the agent's `temperature` for this turn.

##### toolChoice?

```ts
optional toolChoice?: ToolChoice;
```

Overrides the agent's `toolChoice` for this turn.

***

### ToolRunner()

**`Sealed`**

What [toolRunner](#toolrunner-1) hands back: [runTool](#runtool) with the agent already
supplied.

Two call shapes, told apart by the first argument:

- **The tool DEF — typed end to end.** `run(addItem, { item: "apple" })`
  checks the arguments against what `execute` takes and answers what it
  returns, so a spec reads fields off the result with no cast. The def is
  resolved in the agent's table by IDENTITY (a `tools/<name>.ts` default
  export IS the registered object), so the call still goes through the
  toolset's GATE — a dialog out of state refuses it, a roster entry not on
  the line refuses it — exactly as the name form does. A def the agent does
  not declare throws naming the tools it does.
- **The NAME — answers `unknown`.** `run("add_item", …)` is the form the
  model's own call takes; a name is a string, so nothing can type what it
  looks up. Claim the shape with `expectToolOk<T>(…)`, or reach for the def
  form.

Both take the arguments-or-context union [runTool](#runtool) documents: a tool
that takes none may be handed the context in their place.

Named so a caller can annotate a helper that takes one, and so the union in
the second position is written down once here rather than at every call site
that binds it.

#### Call Signature

```ts
ToolRunner<T extends {
  execute: (...args: never[]) => unknown;
}>(
   tool: T, 
   argsOrCtx?: 
  | ToolContext
  | Parameters<T["execute"]>[0], 
   ctx?: ToolContext
): Promise<Awaited<ReturnType<T["execute"]>>>;
```

**`Sealed`**

What [toolRunner](#toolrunner-1) hands back: [runTool](#runtool) with the agent already
supplied.

Two call shapes, told apart by the first argument:

- **The tool DEF — typed end to end.** `run(addItem, { item: "apple" })`
  checks the arguments against what `execute` takes and answers what it
  returns, so a spec reads fields off the result with no cast. The def is
  resolved in the agent's table by IDENTITY (a `tools/<name>.ts` default
  export IS the registered object), so the call still goes through the
  toolset's GATE — a dialog out of state refuses it, a roster entry not on
  the line refuses it — exactly as the name form does. A def the agent does
  not declare throws naming the tools it does.
- **The NAME — answers `unknown`.** `run("add_item", …)` is the form the
  model's own call takes; a name is a string, so nothing can type what it
  looks up. Claim the shape with `expectToolOk<T>(…)`, or reach for the def
  form.

Both take the arguments-or-context union [runTool](#runtool) documents: a tool
that takes none may be handed the context in their place.

Named so a caller can annotate a helper that takes one, and so the union in
the second position is written down once here rather than at every call site
that binds it.

##### Type Parameters

###### T

`T` *extends* \{
  `execute`: (...`args`: `never`[]) => `unknown`;
\}

##### Parameters

###### tool

`T`

###### argsOrCtx?

  \| [`ToolContext`](../aai/index.md#toolcontext)
  \| `Parameters`\<`T`\[`"execute"`\]\>\[`0`\]

###### ctx?

[`ToolContext`](../aai/index.md#toolcontext)

##### Returns

`Promise`\<`Awaited`\<`ReturnType`\<`T`\[`"execute"`\]\>\>\>

#### Call Signature

```ts
ToolRunner(
   name: string, 
   argsOrCtx?: 
  | Record<string, unknown>
  | ToolContext, 
   ctx?: ToolContext
): Promise<unknown>;
```

**`Sealed`**

What [toolRunner](#toolrunner-1) hands back: [runTool](#runtool) with the agent already
supplied.

Two call shapes, told apart by the first argument:

- **The tool DEF — typed end to end.** `run(addItem, { item: "apple" })`
  checks the arguments against what `execute` takes and answers what it
  returns, so a spec reads fields off the result with no cast. The def is
  resolved in the agent's table by IDENTITY (a `tools/<name>.ts` default
  export IS the registered object), so the call still goes through the
  toolset's GATE — a dialog out of state refuses it, a roster entry not on
  the line refuses it — exactly as the name form does. A def the agent does
  not declare throws naming the tools it does.
- **The NAME — answers `unknown`.** `run("add_item", …)` is the form the
  model's own call takes; a name is a string, so nothing can type what it
  looks up. Claim the shape with `expectToolOk<T>(…)`, or reach for the def
  form.

Both take the arguments-or-context union [runTool](#runtool) documents: a tool
that takes none may be handed the context in their place.

Named so a caller can annotate a helper that takes one, and so the union in
the second position is written down once here rather than at every call site
that binds it.

##### Parameters

###### name

`string`

###### argsOrCtx?

  \| `Record`\<`string`, `unknown`\>
  \| [`ToolContext`](../aai/index.md#toolcontext)

###### ctx?

[`ToolContext`](../aai/index.md#toolcontext)

##### Returns

`Promise`\<`unknown`\>

## Type Aliases

### Db

```ts
type Db = {
  query: Promise<T[]>;
};
```

**`Input`**

The one-method SQL handle the runtime's own stores take — session slots, the
workflow journal and its key index (`RuntimeOptions.db`).

DECLARED here rather than re-exported from the SDK: the SDK's identical
`Db` is on its non-semver `/internal` subpath, and a contracted signature
naming it would hash only the name. Structurally the same type, so either is
assignable to the other.

#### Methods

##### query()

```ts
query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
```

Run one parameterized statement and answer its rows.

###### Type Parameters

###### T

`T` = `Record`\<`string`, `unknown`\>

###### Parameters

###### sql

`string`

###### params?

`unknown`[]

###### Returns

`Promise`\<`T`[]\>

***

### FetchRouteHandler

```ts
type FetchRouteHandler = (request: FetchRouteRequest) => 
  | StubStepAnswer
  | undefined
| Promise<StubStepAnswer | undefined>;
```

A route: answers a request with a `Response` or the `{ status, body, headers }`
shorthand `stubStepFetch` takes — or `undefined` to DECLINE, leaving it to
the next route (in a list) or to [FetchRoutesOptions.unmatched](#unmatched).

`stubGatewayRoute().route` is one, so a model leg sits in a list beside a
spec's own.

#### Parameters

##### request

[`FetchRouteRequest`](#fetchrouterequest)

#### Returns

  \| [`StubStepAnswer`](#stubstepanswer)
  \| `undefined`
  \| `Promise`\<[`StubStepAnswer`](#stubstepanswer) \| `undefined`\>

***

### FetchRouteHit

```ts
type FetchRouteHit = FetchRouteRequest & {
  outcome:   | "routed"
     | "passthrough"
     | "unmatched"
     | string & {
   };
  route?: string;
  status?: number;
  via:   | "fetch"
     | "stepFetch"
     | string & {
   };
};
```

**`Sealed`**

One request the router saw, whatever became of it.

#### Type Declaration

##### outcome

```ts
readonly outcome: 
  | "routed"
  | "passthrough"
  | "unmatched"
  | string & {
};
```

Answered by a route, sent to the real network, or answered by nothing.

##### route?

```ts
readonly optional route?: string;
```

The table key that answered it (a list's routes have none).

##### status?

```ts
readonly optional status?: number;
```

The response's status, for a request that got one.

##### via

```ts
readonly via: 
  | "fetch"
  | "stepFetch"
  | string & {
};
```

Which fetch it arrived through.

***

### FetchRouteRequest

```ts
type FetchRouteRequest = StubStepRequest & {
  host: string;
  json: unknown;
  pathname: string;
  searchParams: URLSearchParams;
};
```

**`Sealed`**

One request as a route sees it: the recorded request (`url`, `method`,
`headers`, `body` — the same fields `stubStepFetch` records) plus the parts a
route branches on, already parsed.

#### Type Declaration

##### host

```ts
readonly host: string;
```

`new URL(url).hostname`.

##### json

```ts
readonly json: unknown;
```

The body parsed as JSON when it parses; `undefined` otherwise (and for none).

##### pathname

```ts
readonly pathname: string;
```

`new URL(url).pathname`.

##### searchParams

```ts
readonly searchParams: URLSearchParams;
```

`new URL(url).searchParams` — PostgREST filters, query strings.

***

### FetchRoutesOptions

```ts
type FetchRoutesOptions = {
  globalFetch?: boolean;
  passThrough?: RegExp;
  stepFetch?: boolean;
  unmatched?: "throw" | "notFound" | "passthrough";
};
```

**`Input`**

What [stubFetchRoutes](#stubfetchroutes-1) may be told.

#### Properties

##### globalFetch?

```ts
optional globalFetch?: boolean;
```

Install the router as the global `fetch` too (the default). Pass `false`
to route ONLY the step fetch and leave the global untouched — for an eval
whose live mode sends the voice model's own traffic over the global while
its steps stay scripted.

##### passThrough?

```ts
optional passThrough?: RegExp;
```

URLs that reach the REAL network before any route is consulted, tested
against the full URL — e.g. `/^https://[^/]*assemblyai\.com//` for a
live model's own traffic.

##### stepFetch?

```ts
optional stepFetch?: boolean;
```

Publish the router as the step fetch too (the default), so a step's
`stepFetch` lands in the same routes and the same log as a tool's
`fetch`. Pass `false` for a spec that installs its own step fetch.

##### unmatched?

```ts
optional unmatched?: "throw" | "notFound" | "passthrough";
```

What a request no route answers means.

- `"throw"` (the default) — a finding: the fetch rejects naming the method
  and URL, the way an unreachable host does, and the request is logged
  with `outcome: "unmatched"`. An invented `200 {}` reads to a tool as
  success, so the spec would pass having tested the wrong branch.
- `"notFound"` — a real 404, for a spec whose subject is one.
- `"passthrough"` — the REAL network. Rarely right in a unit test.

***

### FetchRouteTable

```ts
type FetchRouteTable = Readonly<Record<string, 
  | FetchRouteHandler
| StubStepAnswer>>;
```

Routes by where they answer. A key is an optional METHOD, then one of:

- a HOST — `"api.mem0.ai"` — matching that hostname exactly;
- a WILDCARD host — `"*.example"` — matching any subdomain of it;
- a URL PREFIX — `"https://api.mem0.ai/v3/memories/"` — matching any URL that
  starts with it.

So `"POST textbelt.com"` answers only a POST. The most specific key answers:
a URL prefix (longest first), then an exact host, then a wildcard (longest
first); a METHOD-qualified key beats the same key without one. A value is a
[FetchRouteHandler](#fetchroutehandler), or a fixed answer given to every request it
matches.

***

### FiredEvent

```ts
type FiredEvent = {
  dialogs: readonly string[];
  typed: boolean;
  wildcard: boolean;
};
```

**`Sealed`**

What [fireEvent](#fireevent) reports: how many handlers the event reached.

#### Properties

##### dialogs

```ts
readonly dialogs: readonly string[];
```

The keys of the declared dialogs the event MOVED — one whose `on` map
names it (`"@session.timedOut": "abandoned"`) and whose active state
handles it. Every declared dialog is offered the event, before the
handlers, as the session offers it.

##### typed

```ts
readonly typed: boolean;
```

The per-type handler ran.

##### wildcard

```ts
readonly wildcard: boolean;
```

The `"*"` handler ran, after the typed one.

***

### ProjectFiles

```ts
type ProjectFiles = {
  systemPrompt?: string;
  tools?: Readonly<Record<string, unknown>>;
  workflows?: Readonly<Record<string, unknown>>;
};
```

**`Input`**

What the BUILD lowers onto an `agent.ts` default export — the files beside it
that a deployed agent runs with and a spec has to apply itself.

Both fields are optional and at least one must be present: an empty object is
a call that does nothing, which is the shape of a forgotten argument rather
than of a project with no files.

#### Properties

##### systemPrompt?

```ts
readonly optional systemPrompt?: string;
```

`import prompt from "./system-prompt.md?raw"`.

Omit it for a project with no `system-prompt.md`. Pass it even when
`agent.ts` imports the file itself — whether it composes a string out of it
or closes over it in a `systemPrompt` resolver, the def is left exactly as
the author built it, so a spec never has to know which of the three shapes
its own project uses.

##### tools?

```ts
readonly optional tools?: Readonly<Record<string, unknown>>;
```

`import.meta.glob("./tools/*.ts", { eager: true })`, written at the CALL
SITE — see the module doc for why it cannot be a directory string.

Omit it for a project with no `tools/` directory. Passing an EMPTY glob is
an error, not a no-op: see [deployedAgent](#deployedagent).

Spelled out rather than named as `ToolModules` (the same type, on
`/manifest`): the value is a glob result, not something a spec names, so
`/testing` exports no alias for it and a named one would be a declaration no
capability owns.

##### workflows?

```ts
readonly optional workflows?: Readonly<Record<string, unknown>>;
```

`import.meta.glob("./workflows/*.ts", { eager: true })`, written at the
call site like `tools`. A module default-exporting a `workflow()` def is
registered under its file name, an explicit `agent({ workflows })` entry
winning a clash; the rest of the directory (a body's helpers) is skipped,
so unlike `tools` an empty or helper-only result is not an error.

***

### RecordedSignal

```ts
type RecordedSignal = {
  key: string;
  label: string;
  options: SignalOptions | undefined;
  payload: unknown;
  workflow: string;
};
```

**`Sealed`**

One `signalRun` as a tool made it.

#### Properties

##### key

```ts
key: string;
```

##### label

```ts
label: string;
```

##### options

```ts
options: SignalOptions | undefined;
```

##### payload

```ts
payload: unknown;
```

##### workflow

```ts
workflow: string;
```

The workflow's declared name.

***

### RecordedSleep

```ts
type RecordedSleep = {
  correlationId?: string;
  label: string;
  until: number | Date;
};
```

**`Sealed`**

One wait the body asked for — and did NOT take.

#### Properties

##### correlationId?

```ts
optional correlationId?: string;
```

##### label

```ts
label: string;
```

The wait's `label` — its identity in a real run's journal, and the field a
case asserting a SCHEDULE actually wants: a body with two waits is telling
you WHICH one it reached, which a duration cannot.

##### until

```ts
until: number | Date;
```

Exactly what the body passed: milliseconds, or a `Date`.

***

### RecordedStart

```ts
type RecordedStart = {
  def: AnyWorkflowDef | undefined;
  input: unknown;
  options: StartOptions | undefined;
  runId: string;
  workflow: string;
};
```

**`Sealed`**

One `start` the client recorded.

#### Properties

##### def

```ts
readonly def: AnyWorkflowDef | undefined;
```

The def passed, when one was (`undefined` for a start by name).

##### input

```ts
readonly input: unknown;
```

The input, exactly as the tool passed it — not validated, since nothing runs.

##### options

```ts
readonly options: StartOptions | undefined;
```

The start options (`key`, `label`, `notify`, …), when any were passed.

##### runId

```ts
readonly runId: string;
```

The run id `start` resolved with.

##### workflow

```ts
readonly workflow: string;
```

The declared name — the key in `agent({ workflows })` — or the string passed.

***

### RecordedStep

```ts
type RecordedStep = {
  maxAttempts?: number;
  maxWaits?: number;
  name: string;
};
```

**`Sealed`**

One step the body reached, as the recorder saw it.

#### Properties

##### maxAttempts?

```ts
optional maxAttempts?: number;
```

What the body asked for, or `undefined` when it passed no options.

##### maxWaits?

```ts
optional maxWaits?: number;
```

The step's wait budget (`StepOptions.maxWaits`), or `undefined` when none was asked for.

##### name

```ts
name: string;
```

***

### RouteContextOverrides

```ts
type RouteContextOverrides = { [K in keyof RouteContext]?: RouteContext[K] };
```

**`Input`**

What [createRouteContext](#createroutecontext) accepts: a field per [RouteContext](../aai/index.md#routecontext)
field, each also taking `undefined` for one the caller does not have.

***

### RunSnapshotOverrides

```ts
type RunSnapshotOverrides<R = unknown> = Partial<WorkflowRunBase> & 
  | {
  status?: undefined;
}
  | WorkflowRunSnapshot<R> extends infer S ? S extends unknown ? Omit<S, keyof WorkflowRunBase> : never : never;
```

What [createRunSnapshot](#createrunsnapshot) accepts: the shared fields, plus whatever the
chosen status requires.

The `status`-bearing half is DERIVED from [WorkflowRunSnapshot](../aai/workflow-api.md#workflowrunsnapshot)'s own
union, arm by arm, so asking for `status: "completed"` without an `output` is
a compile error rather than a fixture that lies — and an arm the snapshot
grows is one this accepts without a second edit.

#### Type Parameters

##### R

`R` = `unknown`

The workflow's return type, when the caller names it.

***

### RunTextAgentOptions

```ts
type RunTextAgentOptions = Omit<TextAgentOptions, "agent" | "model"> & Pick<TextTurnOptions, "signal" | "systemPrompt" | "maxSteps" | "temperature" | "toolChoice"> & {
  script: readonly ScriptedTextStep[];
};
```

**`Input`**

What [runTextAgent](#runtextagent) takes, beyond the definition and the conversation.

The agent half is `TextAgentOptions` MINUS the two things this helper
supplies — derived by subtraction rather than restated, for the reason
`server/agent-server-forwarding.ts` exists in this package: every field of that type
is optional, so an omission is valid TypeScript and presents as a harness
quietly ignoring part of its own configuration. A capability added to a text
agent is reachable from here the day it lands.

The turn half is deliberately NOT the whole of `TextTurnOptions`. `stopWhen`,
`prepareStep` and `onStepFinish` are hooks a chat surface installs, and a
caller that wants one is past the point where a one-call convenience helps —
it builds the agent with `createTextAgent` and streams the turn itself.

#### Type Declaration

##### script

```ts
readonly script: readonly ScriptedTextStep[];
```

One entry per model call — see [ScriptedTextStep](#scriptedtextstep).

Required, because a run with no script is a run against a model that
answers nothing, which is a spec asserting on silence by accident.

***

### RunWorkflowOptions

```ts
type RunWorkflowOptions = {
  crashAt?: string;
  journal?: WorkflowJournal;
  key?: string;
  logger?: Logger;
  maxDeliveries?: number;
  name?: string;
};
```

**`Input`**

What [runWorkflow](#runworkflow) takes.

#### Properties

##### crashAt?

```ts
optional crashAt?: string;
```

Kill the first delivery that reaches this step, before its body runs.

A worker that died mid-run, which is the one durable-execution failure a
body cannot be written against without being able to produce it. It fires
ONCE and then disarms, so `restart` resumes rather
than crashing again.

The kill lands after the step's attempt has been CHARGED and before its body
runs, which is exactly where a real death lands — the charge is what a
resume reads to tell an abandoned attempt from one that never started.

##### journal?

```ts
optional journal?: WorkflowJournal;
```

The journal the run lives in. Defaults to a fresh in-memory one.

Pass a previous run's `journal` (or a
`createMemoryJournal()` of your own) to start two runs in the same world.

##### key?

```ts
optional key?: string;
```

The correlation key the run is started with — `StartOptions.key`, which
the body reads as `ctx.key` and `ctx.signalToken`/`ctx.waitForSignal`
derive their token from. Defaults to `"test"`, so a keyed body runs out
of the box; a spec asserting on the key passes its own.

##### logger?

```ts
optional logger?: Logger;
```

Where the engine logs. Defaults to silence.

##### maxDeliveries?

```ts
optional maxDeliveries?: number;
```

How many deliveries the driver may make before it gives up.

A bound rather than a timeout: a body that suspends and is woken in a loop
would otherwise spin, and a spec that hangs reports the runner's timeout
instead of the loop. Defaults to [DEFAULT\_MAX\_DELIVERIES](#default_max_deliveries).

##### name?

```ts
optional name?: string;
```

The name the workflow is registered under, as `agent({ workflows })` keys
it. Defaults to `"workflow"`.

It is what the body reads as `ctx.workflow`, and what a run's record
carries — so a spec asserting on either passes the real key.

***

### ScriptedTextStep

```ts
type ScriptedTextStep = {
  text?: string;
  toolCalls?: readonly ScriptedToolCall[];
};
```

**`Input`**

One step of a scripted turn: what the model says, and what it calls.

A step with tool calls finishes as `tool-calls`, so the agent runs them and
comes back for the next step; a step without them ends the turn. That makes a
tool-calling turn the obvious two-entry script — the call, then the answer —
and a plain reply a one-entry one.

#### Properties

##### text?

```ts
readonly optional text?: string;
```

What the model streams as text on this step. Absent streams none.

##### toolCalls?

```ts
readonly optional toolCalls?: readonly ScriptedToolCall[];
```

The tool calls the model makes on this step, in order.

***

### ScriptedToolCall

```ts
type ScriptedToolCall = {
  id?: string;
  input?: Record<string, unknown>;
  name: string;
};
```

**`Input`**

One tool call in a [ScriptedTextStep](#scriptedtextstep).

#### Properties

##### id?

```ts
readonly optional id?: string;
```

The call id. Defaults to `call-1`, `call-2`, … across the whole script.

Worth naming only when a spec asserts on the id itself — everything a turn
reports carries it, so two calls of one tool are already distinguishable
without one.

##### input?

```ts
readonly optional input?: Record<string, unknown>;
```

The arguments, as an object.

Serialized to the JSON string the wire carries, so a spec writes the
arguments it means and the real coercion, Standard Schema validation and
repair path (`tools/call-repair.ts`) all still run on the way in — which is
the point of scripting a MODEL rather than calling `execute` directly.
Defaults to `{}`.

##### name

```ts
readonly name: string;
```

The tool's name, as the agent's `tools` record keys it.

***

### SessionEventFields

```ts
type SessionEventFields<K extends SessionEventType> = { [T in K]: Omit<SessionEventMap[T], "type" | "meta"> }[K];
```

The fields of one event beyond its envelope — what [sessionEvent](#sessionevent) takes
after the type: the member of `SessionEventMap` minus `type` and `meta`.
Distributes over `K`, so each member keeps its own fields.

#### Type Parameters

##### K

`K` *extends* [`SessionEventType`](../aai/index.md#sessioneventtype)

***

### SessionEventRest

```ts
type SessionEventRest<K extends SessionEventType> = keyof SessionEventFields<K> extends never ? [SessionEventFields<K>, Partial<SessionEventMeta>] : [SessionEventFields<K>, Partial<SessionEventMeta>];
```

The trailing parameters of [sessionEvent](#sessionevent): `[meta?]` for an envelope-only
event, `[fields, meta?]` for one with a payload. An event that is only its
envelope (`reply.completed`) takes no fields argument at all, so
`sessionEvent("reply.completed")` is the whole call rather than
`sessionEvent("reply.completed", {})`.

#### Type Parameters

##### K

`K` *extends* [`SessionEventType`](../aai/index.md#sessioneventtype)

***

### SlotContractOptions

```ts
type SlotContractOptions<T> = {
  caps?: Readonly<Record<string, number>>;
  write?: (draft: T) => void;
};
```

**`Input`**

What [expectSlotContract](#expectslotcontract) may be told.

#### Type Parameters

##### T

`T`

#### Properties

##### caps?

```ts
readonly optional caps?: Readonly<Record<string, number>>;
```

The caps to check — each top-level array key and the most entries it
keeps. Defaults to what the slot DECLARED (`slot.caps`); given, each is
driven past its bound and the surviving entries must be the NEWEST ones,
and a bound that differs from the declared one fails naming both.

##### write?

```ts
readonly optional write?: (draft: T) => void;
```

A mutation that CHANGES the value — what the isolation check writes
through one session to prove the other does not see it. Optional: without
it the check is that two sessions hold distinct values of the default,
which catches a shared default object and nothing subtler. A `write` that
leaves the value equal to the default is refused, because it proves
nothing.

###### Parameters

###### draft

`T`

###### Returns

`void`

***

### StubClientInbox

```ts
type StubClientInbox = {
  calls: StubClientInboxCall[];
  restore: void;
};
```

**`Sealed`**

What [stubClientInbox](#stubclientinbox-1) returns: the call log, and how to put the slot back.

#### Methods

##### restore()

```ts
restore(): void;
```

Unpublish the inbox. Call it in an `afterEach`, like `stubSpeech`'s.

###### Returns

`void`

#### Properties

##### calls

```ts
calls: StubClientInboxCall[];
```

Every notice pushed, in order — including those the device did not take.

***

### StubClientInboxCall

```ts
type StubClientInboxCall = {
  clientId: string;
  notice: ClientNotice;
};
```

**`Sealed`**

One pushed notice, as [stubClientInbox](#stubclientinbox-1) records it.

#### Properties

##### clientId

```ts
clientId: string;
```

##### notice

```ts
notice: ClientNotice;
```

***

### StubClientInboxOptions

```ts
type StubClientInboxOptions = {
  answer?:   | "acked"
     | ClientUnreachableReason
     | ((call: StubClientInboxCall) => 
     | "acked"
     | ClientUnreachableReason);
};
```

**`Input`**

What [stubClientInbox](#stubclientinbox-1) may be told.

#### Properties

##### answer?

```ts
optional answer?: 
  | "acked"
  | ClientUnreachableReason
  | ((call: StubClientInboxCall) => 
  | "acked"
  | ClientUnreachableReason);
```

How the device answers each notice: `"acked"` (the default), or a reason it
did not take it — `"offline"`, `"busy"`, `"no-ack"`, `"disconnected"`. A
function answers per call, e.g. busy once and then acked.

***

### StubClientTranscript

```ts
type StubClientTranscript = {
  calls: StubClientTranscriptCall[];
  restore: void;
};
```

**`Sealed`**

What [stubClientTranscript](#stubclienttranscript-1) returns: the call log, and how to put the slot back.

#### Methods

##### restore()

```ts
restore(): void;
```

Unpublish the reader. Call it in an `afterEach`, like `stubClientInbox`'s.

###### Returns

`void`

#### Properties

##### calls

```ts
calls: StubClientTranscriptCall[];
```

Every read, in order.

***

### StubClientTranscriptAnswer

```ts
type StubClientTranscriptAnswer = 
  | ClientTranscript
  | ((call: StubClientTranscriptCall) => ClientTranscript);
```

What [stubClientTranscript](#stubclienttranscript-1) answers each read with.

***

### StubClientTranscriptCall

```ts
type StubClientTranscriptCall = {
  clientId: string;
  options: StepClientTranscriptOptions;
};
```

**`Sealed`**

One read, as [stubClientTranscript](#stubclienttranscript-1) records it.

#### Properties

##### clientId

```ts
clientId: string;
```

##### options

```ts
options: StepClientTranscriptOptions;
```

***

### StubDelegateReply

```ts
type StubDelegateReply = 
  | string
  | {
  complaint?: string;
  revisions?: number;
  steps?: number;
  text: string;
  toolCalls?: readonly DelegateToolCall[];
};
```

What one route answers with.

A bare string is the subagent's final text with an empty cost report, which
is what a tool that only reads `text` wants. The object form fills in
`steps` and `toolCalls` for a tool that narrates the wait.

#### Union Members

`string`

***

##### Type Literal

```ts
{
  complaint?: string;
  revisions?: number;
  steps?: number;
  text: string;
  toolCalls?: readonly DelegateToolCall[];
}
```

###### complaint?

```ts
optional complaint?: string;
```

Stage a run the subagent's GUARDRAIL never accepted: the complaint the
real runtime returns beside the last rejected attempt.

Its presence is what makes the result's `accepted` false — the
two cannot be staged apart, because in the runtime they cannot occur
apart. A spec cannot describe an unaccepted answer with no reason, and
a caller reading `complaint` on an accepted one would be reading a
field that is never set.

###### revisions?

```ts
optional revisions?: number;
```

How many times a guardrail sent an answer back. Defaults to `0`.

###### steps?

```ts
optional steps?: number;
```

###### text

```ts
text: string;
```

###### toolCalls?

```ts
optional toolCalls?: readonly DelegateToolCall[];
```

***

### StubDelegateRoute

```ts
type StubDelegateRoute = 
  | StubDelegateReply
  | ((call: StubDelegateCall) => StubDelegateReply);
```

How a route answers: a fixed reply, or a function of the call — the function
form being what a route asked more than once (a subagent run per document)
needs in order to shift its own script.

***

### StubDelegateScript

```ts
type StubDelegateScript = 
  | {
  reply: StubDelegateRoute;
  routes?: never;
}
  | {
  reply?: never;
  routes: Readonly<Record<string, StubDelegateRoute>>;
};
```

Everything [stubDelegate](#stubdelegate-1) and [stubStepDelegate](#stubstepdelegate) accept: ONE route
answering every delegation, or a table of routes keyed by subagent name —
each under a key that says which.

The same two shapes [StubGenerateScript](#stubgeneratescript) takes, for the same reason: a
bare "a table, or a reply" union is told apart at runtime by the reply's
shape, so a subagent named `text` could never be routed and a reply object
could be read as a table. Named, there is nothing to guess.

#### Union Members

##### Type Literal

```ts
{
  reply: StubDelegateRoute;
  routes?: never;
}
```

###### reply

```ts
readonly reply: StubDelegateRoute;
```

Answers EVERY delegation, whichever subagent it names.

###### routes?

```ts
readonly optional routes?: never;
```

***

##### Type Literal

```ts
{
  reply?: never;
  routes: Readonly<Record<string, StubDelegateRoute>>;
}
```

###### reply?

```ts
readonly optional reply?: never;
```

###### routes

```ts
readonly routes: Readonly<Record<string, StubDelegateRoute>>;
```

One route per subagent, keyed by its `name`. A delegation naming no
route rejects, naming the subagent.

***

### StubEmitted

```ts
type StubEmitted = {
  chunk: unknown;
  namespace: string;
};
```

**`Sealed`**

One chunk `stepEmit()` wrote, and the stream it went to.

#### Properties

##### chunk

```ts
chunk: unknown;
```

The value, exactly as the step passed it.

##### namespace

```ts
namespace: string;
```

The stream named at the call site.

***

### StubFetchRoutes

```ts
type StubFetchRoutes = {
  fetch: typeof globalThis.fetch;
  hits: FetchRouteHit[];
  restore: void;
  to: FetchRouteHit[];
};
```

**`Sealed`**

What [stubFetchRoutes](#stubfetchroutes-1) returns.

#### Methods

##### restore()

```ts
restore(): void;
```

Put the global `fetch` back and unpublish the step fetch.

###### Returns

`void`

##### to()

```ts
to(filter: string | RegExp): FetchRouteHit[];
```

The hits a filter selects: a string matched the way a route KEY is
(`"POST supabase.test"`, `"*.example"`), a `RegExp` tested against the URL.

###### Parameters

###### filter

`string` \| `RegExp`

###### Returns

[`FetchRouteHit`](#fetchroutehit)[]

#### Properties

##### fetch

```ts
readonly fetch: typeof globalThis.fetch;
```

The router as a `fetch`, for code handed one explicitly.

##### hits

```ts
readonly hits: FetchRouteHit[];
```

Every request, in order, including passed-through and unmatched ones.

***

### StubGenerateReply

```ts
type StubGenerateReply = 
  | string
  | {
  object: unknown;
  text?: string;
};
```

What one route answers with.

A bare string is text (the schemaless shape); an object is structured output,
and its `text` defaults to the JSON the real host would have returned — a
schema call's `text` IS the stringified object, so a fake that left it empty
would differ from production in the one place a caller might read it.

***

### StubGenerateRoute

```ts
type StubGenerateRoute = 
  | StubGenerateReply
  | ((call: StubGenerateCall) => StubGenerateReply);
```

How a route answers: a fixed reply, or a function of the call.

The function form is what a route with a QUEUE needs — a grader asked once per
document, an executor asked once per turn — since it can shift its own script.

***

### StubGenerateScript

```ts
type StubGenerateScript = 
  | {
  reply: StubGenerateRoute;
  routes?: never;
}
  | {
  reply?: never;
  routes: Readonly<Record<string, StubGenerateRoute>>;
};
```

Everything [stubGenerate](#stubgenerate-1) accepts: ONE route answering every call, or a
table of routes keyed by system prompt — each under a key that says which.

```ts
import { stubGenerate } from "@alexkroman1/aai/testing";

stubGenerate({ reply: "The documented answer." });
stubGenerate({ routes: { "You grade documents.": { object: { score: 1 } } } });
```

**Why two keys rather than "a record, or a route".** The bare form was a union
of a route table and a single reply, told apart at runtime by whether the
object had an `object` key — so `stubGenerate({ text: "…" })` type-checked as
a table with one route named `text` and rejected every call. A misuse arm in
the type was meant to refuse it, and could not SPEAK: the reply arm's
optional `text` out-scored it, so `tsc` printed "Property 'object' is
missing" — the wrong remedy. With the shape named, there is nothing to
disambiguate: `{ reply: { text } }` is a reply, and a function under `reply`
is a computed route, never mistaken for the seam itself (see
`ToolContextOverrides.generate`).

Named because it is written down in two places — that function and the
`generate` field of `createToolContext`'s overrides — and a union restated at
each of them is a union that drifts.

#### Union Members

##### Type Literal

```ts
{
  reply: StubGenerateRoute;
  routes?: never;
}
```

###### reply

```ts
readonly reply: StubGenerateRoute;
```

Answers EVERY call, whatever its system prompt.

###### routes?

```ts
readonly optional routes?: never;
```

***

##### Type Literal

```ts
{
  reply?: never;
  routes: Readonly<Record<string, StubGenerateRoute>>;
}
```

###### reply?

```ts
readonly optional reply?: never;
```

###### routes

```ts
readonly routes: Readonly<Record<string, StubGenerateRoute>>;
```

One route per model ROLE, keyed by the call's system prompt. A call
whose system prompt names no route rejects, naming it; `""` is the
route for a call that carries none.

***

### StubPlaceCall

```ts
type StubPlaceCall = {
  calls: StubPlacedCall[];
  restore: void;
};
```

**`Sealed`**

What [stubPlaceCall](#stubplacecall-1) returns: the call log, and how to put the slot back.

#### Methods

##### restore()

```ts
restore(): void;
```

Unpublish the `stepFetch` and the public URL. Call it in an `afterEach`.

###### Returns

`void`

#### Properties

##### calls

```ts
calls: StubPlacedCall[];
```

Every dial, in order — including refused ones.

***

### StubPlaceCallOptions

```ts
type StubPlaceCallOptions = {
  dial?:   | "accept"
     | StubPlaceCallRefusal
     | ((call: StubPlacedCall) => "accept" | StubPlaceCallRefusal);
  otherwise?: (request: StubStepRequest) => 
     | StubStepAnswer
    | Promise<StubStepAnswer>;
  publicUrl?: string;
  status?:   | PlacedCallStatus
     | "initiated"
     | ((call: StubPlacedCall) => PlacedCallStatus | "initiated");
};
```

**`Input`**

What [stubPlaceCall](#stubplacecall-1) may be told.

#### Properties

##### dial?

```ts
optional dial?: 
  | "accept"
  | StubPlaceCallRefusal
  | ((call: StubPlacedCall) => "accept" | StubPlaceCallRefusal);
```

How Twilio answers each dial: `"accept"` (the default), or a refusal —
`{ status: 400, code: 21219 }` is a trial account calling an unverified
number. A function answers per call.

##### otherwise?

```ts
optional otherwise?: (request: StubStepRequest) => 
  | StubStepAnswer
| Promise<StubStepAnswer>;
```

Every request that is not to Twilio's Calls API. Default: throw, naming it —
a request nobody set up is a finding (see `stubFetchRoutes`).

###### Parameters

###### request

[`StubStepRequest`](#stubsteprequest)

###### Returns

  \| [`StubStepAnswer`](#stubstepanswer)
  \| `Promise`\<[`StubStepAnswer`](#stubstepanswer)\>

##### publicUrl?

```ts
optional publicUrl?: string;
```

This agent's public URL while the stub is installed — what a deployment
publishes and `stepPlaceCall` dials back to when no `agentUrl` is passed.
Default `"https://agent.example.test"`; `restore()` puts back the previous one.

##### status?

```ts
optional status?: 
  | PlacedCallStatus
  | "initiated"
  | ((call: StubPlacedCall) => PlacedCallStatus | "initiated");
```

What each status read answers: a status, or a function of the call (its
`polls` already counts this read). Default `"completed"`.

***

### StubPlaceCallRefusal

```ts
type StubPlaceCallRefusal = {
  code?: number;
  message?: string;
  status: number;
};
```

**`Input`**

A Twilio refusal to stage: the HTTP status and, optionally, Twilio's error code and message.

#### Properties

##### code?

```ts
optional code?: number;
```

##### message?

```ts
optional message?: string;
```

##### status

```ts
status: number;
```

***

### StubPlacedCall

```ts
type StubPlacedCall = {
  callId: string | undefined;
  from: string;
  parameters: Record<string, string>;
  polls: number;
  ringTimeoutS: number;
  timeLimitS: number;
  to: string;
  webhookUrl: string | undefined;
};
```

**`Sealed`**

One call a step placed, as [stubPlaceCall](#stubplacecall-1) records it.

#### Properties

##### callId

```ts
callId: string | undefined;
```

The call id the stub answered with (`CA` + a counter), or `undefined` for a refused dial.

##### from

```ts
from: string;
```

##### parameters

```ts
parameters: Record<string, string>;
```

The `<Parameter>`s, decoded — what the answering session reads as `call.parameters`.

##### polls

```ts
polls: number;
```

How many times [StubPlaceCallOptions.status](#status-1) has been asked about this call.

##### ringTimeoutS

```ts
ringTimeoutS: number;
```

##### timeLimitS

```ts
timeLimitS: number;
```

##### to

```ts
to: string;
```

##### webhookUrl

```ts
webhookUrl: string | undefined;
```

The webhook Twilio fetches once the call is answered, WITHOUT the
parameters (they are [StubPlacedCall.parameters](#parameters)):
`https://…/phone?carrier=twilio`.

***

### StubReporter

```ts
type StubReporter = {
  emitted: StubEmitted[];
  lines: string[];
  restore: () => void;
};
```

**`Sealed`**

What [stubReporter](#stubreporter-1) returns.

#### Properties

##### emitted

```ts
emitted: StubEmitted[];
```

Every chunk `stepEmit()` wrote, oldest first.

##### lines

```ts
lines: string[];
```

Every line `stepReport()` wrote, oldest first.

##### restore

```ts
restore: () => void;
```

Unpublish. Call it in an `afterEach` — see [stubReporter](#stubreporter-1).

###### Returns

`void`

***

### StubSpeechCall

```ts
type StubSpeechCall = {
  apiKey: string;
  language: string | undefined;
  sampleRate: number;
  text: string;
  voice: string;
};
```

**`Sealed`**

One `stepSpeak` call, as [stubSpeech](#stubspeech) records it.

#### Properties

##### apiKey

```ts
apiKey: string;
```

The credential `stepSpeak` resolved out of the step env — `""` when the
env holds none, which the stub accepts unless
[StubSpeechOptions.requireApiKey](eval/vitest.md#requireapikey) is set.

##### language

```ts
language: string | undefined;
```

The language code, or `undefined` when the caller named none.

##### sampleRate

```ts
sampleRate: number;
```

The rate the audio was asked for at.

##### text

```ts
text: string;
```

The text handed to the synthesizer, trimmed the way `stepSpeak` trims it.

##### voice

```ts
voice: string;
```

The voice, with `stepSpeak`'s default already filled in.

***

### StubStepAnswer

```ts
type StubStepAnswer = 
  | Response
  | {
  body?: unknown;
  headers?: Record<string, string>;
  status?: number;
};
```

What a [stubStepFetch](#stubstepfetch) answer may be: a whole `Response`, or the
`{ status, body, headers }` shorthand that JSON-encodes `body`.

Named because the transcription fake (`stubTranscribe`) hands its
`otherwise` handler the same vocabulary, and a spec routing by URL should not
have to restate the union to write one.

***

### StubStepRequest

```ts
type StubStepRequest = {
  body: Uint8Array | string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
};
```

**`Sealed`**

One request a [stubStepFetch](#stubstepfetch) recorder captured.

#### Properties

##### body

```ts
body: Uint8Array | string | undefined;
```

The body as sent.

A STREAMING body (an async iterable — see `StepFetchInit.body`) is DRAINED into
a `Uint8Array` before it reaches a spec, so an assertion reads the bytes that
went out rather than an iterator it would have to consume itself — and
consuming it in the spec would be consuming the one the request was going to
send.

##### headers

```ts
headers: Record<string, string>;
```

##### method

```ts
method: string;
```

##### url

```ts
url: string;
```

***

### StubTranscribeCall

```ts
type StubTranscribeCall = StubStepRequest & {
  leg: StubTranscribeLeg;
};
```

**`Sealed`**

One request [stubTranscribe](#stubtranscribe) answered, with the leg it belonged to.

#### Type Declaration

##### leg

```ts
leg: StubTranscribeLeg;
```

Which of the four calls this was, or `"other"`.

***

### StubTranscribeFailure

```ts
type StubTranscribeFailure = {
  leg?:   | StubTranscribeLeg
     | readonly StubTranscribeLeg[];
  message?: string;
  retryAfterSeconds?: number;
  status?: number;
};
```

**`Input`**

A refusal to stage, as an HTTP answer the SDK then classifies.

Deliberately not a `TranscribeError`: the verdict a spec cares about
(`retryable`, `retryAfter`) is computed by `transcribeFailure` from the status
and the headers, so staging the STATUS exercises that classification and
staging the error would replace it. `429` and `5xx` are the transient pair,
`408` counts, and everything else is terminal — see `isTransientStatus` on
`@alexkroman1/aai/step`.

#### Properties

##### leg?

```ts
optional leg?: 
  | StubTranscribeLeg
  | readonly StubTranscribeLeg[];
```

Which leg refuses. Defaults to ALL FOUR, which is what a spec asserting
"this flow reports a 429 as retryable" wants — it does not care which call
met the limit.

##### message?

```ts
optional message?: string;
```

What the body says went wrong.

Sent as `{ error }`, which both endpoints' readers understand — the async
API's own spelling, and one of the three `transcribeFailure` accepts.

##### retryAfterSeconds?

```ts
optional retryAfterSeconds?: number;
```

Seconds to put in `Retry-After`.

The field a fan-out's behaviour turns on: four segments that hit a
per-minute limit together re-collect their 429s on a backoff nobody chose
unless the header is honoured, so a spec about batching needs to be able to
send one.

##### status?

```ts
optional status?: number;
```

The status to answer. Defaults to `500`.

***

### StubTranscribeLeg

```ts
type StubTranscribeLeg = 
  | "upload"
  | "submit"
  | "poll"
  | "sync"
  | "other"
  | string & {
};
```

Which transcription call a request was.

`"other"` is anything that is not one of the four — a model call, a feed
download — which reaches the `otherwise` handler rather than this fake.

***

### StubUpload

```ts
type StubUpload = 
  | Uint8Array
  | {
  bytes: Uint8Array;
  complete?: boolean;
  name?: string;
  type?: string;
};
```

One file a [stubUploads](#stubuploads) store answers for.

A bare `Uint8Array` is the common case and means "these bytes, no name".

#### Union Members

`Uint8Array`

***

##### Type Literal

```ts
{
  bytes: Uint8Array;
  complete?: boolean;
  name?: string;
  type?: string;
}
```

###### bytes

```ts
bytes: Uint8Array;
```

###### complete?

```ts
optional complete?: boolean;
```

Whether every byte is in. Defaults to `true`.

`false` stages a STREAMED upload that is still arriving, which is the state
a step polling one has to handle and the only one where `stepReadUpload`
legitimately comes back short. Being able to write that down is most of why
this field exists: a body that treats a stalled size as the end returns a
transcript of most of a recording and reports success, and a spec cannot
catch that without an incomplete upload to hand it.

###### name?

```ts
optional name?: string;
```

###### type?

```ts
optional type?: string;
```

***

### StubUploadWrite

```ts
type StubUploadWrite = {
  bytes: Uint8Array;
  id: string;
  name: string;
  type: string;
};
```

**`Sealed`**

One file a step WROTE into a [stubUploads](#stubuploads) store.

#### Properties

##### bytes

```ts
bytes: Uint8Array;
```

Every byte written, drained from the step's stream.

##### id

```ts
id: string;
```

The minted id the step was handed back — `upl_stub_1`, unless renamed.

##### name

```ts
name: string;
```

The name the step declared, or `""` when it named none.

##### type

```ts
type: string;
```

The content type the step declared, or `""`.

***

### TestToolContext

```ts
type TestToolContext = ToolContext & {
  desk: StubDelegate;
  interrupts: number;
  model: StubGenerate;
  said: SaidLine[];
  sent: SentEvent[];
};
```

**`Sealed`**

A [ToolContext](../aai/index.md#toolcontext) that records what its tools sent and said.

Assignable to `ToolContext` wherever one is required, so it passes straight
to `execute`. Only [createToolContext](#createtoolcontext) makes one, so a recorder it
gains is a revision rather than a break.

#### Type Declaration

##### desk

```ts
readonly desk: StubDelegate;
```

The `ctx.delegate` fake — `desk.calls` is every subagent run the tools asked
for. Present and wired on the same terms as `TestToolContext.model`.

##### interrupts

```ts
readonly interrupts: number;
```

How many times `ctx.speech.interrupt()` was called.

##### model

```ts
readonly model: StubGenerate;
```

The `ctx.generate` fake — `model.calls` is every prompt the tools sent.

Present on every context, so an assertion needs no null check, and WIRED
whenever `generate` arrived as a script or as a fake. Given a bare function
(or nothing at all) it is a fake nothing reaches: `model.calls` stays empty
for the same reason `TestToolContext.sent` does when a test brings its
own `send` spy — the seam belongs to the caller, and so does the log.

##### said

```ts
readonly said: SaidLine[];
```

Every `ctx.speech.say`, in call order. Empty when a spec passes its own
`speech`, on the rule `sent` follows for `send`.

##### sent

```ts
readonly sent: SentEvent[];
```

Events `ctx.send` would put on the wire, in call order. An event the
runtime would drop (over the payload cap, an over-long name, no JSON form)
is not here, for the same reason it is not in the browser.

***

### TextAgentTestRun

```ts
type TextAgentTestRun = {
  events: readonly SessionEvent[];
  messages: readonly ModelMessage[];
  text: string;
  texts: readonly string[];
  toolCalls: readonly TextAgentTestToolCall[];
};
```

**`Sealed`**

What one scripted turn produced.

#### Properties

##### events

```ts
readonly events: readonly SessionEvent[];
```

The turn as a typed [SessionEvent](../aai/index.md#sessionevent) stream, in order — every event
`TextAgentOptions.onEvent` reported while this turn ran.

**This is the field that makes a text agent GRADEABLE by the same readers a
voice one is.** `@alexkroman1/aai-runtime/eval` answers three questions off
an event list — where a reply ends, what the agent said, which tools it
called with what — and every one of them takes this array unchanged:

```ts
import { agent } from "@alexkroman1/aai";
import { saidIn, toolCallsInEvents, toolNames } from "@alexkroman1/aai-runtime/eval";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";

const desk = agent({ name: "Desk", mode: "text" });
const run = await runTextAgent(desk, "where is order 7?", {
  script: [
    { text: "Let me check.", toolCalls: [{ name: "look_up", input: { id: "7" } }] },
    { text: "It shipped yesterday." },
  ],
});

console.log(toolNames(toolCallsInEvents(run.events))); // ["look_up"]
console.log(saidIn(run.events)); // ["Let me check.It shipped yesterday."]
```

The three projections above it are not made redundant by it and are not a
second copy of it either: [TextAgentTestRun.toolCalls](#toolcalls-1) carries the
SDK's own parsed `input` where an event carries the wire's record. What
this adds is the vocabulary the eval tier already
speaks — including the turn TERMINATOR, which is what lets a harness wait
for a reply to end rather than for a timer.

Ends in exactly one `reply.completed` or `reply.cancelled`, on every turn
this helper drives: it consumes the whole stream, so the terminal part has
always passed through by the time this resolves. `text-agent/events.ts`
carries which events a text agent emits and which it refuses.

##### messages

```ts
readonly messages: readonly ModelMessage[];
```

The messages the turn APPENDED — every step's assistant reply and every
tool exchange, as the SDK reconstructs them.

What a caller persists, and what a second turn of the same conversation is
built on: `[...sent, ...run.messages]`. Taken from `responseMessages`
(every step) rather than from `response` (the last step only), for the
reason [TextAgentTestRun.text](#text-3) carries — a tool-calling turn's own
exchange lives in the steps before the last one, so the narrower field
hands back an assistant message with no tool call to explain it.

##### text

```ts
readonly text: string;
```

Everything the agent said, concatenated across steps — what the caller
heard.

NOT `StreamTextResult.text`, which is the LAST step's text alone. That is
the right value for a chat surface reconstructing one assistant message and
a trap for a spec: a turn that narrates ("let me check") and then calls a
tool reports only the sentence after the call, so an assertion on the
narration silently passes against nothing. Read [TextAgentTestRun.texts](#texts) when the per-step split is what matters.

##### texts

```ts
readonly texts: readonly string[];
```

What the agent said on each step, in order — one entry per model call.

##### toolCalls

```ts
readonly toolCalls: readonly TextAgentTestToolCall[];
```

Every tool call the turn made, in the order the turn made them.

Flattened across steps deliberately: a tool-calling turn's steps are an
artifact of how the loop is cut, while "it looked the order up and then
cancelled it" is the property a spec is about.

***

### TextAgentTestToolCall

```ts
type TextAgentTestToolCall = {
  args: unknown;
  id: string;
  name: string;
  result: unknown;
};
```

**`Sealed`**

One tool call the turn made, with what it was given and what it answered.

The two halves are one record here because they are one EVENT to a spec, and
the SDK hands them back as two arrays that have to be joined on
`toolCallId` — a join every caller was writing, and getting subtly wrong in
the same way: a `toolResults` walk alone silently omits a call that never came
back, which is exactly the case a spec about a failing tool is asserting.

#### Properties

##### args

```ts
readonly args: unknown;
```

What the MODEL asked for — the script's `input`, as the SDK parsed it off
the wire.

Deliberately not the value the tool's `execute` received: coercion and
Standard Schema validation happen inside `executeToolCall`, and nothing the
turn reports carries their output. So a script writing `{ n: "4" }` against
a `z.number()` reads back `{ n: "4" }` here while the tool really got `4` —
a spec asserting on the COERCED value asserts inside the tool, which is the
only place that value exists.

##### id

```ts
readonly id: string;
```

The call id, which is what pairs this call with its result on the wire.

##### name

```ts
readonly name: string;
```

The tool's name, as the model asked for it.

##### result

```ts
readonly result: unknown;
```

What the call answered, as the model sees it.

A STRING in practice, and that is the production path rather than a
projection: `executeToolCall` serializes every result — a thrown error
included, which arrives as a failure string the model can read — because a
tool result is a wire value. So a tool returning `5` reads back `"5"`.

`undefined` for a call the turn never came back from: an aborted turn, or
one the step budget ended on the call.

***

### ToolBearingAgent

```ts
type ToolBearingAgent = {
  dialogs?: readonly AnyDialog[];
  tools: Readonly<Record<string, ToolDef>>;
};
```

**`Input`**

The slice of an agent these helpers read: its tool table — the `tools/`
files plus every toolset `agent()` attached (a roster's `handoff`, `delegate`
and gated tools), gated by its dialogs.

Structural rather than `AgentDef`, so a spec may pass the agent's default
export, a bare `{ tools }` literal, or anything else carrying one.

#### Properties

##### dialogs?

```ts
readonly optional dialogs?: readonly AnyDialog[];
```

##### tools

```ts
readonly tools: Readonly<Record<string, ToolDef>>;
```

***

### ToolContextOverrides

```ts
type ToolContextOverrides = {
  call?: SessionCall;
  clientId?: string;
  clientLocation?: string;
  clientPhone?: string;
  deadlineAt?: ToolContext["deadlineAt"];
  delegate?:   | ToolContext["delegate"]
     | StubDelegateScript;
  desk?: StubDelegate;
  env?: ToolContext["env"];
  generate?:   | ToolContext["generate"]
     | StubGenerateScript;
  messages?: ToolContext["messages"];
  model?: StubGenerate;
  now?: ToolContext["now"];
  random?: ToolContext["random"];
  send?: ToolContext["send"];
  sessionId?: ToolContext["sessionId"];
  signal?: ToolContext["signal"];
  slots?: ToolContext["slots"];
  speech?: ToolContext["speech"];
  turn?: ToolContext["turn"];
  workflows?: ToolContext["workflows"];
};
```

**`Input`**

What [createToolContext](#createtoolcontext) accepts: a field per [ToolContext](../aai/index.md#toolcontext) field,
each also taking `undefined` for one the caller does not have.

**Not `Partial<ToolContext>`, and the difference is the whole point.** Under
`exactOptionalPropertyTypes` — which this repo and the scaffold both set —
`Partial<T>` means `sessionId?: string`, a property that may be ABSENT but
whose value may never be `undefined`. So a spec holding a `string |
undefined` could not pass it, and the workaround it reached for instead was a
conditional spread:

```ts no-check
createToolContext({ generate, ...(sessionId ? { sessionId } : {}) });
```

Two shipped templates had that line byte-identical, and it is the exact shape
this repo's own `guard-invariants` rule 22 counts as debt — so the SDK's
signature was teaching the pattern its gates refuse. Adding `| undefined` to
every field costs nothing (an explicit `undefined` and an absent key
both fall through to the default, because [createToolContext](#createtoolcontext) takes the
overrides through `omitUndefined` before spreading them) and strictly widens what compiles.

**Every field is NAMED rather than mapped over `keyof ToolContext`.** A mapped
type is one a reader cannot see the members of without expanding it, and one
that silently grows a field when `ToolContext` does — which is the moment a
test double should have to decide what its default is. `testing.test-d.ts`
pins that the two key sets agree, so a new `ToolContext` field fails there
rather than being unoverridable.

The two MODEL seams also accept the SCRIPT their fake is built from — see
their own docs below.

#### Properties

##### call?

```ts
optional call?: SessionCall;
```

The phone call this session is, as `sessionCall(ctx)` will read it —
recorded under the context's `sessionId` the way the runtime records a
`WS /phone` stream's `start` frame. Omitted, `sessionCall` answers
`undefined`, which is what a browser tab gets.

##### clientId?

```ts
optional clientId?: string;
```

The device this session belongs to, as `sessionClientId(ctx)` will read it —
recorded under the context's `sessionId` the way the runtime records a
socket's `?client=`. Omitted, `sessionClientId` answers `undefined`, which is
what a browser tab or a phone call gets.

##### clientLocation?

```ts
optional clientLocation?: string;
```

Where this session's client is, as `sessionClientLocation(ctx)` — and the
`google_places` / `open_meteo` builtins — will read it, cleaned by the
`?location=` rule. Omitted, or refused by it, it answers `undefined`.

##### clientPhone?

```ts
optional clientPhone?: string;
```

The phone number this session's client reported, as `sessionClientPhone(ctx)`
will read it — recorded the way the runtime records `?phone=`, in E.164
(`"+1 (503) 555-0123"` reads back `"+15035550123"`). Omitted, or not an
E.164 number at all, `sessionClientPhone` answers `undefined`.

##### deadlineAt?

```ts
optional deadlineAt?: ToolContext["deadlineAt"];
```

See [ToolContext.deadlineAt](../aai/index.md#deadlineat). Defaults to the runtime's tool deadline, from now.

##### delegate?

```ts
optional delegate?: 
  | ToolContext["delegate"]
  | StubDelegateScript;
```

A real `ctx.delegate`, or `stubDelegate`'s own SCRIPT — `{ reply }` or
`{ routes }` keyed by subagent name. A function is the seam, on the same
rule as `generate` above; the fake comes back on `TestToolContext.desk`.

##### desk?

```ts
optional desk?: StubDelegate;
```

The `stubDelegate` twin of `ToolContextOverrides.model`.

##### env?

```ts
optional env?: ToolContext["env"];
```

See [ToolContext.env](../aai/index.md#env-7). Defaults to `{}`.

##### generate?

```ts
optional generate?: 
  | ToolContext["generate"]
  | StubGenerateScript;
```

A real `ctx.generate`, or `stubGenerate`'s own SCRIPT — `{ reply }` or
`{ routes }`.

A script is built into the fake here, so the two-step every spec wrote —
`stubGenerate(script)`, destructure, `createToolContext({ generate })` — is
one call, and the fake comes back on `TestToolContext.model`.

**A FUNCTION in this position is always the seam itself**, and nothing else
can be one: a computed route is written `{ reply: (call) => … }`, so it
cannot be mistaken for a `GenerateFn` the way a bare function route used to
be.

##### messages?

```ts
optional messages?: ToolContext["messages"];
```

See [ToolContext.messages](../aai/index.md#messages-4). Defaults to `[]`.

##### model?

```ts
optional model?: StubGenerate;
```

A fake this spec built itself, to be exposed as `TestToolContext.model`
— and, unless `generate` also names a function, INSTALLED as the seam.

The escape hatch under the script sugar: a caller holding a `stubGenerate`
it wants to share across two contexts names it here rather than leaving
`ctx.model` pointing at a fake nothing reaches.

##### now?

```ts
optional now?: ToolContext["now"];
```

See [ToolContext.now](../aai/index.md#now). Defaults to `Date.now`.

##### random?

```ts
optional random?: ToolContext["random"];
```

See [ToolContext.random](../aai/index.md#random-1). Defaults to a SEEDED source.

##### send?

```ts
optional send?: ToolContext["send"];
```

See [ToolContext.send](../aai/index.md#send-5). Defaults to the recorder behind `TestToolContext.sent`.

##### sessionId?

```ts
optional sessionId?: ToolContext["sessionId"];
```

See [ToolContext.sessionId](../aai/index.md#sessionid-5). Defaults to a fresh id per call.

##### signal?

```ts
optional signal?: ToolContext["signal"];
```

See [ToolContext.signal](../aai/index.md#signal-5). Defaults to a signal that never aborts.

##### slots?

```ts
optional slots?: ToolContext["slots"];
```

See [ToolContext.slots](../aai/index.md#slots-4). Defaults to a fresh, empty, REAL slot store.

##### speech?

```ts
optional speech?: ToolContext["speech"];
```

See [ToolContext.speech](../aai/index.md#speech-2). Defaults to the recorder behind `TestToolContext.said`.

##### turn?

```ts
optional turn?: ToolContext["turn"];
```

See [ToolContext.turn](../aai/index.md#turn-1). Defaults to `0` — a context that belongs to no turn.

##### workflows?

```ts
optional workflows?: ToolContext["workflows"];
```

See [ToolContext.workflows](../aai/index.md#workflows-4). Defaults to a client whose every method rejects.

***

### WorkflowContextOptions

```ts
type WorkflowContextOptions = {
  hooks?: Record<string, unknown>;
  key?: string;
  now?: number | (() => number);
  random?: number | (() => number);
  results?: Record<string, unknown>;
  runId?: string;
  runSteps?: boolean;
  uuid?: string | (() => string);
  workflow?: string;
};
```

**`Input`**

What [createWorkflowContext](#createworkflowcontext) takes.

#### Properties

##### hooks?

```ts
optional hooks?: Record<string, unknown>;
```

Payloads for `ctx.waitFor`, by token.

A token that is absent THROWS rather than hanging, because a spec that hangs
reports a timeout naming the runner instead of the missing payload.

##### key?

```ts
optional key?: string;
```

The run's `StartOptions.key` — what `ctx.key` answers and what
`ctx.signalToken`/`ctx.waitForSignal` derive from. Defaults to none, so a
body that signals is driven with the key it would be started with.

##### now?

```ts
optional now?: number | (() => number);
```

What `ctx.now()` answers — a fixed number, or a function called per reach.

Defaults to [WORKFLOW\_CONTEXT\_NOW](#workflow_context_now), a FIXED instant, so a body's derived
durations are constants a spec can write down. There is no journal here, so
nothing is memoized: a function is called once per reach, which is what a
spec asserting on two reads (a start and an end) wants.

##### random?

```ts
optional random?: number | (() => number);
```

What `ctx.random()` answers. Defaults to a fixed `0.5`.

##### results?

```ts
optional results?: Record<string, unknown>;
```

Results to answer particular steps with, by step NAME.

Takes precedence over running the step, so it works in both modes: with
`runSteps: true` it stubs one expensive step and leaves the rest real, and
with `runSteps: false` it is what makes a body whose control flow READS its
steps drivable at all — `planAngles` returning `undefined` otherwise reaches
the fan-out below it as a missing list.

Keyed by name rather than by occurrence: a step in a loop is one name, and a
spec that needs the iterations to differ wants `runSteps: true` with the
collaborator stubbed instead.

##### runId?

```ts
optional runId?: string;
```

Defaults to `"wrun_test"`.

##### runSteps?

```ts
optional runSteps?: boolean;
```

Run each step's `fn`, or only record that it was reached.

Defaults to `true`, which is what makes this drive a REAL body. Pass `false`
when the subject is the policy or the order — a step that is not run needs
no collaborator stubbed, so such a spec stays short.

Note a recorded-only step resolves `undefined`, so a body that reads its
result will see one. That is the honest cost of not running it.

##### uuid?

```ts
optional uuid?: string | (() => string);
```

What `ctx.uuid()` answers.

Defaults to a DISTINCT value per reach — `"uuid-0"`, `"uuid-1"`, … — because
a body that mints two ids and gets one is a body whose bug the spec would
hide. Not a real UUID, deliberately: a spec asserting on a shape rather than
on a value is asserting on the fake.

##### workflow?

```ts
optional workflow?: string;
```

The declared key. Defaults to `"test"`.

***

### WorkflowContextRecorder

```ts
type WorkflowContextRecorder = WorkflowContext & {
  slept: RecordedSleep[];
  steps: RecordedStep[];
  waited: string[];
};
```

**`Sealed`**

What [createWorkflowContext](#createworkflowcontext) answers: a real `WorkflowContext` plus its log.

#### Type Declaration

##### slept

```ts
readonly slept: RecordedSleep[];
```

Every `ctx.sleep`, in order.

##### steps

```ts
readonly steps: RecordedStep[];
```

Every step reached, in the order the body reached them.

##### waited

```ts
readonly waited: string[];
```

Every token `ctx.waitFor` was called with, in order.

***

### WorkflowJournal

```ts
type WorkflowJournal = {
  [workflowJournalBrand]: true;
};
```

**`Sealed`**

Where a host's durable runs are recorded — an opaque handle a host passes as
`RuntimeOptions.journal` (or to `runWorkflow`) and never reads.

 Only [createMemoryJournal](#creatememoryjournal) (and this package's own durable
backends) produce one — see [workflowJournalBrand](#workflowjournalbrand-1).

#### Properties

##### \[workflowJournalBrand\]

```ts
readonly [workflowJournalBrand]: true;
```

The seal — see [workflowJournalBrand](#workflowjournalbrand-1).

***

### workflowJournalBrand

```ts
type workflowJournalBrand = typeof workflowJournalBrand;
```

The seal [WorkflowJournal](#workflowjournal) carries. TYPE-ONLY: there is no value to
import, which is what stops a hand-written object from satisfying the type.

***

### WorkflowTestHandle

```ts
type WorkflowTestHandle<R> = WorkflowTestRun<R> & {
  journal: WorkflowJournal;
  key: string;
  signalled: boolean;
  advanceSleep: Promise<WorkflowTestHandle<R>>;
  close: Promise<void>;
  expireWaits: Promise<WorkflowTestHandle<R>>;
  restart: Promise<WorkflowTestHandle<R>>;
  signal: Promise<WorkflowTestHandle<R>>;
  signalRun: Promise<WorkflowTestHandle<R>>;
};
```

**`Sealed`**

A started run, plus the four things a spec can do to it.

Every method drives the run and resolves the SAME handle, so a spec reads the
fields off it afterwards rather than threading a new value:

```ts
import { workflow } from "@alexkroman1/aai";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";

const review = workflow({
  description: "Hold a draft until a human approves it.",
  run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval"),
});

const run = await runWorkflow(review, {}, { name: "review" });
await run.signal("approval", { approved: true });
console.log(run.status, run.output);
```

#### Type Declaration

##### journal

```ts
readonly journal: WorkflowJournal;
```

The journal the run lives in — opaque, and what a caller may pass back in
as [RunWorkflowOptions.journal](#journal) to start a second run against the
same world. What it holds for this run is [WorkflowTestRun.steps](#steps),
[WorkflowTestRun.reads](#reads) and [WorkflowTestRun.waits](#waits).

##### key

```ts
readonly key: string;
```

The correlation key the run was started with — [RunWorkflowOptions.key](#key-1),
`"test"` by default — which is what the body reads as `ctx.key` and what
its `ctx.signalToken(label)` derives a token from.

##### signalled

```ts
readonly signalled: boolean;
```

What the last `signal` or `signalRun` answered.

##### advanceSleep()

```ts
advanceSleep(correlationIds?: readonly string[]): Promise<WorkflowTestHandle<R>>;
```

Cut short every wait the run is parked on, and deliver.

`ctx.workflows.wakeUp`'s own mechanism, which is what makes it honest: the
journaled deadline is marked woken and the body continues from the journal,
exactly as it would when a tool decides not to wait out a schedule. It does
NOT move a clock, so a body that computes a duration from `ctx.now` still
sees the instant it was journaled with.

A bare call reaches SLEEPS only. A hook's deadline is a different kind of
wait and is ended by naming its correlation id, or by answering it with
`signal` — see [WorkflowTestWait.kind](#kind-2) for the approval
window a bare wake used to close.

Resolves this handle. Read `wakeAt` before calling it to assert what the
body asked for.

###### Parameters

###### correlationIds?

readonly `string`[]

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### close()

```ts
close(): Promise<void>;
```

Stop the engine.

Nothing leaks without it — this driver injects its own dispatcher, so no
timer is ever armed — but a run left open is still an engine holding a
journal, and calling it is what keeps that true if the driver ever arms one.

###### Returns

`Promise`\<`void`\>

##### expireWaits()

```ts
expireWaits(): Promise<WorkflowTestHandle<R>>;
```

Close every `ctx.waitFor` WINDOW the run is parked on, and deliver.

The branch a body's safe default lives in, and the one nothing else can
reach. A `waitFor(token, { timeoutMs })` journals its deadline as a sleep of
kind `hookTimeout`, and `ctx.workflows.wakeUp` deliberately cannot end one:
a bare wake is the "send it now" call a tool makes to cut a SCHEDULE short,
and letting it also close an approval window would cancel something the body
never asked to cancel. A targeted wake cannot either — the deadline carries
no correlation id. So without this, the only way to reach the timeout branch
is to wait out a window measured in minutes.

It does NOT move a clock and does not rewrite the stored record. It answers
the deadline READ the way an elapsed one answers it — `woken`, which
[WorkflowTestWait.woken](#woken) defines as "returns immediately" — for the
windows OUTSTANDING when it is called, from the delivery it triggers on
(a closed window stays closed on every later walk, as an elapsed one
does). A window the body opens during that delivery (a second `waitFor`
the first one's close led to) is not expired with them: it parks, and a
later `expireWaits()` or `signal` ends it. Everything downstream is the
engine's own: the close is still a compare-and-set on `delivered`, so a
payload that landed first still wins and the body still takes the
ANSWERED branch.

Resolves this handle. A run parked on a `ctx.sleep` is unaffected;
`advanceSleep` is that one.

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### restart()

```ts
restart(): Promise<WorkflowTestHandle<R>>;
```

Throw this engine away, build a new one over the same journal, and deliver.

The crash model an author cares about: the process is gone and the journal
is not. A step already journaled returns its stored result without running,
and a step that was mid-flight runs again — which is the at-least-once
contract seen from a body's own side.

It models the redelivery a QUEUE makes rather than
`createInProcessWorkflowEngine`'s boot sweep, because this driver owns the
schedule (see [runWorkflow](#runworkflow)). The sweep — the thing that re-enqueues a
run whose deadline outlived the process — has its own property in this
package and is not what a template spec is asserting.

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### signal()

```ts
signal(token: string, payload?: unknown): Promise<WorkflowTestHandle<R>>;
```

Answer a `ctx.waitFor` token, and deliver.

Resolves this handle. `signalled` says whether
anything was holding the token — `false` for a token nobody waits on, one
already answered, or one whose window has closed, which are the same refusal
a deployed `ctx.workflows.signal` gives.

###### Parameters

###### token

`string`

###### payload?

`unknown`

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

##### signalRun()

```ts
signalRun(label: string, payload?: unknown): Promise<WorkflowTestHandle<R>>;
```

Answer the body's `ctx.waitForSignal(label)`, and deliver — `signal`
for the token the body DERIVED from the run's name, its `key` and
`label` (`ctx.signalToken`), so a spec names the label it reads in the
body rather than re-spelling the token grammar. `signalled` reads the
same answer.

###### Parameters

###### label

`string`

###### payload?

`unknown`

###### Returns

`Promise`\<[`WorkflowTestHandle`](#workflowtesthandle)\<`R`\>\>

#### Type Parameters

##### R

`R`

***

### WorkflowTestRead

```ts
type WorkflowTestRead = {
  key: string;
  kind:   | "now"
     | "random"
     | "uuid"
     | string & {
   };
  value: unknown;
};
```

**`Sealed`**

One journaled determinism read — what `ctx.now()`, `ctx.random()` or
`ctx.uuid()` answered, and will answer again on every later walk.

#### Properties

##### key

```ts
readonly key: string;
```

`now!0`, `random!0`, `uuid!0` — the reserved key space, per kind.

##### kind

```ts
readonly kind: 
  | "now"
  | "random"
  | "uuid"
  | string & {
};
```

Which affordance this reach was: `now`, `random` or `uuid`. Open, so a new
determinism read is not a break for a spec switching over this.

##### value

```ts
readonly value: unknown;
```

The value the journal holds, which every replay reads back.

***

### WorkflowTestRun

```ts
type WorkflowTestRun<R> = {
  crashed: boolean;
  deliveries: number;
  error: string | undefined;
  output: R | undefined;
  reads: readonly WorkflowTestRead[];
  resumable: boolean;
  runId: string;
  status: WorkflowRunStatus;
  steps: readonly WorkflowTestStep[];
  waits: readonly WorkflowTestWait[];
  wakeAt: number | undefined;
};
```

**`Sealed`**

The run, as it stands after the last thing the driver did.

#### Type Parameters

##### R

`R`

What the body returns, taken from the declaration.

#### Properties

##### crashed

```ts
readonly crashed: boolean;
```

True once a [RunWorkflowOptions.crashAt](#crashat) delivery was killed.

##### deliveries

```ts
readonly deliveries: number;
```

Deliveries this run has taken.

A durable run is delivered once per suspension plus once to start, so this
is what a spec reads to assert that a resume really was a SECOND walk rather
than one body that happened to keep going.

##### error

```ts
readonly error: string | undefined;
```

The failure message, once the run is `failed`.

##### output

```ts
readonly output: R | undefined;
```

The body's return value, once the run is `completed`.

##### reads

```ts
readonly reads: readonly WorkflowTestRead[];
```

Every journaled determinism read — `ctx.now()`, `ctx.random()`,
`ctx.uuid()` — in the same canonical order.

Kept apart from [WorkflowTestRun.steps](#steps) because the ENGINE keeps them
apart: they are journaled through the same `appendStep` (which is what makes
a second walk read the same value, and what let them ship without a new
`JournalStore` method) but into a reserved key space of their own —
`now!0`, not `now#0` — and `isDeterminismKey` is the engine's own predicate
for the difference. They also carry no attempt, having no body to abandon.

Folding them in was this surface's own bug: a spec asserting which call
sites a body reached got a `now` it never wrote, and the projection was
flattening a distinction the journal makes on purpose.

##### resumable

```ts
readonly resumable: boolean;
```

Would a boot sweep pick this run up?

The query a worker that died mid-run is found by: `true` for every run not
yet settled — parked on a deadline (the sweep re-arms it) or abandoned
mid-walk (the sweep redelivers it) — which is what makes "resume" a
platform behaviour rather than a promise this handle keeps.

##### runId

```ts
readonly runId: string;
```

##### status

```ts
readonly status: WorkflowRunStatus;
```

Where the run is.

`running` is the PARKED state as well as the executing one — a durable run
that suspended is in progress, it is just not executing — so a spec that
expects a wait asserts `running` plus a [WorkflowTestRun.wakeAt](#wakeat) or a
pending hook.

##### steps

```ts
readonly steps: readonly WorkflowTestStep[];
```

Every settled `ctx.step`, ordered by NAME and then by occurrence.

## Not the journal's order, deliberately

`JournalStore.readSteps` answers by `finishedAt` with the key breaking a
tie, which is the right contract for a STORE — it is what makes three
backends comparable — and the wrong one to hand a spec. Two steps of one
fast walk settle inside the same millisecond routinely, so under that order
the obvious assertion
(`expect(run.steps.map((s) => s.key)).toEqual([…])`) passes on a slow
machine and fails on a quick one. That is a flake whose failure names a
timing detail rather than a bug, which is the shape this repo refuses
everywhere else it observes a clock.

So the order here is a property of the BODY rather than of the run: `name`
ascending, then occurrence NUMERICALLY — `poll#2` before `poll#10`, which a
plain string sort gets wrong. Nothing is lost, because settle order under a
fan-out is the scheduler's and was never assertable anyway.

`ctx.now()`, `ctx.random()` and `ctx.uuid()` are NOT in here — see
[WorkflowTestRun.reads](#reads).

##### waits

```ts
readonly waits: readonly WorkflowTestWait[];
```

Every wait the journal holds for this run — a `ctx.sleep`'s deadline or a
`ctx.waitFor` window's — ordered by key.

The durable record rather than the driver's view of it: what tells an
ordinary sleep from an approval window's deadline is
[WorkflowTestWait.kind](#kind-2), and only the journal carries it.

##### wakeAt

```ts
readonly wakeAt: number | undefined;
```

The deadline the run is parked on, when it is parked on one.

Read off what the body's suspension handed the dispatcher, which is the
journaled wake time — so a spec asserting "it slept for a day" compares this
against the instant the run started rather than waiting one.

***

### WorkflowTestStep

```ts
type WorkflowTestStep = {
  attempts: number;
  error?: string;
  key: string;
  name: string;
  output?: unknown;
  status:   | "ok"
     | "failed"
     | string & {
   };
};
```

**`Sealed`**

One step the run journaled.

A projection of the engine's own `StepEntry` rather than that type re-exported:
`finishedAt` is a wall clock, so a spec that could see it would be a spec that
could depend on it.

#### Properties

##### attempts

```ts
readonly attempts: number;
```

Attempts this step consumed, counting the one that settled it.

The field a spec asserting a RETRY reads: a `maxAttempts` step whose body
threw once and then succeeded settles at `2`.

##### error?

```ts
readonly optional error?: string;
```

Why it failed. Present when `status` is `failed`.

##### key

```ts
readonly key: string;
```

`name#occurrence` — what makes a step in a loop distinguishable.

##### name

```ts
readonly name: string;
```

The name the body passed `ctx.step`.

##### output?

```ts
readonly optional output?: unknown;
```

What the step returned. Present when `status` is `ok`.

##### status

```ts
readonly status: 
  | "ok"
  | "failed"
  | string & {
};
```

`ok` or `failed` today; open, so a new settle state is not a break.

***

### WorkflowTestWait

```ts
type WorkflowTestWait = {
  correlationId: string | undefined;
  key: string;
  kind:   | "sleep"
     | "hookTimeout"
     | string & {
   };
  wakeAt: number;
  woken: boolean;
};
```

**`Sealed`**

One wait the run's journal holds.

#### Properties

##### correlationId

```ts
readonly correlationId: string | undefined;
```

The correlation id a targeted wake names, when the body gave one.

##### key

```ts
readonly key: string;
```

The journal key of the suspension (`sleep!poll#0`, …).

##### kind

```ts
readonly kind: 
  | "sleep"
  | "hookTimeout"
  | string & {
};
```

`sleep` for a `ctx.sleep`, `hookTimeout` for a `ctx.waitFor` window's
deadline — the distinction a bare `advanceSleep()` respects (it ends only
sleeps). Open, so a new kind of wait is not a break.

##### wakeAt

```ts
readonly wakeAt: number;
```

The journaled wake time, epoch milliseconds.

##### woken

```ts
readonly woken: boolean;
```

Already woken: a later walk past it returns immediately.

## Variables

### DEFAULT\_MAX\_DELIVERIES

```ts
const DEFAULT_MAX_DELIVERIES: 50 = 50;
```

How many deliveries one run may take before the driver gives up.

Generous — a template's longest body suspends twice — and low enough that a
body woken in a loop fails in milliseconds with a message naming the bound
rather than hanging until the runner's own timeout, which reports the runner.

***

### STUB\_SPEECH\_PCM\_BYTES

```ts
const STUB_SPEECH_PCM_BYTES: number;
```

PCM bytes [stubSpeech](#stubspeech) answers with when no size is named — ~0.25s at 24 kHz.

***

### WORKFLOW\_CONTEXT\_NOW

```ts
const WORKFLOW_CONTEXT_NOW: number;
```

The instant [createWorkflowContext](#createworkflowcontext) freezes `ctx.now()` at.

`2026-01-01T00:00:00.000Z`. Exported so a spec computes an expected duration
from it rather than copying the number.

## References

### createRecordingWorkflows

Re-exports [createRecordingWorkflows](eval/vitest.md#createrecordingworkflows)

***

### dialogRefusalPattern

Re-exports [dialogRefusalPattern](eval/vitest.md#dialogrefusalpattern)

***

### dialogResultSchema

Re-exports [dialogResultSchema](eval/vitest.md#dialogresultschema)

***

### eventsOf

Re-exports [eventsOf](eval/vitest.md#eventsof)

***

### HostAgentOptions

Re-exports [HostAgentOptions](eval.md#hostagentoptions)

***

### isEvent

Re-exports [isEvent](eval/vitest.md#isevent)

***

### RecordingWorkflows

Re-exports [RecordingWorkflows](eval/vitest.md#recordingworkflows)

***

### RecordingWorkflowsOptions

Re-exports [RecordingWorkflowsOptions](eval/vitest.md#recordingworkflowsoptions)

***

### stubGatewayRoute

Re-exports [stubGatewayRoute](eval/vitest.md#stubgatewayroute-1)

***

### StubGatewayRoute

Re-exports [StubGatewayRoute](eval/vitest.md#stubgatewayroute)

***

### StubSpeech

Re-exports [StubSpeech](eval/vitest.md#stubspeech)

***

### StubSpeechOptions

Re-exports [StubSpeechOptions](eval/vitest.md#stubspeechoptions)

***

### StubStepDelegate

Re-exports [StubStepDelegate](eval/vitest.md#stubstepdelegate)

***

### StubStepFetch

Re-exports [StubStepFetch](eval/vitest.md#stubstepfetch)

***

### StubTranscribe

Re-exports [StubTranscribe](eval/vitest.md#stubtranscribe)

***

### StubTranscribeOptions

Re-exports [StubTranscribeOptions](eval/vitest.md#stubtranscribeoptions)

***

### StubUploads

Re-exports [StubUploads](eval/vitest.md#stubuploads)

***

### StubUploadsOptions

Re-exports [StubUploadsOptions](eval/vitest.md#stubuploadsoptions)
