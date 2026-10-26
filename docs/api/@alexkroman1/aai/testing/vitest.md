# testing/vitest

`@alexkroman1/aai/testing/vitest` — the vitest-coupled half of the test helpers — everything that INSTALLS or RESTORES.

A FACADE. The subpath resolves here rather than at `testing-vitest.ts`, which buys two
things the direct form could not. That module can be SPLIT as it grows without
moving the published entry point — the path an implementation file happens to
have is not a thing to promise anyone — and a name it gains next reaches the
public surface only when a line is added below, rather than the moment it is
written.

Named re-exports rather than `export *` for the second half of that: the
wildcard form re-exports whatever arrives, and needs a `noReExportAll`
suppression the escape-hatch ratchet only lets move down.

An agent project's test files import these through `@alexkroman1/aai-runtime/testing/vitest`,
which re-exports every name here as the same declaration alongside the
runtime's own drivers — one door per kind of helper, whatever package
declares it. This subpath keeps working; it is where the names are declared.

## Functions

### describeAgent()

```ts
function describeAgent<D extends ToolBearingAgent & {
  llm?: unknown;
  name: string;
  stt?: unknown;
  tts?: unknown;
}>(agent: D, define: (run: ToolRunner, agent: D) => void): void;
```

Declare a suite for one deployed agent: the built-in "is deployable" case,
then the body, handed the typed [ToolRunner](../testing.md#toolrunner) for the agent.

Every shipped template's spec opened with the same two things — a
`describe(agentDef.name, …)` whose first case was `expectDeployable(agentDef)`,
and `const run = toolRunner(agentDef)` above it. The deployable case is the
one no agent spec should be without (a config the platform refuses is a spec
measuring nothing), and binding the runner is the line every file repeated.

The body takes vitest's own `test`/`expect` from `vitest` as usual; only the
runner is handed in, so a case reads `run(addItem, { … })` typed, or
`run("add_item", …)` by name.

#### Type Parameters

##### D

`D` *extends* [`ToolBearingAgent`](../testing.md#toolbearingagent) & \{
  `llm?`: `unknown`;
  `name`: `string`;
  `stt?`: `unknown`;
  `tts?`: `unknown`;
\}

#### Parameters

##### agent

`D`

##### define

(`run`: [`ToolRunner`](../testing.md#toolrunner), `agent`: `D`) => `void`

#### Returns

`void`

#### Example

```ts
// file: agent.ts
import { agent } from "@alexkroman1/aai";

export default agent({ name: "Orders" });

// file: tools/add_item.ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Add an item to the order",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }) => ({ added: item }),
});

// file: agent.test.ts
import { deployedAgent } from "@alexkroman1/aai/testing";
import { describeAgent } from "@alexkroman1/aai/testing/vitest";
import { expect, test } from "vitest";
import authored from "./agent.ts";
import addItem from "./tools/add_item.ts";

// Under vitest, `import agentDef from "virtual:aai/agent"` is this line.
const agentDef = deployedAgent(authored, {
  tools: import.meta.glob("./tools/*.ts", { eager: true }),
});

describeAgent(agentDef, (run) => {
  test("adds the item", async () => {
    const { added } = await run(addItem, { item: "apple" });
    expect(added).toBe("apple");
  });
});
```

***

### installStubClientInbox()

```ts
function installStubClientInbox(options?: StubClientInboxOptions): StubClientInbox;
```

Publish a device inbox for `stepNotifyClient`, restored when this test
finishes.

`stubClientInbox` with the bookkeeping done — see it for the call log and how
to make the device answer busy or offline. The usual partner of
[installStubSpeech](#installstubspeech): a step that speaks a notice and pushes it to a
speaker needs both, and each used to cost a `try`/`finally` of its own.

#### Parameters

##### options?

[`StubClientInboxOptions`](../testing.md#stubclientinboxoptions)

#### Returns

[`StubClientInbox`](../testing.md#stubclientinbox)

#### Example

In a test body or a `beforeEach`:
```ts
import { stepNotifyClient } from "@alexkroman1/aai/step";
import { installStubClientInbox } from "@alexkroman1/aai/testing/vitest";

const inbox = installStubClientInbox();
await stepNotifyClient("kitchen", { id: "wrun_1", event: "reminder" });
console.log(inbox.calls[0]?.clientId); // "kitchen"
```

***

### installStubGateway()

```ts
function installStubGateway(replies: string | readonly string[], options?: InstallStubGatewayOptions): StubGatewayCall[];
```

Install a fake LLM gateway as the global `fetch`, and return its call log.

`stubGateway` (`@alexkroman1/aai/testing`) installed for you. Import it under
THIS name — aliasing it to `stubGateway` shadows the uninstalled fake of that
name. A step whose HTTP goes through a published `stepFetch` wants
`stubGatewayRoute` instead; `stubGateway`'s doc has the table.

The calls array is what a spec asserts on, and it is live — a reference taken
before the code under test runs holds every call made after.

**Lifetime is one test**, as it is for any `vi.stubGlobal` under
`unstubGlobals` — which this repo's shared config and `defineAgentTestConfig`
(`@alexkroman1/aai/testing/vite`) both set, so the real `fetch` is back
before the next test. Install per test (the test body or a `beforeEach`);
one installed in `beforeAll` is gone before the first test runs. Without
`unstubGlobals`, `vi.unstubAllGlobals()` is the explicit undo.

**It also seeds `ASSEMBLYAI_API_KEY`** for the test when the process holds
none, since `stepGenerate` refuses by name without one and the fake never
reads it — `apiKey: false` opts out. The seed is put back when the test
finishes.

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order; the last repeats — see
  `stubGateway` in `@alexkroman1/aai/testing`, which this installs.

##### options?

[`InstallStubGatewayOptions`](#installstubgatewayoptions)

#### Returns

[`StubGatewayCall`](../testing.md#stubgatewaycall)[]

#### Example

```ts
// file: workflows/digest.ts
import { stepGenerateJson } from "@alexkroman1/aai/step";
import { z } from "zod";

export const summarize = (article: string) =>
  stepGenerateJson(`One headline for: ${article}`, { schema: z.object({ headline: z.string() }) });

// file: digest.test.ts
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

[`StubStepDelegate`](../testing.md#stubstepdelegate)

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

```ts
// file: workflows/ingest.ts
import { stepReadUpload, stepWriteUpload } from "@alexkroman1/aai/step";

export async function ingest(uploadId: string) {
  const { bytes } = await stepReadUpload(uploadId);
  return stepWriteUpload(bytes);
}

// file: ingest.test.ts
import { installStubUploads } from "@alexkroman1/aai/testing/vitest";
import { expect, test } from "vitest";
import { ingest } from "./workflows/ingest.ts";

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

#### Parameters

##### options?

[`StubWorkflowsOptions`](#stubworkflowsoptions)

#### Returns

[`WorkflowClient`](../index.md#workflowclient)

***

### installStubWorld()

```ts
function installStubWorld(options?: StubWorldOptions): StubWorld;
```

Install every seam a workflow step reaches through, composed in the one
order that works, and seed the credential — restored when this test
finishes.

A step's HTTP goes through ONE published `stepFetch`, so a flow that calls a
model AND fetches a page AND transcribes a recording cannot install three
fakes: whichever published last answers everything. The composition every
workflow spec therefore hand-wrote is the gateway route in FRONT of the page
stub (`model.route(request) ?? page()`), and in front of both the
transcription fake holding the slot with the pair as its `otherwise`. Get
the order wrong and the page stub answers the gateway's request with HTML,
which `stepGenerate` retries against until its budget runs out; a shipped
template carries a paragraph warning about exactly this. Here the order is
fixed, and a spec names only the legs it has.

It also seeds `ASSEMBLYAI_API_KEY` (unless `apiKey: false`), because
`stepGenerate` refuses by name without one and the fake never reads it; the
previous value is put back when the test finishes. `stubGatewayRoute` itself
cannot seed anything — it installs nothing and owns no lifetime — so the
seeding lives with the installers.

`installStubReporter` is installed too, so what the steps narrated is on
`reported` without a second call — unless a reporter is already published
(an eval's), which is left in place: `reporter` decides.

#### Parameters

##### options?

[`StubWorldOptions`](#stubworldoptions)

#### Returns

[`StubWorld`](#stubworld)

#### Example

```ts
// file: workflows/digest.ts
import { stepFetch, stepGenerateJson } from "@alexkroman1/aai/step";
import { z } from "zod";

export async function digest(input: { url: string }) {
  const page = await (await stepFetch(input.url)).text();
  return stepGenerateJson(`One headline for: ${page}`, {
    schema: z.object({ headline: z.string() }),
  });
}

// file: digest.test.ts
import { installStubWorld } from "@alexkroman1/aai/testing/vitest";
import { expect, test } from "vitest";
import { digest } from "./workflows/digest.ts";

test("the digest reads the page and asks the model", async () => {
  const world = installStubWorld({
    model: '{"headline":"Otters use tools"}',
    pages: { "https://example.com/otters": { body: "<p>Otters use tools.</p>" } },
  });
  await digest({ url: "https://example.com/otters" });
  expect(world.model[0]?.prompt).toContain("Otters");
});
```

## Type Aliases

### InstallStubGatewayOptions

```ts
type InstallStubGatewayOptions = StubGatewayOptions & {
  apiKey?: string | false;
};
```

**`Input`**

Options for [installStubGateway](#installstubgateway): `stubGateway`'s, plus the credential.

#### Type Declaration

##### apiKey?

```ts
optional apiKey?: string | false;
```

The `ASSEMBLYAI_API_KEY` to seed for this test, when the process holds
none — see [installStubWorld](#installstubworld). Defaults to a recognizable stub
value; `false` seeds nothing, for the one spec whose subject IS the
missing-key refusal.

***

### StubWorkflowsOptions

```ts
type StubWorkflowsOptions = {
  agent?: WorkflowAppLike;
  lastLine?: unknown;
  names?: readonly string[];
  runId?: string;
  runs?: readonly WorkflowRunSnapshot[];
};
```

**`Input`**

What [installStubWorkflows](#installstubworkflows) answers each read with.

Every field has a default, so `installStubWorkflows()` is a client whose reads all
answer "nothing has run" — which is the arm a `*_status` tool branches on
first and the one most specs of one want.

#### Properties

##### agent?

```ts
optional agent?: WorkflowAppLike;
```

The agent under test, whose declared `workflows` are what `listing()`
reports — so a renamed workflow is read off the def rather than restated.
Pass `agentDef`; an explicit `names` wins over it.

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
under test declares. Defaults to the keys of [StubWorkflowsOptions.agent](#agent)'s
`workflows`, else none, i.e. an agent declaring no workflow.

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

***

### StubWorld

```ts
type StubWorld = {
  files: StubUploads | undefined;
  model: StubGatewayCall[];
  provider: StubTranscribeCall[];
  reported: StubReporter;
  speech: StubSpeechCall[];
};
```

**`Sealed`**

What [installStubWorld](#installstubworld) returns: every fake's call log, live.

#### Properties

##### files

```ts
readonly files: StubUploads | undefined;
```

The upload store itself — `undefined` when `uploads` was not named. Read a
file back with `read`; what a step wrote (under `writable`) is `writes`.

##### model

```ts
readonly model: StubGatewayCall[];
```

Every completion request the gateway answered, decoded.

##### provider

```ts
readonly provider: StubTranscribeCall[];
```

Every transcription request, by leg — empty when `transcribe` was not named.

##### reported

```ts
readonly reported: StubReporter;
```

What the steps narrated and emitted (`installStubReporter`) — empty, and
recording nothing, when the world left a published reporter in place
(see `StubWorldOptions.reporter`).

##### speech

```ts
readonly speech: StubSpeechCall[];
```

Every line the synthesizer was asked to say — empty when `speech` was not named.

***

### StubWorldOptions

```ts
type StubWorldOptions = {
  apiKey?: string | false;
  model?: string | readonly string[];
  pages?:   | FetchRouteTable
     | readonly FetchRouteHandler[]
     | FetchRouteHandler;
  reporter?: boolean;
  speech?: StubSpeechOptions | true;
  transcribe?: StubTranscribeOptions;
  uploads?: StubUploadsOptions & {
     files?: Readonly<Record<string, StubUpload>>;
  };
};
```

**`Input`**

What [installStubWorld](#installstubworld) may be told: one entry per seam a step reaches
through, each optional, each installed only when named.

#### Properties

##### apiKey?

```ts
readonly optional apiKey?: string | false;
```

The `ASSEMBLYAI_API_KEY` to seed for this test, when the process holds
none. Defaults to a recognizable stub value; `false` seeds nothing.

##### model?

```ts
readonly optional model?: string | readonly string[];
```

What the LLM gateway answers, in order, the last repeating — `stubGatewayRoute`'s
replies. Routed FIRST, on the completions path, before every other leg:
a page stub answering the gateway's request with HTML is the footgun this
ordering exists for (the summarize step retries six times against it).
Absent, a completion request falls through to the other legs.

##### pages?

```ts
readonly optional pages?: 
  | FetchRouteTable
  | readonly FetchRouteHandler[]
  | FetchRouteHandler;
```

Everything else a step fetches — a page, a vendor API — as a
`stubFetchRoutes` table, an ordered handler list (what `describeEval`'s
`steps.routes` takes too) or one handler. The LAST leg: a request it does
not answer is a finding and throws naming the method and URL, never an
empty `200` a step would try to parse — after a `transcribe.otherwise` of
your own has declined it.

##### reporter?

```ts
readonly optional reporter?: boolean;
```

Publish the recording reporter (`installStubReporter`). Defaults to
publishing one only when NO reporter is published yet — inside
`describeEval` the harness's reporter is what `run.reported` reads, and a
stub published over it emptied that log. `false` never publishes one;
`true` always does.

##### speech?

```ts
readonly optional speech?: StubSpeechOptions | true;
```

Publish a recording synthesizer — `installStubSpeech`'s options, or `true` for the defaults.

##### transcribe?

```ts
readonly optional transcribe?: StubTranscribeOptions;
```

Answer AssemblyAI's transcription endpoints — `installStubTranscribe`'s
options. When present, the transcription fake OWNS the published step
fetch and the gateway and `pages` legs are its `otherwise`, which is the
only order that works: publishing replaces, so two fakes cannot both hold
the slot. An `otherwise` of your own runs after both.

##### uploads?

```ts
readonly optional uploads?: StubUploadsOptions & {
  files?: Readonly<Record<string, StubUpload>>;
};
```

Publish an in-memory upload store — `installStubUploads`'s two arguments
as one object: the `files` it holds by id, beside its options (`writable`,
`idPrefix`). `{}` publishes an empty read-only store; `{ writable: true }`
one a step may write into, read back on `files`.

###### Type Declaration

###### files?

```ts
readonly optional files?: Readonly<Record<string, StubUpload>>;
```
