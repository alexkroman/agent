# eval/vitest

`@alexkroman1/aai-runtime/eval/vitest` — the eval harness's vitest door.

An agent project reaches every name here through
`@alexkroman1/aai-runtime/testing/vitest`, which re-exports them all beside
the SDK's installers, so a test file imports from the two testing doors
(`/testing`, `/testing/vitest`) whether it is a unit spec or an eval. This
subpath keeps working, and it is where a stub an eval needs is added first.

One `*.eval.test.ts` used to reach four subpaths of two packages: the suite
from here, the readers and the session from `/eval`, the simulated caller from
`/eval/simulate`, and the stubs a case composes with from
`@alexkroman1/aai/testing` and `/testing/vitest`. Every one of those names is
re-exported here — the SAME declarations, so a type from one door is the type
from another — and an eval needs no other import from either package for its
harness:

```ts
import type { AgentDef } from "@alexkroman1/aai";
import { describeEval, expectCalled } from "@alexkroman1/aai-runtime/testing/vitest";

declare const agentDef: AgentDef;

describeEval(agentDef, (test) => {
  test(
    "looks the order up before answering",
    async ({ session }) => {
      expectCalled(await session.say("where is order W1234?"), "look_up");
    },
    { stubReply: "Order W1234 shipped yesterday." },
  );
});
```

Why HERE rather than on `/eval`, and why not in the SDK:

- **`/eval` must stay importable without vitest.** `vitest` is an OPTIONAL
  peer dependency and this module imports it (`describeEval` registers a
  suite, opens a session per case and closes it afterwards — everything
  defined here either INSTALLS something or OWNS a lifetime, the repo's rule
  for a runner-flavoured subpath). A harness that is not vitest — a load-test
  stub, a recording runner — imports `/eval`, the runner-free half this is
  built on. An eval FILE is always vitest (`*.eval.test.ts` is a vitest tier),
  so the one author-facing door is the vitest one.
- **The SDK cannot host it.** `@alexkroman1/aai` never imports this package
  (the dependency runs one way), and the harness is host runtime. So the
  re-export runs the other way: this subpath re-exports the SDK's unit-level
  stubs, which stay DECLARED on `@alexkroman1/aai/testing` for a tool's or a
  step's own spec.
- **Capabilities are unchanged.** A re-export does not move ownership: the
  readers stay `eval`'s, `evalNetwork` `eval-network`'s, the claims
  `eval-assert`'s, the simulation `eval-simulate`'s, and the SDK stubs
  `aai:testing`'s, each on its own epoch.

`/eval/simulate` was removed for this reason (its names are here and on
`/eval`); `/eval` stays — it is the runner-free door, not a second
author-facing one.

## Functions

### createRecordingWorkflows()

```ts
function createRecordingWorkflows(options?: RecordingWorkflowsOptions): RecordingWorkflows;
```

