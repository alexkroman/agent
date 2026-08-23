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

Capture what a `"use step"` function narrates and emits, restored when this
test finishes.

`stubReporter` with the bookkeeping done — see it for why `report()` and
`emit()` are separated the way the streams are.

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
