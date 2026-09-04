# testing/vitest

The vitest-coupled half of the test helpers (`@alexkroman1/aai/testing/vitest`).

`sdk/testing.ts` is framework-agnostic on purpose — it returns fakes rather
than installing them, so it carries no test-runner dependency and a project
using another runner can still build a `ToolContext`. That is the right
default and it is not free: `stubGateway` (`@alexkroman1/aai/testing`)
hands back a `fetch`
implementation, and the INSTALLATION of it was then written out by hand in
every workflow template, four times, each with the same paragraph explaining
why the SDK had not done it.

So the coupling gets its own subpath instead of leaking into the main one.
`vitest` is an OPTIONAL peer dependency: importing this module is what pulls
it, importing `@alexkroman1/aai/testing` is not, and a project that never
writes a test resolves neither.

**The rule for what belongs here: anything that installs, and anything that
restores.** Every fake on `@alexkroman1/aai/testing` that fills a published
slot hands back a `restore` the caller owns, and owning it means a registry —
`const restores: (() => void)[]` with an `afterEach` that splices it, written
out in template after template, three times in one file. The `install*` half
of this module is that fake plus `onTestFinished(restore)`: same object,
unwound by the runner in reverse order when the test that installed it ends.

A fake with no lifetime (`stubGenerate`, `createToolContext`, the workflow
snapshots) gets no wrapper — there is nothing to restore, so a second name
for it would only be a second name.

**`installStubWorkflows` is here for the other half of the same rule: `vi.fn` IS its
content.** It restores nothing and installs nothing, so it takes no `install`
prefix — but its methods have to be spies, because a spec of a
workflow-driving tool asserts on `start` and re-points `lastLine` per test.
A plain-function version would be a helper neither caller could use, so the
coupling is the feature rather than a leak.

## Functions

### installStubGateway()

```ts
function installStubGateway(replies: string | readonly string[], opts?: StubGatewayOptions): StubGatewayCall[];
```

Install a fake LLM gateway as the global `fetch`, and return its call log.

The calls array is what a spec asserts on, and it is live — a reference taken
before the code under test runs holds every call made after.

**Lifetime is the caller's**, as it is for any `vi.stubGlobal`. This repo does
not set `unstubGlobals`, so a stub outlives its test unless the next one
replaces it; installing per test (which is the shape every caller wants
anyway) makes that moot, and `vi.unstubAllGlobals()` is the explicit undo.

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order; the last repeats — see
  `stubGateway` in `@alexkroman1/aai/testing`, which this installs.

##### opts?

[`StubGatewayOptions`](../testing.md#stubgatewayoptions)

#### Returns

[`StubGatewayCall`](../testing.md#stubgatewaycall)[]

#### Example

```ts no-check
// `no-check`: the step under test is in another file, which is the point.
import { installStubGateway } from "@alexkroman1/aai/testing/vitest";
import { expect, test } from "vitest";
import { summarize } from "./workflows/digest.ts";

test("summarize sends the article", async () => {
  const calls = installStubGateway('{"headline":"Otters use tools"}');
  await summarize("Otters use tools.");
  expect(calls[0]?.prompt).toContain("Otters use tools.");
});
```

***

### installStubReporter()

```ts
function installStubReporter(): StubReporter;
```

Capture what a step narrates and emits, restored when this
test finishes.

`stubReporter` with the bookkeeping done — see it for why `stepReport()` and
`stepEmit()` are separated the way the streams are.

#### Returns

[`StubReporter`](../testing.md#stubreporter)

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

[`StubSpeechOptions`](../testing.md#stubspeechoptions)

#### Returns

[`StubSpeech`](../testing.md#stubspeech)

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

[`StubStepFetch`](../testing.md#stubstepfetch)

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

[`StubTranscribeOptions`](../testing.md#stubtranscribeoptions)

#### Returns

[`StubTranscribe`](../testing.md#stubtranscribe)

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

[`StubUploadsOptions`](../testing.md#stubuploadsoptions)

#### Returns

[`StubUploads`](../testing.md#stubuploads)

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

### installStubWorkflows()

```ts
function installStubWorkflows(options?: StubWorkflowsOptions): WorkflowClient;
```

A `ctx.workflows` whose reads answer from one fixture and whose every method
is a `vi.fn`.

`createStubWorkflows` (`@alexkroman1/aai/testing`) is the framework-agnostic
base: it REJECTS every method, so a tool reaching for one the spec did not
stub says so. That is the right default and it is not the shape a spec of a
workflow-driving agent wants, because such a tool reads two or three methods
per call and asserts on `start`. Both shipped workflow templates therefore
opened with the same fifteen lines — a `vi.fn` per method, answering from one
`runs` array — byte-identical apart from the workflow name in `listing`.

**It is on this subpath because `vi.fn` is the content.** The methods have to
be spies: a spec asserts `expect(workflows.start).toHaveBeenCalledWith(def,
input)` and re-points one per test with
`vi.mocked(workflows.lastLine).mockResolvedValue("…")`. A plain-function
version would be a different helper that neither template could use.

**What it does NOT answer is deliberate.** `stream`, `streamTail`, `signal`
and `publicWebhookUrl` fall through to the rejecting base, because a tool
reading a progress channel by hand is the hazard `lastLine` exists to remove
— see `WorkflowClient.lastLine`, where composing `streamTail` + `stream` in
the wrong order waits forever with no error. A spec that really is testing
one of those overrides it, which reads as the deliberate act it is.

Spread it to replace a method for one test: `{ ...installStubWorkflows(), signal }`.

#### Parameters

##### options?

[`StubWorkflowsOptions`](#stubworkflowsoptions)

#### Returns

[`WorkflowClient`](../index.md#workflowclient)

#### Example

```ts
import { createRunSnapshot, createToolContext } from "@alexkroman1/aai/testing";
import { installStubWorkflows } from "@alexkroman1/aai/testing/vitest";

const workflows = installStubWorkflows({
  names: ["recap"],
  runs: [createRunSnapshot({ workflow: "recap", status: "running" })],
});
const ctx = createToolContext({ workflows });
```

## Type Aliases

### StubWorkflowsOptions

```ts
type StubWorkflowsOptions = {
  lastLine?: unknown;
  names?: readonly string[];
  runId?: string;
  runs?: readonly WorkflowRunSnapshot[];
};
```

What [installStubWorkflows](#installstubworkflows) answers each read with.

Every field has a default, so `installStubWorkflows()` is a client whose reads all
answer "nothing has run" — which is the arm a `*_status` tool branches on
first and the one most specs of one want.

#### Properties

##### lastLine?

```ts
optional lastLine?: unknown;
```

What `lastLine` resolves with. Defaults to `undefined`, which means "the
run has written nothing yet" — the arm a progress tool branches on, and the
reason this has a default rather than being left to reject.

##### names?

```ts
optional names?: readonly string[];
```

Workflow names `listing()` reports, in order — normally the one the agent
under test declares. Defaults to none, i.e. an agent declaring no workflow.

##### runId?

```ts
optional runId?: string;
```

What `start` resolves with. Defaults to `"wrun_stub"`.

##### runs?

```ts
optional runs?: readonly WorkflowRunSnapshot[];
```

The runs `get`, `find` and `recent` answer from — `get` with the first,
the other two with the whole list. One list rather than three, because a
spec asserting what a tool REPORTS is describing one world, and three
fixtures that can disagree about it is a way to write a passing test for a
state the platform cannot produce. Build them with `createRunSnapshot`.