Build a [RecordingWorkflows](#recordingworkflows).

#### Parameters

##### options?

[`RecordingWorkflowsOptions`](#recordingworkflowsoptions)

#### Returns

[`RecordingWorkflows`](#recordingworkflows)

#### Example

```ts
import { createRecordingWorkflows, createRunSnapshot } from "@alexkroman1/aai/testing";

const workflows = createRecordingWorkflows({
  runs: [createRunSnapshot({ workflow: "remind", key: "kitchen", runId: "wrun_pending" })],
});
await workflows.start("remind", { text: "flip the laundry" }, { key: "kitchen" });
console.log(workflows.started("remind").length); // 1
console.log((await workflows.find("remind", "kitchen")).length); // 2
```

***

### describeEval()

```ts
function describeEval<Network extends EvalNetwork = never, Client extends WorkflowClient = never>(
   agent: AgentDef, 
   define: (test: EvalTest<Network, Client>) => void, 
   options?: Omit<DescribeEvalOptions, "workflows" | "network"> & {
  network?: Network | (() => Network);
  workflows?: Client | (() => Client);
}
): void;
```

Declare an eval suite for `agent`.

Generic over the suite's `network` and `workflows` only so a case's
`ctx.network` and `ctx.workflowClient` are typed by them (see
[EvalTestContext.network](#network-2)); nobody writes the type arguments, they
are read off `options`.

```ts no-check
describeEval(agentDef, (test) => {
  test(
    "offers to take an order",
    async ({ session }) => {
      const turn = await session.say("hi, what can you do?");
      expect(turn.text).toMatch(/order/i);
    },
    { stubReply: "I can take an order for you." },
  );
});
```

#### Type Parameters

##### Network

`Network` *extends* [`EvalNetwork`](../eval.md#evalnetwork) = `never`

##### Client

`Client` *extends* [`WorkflowClient`](../../aai/index.md#workflowclient) = `never`

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalTest`](#evaltest)\<`Network`, `Client`\>) => `void`

##### options?

`Omit`\<[`DescribeEvalOptions`](#describeevaloptions), `"workflows"` \| `"network"`\> & \{
  `network?`: `Network` \| (() => `Network`);
  `workflows?`: `Client` \| (() => `Client`);
\}

#### Returns

`void`

***

### describeTextEval()

```ts
function describeTextEval(
   agent: AgentDef, 
   define: (test: EvalTextTest) => void, 
   options?: DescribeTextEvalOptions
): void;
```

Declare an eval suite for a TEXT agent.

```ts
import { agent } from "@alexkroman1/aai";
import { toolNames } from "@alexkroman1/aai-runtime/eval";
import { describeTextEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

const agentDef = agent({ name: "Coder", mode: "text" });

describeTextEval(agentDef, (test) => {
  test(
    "reads a file before it edits one",
    async ({ agent: coder }) => {
      const turn = await coder.send("rename `total` to `sum` in cart.ts");
      expect(toolNames(turn.toolCalls)).toContain("read_file");
    },
    { stubReply: [{ tool: "read_file", args: { path: "cart.ts" } }, "Renamed it."] },
  );
});
```

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalTextTest`](#evaltexttest)) => `void`

##### options?

[`DescribeTextEvalOptions`](#describetextevaloptions)

#### Returns

`void`

***

### describeWorkflowEval()

```ts
function describeWorkflowEval(
   agent: AgentDef, 
   define: (test: EvalWorkflowTest) => void, 
   options?: Omit<EvalWorkflowsOptions, "agent">
): void;
```

Declare an eval suite for a workflow app.

The signature mirrors `describeEval` down to the two things a LINTER decides —
the callback parameter is named `test` (`noMisplacedAssertion` matches the
callee identifier) and a case body takes a DESTRUCTURED context
(`noDoneCallback` reads the first positional parameter of an async test
callback as jest's `done`). Do not tidy either.

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### define

(`test`: [`EvalWorkflowTest`](#evalworkflowtest)) => `void`

##### options?

`Omit`\<[`EvalWorkflowsOptions`](../eval.md#evalworkflowsoptions), `"agent"`\>

#### Returns

`void`

***

### dialogRefusalPattern()

```ts
function dialogRefusalPattern(state?: string): RegExp;
```

A pattern matching the sentence a `dialog()` gate refuses with — optionally
pinned to the state it names.

For a SPEC. A gated tool called out of state answers a `ToolFailure` whose
`error` is this sentence, and every template spec that asserts a gate held
used to spell a regex for it by hand. Two kinds of spec read it, and the
pattern serves both: a unit test holds the `ToolFailure` itself (prefer
`expectDialogRefused` there, which also throws on a success), while an eval
reads a tool result off the event stream as a SERIALIZED string, where the
state's quotes arrive escaped (`\"identifying\"`). The pattern admits the
escaping, so one matcher reads both.

With no `state`, it matches any refusal — for a spec that pins the state a
line later, or whose subject is that the body did not run rather than where
the conversation was.

#### Parameters

##### state?

`string`

The state the refusal must name, as `DialogPosition.state`
  spells it (`"identifying"`, `"onCall.inbox"`). Matched literally.

#### Returns

`RegExp`

#### Example

```ts
import { dialogRefusalPattern } from "@alexkroman1/aai/testing";

const refused = 'Not available yet: this conversation is at "identifying". Verify the caller first.';
dialogRefusalPattern("identifying").test(refused); // true
dialogRefusalPattern("transferred").test(refused); // false
dialogRefusalPattern().test(refused); // true
```

***

### dialogResultSchema()

```ts
function dialogResultSchema<T extends ZodType<unknown, unknown, $ZodTypeInternals<unknown, unknown>>>(result: T): ZodObject<{
  done: ZodBoolean;
  instruction: ZodOptional<ZodString>;
  result: T;
  state: ZodString;
}, $strip>;
```

The envelope a gated tool answers with, as a schema around the tool's own.

[expectDialogOk](../testing.md#expectdialogok) unwraps a value a spec HOLDS. An eval holds the
serialized copy the model was handed and reads it back through a schema —
`toolResultIn(turn.toolCalls, "set_stay", schema)` — so it needs the same
envelope as a schema rather than as a function, and three shipped evals had
each written it out: `z.object({ result, state: z.string(), done:
z.boolean() })`, under a comment saying the shape was the SDK's. It is, and
this is where it lives: `result` is whatever the author's `execute` returned,
`state` is where the call landed, `done` whether that state is final, and
`instruction` is the state's own brief when it declares one — the fields of
[DialogToolResult](../../aai/index.md#dialogtoolresult), which a `dialog.tool` writes and no tool file does.

Parsing rather than casting is what makes a template that stopped carrying its
position fail naming the field, instead of a later `expect` reading
`undefined.state`.

#### Type Parameters

##### T

`T` *extends* `ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>

The schema of the tool's OWN result, under `result`.

#### Parameters

##### result

`T`

What the tool's `execute` answers with.

#### Returns

`ZodObject`\<\{
  `done`: `ZodBoolean`;
  `instruction`: `ZodOptional`\<`ZodString`\>;
  `result`: `T`;
  `state`: `ZodString`;
\}, `$strip`\>

#### Example

```ts
import { dialogResultSchema } from "@alexkroman1/aai/testing";
import { z } from "zod";

// In an eval: `toolResultIn(turn.toolCalls, "set_stay", Stay)`. Holding the
// serialized result yourself, it is the same parse:
const Stay = dialogResultSchema(z.object({ options: z.string() }));
const stay = Stay.parse(
  JSON.parse('{"result":{"options":"garden view"},"state":"booking.room","done":false}'),
);
stay.state; // "booking.room"
stay.result.options; // "garden view"
```

***

### eventsOf()

```ts
function eventsOf<E extends {
  type: string;
}, K extends string>(events: Iterable<E>, type: K): Extract<E, {
  type: K;
}>[];
```

Every event in `events` named `type`, in order, typed as that member.

```ts
import type { SessionEvent } from "@alexkroman1/aai";
import { eventsOf } from "@alexkroman1/aai/testing";

declare const recorded: SessionEvent[];
const calls = eventsOf(recorded, "tool.called");
console.log(calls.map((e) => e.toolName));
```

#### Type Parameters

##### E

`E` *extends* \{
  `type`: `string`;
\}

##### K

`K` *extends* `string`

#### Parameters

##### events

`Iterable`\<`E`\>

##### type

`K`

#### Returns

`Extract`\<`E`, \{
  `type`: `K`;
\}\>[]

***

### installStubSpeech()

```ts
function installStubSpeech(options?: StubSpeechOptions): StubSpeech;
```

Publish a synthesizer that records what it was asked to say, restored when
this test finishes.

`stubSpeech` with the bookkeeping done — see it for the call log's
shape, the silence it answers with, and how to make it fail instead.

#### Parameters

##### options?

[`StubSpeechOptions`](#stubspeechoptions)

#### Returns

[`StubSpeech`](#stubspeech)

***

### installStubStepDelegate()

```ts
function installStubStepDelegate(script: StubDelegateScript): StubStepDelegate;
```

Publish a fake subagent runner for `stepDelegate`, restored when this test
finishes.

`stubStepDelegate` with the bookkeeping done. It is the only way to drive an
exported step that delegates — the real slot THROWS when nothing has published,
deliberately, because there is no degraded version of running a model loop.

#### Parameters

##### script

[`StubDelegateScript`](../testing.md#stubdelegatescript)

#### Returns

[`StubStepDelegate`](#stubstepdelegate)

***

### installStubStepFetch()

```ts
function installStubStepFetch(answer?: (request: StubStepRequest) => 
  | StubStepAnswer
  | Promise<StubStepAnswer>): StubStepFetch;
```

Publish a fake `stepFetch`, restored when this test finishes.

`stubStepFetch` with the bookkeeping done — see it for why a step's HTTP
goes through a published slot rather than the global, and what the recorded
request carries.

#### Parameters

##### answer?

(`request`: [`StubStepRequest`](../testing.md#stubsteprequest)) => 
  \| [`StubStepAnswer`](../testing.md#stubstepanswer)
  \| `Promise`\<[`StubStepAnswer`](../testing.md#stubstepanswer)\>

Called per request. Defaults to an empty `200`.

#### Returns

[`StubStepFetch`](#stubstepfetch)

***

### installStubTranscribe()

```ts
function installStubTranscribe(options?: StubTranscribeOptions): StubTranscribe;
```

Answer AssemblyAI's transcription endpoints in memory, restored when this test
finishes.

`stubTranscribe` with the bookkeeping done — see it for the four legs it
routes, why a refusal is staged as an HTTP status rather than as a
`TranscribeError`, and why it takes an `otherwise` handler.

#### Parameters

##### options?

[`StubTranscribeOptions`](#stubtranscribeoptions)

#### Returns

[`StubTranscribe`](#stubtranscribe)

***

### installStubUploads()

```ts
function installStubUploads(files: Readonly<Record<string, StubUpload>>, options?: StubUploadsOptions): StubUploads;
```

Publish an in-memory upload store, restored when this test finishes.

`stubUploads` with the bookkeeping done — see it for what the store
serves, why writes are opt-in, and why the minted ids count up.

#### Parameters

##### files

`Readonly`\<`Record`\<`string`, [`StubUpload`](../testing.md#stubupload)\>\>

##### options?

[`StubUploadsOptions`](#stubuploadsoptions)

#### Returns

[`StubUploads`](#stubuploads)

#### Example

```ts no-check
import { installStubUploads } from "@alexkroman1/aai/testing/vitest";

test("the step reads the recording it was given", async () => {
  const uploads = installStubUploads({ upl_1: new Uint8Array(5000) }, { writable: true });
  await ingest("upl_1");
  expect(uploads.writes).toHaveLength(1);
});
```

***

### isEvent()

```ts
function isEvent<E extends {
  type: string;
}, K extends string>(event: E, type: K): event is Extract<E, { type: K }>;
```

Whether `event` is the one named `type` — a type guard, so the branch it
guards reads that member's fields without a cast.

```ts
import type { SessionEvent } from "@alexkroman1/aai";
import { isEvent } from "@alexkroman1/aai/testing";

declare const recorded: SessionEvent[];
const last = recorded.at(-1);
if (last && isEvent(last, "tool.called")) console.log(last.toolName);
```

#### Type Parameters

##### E

`E` *extends* \{
  `type`: `string`;
\}

##### K

`K` *extends* `string`

#### Parameters

##### event

`E`

##### type

`K`

#### Returns

`event is Extract<E, { type: K }>`

***

### resolveEvalMode()

```ts
function resolveEvalMode(
   agent: AgentDef, 
   hostEnv?: Record<string, string | undefined>, 
   overrides?: {
  llm?: LlmProvider;
}
): {
  mode: EvalMode;
  reason: string;
};
```

Live if this machine can be, stub if it cannot — unless a caller has said
which it wants.

`AAI_REQUIRE_EVAL` is for a pipeline that means to MEASURE: with it set, a
missing credential is a failure instead of a quiet downgrade to a wiring
check. `AAI_EVAL_STUB` is the opposite instruction, and CI wants it —
a required check must not start spending tokens the day a key reaches its
environment, and must not become a flaky gate on a live model's behaviour.

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### hostEnv?

`Record`\<`string`, `string` \| `undefined`\>

##### overrides?

What the CASE overrides, which decides the credential question with it.

Without this the mode was read off the AGENT alone, so
`describeEval(def, define, { llm: llm({ provider: "assemblyai", model }) })` on an agent declaring
`anthropic()` announced "SCRIPTED — ANTHROPIC_API_KEY is not set" while
holding the key the run would actually have used. Measured on
`custom-pipeline-agent`: the override was honoured by the session and ignored by
the gate, so a case could not be run live at all.

###### llm?

[`LlmProvider`](../../aai/index.md#llmprovider)

#### Returns

```ts
{
  mode: EvalMode;
  reason: string;
}
```

##### mode

```ts
mode: EvalMode;
```

##### reason

```ts
reason: string;
```

***

### resolveWorkflowEvalMode()

```ts
function resolveWorkflowEvalMode(agent: AgentDef, hostEnv?: Record<string, string | undefined>): {
  mode: EvalMode;
  reason: string;
};
```

[resolveEvalMode](#resolveevalmode) for a WORKFLOW app, whose credentials are a different
question.

Split rather than folded in because the two gates read different fields and the
wrong one is silent: a `mode: "workflow-app"` agent needs no provider credential, so
`evalCredentials` reports every workflow app ready and a keyless run goes LIVE
— then every case fails on a 401 three layers down. `evalWorkflowCredentials`
reads `requiredEnv`, which is the only thing a workflow app declares its
credentials in.

#### Parameters

##### agent

[`AgentDef`](../../aai/index.md#agentdef)

##### hostEnv?

`Record`\<`string`, `string` \| `undefined`\>

#### Returns

```ts
{
  mode: EvalMode;
  reason: string;
}
```

##### mode

```ts
mode: EvalMode;
```

##### reason

```ts
reason: string;
```

***

### stubGatewayRoute()

```ts
function stubGatewayRoute(replies: string | readonly string[], options?: StubGatewayOptions): StubGatewayRoute;
```

A gateway reply for a step that goes through the PUBLISHED `stepFetch` slot
rather than the global `fetch` — a ROUTE to compose, not a fake to install.
[stubGateway](../testing.md#stubgateway-1) says which of the three gateway fakes fits which seam.

[stubGateway](../testing.md#stubgateway-1) answers over `globalThis.fetch`, which is the wrong seam
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
   last reply repeats, which is [stubGateway](../testing.md#stubgateway-1)'s convention and now
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

##### options?

[`StubGatewayOptions`](../testing.md#stubgatewayoptions)

#### Returns

[`StubGatewayRoute`](#stubgatewayroute)

## Interfaces

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
caller composes it: as the first leg of a `stubFetchRoutes` list (where
an unexpected request is a finding by default), `?? { body: html }` for a
flow that also fetches a page, or straight into `stubTranscribe`'s
`otherwise`.

###### Parameters

###### request

[`StubStepRequest`](../testing.md#stubsteprequest)

###### Returns

[`StubStepAnswer`](../testing.md#stubstepanswer) \| `undefined`

***

### StubStepDelegate

A fake `stepDelegate`: the calls it recorded, and the slot to give back.

#### Methods

##### restore()

```ts
restore(): void;
```

Unpublish the runner.

Calling it in an `afterEach` is not optional — a stub left published makes
the next file's steps delegate into this one's log, which is the kind of
cross-file leak that presents as a passing test somewhere else.

###### Returns

`void`

#### Properties

##### calls

```ts
calls: StubDelegateCall[];
```

Every call, in order — the same log [stubDelegate](../testing.md#stubdelegate-1) keeps.

## Type Aliases

### DescribeEvalOptions

```ts
type DescribeEvalOptions = Omit<EvalSessionOptions, "agent"> & {
  network?:   | EvalNetwork
     | (() => EvalNetwork);
  workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
};
```

What [describeEval](#describeeval) takes beyond the agent.

The session options, plus `workflowOptions` for the engine it opens per case
when the agent declares `workflows`. That second one is not symmetry for its
own sake: a workflow-starting tool's STEPS make provider calls, and the only
honest way to evaluate which tool the desk reached for — without paying for
five gateway calls and a real web search per case, and without a 429 failing
the run outright because a step's `maxRetries` is inert here — is to script
the step's HTTP while leaving the SESSION's model live. Both templates that
hand off to a run had to install that inside the case body, which worked only
because the engine publishes nothing when nobody passed one.

#### Type Declaration

##### network?

```ts
readonly optional network?: 
  | EvalNetwork
  | (() => EvalNetwork);
```

A fake network for every case — an `evalNetwork(...)`, or a FACTORY
returning one, called afresh for every case and every `AAI_EVAL_REPEAT`
repeat.

It becomes all three fetches a case's code can reach: the global `fetch`
a custom tool calls, the `fetch` the builtins take, and the step fetch a
workflow step (or `sendToChannel`) reads. A request no route answers is
REFUSED and logged; only the live model's own provider hosts pass through,
worked out from the agent's `llm` (in a scripted run, not even those).
The global is swapped for the whole SUITE rather than per case, so an
`onSessionEnd` still running after a case closed (the session waits 10
seconds for it, then stops waiting) is refused into that case's log
rather than reaching the real network.

Keep a route's STATE (rows a fake database holds) in the network's own
`state` (`evalNetwork({ state, routes })`): an instance's log AND state are
rebuilt per case and per repeat, and the case reads it, typed, as
`ctx.network.state`. State a handler keeps in its closure is not reset —
use a factory for that — and state carried from one repeat into the next
makes the second repeat measure the first. Mutually exclusive with
`fetch`, which it replaces.

##### workflowOptions?

```ts
readonly optional workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
```

***

### DescribeTextEvalOptions

```ts
type DescribeTextEvalOptions = Omit<EvalTextAgentOptions, "agent">;
```

What [describeTextEval](#describetexteval) takes beyond the agent.

***

### EvalCaseOptions

```ts
type EvalCaseOptions = {
  call?: SessionCall | null;
  clientId?: string | null;
  live?: boolean;
  network?:   | EvalNetwork
     | (() => EvalNetwork);
  phone?: string | null;
  scripted?: boolean;
  stubGenerate?: StubScript;
  stubReply?: StubScript;
};
```

What a case gets to say about how it should be run.

#### Properties

##### call?

```ts
readonly optional call?: SessionCall | null;
```

This case's placed phone call, over the suite's — what `sessionContext`
receives as `call`. See `EvalSessionOptions.call`; a call the hook refuses
lands on `session.refused`. `null` is "not a placed call": a calling
agent's refusal of a session no carrier started, inside a suite whose
other cases are all the one call.

##### clientId?

```ts
readonly optional clientId?: string | null;
```

WHO this case's session is, over the suite's own
([DescribeEvalOptions](#describeevaloptions)) — the client id `sessionClientId(ctx)`
answers. See `EvalSessionOptions.clientId`. `null` is "no client id for
this case", whatever the suite set; absent is "the suite's".

Per case because a suite's cases are rarely all the same caller: a
speaker agent's "a device with no client id is refused" case sits beside
twenty that run as the kitchen speaker, and it is written
`{ clientId: null }`.

##### live?

```ts
readonly optional live?: boolean;
```

This case only means something against a live model — it is SKIPPED in stub
mode. Use it for a claim no script can honestly satisfy: a tool the model
has to choose for itself, a refusal, a judgement.

##### network?

```ts
readonly optional network?: 
  | EvalNetwork
  | (() => EvalNetwork);
```

This case's fake network, over the suite's — see
`DescribeEvalOptions.network`. A case needing routes of its own (a
service that answers differently in this one scenario) passes them here.

##### phone?

```ts
readonly optional phone?: string | null;
```

This case's reported phone number, over the suite's. See
`EvalSessionOptions.phone`. `null` is "no number for this case".

##### scripted?

```ts
readonly optional scripted?: boolean;
```

The mirror: this case only means something against a SCRIPT, and is skipped
against a live model.

It is not a symmetry for its own sake — three cases needed it. A gate can
only be observed refusing if something CALLS the gated tool, and a competent
model declines to (measured: `tabletop-rpg-agent`'s game-over route is a tool its own
prompt forbids unprompted; a dispatcher calls `resources_get_available`
first and never trips the busy-unit refusal; a `visit_webpage` at a private
address is the SSRF screen's own case and a live model sensibly refuses to
try). Without this marker each cost a red live run and got weakened.

##### stubGenerate?

```ts
readonly optional stubGenerate?: StubScript;
```

What a SCRIPTED `ctx.generate` answers with — its OWN script, walked by its
own cursor.

Separate from [EvalCaseOptions.stubReply](#stubreply) because `ctx.generate`
resolves a model INSTANCE of its own, in parallel with the turn's: one
script would need element 0 to be the turn's first move and the first
`generate` answer simultaneously. A tool that reasons with a model — a
grader, a planner, a rewriter — is the shape this exists for, and two
shipped templates' central tools are exactly that. For the schema overload,
write the object as the JSON string the model would have returned.

##### stubReply?

```ts
readonly optional stubReply?: StubScript;
```

What a SCRIPTED model does when this suite runs without a key — one entry
per model call, the last line repeating. A string is a line the agent says;
`{ tool, args }` is a tool call, which is what makes a stub run worth having
for an agent that HAS tools:

`no-check`: the fence is one FIELD of this type, and its only compilable
reading is a labelled statement inside a block — it would type-check
whatever the field were called, so checking it asserts nothing about
[EvalCaseOptions.stubReply](#stubreply). Kept as a fragment deliberately, not
because it cannot compile: a `no-check` that would pass is unclaimed
headroom, and this one would pass for the wrong reason.

```ts no-check
{ stubReply: [{ tool: "look_up", args: { orderId: "W1234" } }, "It shipped."] }
```

Choose it so the case's own assertions still hold: the point of a stub run
is that the case really executes, and a stub the case then fails against
measures nothing.

***

### EvalMode

```ts
type EvalMode = "live" | "stub";
```

How the suite is running, and why.

***

### EvalTest

```ts
type EvalTest<Network extends EvalNetwork = never, Client extends WorkflowClient = never> = (name: string, body: (ctx: EvalTestContext & [Network] extends [never] ? unknown : {
  network: Network;
} & [Client] extends [never] ? unknown : {
  workflowClient: Client;
}) => Promise<void>, options?: [Network] extends [never] ? EvalCaseOptions : Omit<EvalCaseOptions, "network"> & {
  network?: Network | (() => Network);
}) => void;
```

Declare one eval case. The session is opened for it and closed after it.

Two things about this signature are decided by a LINTER rather than by
taste, both A/B'd against Biome 2.5 and both invisible until a user's own
project lights up red on a file the SDK told them to write:

- **The parameter is named `test`.** `noMisplacedAssertion` matches on the
  CALLEE IDENTIFIER and nothing else, so an `expect` inside `evalTest(…)` is
  an error while the identical body inside `test(…)` is fine.
- **The body takes a DESTRUCTURED context, not the session positionally.**
  `noDoneCallback` reads the first parameter of an async test callback as
  jest's `done`, so `async (session) => …` is an error; `async ({ session })
  => …` is not — and it is vitest's own fixture shape, which is what a reader
  already expects.

#### Type Parameters

##### Network

`Network` *extends* [`EvalNetwork`](../eval.md#evalnetwork) = `never`

##### Client

`Client` *extends* [`WorkflowClient`](../../aai/index.md#workflowclient) = `never`

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalTestContext`](#evaltestcontext) & \[`Network`\] *extends* \[`never`\] ? `unknown` : \{
  `network`: `Network`;
\} & \[`Client`\] *extends* \[`never`\] ? `unknown` : \{
  `workflowClient`: `Client`;
\}) => `Promise`\<`void`\>

##### options?

\[`Network`\] *extends* \[`never`\] ? [`EvalCaseOptions`](#evalcaseoptions) : `Omit`\<[`EvalCaseOptions`](#evalcaseoptions), `"network"`\> & \{
  `network?`: `Network` \| (() => `Network`);
\}

#### Returns

`void`

***

### EvalTestContext

```ts
type EvalTestContext = {
  mode: EvalMode;
  network: EvalNetwork | undefined;
  session: EvalSession;
  workflowClient: WorkflowClient | undefined;
  workflows: EvalWorkflows | undefined;
};
```

**`Sealed`**

What a case body is handed: its own session, which model it is on, and the
workflow app behind it.

A simulated caller and a model-graded judge are NOT on it: a case that wants
them builds the pair from `session` and `mode` with `evalSimulation` (on this
same `@alexkroman1/aai-runtime/eval/vitest`), a surface versioned on its own.

#### Properties

##### mode

```ts
readonly mode: EvalMode;
```

Which model this run got. A case may branch on it, and most should not.

## The one branch that is always right

**A value a SCRIPT determined may only be asserted under
`mode === "stub"`.** `stubReply` and `stubGenerate` are what make a value
predictable, so pinning one against a live model is pinning the script — and
it presents as the agent misbehaving, which is the expensive part. Three
shipped template evals had it, and each read as a defect in the template
until the script was checked:

- `word-game-agent` asserted `playerSaid: "Is it a zebra crossing?"`, the
  exact remark of a scripted player, in a game whose word is drawn at
  random. Live, "Is it a zebra?" is a perfectly good wrong guess.
- `executive-inbox-agent` pinned `2 closed / 6 queued`, a split decided by
  eight live triage verdicts. A run that found every email worth answering
  failed on "expected [] to have a length of 2".
- `topic-briefing-agent` required a verdict word from a subagent its own
  tool documents as allowed to come back unusable.

So: assert the INVARIANT in both modes — the tool was called, the verdict
and the score agree, nothing was sent before a yes — and put the exact
strings behind the branch.

```ts no-check
test("a wrong guess is relayed without a point", async ({ session, mode }) => {
  const relayed = await play(session);
  // True either way: the player answered and the round stands.
  expect(relayed.playerSaid.length).toBeGreaterThan(0);
  if (relayed.verdict === "wrong") expect(relayed.score).toBe(0);
  // Only a script can pin the words.
  if (mode === "stub") expect(relayed.playerSaid).toBe("Is it a zebra crossing?");
});
```

A case that cannot be written that way wants `{ scripted: true }` instead,
which skips it live rather than weakening it — see
[EvalCaseOptions.scripted](#scripted).

##### network

```ts
readonly network: EvalNetwork | undefined;
```

The fake network every `fetch` of this case went through. Its log holds
THIS case's requests (THIS repeat's, under `AAI_EVAL_REPEAT`), so a case
asserts on `network.calls("textbelt.com")` or
`network.expectNoOutbound(/twilio/)` without filtering out another run's
traffic, and reads its routes' `network.state`.

TYPED BY WHAT WAS PASSED, in the body a case hands [EvalTest](#evaltest): in
a suite given `network` it is exactly that network's type —
`EvalNetwork<{ calls: Map<…> }>` for one built with `state` — so there is
no `undefined` to guard and no cast to reach the state. A case's own
`network` must be of the suite's type, so the type holds for it too. In a
suite given none it is `EvalNetwork | undefined` (this declaration) —
`undefined` at runtime unless the case passed one.

##### session

```ts
readonly session: EvalSession;
```

Open for this case, closed after it.

##### workflowClient

```ts
readonly workflowClient: WorkflowClient | undefined;
```

The client this session's `ctx.workflows` IS: the suite's own
(`describeEval`'s `workflows` — the one its factory built for THIS case
and repeat), else the engine's `workflows.client`, else
`undefined` for an agent that declares no workflows and was given none.

Typed by what the suite passed, in the body a case hands
[EvalTest](#evaltest): a suite whose factory returns a recording client —
`() => createRecordingWorkflows({ workflows: agentDef.workflows })` from
`@alexkroman1/aai/testing`, which records every start and runs nothing —
reads `workflowClient.started("remind")` and seeds the runs `find`
answers with `workflowClient.seed(...)`, typed, with no module-level log
to reset.

##### workflows

```ts
readonly workflows: EvalWorkflows | undefined;
```

The workflow app behind this session's `ctx.workflows`, for an agent that
declares workflows — `undefined` for one that does not.

Opened per case and closed after it, and it is what makes a tool calling
`ctx.workflows.start` runnable at all: the real client the runtime would
build cannot start an untransformed body. A case reads the run its tool
started with `workflows.settle(runId)`.

The engine under it is NOT durable — see `eval/workflow-engine.ts` before
writing a claim about a run.

***

### EvalTextTest

```ts
type EvalTextTest = (name: string, body: (ctx: EvalTextTestContext) => Promise<void>, options?: EvalCaseOptions) => void;
```

Declare one text eval case. The conversation is opened and closed for it.

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalTextTestContext`](#evaltexttestcontext)) => `Promise`\<`void`\>

##### options?

[`EvalCaseOptions`](#evalcaseoptions)

#### Returns

`void`

***

### EvalTextTestContext

```ts
type EvalTextTestContext = {
  agent: EvalTextAgent;
  mode: EvalMode;
};
```

**`Sealed`**

What a text case body is handed: its own conversation and the mode. A
simulated caller is `evalSimulation({ target: agent, … })` (on this same
`@alexkroman1/aai-runtime/eval/vitest`), as for a voice case.

#### Properties

##### agent

```ts
readonly agent: EvalTextAgent;
```

Opened for this case, released after it.

##### mode

```ts
readonly mode: EvalMode;
```

Which model this run got. A case may branch on it, and most should not.

***

### EvalWorkflowCaseOptions

```ts
type EvalWorkflowCaseOptions = {
  live?: boolean;
};
```

What a workflow case gets to say about how it should be run.

#### Properties

##### live?

```ts
readonly optional live?: boolean;
```

This case only means something against real providers — it is SKIPPED in
stub mode.

Reach for it when a step MUST reach the far side for the claim to mean
anything: a transcript that has to be of the audio, a summary that has to
be of the page. A case that can be scripted should be, because a scripted
run is what a pipeline with no key can still gate on.

***

### EvalWorkflowTest

```ts
type EvalWorkflowTest = (name: string, body: (ctx: EvalWorkflowTestContext) => Promise<void>, options?: EvalWorkflowCaseOptions) => void;
```

Declare one workflow eval case. The app is opened for it and closed after it.

#### Parameters

##### name

`string`

##### body

(`ctx`: [`EvalWorkflowTestContext`](#evalworkflowtestcontext)) => `Promise`\<`void`\>

##### options?

[`EvalWorkflowCaseOptions`](#evalworkflowcaseoptions)

#### Returns

`void`

***

### EvalWorkflowTestContext

```ts
type EvalWorkflowTestContext = {
  app: EvalWorkflows;
  mode: EvalMode;
};
```

**`Sealed`**

What a workflow case body is handed.

#### Properties

##### app

```ts
readonly app: EvalWorkflows;
```

Opened for this case, closed after it.

##### mode

```ts
readonly mode: EvalMode;
```

Which mode this run got.

Unlike a voice case, a workflow case is EXPECTED to branch on it: it is what
decides whether to install a fake for a provider a step would otherwise
really dial.

***

### RecordingWorkflows

```ts
type RecordingWorkflows = WorkflowClient & {
  cancelled: string[];
  starts: RecordedStart[];
  seed: void;
  started: RecordedStart[];
};
```

A `WorkflowClient` that records, plus its log.

`start` records and resolves a fresh run id, and the run it "started" is
visible to `get`/`find`/`recent` as `running` — so a tool that checks for a
pending run before starting a second one sees its own first start. `cancel`
marks a known, unfinished run `cancelled` and resolves `true` (else
`false`); `wakeUp` resolves `0`; `lastLine` resolves `undefined`. The
progress-channel reads (`stream`, `streamTail`, `signal`,
`publicWebhookUrl`) REJECT, as `createStubWorkflows`' do — spread over it to
answer one.

#### Type Declaration

##### cancelled

```ts
readonly cancelled: string[];
```

Every run id `cancel` was called with, in order, whatever it resolved.

##### starts

```ts
readonly starts: RecordedStart[];
```

Every start, in order.

##### seed()

```ts
seed(...runs: WorkflowRunSnapshot[]): void;
```

Add runs for the reads to answer from, e.g. inside a case before `say()`.

###### Parameters

###### runs

...[`WorkflowRunSnapshot`](../../aai/workflow-api.md#workflowrunsnapshot)[]

###### Returns

`void`

##### started()

```ts
started(workflow?: string | AnyWorkflowDef): RecordedStart[];
```

The starts of one workflow — by declared name or by def — or all of them.

###### Parameters

###### workflow?

`string` \| [`AnyWorkflowDef`](../../aai/workflow-api.md#anyworkflowdef)

###### Returns

[`RecordedStart`](../testing.md#recordedstart)[]

***

### RecordingWorkflowsOptions

```ts
type RecordingWorkflowsOptions = {
  runIdPrefix?: string;
  runs?: readonly WorkflowRunSnapshot[];
  workflows?: Readonly<Record<string, AnyWorkflowDef>>;
};
```

What [createRecordingWorkflows](#createrecordingworkflows) takes.

#### Properties

##### runIdPrefix?

```ts
optional runIdPrefix?: string;
```

Prefix of the minted run ids, numbered from 1. Defaults to `"wrun_rec_"`.

##### runs?

```ts
optional runs?: readonly WorkflowRunSnapshot[];
```

Runs the reads answer from before anything starts — a reminder already
pending, a job that failed. Build them with `createRunSnapshot`; more can
be added later with `seed`.

##### workflows?

```ts
optional workflows?: Readonly<Record<string, AnyWorkflowDef>>;
```

The agent's declared workflows — pass `agentDef.workflows` — so a start
by DEF is recorded under its declared name, and `listing()` reports them.
A def not in it is refused, as the real client refuses it. Without it, a
def is recorded under its `description` and matched by identity.

***

### StubSpeech

```ts
type StubSpeech = {
  calls: StubSpeechCall[];
  restore: void;
};
```

What [stubSpeech](../testing.md#stubspeech) returns: the call log, and how to put the slot back.

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

### StubSpeechOptions

```ts
type StubSpeechOptions = {
  error?: Error;
  pcmBytes?: number;
  requireApiKey?: boolean;
};
```

What [stubSpeech](../testing.md#stubspeech) may be told.

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

Defaults to [STUB\_SPEECH\_PCM\_BYTES](../testing.md#stub_speech_pcm_bytes), which is enough that the WAV
`stepSpeak` frames has a plausible duration and a spec asserting on one
gets a number rather than zero. A caller that cares about the exact
duration sets this: at the default 24 kHz mono 16-bit, one second is
48,000 bytes.

##### requireApiKey?

```ts
optional requireApiKey?: boolean;
```

Refuse, as the real synthesizer does, when the step env holds no
credential. Defaults to `false`: the stub presents the key to nobody, so a
spec should not have to `vi.stubEnv("ASSEMBLYAI_API_KEY", …)` just to get
past a check that guards a socket it never opens. Set it for the one spec
whose subject IS the missing-key sentence.

***

### StubStepFetch

```ts
type StubStepFetch = {
  calls: StubStepRequest[];
  restore: () => void;
};
```

What [stubStepFetch](../testing.md#stubstepfetch) returns.

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

Unpublish. Call it in an `afterEach` — see [stubStepFetch](../testing.md#stubstepfetch).

###### Returns

`void`

***

### StubTranscribe

```ts
type StubTranscribe = {
  calls: StubTranscribeCall[];
  restore: void;
};
```

What [stubTranscribe](../testing.md#stubtranscribe) returns.

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

What [stubTranscribe](../testing.md#stubtranscribe) may be told.

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

Refuse at the HTTP level. See [StubTranscribeFailure](../testing.md#stubtranscribefailure).

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

[`StubStepRequest`](../testing.md#stubsteprequest)

###### Returns

  \| [`StubStepAnswer`](../testing.md#stubstepanswer)
  \| `undefined`
  \| `Promise`\<[`StubStepAnswer`](../testing.md#stubstepanswer) \| `undefined`\>

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

### StubUploads

```ts
type StubUploads = {
  writes: StubUploadWrite[];
  read: StubUploadWrite | undefined;
  restore: void;
};
```

What [stubUploads](../testing.md#stubuploads) returns.

An OBJECT, like every other fake here (`stubSpeech`, `stubReporter`,
`stubStepFetch`) — this one used to be the bare `restore` function, which made
it the only stub in the family a spec had to remember was different, and left
a spec asserting on a WRITE to round-trip through `stepUploadInfo`/`stepReadUpload`:
the published slot, read back through the same seam the step wrote it through,
to answer "did it write anything at all".

#### Methods

##### read()

```ts
read(id: string): StubUploadWrite | undefined;
```

What is stored under `id` right now — a seeded file or one a step wrote.

Synchronous and outside the published slot, so a spec asserting on bytes
does not have to `await stepReadUpload` through the very seam it is testing.

###### Parameters

###### id

`string`

###### Returns

[`StubUploadWrite`](../testing.md#stubuploadwrite) \| `undefined`

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

What [stubUploads](../testing.md#stubuploads) may be told beyond the files themselves.

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

Accept WRITES, so a step calling `stepWriteUpload` can be tested.

Off by default, and deliberately: a store that silently accepts writes it
was not asked for cannot fail a spec whose step wrote a file nobody meant
it to, and `stepWriteUpload` naming a read-only store is a better failure than
an upload appearing from nowhere. What a step writes is readable through
`stepReadUpload`/`stepUploadInfo` on the id it was given, like any other upload.

## References

### CallVerdict

Re-exports [CallVerdict](../eval.md#callverdict)

***

### completedOutput

Re-exports [completedOutput](../eval.md#completedoutput)

***

### createStubSttOpener

Re-exports [createStubSttOpener](../eval.md#createstubsttopener)

***

### createStubTtsOpener

Re-exports [createStubTtsOpener](../eval.md#createstubttsopener)

***

### createVmRunCode

Re-exports [createVmRunCode](../eval.md#createvmruncode)

***

### CriterionVerdict

Re-exports [CriterionVerdict](../eval.md#criterionverdict)

***

### customEventsIn

Re-exports [customEventsIn](../eval.md#customeventsin)

***

### DEFAULT\_MAX\_TURNS

Re-exports [DEFAULT_MAX_TURNS](../eval.md#default_max_turns)

***

### DEFAULT\_RUN\_TIMEOUT\_MS

Re-exports [DEFAULT_RUN_TIMEOUT_MS](../eval.md#default_run_timeout_ms)

***

### describeToolCalls

Re-exports [describeToolCalls](../eval.md#describetoolcalls)

***

### describeTurn

Re-exports [describeTurn](../eval.md#describeturn)

***

### END\_CALL\_TOOL

Re-exports [END_CALL_TOOL](../eval.md#end_call_tool)

***

### errorsIn

Re-exports [errorsIn](../eval.md#errorsin)

***

### evalCredentials

Re-exports [evalCredentials](../eval.md#evalcredentials-1)

***

### EvalCredentials

Re-exports [EvalCredentials](../eval.md#evalcredentials)

***

### EvalEmitted

Re-exports [EvalEmitted](../eval.md#evalemitted)

***

### evalNetwork

Re-exports [evalNetwork](../eval.md#evalnetwork-1)

***

### EvalNetwork

Re-exports [EvalNetwork](../eval.md#evalnetwork)

***

### EvalNetworkOptions

Re-exports [EvalNetworkOptions](../eval.md#evalnetworkoptions)

***

### EvalRequest

Re-exports [EvalRequest](../eval.md#evalrequest)

***

### EvalRequestFilter

Re-exports [EvalRequestFilter](../eval.md#evalrequestfilter)

***

### EvalRoute

Re-exports [EvalRoute](../eval.md#evalroute)

***

### EvalRunOptions

Re-exports [EvalRunOptions](../eval.md#evalrunoptions)

***

### EvalSession

Re-exports [EvalSession](../eval.md#evalsession)

***

### EvalSessionOptions

Re-exports [EvalSessionOptions](../eval.md#evalsessionoptions)

***

### evalSimulation

Re-exports [evalSimulation](../eval.md#evalsimulation)

***

### EvalSimulationContext

Re-exports [EvalSimulationContext](../eval.md#evalsimulationcontext)

***

### EvalSimulationOptions

Re-exports [EvalSimulationOptions](../eval.md#evalsimulationoptions)

***

### EvalSleep

Re-exports [EvalSleep](../eval.md#evalsleep)

***

### EvalTextAgent

Re-exports [EvalTextAgent](../eval.md#evaltextagent)

***

### EvalTextAgentOptions

Re-exports [EvalTextAgentOptions](../eval.md#evaltextagentoptions)

***

### evalTextCredentials

Re-exports [evalTextCredentials](../eval.md#evaltextcredentials)

***

### EvalToolCall

Re-exports [EvalToolCall](../eval.md#evaltoolcall)

***

### EvalTurn

Re-exports [EvalTurn](../eval.md#evalturn)

***

### evalWorkflowCredentials

Re-exports [evalWorkflowCredentials](../eval.md#evalworkflowcredentials)

***

### EvalWorkflowEngineOptions

Re-exports [EvalWorkflowEngineOptions](../eval.md#evalworkflowengineoptions)

***

### EvalWorkflowRun

Re-exports [EvalWorkflowRun](../eval.md#evalworkflowrun)

***

### EvalWorkflows

Re-exports [EvalWorkflows](../eval.md#evalworkflows)

***

### EvalWorkflowsOptions

Re-exports [EvalWorkflowsOptions](../eval.md#evalworkflowsoptions)

***

### expectCalled

Re-exports [expectCalled](../eval.md#expectcalled)

***

### expectToolBeforeSpeech

Re-exports [expectToolBeforeSpeech](../eval.md#expecttoolbeforespeech)

***

### HostAgentOptions

Re-exports [HostAgentOptions](../eval.md#hostagentoptions)

***

### HostGenerateFn

Re-exports [HostGenerateFn](../eval.md#hostgeneratefn)

***

### installStubLlm

Re-exports [installStubLlm](../eval.md#installstubllm)

***

### installStubSpeechProviders

Re-exports [installStubSpeechProviders](../eval.md#installstubspeechproviders)

***

### judgeCall

Re-exports [judgeCall](../eval.md#judgecall)

***

### JudgeCallOptions

Re-exports [JudgeCallOptions](../eval.md#judgecalloptions)

***

### JudgeInput

Re-exports [JudgeInput](../eval.md#judgeinput)

***

### lastStateIn

Re-exports [lastStateIn](../eval.md#laststatein)

***

### lastToolResultIn

Re-exports [lastToolResultIn](../eval.md#lasttoolresultin)

***

### LogContext

Re-exports [LogContext](../eval.md#logcontext)

***

### LogFn

Re-exports [LogFn](../eval.md#logfn)

***

### Logger

Re-exports [Logger](../eval.md#logger-3)

***

### LogLevel

Re-exports [LogLevel](../eval.md#loglevel)

***

### openEvalSession

Re-exports [openEvalSession](../eval.md#openevalsession)

***

### openEvalTextAgent

Re-exports [openEvalTextAgent](../eval.md#openevaltextagent)

***

### openEvalWorkflows

Re-exports [openEvalWorkflows](../eval.md#openevalworkflows)

***

### RunCodeExecutor

Re-exports [RunCodeExecutor](../eval.md#runcodeexecutor)

***

### runCodeIn

Re-exports [runCodeIn](../eval.md#runcodein)

***

### runCodeOutput

Re-exports [runCodeOutput](../eval.md#runcodeoutput)

***

### saidIn

Re-exports [saidIn](../eval.md#saidin)

***

### simulateCall

Re-exports [simulateCall](../eval.md#simulatecall)

***

### SimulateCallOptions

Re-exports [SimulateCallOptions](../eval.md#simulatecalloptions)

***

### SimulatedCall

Re-exports [SimulatedCall](../eval.md#simulatedcall)

***

### SimulatedCaller

Re-exports [SimulatedCaller](../eval.md#simulatedcaller)

***

### SimulatedTurn

Re-exports [SimulatedTurn](../eval.md#simulatedturn)

***

### SimulationMetrics

Re-exports [SimulationMetrics](../eval.md#simulationmetrics)

***

### SimulationTarget

Re-exports [SimulationTarget](../eval.md#simulationtarget)

***

### statesIn

Re-exports [statesIn](../eval.md#statesin)

***

### StepUsage

Re-exports [StepUsage](../eval.md#stepusage)

***

### SttError

Re-exports [SttError](../eval.md#stterror)

***

### SttEvents

Re-exports [SttEvents](../eval.md#sttevents)

***

### SttOpener

Re-exports [SttOpener](../eval.md#sttopener)

***

### SttOpenOptions

Re-exports [SttOpenOptions](../eval.md#sttopenoptions)

***

### SttSession

Re-exports [SttSession](../eval.md#sttsession)

***

### SttTurnMeta

Re-exports [SttTurnMeta](../eval.md#sttturnmeta)

***

### STUB\_LLM\_API\_KEY\_ENV

Re-exports [STUB_LLM_API_KEY_ENV](../eval.md#stub_llm_api_key_env)

***

### STUB\_SPEECH\_API\_KEY\_ENV

Re-exports [STUB_SPEECH_API_KEY_ENV](../eval.md#stub_speech_api_key_env)

***

### StubLlm

Re-exports [StubLlm](../eval.md#stubllm)

***

### StubScript

Re-exports [StubScript](../eval.md#stubscript)

***

### StubSpeechProviders

Re-exports [StubSpeechProviders](../eval.md#stubspeechproviders)

***

### StubStep

Re-exports [StubStep](../eval.md#stubstep)

***

### StubSttSession

Re-exports [StubSttSession](../eval.md#stubsttsession)

***

### StubTtsSession

Re-exports [StubTtsSession](../eval.md#stubttssession)

***

### toolArgsIn

Re-exports [toolArgsIn](../eval.md#toolargsin)

***

### toolCallsInEvents

Re-exports [toolCallsInEvents](../eval.md#toolcallsinevents)

***

### toolCallsInTurns

Re-exports [toolCallsInTurns](../eval.md#toolcallsinturns)

***

### toolNames

Re-exports [toolNames](../eval.md#toolnames)

***

### toolResultIn

Re-exports [toolResultIn](../eval.md#toolresultin)

***

### toolResultsIn

Re-exports [toolResultsIn](../eval.md#toolresultsin)

***

### transcriptOf

Re-exports [transcriptOf](../eval.md#transcriptof)

***

### TtsError

Re-exports [TtsError](../eval.md#ttserror)

***

### TtsEvents

Re-exports [TtsEvents](../eval.md#ttsevents)

***

### TtsOpener

Re-exports [TtsOpener](../eval.md#ttsopener)

***

### TtsOpenOptions

Re-exports [TtsOpenOptions](../eval.md#ttsopenoptions)

***

### TtsSession

Re-exports [TtsSession](../eval.md#ttssession)

***

### TtsWordTiming

Re-exports [TtsWordTiming](../eval.md#ttswordtiming)

***

### TURN\_ENDS

Re-exports [TURN_ENDS](../eval.md#turn_ends)

***

### turnCalling

Re-exports [turnCalling](../eval.md#turncalling)

***

### Unsubscribe

Re-exports [Unsubscribe](../eval.md#unsubscribe)

***

### VmRunCodeOptions

Re-exports [VmRunCodeOptions](../eval.md#vmruncodeoptions)
