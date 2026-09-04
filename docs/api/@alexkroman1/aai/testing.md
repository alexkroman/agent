# testing

Test helpers for agent code (the `@alexkroman1/aai/testing` subpath).

**Framework-agnostic on purpose.** Everything here returns a fake rather than
installing one — `createToolContext`'s `send` records into an array instead of
calling a mock library, and each `stub*` hands back a `restore` the caller
owns. So this module carries no test-runner dependency, a project on another
runner can still use all of it, and a spy can be passed IN wherever a spec
wants call-order assertions. The half that installs into vitest, including an
`install*` per fake that registers its own cleanup, is
`@alexkroman1/aai/testing/vitest`.

**This module is the assembly point, not the implementation.** Each fake is a
function plus the shape of what it records, and lives in its own module beside
this one; what is here is the re-export surface and `stubReporter`. Reading
order, roughly by what a spec reaches for first:

- `_testing-context.ts` — `createToolContext`, and the stub `db`/`workflows`
  its defaults are built from.
- `testing-tools.ts` — `toolOf` / `runTool` / `toolRunner`, the tool under the
  name the model calls it by, the last of those being `runTool` with the agent
  bound; `testing-discovery.ts` — `deployedAgent`, which lowers a project's
  own FILES (`tools/`, `system-prompt.md`) onto its `agent.ts` default export
  the way the build does — the one function a spec needs.
- `_testing-tool-results.ts` — `ok` / `okPosition`, unwrapping what a gated
  tool answered; `_testing-schema.ts` — what a tool's or workflow's input
  schema accepts, without reaching through `~standard`.
- `testing-delegate.ts` — `stubDelegate`, the same seam one loop up: what a
  SUBAGENT concluded, without running one.
- `_testing-step-fetch.ts`, `testing-gateway.ts`, `testing-generate.ts`,
  `testing-speech.ts`, `_testing-transcribe.ts`, `testing-uploads.ts` — the
  slots a step reaches through, each answered in memory.
- `testing-workflows.ts` — run snapshots and progress streams, for a page;
  `testing-workflow-ctx.ts` — `createWorkflowCtx`, the `ctx` a workflow BODY
  takes, which nothing else can hand it.

## Functions

### createProgressStream()

```ts
function createProgressStream(lines?: readonly unknown[]): ReadableStream<unknown>;
```

The progress channel of a run, from the read side — what
`ctx.workflows.stream` resolves with.

Closes after the given lines, which is what makes a tool that drains it
terminate. A run's real stream never closes (no step knows it is the last
one), and the tool bounds itself with `streamTail` instead — so a spec that
wants to exercise THAT bound stubs `streamTail`, not this.

#### Parameters

##### lines?

readonly `unknown`[]

#### Returns

`ReadableStream`\<`unknown`\>

#### Example

```ts
import { createProgressStream, createStubWorkflows } from "@alexkroman1/aai/testing";

const workflows = createStubWorkflows({
  streamTail: () => Promise.resolve(0),
  stream: () => Promise.resolve(createProgressStream(["Reading the sources…"])),
});
```

***

### createRunSnapshot()

```ts
function createRunSnapshot<R = unknown>(over?: RunSnapshotOverrides<R>): WorkflowRunSnapshot<R>;
```

