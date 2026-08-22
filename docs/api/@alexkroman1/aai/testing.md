# testing

Test helpers for agent code (the `@alexkroman1/aai/testing` subpath).

A tool's `execute` takes a [ToolContext](index.md#toolcontext), so testing one means building
one. Every field is supplied at runtime and most tests care about exactly
two of them (`slots`, `sessionId`), which is why the hand-rolled version of
this ends up as `{ … } as unknown as ToolContext` — a cast that also stops
telling you when a field is added.

Framework-agnostic on purpose: `send` records into an array rather than
calling a mock library, so this module carries no test-runner dependency and
a spy can still be passed in when a test wants call-order assertions.

## Interfaces

### SentEvent

One `ctx.send(event, data)` call, as recorded by [createToolContext](#createtoolcontext).

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
error body, which is what `stepGenerate` (`@alexkroman1/aai/utils`)
quotes back in its `StepGenerateError`.

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

### RunSnapshotOverrides

```ts
type RunSnapshotOverrides<R> = Partial<WorkflowRunBase> & 
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

#### Properties

##### calls

```ts
calls: StubSpeechCall[];
```

Every call, in order.

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

### StubUploadsOptions

```ts
type StubUploadsOptions = {
  idPrefix?: string;
  writable?: boolean;
};
```

What [stubUploads](#stubuploads) may be told beyond the files themselves.

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

Events `ctx.send` received, in call order.

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

## Variables

### STUB\_SPEECH\_PCM\_BYTES

```ts
const STUB_SPEECH_PCM_BYTES: 12000 = 12000;
```

PCM bytes [stubSpeech](#stubspeech-1) answers with when no size is named — ~0.25s at 24 kHz.

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
function createRunSnapshot<R>(over?: RunSnapshotOverrides<R>): WorkflowRunSnapshot<R>;
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

Rejecting rather than no-op defaults for the same reason [createUnusedDb](#createunuseddb)
rejects — a tool that reaches for a method the test did not stub should say so,
not silently receive `undefined`. `listing` is the exception and returns `[]`,
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
function createToolContext(overrides?: Partial<ToolContext>): TestToolContext;
```

Build a [ToolContext](index.md#toolcontext) for testing a tool's `execute` in isolation.

Defaults are chosen so the context is inert: empty `env`, an empty slot store,
a `db` and `generate` that reject with a message naming themselves, a
`signal` that never aborts, and a `send` that records. Override any of them.

**Each call is a distinct session.** `sessionId` auto-increments, which is
what makes the two-context isolation test — the same tool run against two
contexts must not share state — read the way it does. Pass `sessionId`
explicitly when a test needs two contexts to be the SAME session (a
reconnect, a keyed lock).

There is no state type parameter, because there is no `ctx.state` bag to
type: a slot types its own value in the module that declares it, and reading
the slot back is how a spec asserts what a tool wrote.

#### Parameters

##### overrides?

`Partial`\<[`ToolContext`](index.md#toolcontext)\>

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

### createUnusedDb()

```ts
function createUnusedDb(): Db;
```

A `Db` whose every query rejects, naming the field — the default for a test
context, so a tool that unexpectedly reaches for storage fails with that
sentence instead of a `TypeError` on `undefined`.

#### Returns

[`Db`](index.md#db)

***

### runTool()

```ts
function runTool(
   agent: ToolBearingAgent, 
   name: string, 
   args: InferSchemaOutput<ToolInputSchema>, 
ctx: ToolContext): Promise<unknown>;
```

Run a tool by the name the model calls it by.

`args` is unvalidated on purpose: the runtime parses a model's arguments
against `inputSchema` BEFORE `execute` sees them, so a spec that pre-validated
would be testing a path the tool never runs on. Pass the arguments the tool
body expects to receive.

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

##### name

`string`

##### args

[`InferSchemaOutput`](index.md#inferschemaoutput)\<[`ToolInputSchema`](index.md#toolinputschema)\>

##### ctx

[`ToolContext`](index.md#toolcontext)

#### Returns

`Promise`\<`unknown`\>

#### Example

```ts no-check
// `no-check`: the agent under test is in another file, which is the point.
import { createToolContext, runTool } from "@alexkroman1/aai/testing";
import agentDef from "./agent.ts";

const ctx = createToolContext();
expect(await runTool(agentDef, "add_item", { item: "apple" }, ctx)).toEqual({ added: "apple" });
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

Capture what a `"use step"` function narrates and emits.

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
  | Response
  | {
  body?: unknown;
  headers?: Record<string, string>;
  status?: number;
}
  | Promise<
  | Response
  | {
  body?: unknown;
  headers?: Record<string, string>;
  status?: number;
}>): StubStepFetch;
```

Publish a fake `stepFetch`, so a `"use step"` function's HTTP can be asserted
without a server and without stubbing a global.

A step's outbound call goes through a process-wide slot rather than
`globalThis.fetch` (see `sdk/step-fetch.ts` for why — HTTP/1.1 pinning, and
a fan-out that breaks on HTTP/2 stream resets), so this is the honest way to
intercept it. `vi.stubGlobal("fetch", …)` still works, because an unpublished
slot falls back to the global; it just tests a path production does not take,
and it cannot see the request BODY as bytes.

`answer` may return a `Response`, or a `{ status, body, headers }` shorthand,
or throw — a throw is what a connection failure looks like, and `stepFetch`
wraps it in a `StepTransportError` exactly as it would in production.

Returns `restore`, and calling it in an `afterEach` is not optional — a fetch
left published makes the next file's steps answer to this one's handler.

#### Parameters

##### answer?

(`request`: [`StubStepRequest`](#stubsteprequest)) => 
  \| `Response`
  \| \{
  `body?`: `unknown`;
  `headers?`: `Record`\<`string`, `string`\>;
  `status?`: `number`;
\}
  \| `Promise`\<
  \| `Response`
  \| \{
  `body?`: `unknown`;
  `headers?`: `Record`\<`string`, `string`\>;
  `status?`: `number`;
\}\>

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

### stubUploads()

```ts
function stubUploads(files: Readonly<Record<string, StubUpload>>, options?: StubUploadsOptions): () => void;
```

Publish an in-memory upload store, so a `"use step"` function that calls
`readUpload` can be tested without a server.

A step reads uploads through a process-wide slot rather than dialling
anything (see `sdk/step-uploads.ts`), which is what makes this possible at
all: a spec supplies its own bytes and the step under test is unchanged.

Returns the UNPUBLISH function, and calling it in an `afterEach` is not
optional — a store left published makes the next file's steps read this
one's bytes, which is the kind of cross-file leak that presents as a passing
test somewhere else.

#### Parameters

##### files

`Readonly`\<`Record`\<`string`, [`StubUpload`](#stubupload)\>\>

Keyed by upload id — the same string a run input would carry.

##### options?

[`StubUploadsOptions`](#stubuploadsoptions)

#### Returns

() => `void`

#### Example

```ts
import { stubUploads } from "@alexkroman1/aai/testing";

const restore = stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
// … call the step …
restore();

// A streamed upload mid-flight: `readUpload` comes back short and
// `uploadInfo(...).complete` is false, which is what a polling body sees.
const firstHalf = new Uint8Array([1, 2]);
stubUploads({ upl_2: { bytes: firstHalf, complete: false } });
```

***

### toolOf()

```ts
function toolOf(agent: ToolBearingAgent, name: string): ToolDef<ToolInputSchema>;
```

The tool `name` is declared under, or a throw naming the ones that are.

#### Parameters

##### agent

[`ToolBearingAgent`](#toolbearingagent)

##### name

`string`

#### Returns

[`ToolDef`](index.md#tooldef)\<[`ToolInputSchema`](index.md#toolinputschema)\>

#### Example

```ts no-check
// `no-check`: the agent under test is in another file, which is the point.
import { toolOf } from "@alexkroman1/aai/testing";
import agentDef from "./agent.ts";

expect(toolOf(agentDef, "add_item").description).toContain("cart");
```

***

### withDiscoveredTools()

```ts
function withDiscoveredTools(def: AgentDef, modules: ToolModules): AgentDef;
```

The def a DEPLOYED agent runs: the one `agent.ts` exports, plus the tools its
`tools/` directory declares.

Pass `import.meta.glob("./tools/*.ts", { eager: true })` — see the module doc
for why the glob belongs at the call site. Every rule the build applies applies
here too, and each is an error naming the file: the name grammar, the
default-export requirement, no nested files, and a name declared twice.

A project with no `tools/` directory gets an empty glob and the def unchanged.

#### Parameters

##### def

[`AgentDef`](index.md#agentdef)

##### modules

[`ToolModules`](manifest.md#toolmodules)

#### Returns

[`AgentDef`](index.md#agentdef)

#### Example

```ts no-check
// `no-check`: import.meta.glob needs your project's vite/client types.
import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
import authored from "./agent.ts";

const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));

test("adds an item", async () => {
  expect(await runTool(agentDef, "add_item", { item: "apple" }, createToolContext())).toEqual({
    added: "apple",
  });
});
```