Build a [WorkflowRunSnapshot](workflow-api.md#workflowrunsnapshot) — the right arm of the union, without a
cast.

Defaults to a `running` run, which is the state a tool that has just started
one reads back.

#### Type Parameters

##### R

`R` = `unknown`

#### Parameters

##### over?

[`RunSnapshotOverrides`](#runsnapshotoverrides)\<`R`\>

#### Returns

[`WorkflowRunSnapshot`](workflow-api.md#workflowrunsnapshot)\<`R`\>

#### Example

```ts
import { createRunSnapshot, createStubWorkflows } from "@alexkroman1/aai/testing";

const workflows = createStubWorkflows({
  find: () => Promise.resolve([createRunSnapshot({ status: "failed", error: "gateway down" })]),
});
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

`Partial`\<[`WorkflowClient`](index.md#workflowclient)\>

#### Returns

[`WorkflowClient`](index.md#workflowclient)

***

### createToolContext()

```ts
function createToolContext(overrides?: ToolContextOverrides): TestToolContext;
```

Build a [ToolContext](index.md#toolcontext) for testing a tool's `execute` in isolation.

Defaults are chosen so the context is inert: empty `env`, an empty slot store,
a `db`, `generate` and `delegate` that reject with a message naming
themselves, a `signal` that never aborts, and a `send` that records.
Override any of them.

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

***

### createWorkflowCtx()

```ts
function createWorkflowCtx(options?: WorkflowCtxOptions): WorkflowCtxRecorder;
```

Build a `WorkflowCtx` that runs a body and records what it asked for.

#### Parameters

##### options?

[`WorkflowCtxOptions`](#workflowctxoptions)

#### Returns

[`WorkflowCtxRecorder`](#workflowctxrecorder)

#### Example

```ts no-check
const ctx = createWorkflowCtx();
const output = await digestFlow({ url: "https://example.com/a" }, ctx);

expect(output.headline).toBe("…");
expect(ctx.steps.map((s) => s.name)).toEqual(["fetchArticle", "summarize", "file"]);
expect(ctx.slept).toEqual([{ label: "settle", until: 10_000 }]);
```

***

### deployedAgent()

```ts
function deployedAgent<D extends AgentDef>(authored: D, project: ProjectFiles): D;
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
// blocker: the doc-example gate compiles against the scaffold's own
// `global.d.ts`, which carries `/// <reference types="vite/client" />`.)
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
`system-prompt.md` that exists while `agent.ts` declares a DIFFERENT prompt —
the "I edited the prompt and nothing changed" failure.

#### Type Parameters

##### D

`D` *extends* [`AgentDef`](index.md#agentdef)

#### Parameters

##### authored

`D`

##### project

[`ProjectFiles`](#projectfiles)

#### Returns

`D`

***

### ok()

```ts
function ok<T>(result: unknown): T;
```

The value a gated tool's own `execute` returned, or a throw naming the refusal.

#### Type Parameters

##### T

`T`

What the tool's `execute` returns. Unchecked at runtime, like
  any assertion about a value crossing a `unknown` boundary — this recovers
  the type the lookup path cannot, it does not validate it.

#### Parameters

##### result

`unknown`

What `runTool` / `toolOf(...).execute(...)` answered.

#### Returns

`T`

#### Throws

When the tool refused (`ToolFailure`), quoting the refusal —
  which for a `dialog()` tool is the sentence naming the state the
  conversation is actually in and what has to happen first.

#### Throws

When the value is not a tool result envelope at all, which is what a
  plain `tool()` answers: use its return value directly, there is nothing to
  unwrap.

#### Example

```ts no-check
// `no-check`: the agent under test is in another file, which is the point.
import { ok, runTool } from "@alexkroman1/aai/testing";

const order = ok<{ id: string }>(await runTool(agentDef, "place_order", {}, ctx));
expect(order.id).toBe("ord_1");
```

***

### okPosition()

```ts
function okPosition<T>(result: unknown): DialogToolResult<T>;
```

The same unwrap as [ok](#ok), keeping WHERE the dialog landed.

The half a spec needs when the assertion is about the conversation rather
than about the tool's own value — that a call advanced the machine into
`quote.pending`, that a final state reports `done`. `ok()` is this with
`.result` taken off the end.

#### Type Parameters

##### T

`T`

What the tool's `execute` returns, under `result`.

#### Parameters

##### result

`unknown`

#### Returns

[`DialogToolResult`](index.md#dialogtoolresult)\<`T`\>

#### Throws

As [ok](#ok) does, and for the same reasons.

#### Example

```ts no-check
import { okPosition, runTool } from "@alexkroman1/aai/testing";

const answered = okPosition<{ quoted: number }>(await runTool(agentDef, "quote", {}, ctx));
expect(answered.state).toBe("quote.pending");
expect(answered.result.quoted).toBe(42);
```

***

### parseSchemaInput()

```ts
function parseSchemaInput<T = Record<string, unknown>>(
   schema: StandardSchemaV1<unknown, unknown> | undefined, 
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

`StandardSchemaV1`\<`unknown`, `unknown`\> \| `undefined`

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

### routeStepFetch()

```ts
function routeStepFetch(routes: readonly StepRoute[], options?: {
  unmatched?: StepUnmatched;
}): (request: StubStepRequest) => StubStepAnswer;
```

Compose several [StepRoute](#steproute)s into the one handler `stubStepFetch`
takes.

Publishing a `stepFetch` REPLACES, so a flow that calls a model AND fetches a
page AND transcribes can install exactly one fake and has to route inside it.
Thirteen sites across seven templates wrote that composition by hand, and
they did not agree on the part that matters — the unmatched case. Three threw
(with a byte-identical message), two answered 404, and six fell through to a
second fake.

**The default is `"throw"` because the alternatives HIDE a finding.** A 404
for a request nobody set up reads to the run as a provider that refused, so
the flow takes its own error path and the spec passes green having tested the
wrong branch. A spec that really is about a 404 says so.

Order matters: the first route to answer wins, so put the most specific leg
first. A route that throws is left alone — this only decides what happens
when every leg answers `undefined`.

#### Parameters

##### routes

readonly [`StepRoute`](#steproute)[]

##### options?

###### unmatched?

[`StepUnmatched`](#stepunmatched)

#### Returns

(`request`: [`StubStepRequest`](#stubsteprequest)) => [`StubStepAnswer`](#stubstepanswer)

#### Example

```ts
import { routeStepFetch, stubGatewayRoute } from "@alexkroman1/aai/testing";

const model = stubGatewayRoute(['{"summary":"ok"}']);
// Model first, then the page; anything else is a finding.
const handler = routeStepFetch([model.route, (req) =>
  req.url.startsWith("https://example.test") ? { body: "<p>hi</p>" } : undefined,
]);
```

***

### runTool()

```ts
function runTool(
   agent: ToolBearingAgent, 
   name: string, 
   argsOrCtx?: Record<string, unknown> | ToolContext, 
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

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

##### name

`string`

##### argsOrCtx?

`Record`\<`string`, `unknown`\> \| [`ToolContext`](index.md#toolcontext)

##### ctx?

[`ToolContext`](index.md#toolcontext)

The context. Defaults to a fresh [createToolContext](#createtoolcontext) — so
  an omitted context is a DISTINCT SESSION with empty slots, which is what a
  stateless tool wants and never what two calls sharing state want. Pass one
  explicitly wherever the second call is supposed to see the first call's
  work.

#### Returns

`Promise`\<`unknown`\>

#### Example

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

### schemaInputIssues()

```ts
function schemaInputIssues(
   schema: StandardSchemaV1<unknown, unknown> | undefined, 
   value: unknown, 
   what?: string
): Promise<readonly StandardSchemaIssue[] | undefined>;
```

The issues `schema` found in `value`, or `undefined` when it accepted it.

The negative half of [parseSchemaInput](#parseschemainput), and `undefined`-on-success is
deliberate: `expect(await schemaInputIssues(…)).toBeUndefined()` is the
accepting case and `…toBeDefined()` the refusing one, which is the pair every
hand-rolled site was already writing against `.issues`.

#### Parameters

##### schema

`StandardSchemaV1`\<`unknown`, `unknown`\> \| `undefined`

As [parseSchemaInput](#parseschemainput): `undefined` throws rather than
  reporting "no issues", which would make a negative test pass for a schema
  that does not exist.

##### value

`unknown`

##### what?

`string`

How the schema is named in that error.

#### Returns

`Promise`\<readonly `StandardSchemaIssue`[] \| `undefined`\>

#### Example

```ts no-check
import { schemaInputIssues } from "@alexkroman1/aai/testing";

expect(await schemaInputIssues(myWorkflow.input, { voice: "not-a-voice" })).toBeDefined();
```

***

### stubDelegate()

```ts
function stubDelegate(script: 
  | StubDelegateRoute
  | Readonly<Record<string, StubDelegateRoute>>): StubDelegate;
```

Build a fake `ctx.delegate` from a script keyed by subagent name.

Pass a single route (not a record) to answer every delegation the same way,
which is what a one-subagent tool wants.

#### Parameters

##### script

  \| [`StubDelegateRoute`](#stubdelegateroute)
  \| `Readonly`\<`Record`\<`string`, [`StubDelegateRoute`](#stubdelegateroute)\>\>

#### Returns

[`StubDelegate`](#stubdelegate)

#### Example

**Two subagents, one queue**

```ts
import { createToolContext, stubDelegate } from "@alexkroman1/aai/testing";

const findings = ["Rain on Tuesday.", "Clear on Wednesday."];
const desk = stubDelegate({
  researcher: () => ({ text: findings.shift() ?? "Nothing found.", steps: 3 }),
  "fact-checker": "Both claims check out.",
});
const ctx = createToolContext({ delegate: desk.delegate });
// … run the tool, then assert on who was asked what:
// expect(desk.calls.map((call) => call.subagent.name)).toEqual([…]);
```

***

### stubGateway()

```ts
function stubGateway(replies: string | readonly string[], opts?: StubGatewayOptions): StubGateway;
```

Build a fake LLM gateway answering `replies` in order.

The LAST reply repeats once the list runs out, so a spec names only the turns
it cares about — which is what makes this usable for a step whose model call
sits in a LOOP: a stub that says the same thing every turn can only ever drive
such a loop into its budget, and one that runs out mid-loop fails on the stub
rather than on the code.

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order. A bare string is one reply.

##### opts?

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

### stubGatewayRoute()

```ts
function stubGatewayRoute(replies: string | readonly string[], opts?: StubGatewayOptions): StubGatewayRoute;
```

A gateway reply for a step that goes through the PUBLISHED `stepFetch` slot
rather than the global `fetch`.

[stubGateway](#stubgateway-1) answers over `globalThis.fetch`, which is the wrong seam
whenever anything has published a `stepFetch`: publishing REPLACES, so a flow
that transcribes AND calls a model — or fetches a page and calls a model — can
install only one fake and has to route by URL inside it. Seven eval files did
exactly that, and each hand-typed the same two things:

1. **The envelope.** `{ body: { choices: [{ message: { content } }] } }`,
   written out six times in six spellings. It is a WIRE shape, so a typo in
   it does not fail — `stepGenerate` reads no content and reports an empty
   completion, i.e. the fake and the code under test disagree and the case
   blames the code.
2. **The cursor.** `contents.at(Math.min(next, contents.length - 1))`,
   re-derived twice, because a model call inside a LOOP cannot know how many
   calls it will make: a script that repeats one line can only drive the loop
   into its budget, and one that runs out mid-loop fails on the script. The
   last reply repeats, which is [stubGateway](#stubgateway-1)'s convention and now
   literally the same code.

And it hands back DECODED calls — `prompt`, `system`, `body`, `headers` — which
is the half no hand-rolled version had. Reading what the model was ASKED off a
`StubStepRequest` means `String(call.body)`, i.e. the raw JSON of the whole
request; one eval asserted its prompts that way and was really asserting
against the serialized `model` and `temperature` too.

```ts no-check
// `no-check`: the step under test is in another file, which is the point.
import { stubGatewayRoute } from "@alexkroman1/aai/testing";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";

const model = stubGatewayRoute(['{"verdict":"ship"}']);
installStubStepFetch((request) => model.route(request) ?? { body: PAGE_HTML });
// … run the workflow …
expect(model.calls[0]?.prompt).toContain("the brief");
```

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order; the last repeats. A bare
  string is one reply.

##### opts?

[`StubGatewayOptions`](#stubgatewayoptions)

#### Returns

[`StubGatewayRoute`](#stubgatewayroute)

***

### stubGenerate()

```ts
function stubGenerate(script: 
  | StubGenerateRoute
  | Readonly<Record<string, StubGenerateRoute>>): StubGenerate;
```

Build a fake `ctx.generate` from a script keyed by system prompt.

A call whose system prompt names no route throws, naming it — an unscripted
model call is a spec that has drifted from the tool, not a case to paper over.
Pass a single route (not a record) to answer every call the same way, which is
what a one-model tool wants.

#### Parameters

##### script

  \| [`StubGenerateRoute`](#stubgenerateroute)
  \| `Readonly`\<`Record`\<`string`, [`StubGenerateRoute`](#stubgenerateroute)\>\>

#### Returns

[`StubGenerate`](#stubgenerate)

#### Examples

**Two model roles, one queue**

```ts
import { createToolContext, stubGenerate } from "@alexkroman1/aai/testing";

const verdicts = ["yes", "no"];
const model = stubGenerate({
  "You grade documents.": () => ({ object: { score: verdicts.shift() ?? "yes" } }),
  "You answer questions.": "The documented answer.",
});
const ctx = createToolContext({ generate: model.generate });
// … run the tool, then assert on the roles it played:
// expect(model.calls.map((call) => call.system)).toEqual([…]);
```

**One model role**

```ts
import { stubGenerate } from "@alexkroman1/aai/testing";

const model = stubGenerate({ object: { steps: ["Only step"] } });
```

***

### stubReporter()

```ts
function stubReporter(): StubReporter;
```

Capture what a step narrates and emits.

`report()` and `emit()` both go through a published slot, and with nothing
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
answering the next file's steps — the same rule [stubStepFetch](#stubstepfetch-1) follows,
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

[`StubSpeechOptions`](#stubspeechoptions)

#### Returns

[`StubSpeech`](#stubspeech)

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

[`StubStepFetch`](#stubstepfetch)

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

[`StubTranscribeOptions`](#stubtranscribeoptions)

#### Returns

[`StubTranscribe`](#stubtranscribe)

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
`readUpload` can be tested without a server.

A step reads uploads through a process-wide slot rather than dialling
anything, which is what makes this possible at all: a spec supplies its own
bytes and the step under test is unchanged.

Returns a [StubUploads](#stubuploads) — `restore`, plus what a step WROTE. Calling
`restore` in an `afterEach` is not optional; a store left published makes the
next file's steps read this one's bytes, which is the kind of cross-file leak
that presents as a passing test somewhere else.

#### Parameters

##### files

`Readonly`\<`Record`\<`string`, [`StubUpload`](#stubupload)\>\>

Keyed by upload id — the same string a run input would carry.

##### options?

[`StubUploadsOptions`](#stubuploadsoptions)

#### Returns

[`StubUploads`](#stubuploads)

#### Examples

```ts
import { stubUploads } from "@alexkroman1/aai/testing";

const uploads = stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
// … call the step …
uploads.restore();

// A streamed upload mid-flight: `readUpload` comes back short and
// `uploadInfo(...).complete` is false, which is what a polling body sees.
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
): Promise<readonly StandardSchemaIssue[] | undefined>;
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

`Promise`\<readonly `StandardSchemaIssue`[] \| `undefined`\>

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

### toolOf()

```ts
function toolOf(agent: ToolBearingAgent, name: string): ToolDef<ToolInputSchema>;
```

The tool `name` is declared under, or a throw naming the ones that are.

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

[`ToolDef`](index.md#tooldef)\<[`ToolInputSchema`](index.md#toolinputschema)\>

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

## Interfaces

### SentEvent

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

One `ctx.delegate` call, as recorded by [stubDelegate](#stubdelegate-1).

#### Properties

##### options

```ts
options: DelegateOptions;
```

The whole options object, for asserting `context` and `maxSteps`.

##### subagent

```ts
subagent: SubagentDef;
```

The subagent that was asked.

##### task

```ts
task: string;
```

The task it was given.

***

### StubGateway

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

### StubGatewayRoute

A gateway answer for a `stepFetch`-published slot, plus what it was asked.

#### Properties

##### calls

```ts
calls: StubGatewayCall[];
```

Every completion request this route answered, DECODED, in call order.

##### route

```ts
route: (request: StubStepRequest) => StubStepAnswer | undefined;
```

Answers a completion request and `undefined` for anything else, so the
caller composes it: `?? { body: html }` for a flow that also fetches a
page, `?? someThrow()` for one where an unexpected request is a finding, or
straight into `stubTranscribe`'s `otherwise`.

###### Parameters

###### request

[`StubStepRequest`](#stubsteprequest)

###### Returns

[`StubStepAnswer`](#stubstepanswer) \| `undefined`

***

### StubGenerate

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

## Type Aliases

### ProjectFiles

```ts
type ProjectFiles = {
  systemPrompt?: string;
  tools?: ToolModules;
};
```

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
`agent.ts` imports the file itself and composes it — that case is
recognised and the def is left exactly as the author built it, so a spec
never has to know which of the two its own template does.

##### tools?

```ts
readonly optional tools?: ToolModules;
```

`import.meta.glob("./tools/*.ts", { eager: true })`, written at the CALL
SITE — see the module doc for why it cannot be a directory string.

Omit it for a project with no `tools/` directory. Passing an EMPTY glob is
an error, not a no-op: see [deployedAgent](#deployedagent).

***

### RecordedSleep

```ts
type RecordedSleep = {
  correlationId?: string;
  label: string;
  until: number | Date;
};
```

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

### RecordedStep

```ts
type RecordedStep = {
  maxAttempts?: number;
  name: string;
};
```

One step the body reached, as the recorder saw it.

#### Properties

##### maxAttempts?

```ts
optional maxAttempts?: number;
```

What the body asked for, or `undefined` when it passed no options.

##### name

```ts
name: string;
```

***

### RunSnapshotOverrides

```ts
type RunSnapshotOverrides<R = unknown> = Partial<WorkflowRunBase> & 
  | {
  status?: "pending" | "running";
}
  | {
  output: R;
  status: "completed";
}
  | {
  error: string;
  status: "failed";
}
  | {
  status: "cancelled";
};
```

What [createRunSnapshot](#createrunsnapshot) accepts: the shared fields, plus whatever the
chosen status requires.

The `status`-bearing half mirrors [WorkflowRunSnapshot](workflow-api.md#workflowrunsnapshot)'s own union, so
asking for `status: "completed"` without an `output` is a compile error rather
than a fixture that lies.

#### Type Parameters

##### R

`R` = `unknown`

The workflow's return type, when the caller names it.

***

### StepRoute

```ts
type StepRoute = (request: StubStepRequest) => StubStepAnswer | undefined;
```

One leg of a step's outside world: answers the requests it recognises and
`undefined` for everything else, so legs compose.

The shape `stubGatewayRoute` already hands back, named so a spec writing its
own leg (a page fetch, a provider's job API) writes the same thing.

#### Parameters

##### request

[`StubStepRequest`](#stubsteprequest)

#### Returns

[`StubStepAnswer`](#stubstepanswer) \| `undefined`

***

### StepUnmatched

```ts
type StepUnmatched = "throw" | "notFound" | StepRoute;
```

What an unrecognised request means.

- `"throw"` (the default) — a finding. A step asked for something the spec
  did not set up, and the test should say so at the call.
- `"notFound"` — a real 404, for a spec whose subject IS how a flow handles
  one.
- a [StepRoute](#steproute) — the fallback leg, for "anything else is this page".

***

### StubDelegateReply

```ts
type StubDelegateReply = 
  | string
  | {
  steps?: number;
  text: string;
  toolCalls?: readonly SubagentToolCall[];
};
```

What one route answers with.

A bare string is the subagent's final text with an empty cost report, which
is what a tool that only reads `text` wants. The object form fills in
`steps` and `toolCalls` for a tool that narrates the wait.

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

### StubEmitted

```ts
type StubEmitted = {
  chunk: unknown;
  namespace: string;
};
```

One chunk `emit()` wrote, and the stream it went to.

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

### StubReporter

```ts
type StubReporter = {
  emitted: StubEmitted[];
  lines: string[];
  restore: () => void;
};
```

What [stubReporter](#stubreporter-1) returns.

#### Properties

##### emitted

```ts
emitted: StubEmitted[];
```

Every chunk `emit()` wrote, oldest first.

##### lines

```ts
lines: string[];
```

Every line `report()` wrote, oldest first.

##### restore

```ts
restore: () => void;
```

Unpublish. Call it in an `afterEach` — see [stubReporter](#stubreporter-1).

###### Returns

`void`

***

### StubSpeech

```ts
type StubSpeech = {
  calls: StubSpeechCall[];
  restore: void;
};
```

What [stubSpeech](#stubspeech-1) returns: the call log, and how to put the slot back.

#### Methods

##### restore()

```ts
restore(): void;
```

Unpublish the synthesizer.

Calling it in an `afterEach` is not optional — a stub left published makes
the next file's steps speak into this one's log, which is the kind of
cross-file leak that presents as a passing test somewhere else.

###### Returns

`void`

#### Properties

##### calls

```ts
calls: StubSpeechCall[];
```

Every call, in order.

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

One `stepSpeak` call, as [stubSpeech](#stubspeech-1) records it.

#### Properties

##### apiKey

```ts
apiKey: string;
```

The credential `stepSpeak` resolved out of the step env.

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

### StubSpeechOptions

```ts
type StubSpeechOptions = {
  error?: Error;
  pcmBytes?: number;
};
```

What [stubSpeech](#stubspeech-1) may be told.

#### Properties

##### error?

```ts
optional error?: Error;
```

Fail instead of speaking, with this error.

The half a spec cannot write by leaving the slot empty: an unpublished
slot is "no synthesizer here", which is a different sentence and a
different branch from a provider that answered and refused.

##### pcmBytes?

```ts
optional pcmBytes?: number;
```

Bytes of PCM to answer with, per call.

Defaults to [STUB\_SPEECH\_PCM\_BYTES](#stub_speech_pcm_bytes), which is enough that the WAV
`stepSpeak` frames has a plausible duration and a spec asserting on one
gets a number rather than zero. A caller that cares about the exact
duration sets this: at the default 24 kHz mono 16-bit, one second is
48,000 bytes.

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

What a [stubStepFetch](#stubstepfetch-1) answer may be: a whole `Response`, or the
`{ status, body, headers }` shorthand that JSON-encodes `body`.

Named because the transcription fake (`stubTranscribe`) hands its
`otherwise` handler the same vocabulary, and a spec routing by URL should not
have to restate the union to write one.

***

### StubStepFetch

```ts
type StubStepFetch = {
  calls: StubStepRequest[];
  restore: () => void;
};
```

What [stubStepFetch](#stubstepfetch-1) returns.

#### Properties

##### calls

```ts
calls: StubStepRequest[];
```

Every request the step made, in order.

##### restore

```ts
restore: () => void;
```

Unpublish. Call it in an `afterEach` — see [stubStepFetch](#stubstepfetch-1).

###### Returns

`void`

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

One request a [stubStepFetch](#stubstepfetch-1) recorder captured.

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

### StubTranscribe

```ts
type StubTranscribe = {
  calls: StubTranscribeCall[];
  restore: void;
};
```

What [stubTranscribe](#stubtranscribe-1) returns.

#### Methods

##### restore()

```ts
restore(): void;
```

Unpublish.

Not optional — a `stepFetch` left published answers the next file's steps.
`installStubTranscribe` (`@alexkroman1/aai/testing/vitest`) is this with the
registration already done.

###### Returns

`void`

#### Properties

##### calls

```ts
calls: StubTranscribeCall[];
```

Every request that reached the fake, in order, each tagged with its leg.

***

### StubTranscribeCall

```ts
type StubTranscribeCall = StubStepRequest & {
  leg: StubTranscribeLeg;
};
```

One request [stubTranscribe](#stubtranscribe-1) answered, with the leg it belonged to.

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
type StubTranscribeLeg = "upload" | "submit" | "poll" | "sync" | "other";
```

Which transcription call a request was.

`"other"` is anything that is not one of the four — a model call, a feed
download — which reaches the `otherwise` handler rather than this fake.

***

### StubTranscribeOptions

```ts
type StubTranscribeOptions = {
  audioUrl?: string;
  durationSec?: number;
  failure?: StubTranscribeFailure;
  jobError?: string;
  jobIdPrefix?: string;
  otherwise?: (request: StubStepRequest) => 
     | StubStepAnswer
     | undefined
    | Promise<StubStepAnswer | undefined>;
  pendingPolls?: number;
  text?: string | readonly string[];
};
```

What [stubTranscribe](#stubtranscribe-1) may be told.

#### Properties

##### audioUrl?

```ts
optional audioUrl?: string;
```

What the upload leg answers with. Defaults to a fixed fake CDN URL.

##### durationSec?

```ts
optional durationSec?: number;
```

The provider's own duration measurement, in seconds. Defaults to `60`.

##### failure?

```ts
optional failure?: StubTranscribeFailure;
```

Refuse at the HTTP level. See [StubTranscribeFailure](#stubtranscribefailure).

##### jobError?

```ts
optional jobError?: string;
```

Fail the JOB rather than the request: the poll answers `200` with
`status: "error"` and this reason.

A different branch from [StubTranscribeOptions.failure](#failure) and the one
most likely to be got wrong in production code — the provider succeeded at
answering and the answer is "no". It is TERMINAL, and a flow that retried
it would poll a dead job until its budget ran out.

##### jobIdPrefix?

```ts
optional jobIdPrefix?: string;
```

Prefix for the job ids the submit leg mints. Defaults to
`"stub_transcript_"`, with a 1-based counter after it.

Minted rather than random for the reason `stubUploads`'s ids are: a spec
asserting that a run journaled the job it later polled needs the id to be a
value it can write down.

##### otherwise?

```ts
optional otherwise?: (request: StubStepRequest) => 
  | StubStepAnswer
  | undefined
| Promise<StubStepAnswer | undefined>;
```

Answer everything that is not a transcription call.

Publishing a `stepFetch` REPLACES, so a flow that transcribes AND calls a
model cannot have two fakes installed — this is the seam for the second
one. Returning `undefined` (or passing no handler) answers `404` with a body
naming the URL, which is a better failure than an empty `200` a step would
try to parse.

###### Parameters

###### request

[`StubStepRequest`](#stubsteprequest)

###### Returns

  \| [`StubStepAnswer`](#stubstepanswer)
  \| `undefined`
  \| `Promise`\<[`StubStepAnswer`](#stubstepanswer) \| `undefined`\>

##### pendingPolls?

```ts
optional pendingPolls?: number;
```

How many polls answer "still working" before the job completes. Defaults to
`0` — the first poll finds it done.

Counted PER JOB ID, so a flow that submits two jobs sees each of them take
the same number of polls. Keep it small: a caller's polling loop usually
`sleep`s between polls, and outside a real run that wait is not one a spec
should be taking.

##### text?

```ts
optional text?: string | readonly string[];
```

The words a completed job or a sync request comes back with.

A list is consumed one per COMPLETED answer and the last repeats, matching
`stubGateway`'s convention and for the same reason: a fan-out over segments
wants a different line per segment, and a stub that ran out mid-fan-out
would fail on the stub rather than on the code.

An EMPTY string is meaningful rather than a lazy default: the async API's
poll refuses it (`"There is no speech in that recording"`, terminal), and
the sync endpoint accepts it — a silent segment in a fan-out is ordinary.
That asymmetry is real, and this is how a spec drives it.

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

One file a [stubUploads](#stubuploads-1) store answers for.

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
a step polling one has to handle and the only one where `readUpload`
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

### StubUploads

```ts
type StubUploads = {
  writes: StubUploadWrite[];
  read: StubUploadWrite | undefined;
  restore: void;
};
```

What [stubUploads](#stubuploads-1) returns.

An OBJECT, like every other fake here (`stubSpeech`, `stubReporter`,
`stubStepFetch`) — this one used to be the bare `restore` function, which made
it the only stub in the family a spec had to remember was different, and left
a spec asserting on a WRITE to round-trip through `uploadInfo`/`readUpload`:
the published slot, read back through the same seam the step wrote it through,
to answer "did it write anything at all".

#### Methods

##### read()

```ts
read(id: string): StubUploadWrite | undefined;
```

What is stored under `id` right now — a seeded file or one a step wrote.

Synchronous and outside the published slot, so a spec asserting on bytes
does not have to `await readUpload` through the very seam it is testing.

###### Parameters

###### id

`string`

###### Returns

[`StubUploadWrite`](#stubuploadwrite) \| `undefined`

##### restore()

```ts
restore(): void;
```

Unpublish.

Not optional — a store left published makes the next file's steps read this
one's bytes, which is the kind of cross-file leak that presents as a passing
test somewhere else. `installStubUploads`
(`@alexkroman1/aai/testing/vitest`) is this store with the registration
already done.

###### Returns

`void`

#### Properties

##### writes

```ts
writes: StubUploadWrite[];
```

Every file a step wrote, in write order.

Empty unless the store was opened `{ writable: true }`, which is what makes
the pair readable as an assertion: a read-only store cannot accept a write,
so `writes` staying empty is the same fact as the step never having tried.

***

### StubUploadsOptions

```ts
type StubUploadsOptions = {
  idPrefix?: string;
  writable?: boolean;
};
```

What [stubUploads](#stubuploads-1) may be told beyond the files themselves.

#### Properties

##### idPrefix?

```ts
optional idPrefix?: string;
```

Prefix for the ids writes are given. Defaults to `"upl_stub_"`, with a
1-based counter after it — `upl_stub_1`, `upl_stub_2` — so the id a step
returned is a value a spec can assert on rather than a fresh UUID.

##### writable?

```ts
optional writable?: boolean;
```

Accept WRITES, so a step calling `writeUpload` can be tested.

Off by default, and deliberately: a store that silently accepts writes it
was not asked for cannot fail a spec whose step wrote a file nobody meant
it to, and `writeUpload` naming a read-only store is a better failure than
an upload appearing from nowhere. What a step writes is readable through
`readUpload`/`uploadInfo` on the id it was given, like any other upload.

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

One file a step WROTE into a [stubUploads](#stubuploads-1) store.

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
  sent: SentEvent[];
};
```

A [ToolContext](index.md#toolcontext) that records what its tools sent.

Assignable to `ToolContext` wherever one is required, so it passes straight
to `execute`.

#### Type Declaration

##### sent

```ts
readonly sent: SentEvent[];
```

Events `ctx.send` would put on the wire, in call order. An event the
runtime would drop (over the payload cap, an over-long name, no JSON form)
is not here, for the same reason it is not in the browser.

***

### ToolBearingAgent

```ts
type ToolBearingAgent = {
  tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>;
};
```

The slice of an agent these helpers read: its tool table.

Structural rather than `AgentDef`, so a spec may pass the agent's default
export, a bare `{ tools }` literal, or anything else carrying one.

#### Properties

##### tools

```ts
readonly tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>;
```

***

### ToolContextOverrides

```ts
type ToolContextOverrides = { [K in keyof ToolContext]?: ToolContext[K] };
```

What [createToolContext](#createtoolcontext) accepts: any field of a [ToolContext](index.md#toolcontext),
and `undefined` for one the caller does not have.

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

***

### ToolRunner

```ts
type ToolRunner = (name: string, argsOrCtx?: 
  | InferSchemaOutput<ToolInputSchema>
| ToolContext, ctx?: ToolContext) => Promise<unknown>;
```

What [toolRunner](#toolrunner-1) hands back: [runTool](#runtool) with the agent already
supplied.

Named so a caller can annotate a helper that takes one, and so the union in
the second position is written down once here rather than at every call site
that binds it.

#### Parameters

##### name

`string`

##### argsOrCtx?

  \| [`InferSchemaOutput`](index.md#inferschemaoutput)\<[`ToolInputSchema`](index.md#toolinputschema)\>
  \| [`ToolContext`](index.md#toolcontext)

##### ctx?

[`ToolContext`](index.md#toolcontext)

#### Returns

`Promise`\<`unknown`\>

***

### WorkflowCtxOptions

```ts
type WorkflowCtxOptions = {
  hooks?: Record<string, unknown>;
  now?: number | (() => number);
  random?: number | (() => number);
  results?: Record<string, unknown>;
  runId?: string;
  runSteps?: boolean;
  uuid?: string | (() => string);
  workflow?: string;
};
```

What [createWorkflowCtx](#createworkflowctx) takes.

#### Properties

##### hooks?

```ts
optional hooks?: Record<string, unknown>;
```

Payloads for `ctx.waitFor`, by token.

A token that is absent THROWS rather than hanging, because a spec that hangs
reports a timeout naming the runner instead of the missing payload.

##### now?

```ts
optional now?: number | (() => number);
```

What `ctx.now()` answers — a fixed number, or a function called per reach.

Defaults to [WORKFLOW\_CTX\_NOW](#workflow_ctx_now), a FIXED instant, so a body's derived
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

### WorkflowCtxRecorder

```ts
type WorkflowCtxRecorder = WorkflowCtx & {
  slept: RecordedSleep[];
  steps: RecordedStep[];
  waited: string[];
};
```

What [createWorkflowCtx](#createworkflowctx) answers: a real `WorkflowCtx` plus its log.

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

## Variables

### STUB\_SPEECH\_PCM\_BYTES

```ts
const STUB_SPEECH_PCM_BYTES: 12000 = 12000;
```

PCM bytes [stubSpeech](#stubspeech-1) answers with when no size is named — ~0.25s at 24 kHz.

***

### WORKFLOW\_CTX\_NOW

```ts
const WORKFLOW_CTX_NOW: 1767225600000 = 1767225600000;
```

The instant [createWorkflowCtx](#createworkflowctx) freezes `ctx.now()` at.

`2026-01-01T00:00:00.000Z`. Exported so a spec computes an expected duration
from it rather than copying the number.
