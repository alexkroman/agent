# workflow-api

`@alexkroman1/aai/workflow-api` — the client side of a deployed agent's HTTP
API, from one import path.

Four modules sit behind it, and the split is a dependency one rather than a
taste one: `agent-client.ts` is a SUPERSET of `workflow-api-client.ts` (it
calls the narrower factory), so the subpath cannot be either file — pointing
it at the client and re-exporting the agent client from there is an import
cycle, which is what this barrel exists to break. `event-stream.ts` is the
parser both of them read a stream with, and `workflow-api-types.ts` holds the
call set.

Start with `createAgentClient` — one object for everything one agent answers.
`createWorkflowApiClient` is the narrower one, for a caller that genuinely
only has workflows (a page already knows what it is).

## Type Aliases

### AgentClient

```ts
type AgentClient = WorkflowApi & {
  baseUrl: string;
  config: Promise<{
     greeting?: z.ZodOptional<z.ZodString>;
     name?: z.ZodOptional<z.ZodString>;
     page?: z.ZodOptional<z.ZodEnum<{
        static: "static";
        voice: "voice";
     }>>;
     sessionUrl?: z.ZodOptional<z.ZodString>;
  }>;
};
```

Everything one agent answers: every [WorkflowApi](#workflowapi) call, plus the front
door.

An intersection rather than a redeclaration — the workflow half must not be
describable twice.

#### Type Declaration

##### baseUrl

```ts
readonly baseUrl: string;
```

The agent's base URL, normalized — no trailing slash.

Here because a caller that has this client should not also be threading the
string it was built from: a webhook to register, a link to print, a `curl`
to paste in a bug report all want it, and re-deriving it invites the
trailing-slash `//workflows` 404 this normalizes away.

##### config()

```ts
config(): Promise<{
  greeting?: z.ZodOptional<z.ZodString>;
  name?: z.ZodOptional<z.ZodString>;
  page?: z.ZodOptional<z.ZodEnum<{
     static: "static";
     voice: "voice";
  }>>;
  sessionUrl?: z.ZodOptional<z.ZodString>;
}>;
```

What the agent says it IS: `{ name?, greeting?, page?, sessionUrl? }`.

The one read that works on EVERY agent, whatever shape it is, and the one a
caller starts with — `page` (absent reads as `"voice"`) is how you know
whether there is a session to open at all, and `sessionUrl` is the current
one. **Re-read it on every connect rather than storing it**: on the platform
it names the agent's sandbox, and that URL changes when the sandbox is
replaced by an idle reclaim or a redeploy.

Unauthenticated on a deployed agent, exactly like the page it describes — so
this call works with no `token`, and a workflow API closed by
`AAI_WORKFLOW_API_TOKEN` does not close it.

###### Returns

`Promise`\<\{
  `greeting?`: `z.ZodOptional`\<`z.ZodString`\>;
  `name?`: `z.ZodOptional`\<`z.ZodString`\>;
  `page?`: `z.ZodOptional`\<`z.ZodEnum`\<\{
     `static`: `"static"`;
     `voice`: `"voice"`;
  \}\>\>;
  `sessionUrl?`: `z.ZodOptional`\<`z.ZodString`\>;
\}\>

***

### ClientConfigResponse

```ts
type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;
```

Parsed body of `GET /client-config`.

***

### EventStreamFrame

```ts
type EventStreamFrame = {
  data: unknown;
  event: string;
};
```

One parsed frame. Comment frames (the heartbeats an idle stream sends) are
skipped rather than yielded, and so is a frame with no `event:` name — the
routes here name every frame they send, and an unnamed one cannot be
classified by any caller.

#### Properties

##### data

```ts
data: unknown;
```

The frame's `data:` line, JSON-parsed, or `undefined` when it was not JSON.

Never a reason to tear the stream down: a run frame carries a WHOLE
snapshot, so the next one restates the same state, and a progress read is
re-opened from where it left off.

##### event

```ts
event: string;
```

The frame's `event:` name — `run`, `chunk`, `done`, `idle`, `missing`.

***

### UploadBody

```ts
type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string;
```

What an upload call accepts as the file's bytes.

***

### UploadOptions

```ts
type UploadOptions = {
  name?: string;
  onProgress?: (progress: UploadProgress) => void;
  parallel?: UploadParallel;
  resume?: boolean;
  signal?: AbortSignal;
  type?: string;
};
```

Options for an upload.

#### Properties

##### name?

```ts
optional name?: string;
```

Filename to store. Defaults to a `File`'s own `name`, else `""`.

##### onProgress?

```ts
optional onProgress?: (progress: UploadProgress) => void;
```

Called as the bytes leave, so a page can draw a progress bar over the one
call on this surface slow enough to need one.

It fires at least twice: once at `0` before anything is sent, so a bar
exists from the moment the request leaves rather than from whenever the
first chunk clears, and once at the end, so a bar cannot be left stopped
short of full by a transport whose last chunk report raced the response.

**Asking for it changes the transport, and only where that is possible.**
See this module's doc: byte-level progress means `XMLHttpRequest`, and where
there is none (Node, a worker without it) the call stays on `fetch` and the
reports degrade to the two ends — sending, then sent. Nothing else differs:
same URL, same headers, same failures.

###### Parameters

###### progress

[`UploadProgress`](#uploadprogress)

###### Returns

`void`

##### parallel?

```ts
optional parallel?: UploadParallel;
```

Cut the file up and send the pieces at once, instead of in one request.

**On by default.** `false` opts out, `{ partBytes, concurrency }` tunes it.
What it buys is the difference between one connection's throughput and the
link's: a single request is bounded by its congestion window over the
round-trip time, so the further away the agent is the smaller a fraction of
the available bandwidth one request can use, and a recording is exactly the
body big enough for that to be the wait a person is sitting through. It is
also the only path here that can RETRY — see `partsSettings` for why the
single-request writers cannot.

It degrades rather than failing: a body that cannot be cut by byte (a
string), a file that fits in one part, or an agent deployed before the
`/parts` routes existed all send the file the ordinary way instead. So the
default does nothing where it would not have helped, and opting out is for a
caller who knows something about their own link that this does not.
`workflow-upload-parts.ts` carries the rest.

##### resume?

```ts
optional resume?: boolean;
```

Continue an upload already begun under this id, sending only the windows that
are missing.

What it buys is the difference between resuming a recording and starting it
over. Without it a second attempt at an id is REFUSED — which is the rule that
makes a caller-chosen id safe, since nothing else stops one upload writing into
another's — so this is how a caller says the id is its own.

**A transient failure needs no flag: this call re-enters itself.** A round
that fails for a reason that looks like an outage is retried with the resume
already set, up to `UPLOAD_RESUME_ATTEMPTS` (see `_upload-resume.ts`, which
carries what "looks like an outage" excludes). So this option is for a
SEPARATE call against an id the caller already owns — the round after a pause,
a second submit of a form the person interrupted — and not for retrying.

Only the parts path can do it, and the store is what makes it safe: a part's
rows are keyed by the offset it starts at, so re-sending one is writing the
same bytes to the same place. The windows already stored come from
`UploadInfo.ranges`, and an agent too old to report them re-sends the whole
file rather than leaving a hole.

The bytes must be the SAME FILE. Nothing here can check that — the id is a
capability and the offsets are the caller's contract — so a resume with a
different file is a corrupted upload only its owner can read.

##### signal?

```ts
optional signal?: AbortSignal;
```

Abort the upload. Its own option rather than the client's `timeoutMs`,
which is sized for a JSON round trip: a large file legitimately takes
minutes, and a deadline that cannot tell those apart cancels the one thing
on this surface that is expensive to redo.

##### type?

```ts
optional type?: string;
```

MIME type to store. Defaults to a `Blob`'s own `type`, else octet-stream.

***

### UploadParallel

```ts
type UploadParallel = boolean | UploadPartsSettings;
```

What [UploadOptions.parallel](#parallel) accepts: `true` for the defaults, or the
settings to tune them.

***

### UploadPartsSettings

```ts
type UploadPartsSettings = {
  concurrency?: number;
  partBytes?: number;
};
```

How a caller tunes the fan-out.

Both fields have defaults sized on the constants' own reasoning, and a caller
that just wants the speed passes `parallel: true` and never sees this type.

#### Properties

##### concurrency?

```ts
optional concurrency?: number;
```

Parts in flight at once. Defaults to 4 (`UPLOAD_PART_CONCURRENCY`).

##### partBytes?

```ts
optional partBytes?: number;
```

Bytes per part. Defaults to 8 MiB (`UPLOAD_PART_BYTES`).

Rounded UP to a whole number of `UPLOAD_CHUNK_BYTES`, because a part starts at
a chunk boundary in the store and a size that is not a multiple of one would
put the next part's start inside a stored chunk.

***

### UploadProgress

```ts
type UploadProgress = {
  fraction: number | undefined;
  loaded: number;
  total: number | undefined;
};
```

How far an upload has got, as [UploadOptions.onProgress](#onprogress) reports it.

#### Properties

##### fraction

```ts
fraction: number | undefined;
```

`loaded / total`, clamped to `0..1` — the number a bar's width IS, so no
caller divides and none has to guard the zero-byte body that would divide
to `NaN` and render as a bar of no width labelled `NaN%`.

Undefined exactly when [UploadProgress.total](#total) is.

##### loaded

```ts
loaded: number;
```

Bytes handed to the network so far.

##### total

```ts
total: number | undefined;
```

The body's size, when it is knowable. Undefined for a body whose length the
transport cannot state up front, which is the case a bar has to render as
indeterminate rather than as empty.

***

### UploadRef

```ts
type UploadRef = {
  complete: boolean;
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
};
```

A stored upload, as `WorkflowApi.upload` resolves it.

#### Properties

##### complete

```ts
complete: boolean;
```

Whether every byte is in — always true for a call that resolved.

##### id

```ts
id: string;
```

The handle a run input carries.

##### name

```ts
name: string;
```

Filename as stored.

##### size

```ts
size: number;
```

Size in bytes.

##### type

```ts
type: string;
```

MIME type as stored.

##### url

```ts
url: string;
```

Absolute URL the bytes can be read back from, `Range` included.

***

### WorkflowApi

```ts
type WorkflowApi = {
  cancel: Promise<boolean>;
  download: Promise<Blob>;
  find: Promise<WorkflowRunSnapshot[]>;
  follow: AsyncIterable<WorkflowRunSnapshot>;
  followOutput: AsyncIterable<unknown>;
  get: Promise<WorkflowRunSnapshot | undefined>;
  list: Promise<WorkflowSummary[]>;
  recent: Promise<WorkflowRunSnapshot[]>;
  start: Promise<string>;
  startAndWait: Promise<WorkflowRunSnapshot>;
  streamOutput: Promise<Response>;
  upload: Promise<UploadRef>;
  uploadInfo: Promise<UploadInfo>;
  uploadStream: Promise<UploadRef>;
  wake: Promise<number>;
  watch: Promise<Response>;
};
```

The calls the API offers — one method per route, and nothing beyond them.

The width is the constraint: a route needing more than a tool can do is the
signal to add a `WorkflowClient` method server-side, never to grow this into
an engine with reads of its own. See the "no engine here" section of
`host/workflow-api.ts`.

#### Methods

##### cancel()

```ts
cancel(runId: string): Promise<boolean>;
```

Stop a run, resolving whether this call is what ended it. A run that had
already finished answers false rather than failing — two tabs pressing Stop
is ordinary.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`boolean`\>

##### download()

```ts
download(id: string, options?: {
  signal?: AbortSignal;
}): Promise<Blob>;
```

Read an upload's BYTES, as a `Blob` — the other end of a run that PRODUCED
a file (`writeUpload` stores it, the output carries the id). A `Blob`
rather than a URL because the byte route takes the same bearer every route
here does and neither `<audio src>` nor `<a href>` can send one;
`downloadUpload` carries the rest.

###### Parameters

###### id

`string`

###### options?

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`Blob`\>

##### find()

```ts
find(
   workflow: string, 
   key: string, 
   options?: {
  limit?: number;
}): Promise<WorkflowRunSnapshot[]>;
```

Runs of `workflow` started with `key`, newest first.

###### Parameters

###### workflow

`string`

###### key

`string`

###### options?

###### limit?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](index.md#workflowrunsnapshot)[]\>

##### follow()

```ts
follow(runId: string, options?: {
  signal?: AbortSignal;
}): AsyncIterable<WorkflowRunSnapshot>;
```

Every snapshot of a run, until it settles — the call `watch` is the raw
material for.

```ts
import { createAgentClient } from "@alexkroman1/aai/workflow-api";

const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
for await (const run of agent.follow("wrun_1")) console.log(run.status);
```

The last value is the TERMINAL snapshot, and reaching it is what ends the
iteration, so a caller that only wants the answer keeps the last one it saw.
The two protocol rules a hand-written loop gets wrong are honoured inside:
the stream hands the client back with an `idle` frame after its own duration
cap (a run may sleep for hours) and this re-opens, and a stream that ends
with the run unsettled THROWS rather than looking like a run that finished.

There is no polling fallback, deliberately — an agent that does not serve
the route fails here with its own sentence, and a caller who wants to poll
instead is the caller [WorkflowApi.watch](#watch) exists for.

###### Parameters

###### runId

`string`

###### options?

###### signal?

`AbortSignal`

###### Returns

`AsyncIterable`\<[`WorkflowRunSnapshot`](index.md#workflowrunsnapshot)\>

##### followOutput()

```ts
followOutput(runId: string, options?: {
  fromIndex?: number;
  namespace?: string;
  signal?: AbortSignal;
}): AsyncIterable<unknown>;
```

Everything a run WRITES, in order, until it settles.

```ts
import { createAgentClient } from "@alexkroman1/aai/workflow-api";

const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
for await (const chunk of agent.followOutput("wrun_1")) console.log(chunk);
```

One read of the route is bounded by the tail it saw, so this re-opens from
the next unread chunk until the run is finished — which is the rule that
makes a single `for await` cover a live run's whole log. Chunks are retained
with the run, so it is a replay as much as a tail and starts at the
beginning by default; `fromIndex` is ABSOLUTE, and the raw route's negative
"last N" form is left on [WorkflowApi.streamOutput](#streamoutput) because it names
no position a re-open could resume from.

###### Parameters

###### runId

`string`

###### options?

###### fromIndex?

`number`

###### namespace?

`string`

###### signal?

`AbortSignal`

###### Returns

`AsyncIterable`\<`unknown`\>

##### get()

```ts
get(runId: string, options?: {
  wait?: number;
}): Promise<WorkflowRunSnapshot | undefined>;
```

Read a run's state. Resolves undefined for an unknown id.

Deliberately NOT generic on the output, even though a caller wants it typed:
a generic METHOD has to be implemented generically, which would make every
test double and every hand-written stub of this client generic too. The type
parameter belongs on whatever a caller states its expectation with —
`useWorkflowRun<R>` in the browser client, or a cast at the one place a
script reads `output`.

###### Parameters

###### runId

`string`

###### options?

###### wait?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](index.md#workflowrunsnapshot) \| `undefined`\>

##### list()

```ts
list(): Promise<WorkflowSummary[]>;
```

Declared workflows: name, description, and the input schema to render.

###### Returns

`Promise`\<[`WorkflowSummary`](index.md#workflowsummary)[]\>

##### recent()

```ts
recent(workflow: string, options?: {
  limit?: number;
}): Promise<WorkflowRunSnapshot[]>;
```

Runs of `workflow`, newest first, whatever key they carry.

The operator's read where [WorkflowApi.find](#find) is the app's — a console
has no correlation key to ask about, and most runs carry none (a page holds
its own `runId`). Two methods rather than one nullable key, so a caller
meaning "this user's runs" cannot silently widen to every user's.

###### Parameters

###### workflow

`string`

###### options?

###### limit?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](index.md#workflowrunsnapshot)[]\>

##### start()

```ts
start(
   workflow: string, 
   input?: unknown, 
   options?: {
  key?: string;
}): Promise<string>;
```

Start a run and resolve its id WITHOUT waiting for it — the point of the
mechanism. Rejects when the name is not declared or the input fails the
workflow's schema, both of which are 400s carrying the reason.

`key` is a correlation handle the caller chooses, so the run can be found
again later without the id — a signed-in user, an upload, a device. Pass one
when the caller might be gone before the run finishes and you would rather
look it up than remember the id.

###### Parameters

###### workflow

`string`

###### input?

`unknown`

###### options?

###### key?

`string`

###### Returns

`Promise`\<`string`\>

##### startAndWait()

```ts
startAndWait(
   workflow: string, 
   input?: unknown, 
   options?: {
  key?: string;
  wait?: number;
}): Promise<WorkflowRunSnapshot>;
```

Start a run and resolve the FINISHED one — the synchronous call.

What a form or a shell script wants, and what [WorkflowApi.start](#start)
deliberately is not: one request in, one result out, with no watch to wire
up. The agent holds the request open until the run settles or its own budget
expires, so a run that is still going when the wait runs out resolves
NON-terminal — check `isTerminal`, or keep the id and read it back later.

`wait` is clamped to `MAX_WORKFLOW_WAIT_MS` at both ends, by the same
function, so this can never be waiting on a request the agent already
answered.

###### Parameters

###### workflow

`string`

###### input?

`unknown`

###### options?

###### key?

`string`

###### wait?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](index.md#workflowrunsnapshot)\>

##### streamOutput()

```ts
streamOutput(runId: string, options?: {
  namespace?: string;
  signal?: AbortSignal;
  startIndex?: number;
}): Promise<Response>;
```

Open a server-sent-event stream of what the run has WRITTEN — its progress,
as opposed to [WorkflowApi.watch](#watch)'s status transitions.

Resolves the raw `Response` for the same reason `watch` does: an agent
deployed before this route existed answers 404, which a caller has to be able
to see rather than have raised at it. Frames are `chunk` then `done`.

Chunks are retained with the run, so this is a replay as much as a live tail:
a caller that reloads gets the whole stream by default, and `startIndex`
(negative counts back from the end) is for a reader resuming from a known
position.

###### Parameters

###### runId

`string`

###### options?

###### namespace?

`string`

###### signal?

`AbortSignal`

###### startIndex?

`number`

###### Returns

`Promise`\<`Response`\>

##### upload()

```ts
upload(file: UploadBody, options?: UploadOptions): Promise<UploadRef>;
```

Store a file and resolve the handle a run input carries.

The other half of `WorkflowDef.uploads`: a workflow's input is journaled and
replayed on every resume, so bytes may not travel in it — they go here once,
and the run carries [UploadRef.id](#id), which a step reads windows of with
`readUpload`.

A `File` from an `<input type="file">` needs no second argument: its own
`name` and `type` are what get stored. Anything else — a `Blob`, a
`Uint8Array` — should name the file it is, since a step's failure messages
and the download link are all the name it will ever have.

One request for the whole body, so a file past `MAX_WORKFLOW_UPLOAD_BYTES` is
a 413 rather than a truncation; [UploadOptions.onProgress](#onprogress) draws a bar.
`{ parallel: true }` sends it as concurrent parts instead, which is what a
recording over a long link wants — see [UploadOptions.parallel](#parallel).

###### Parameters

###### file

[`UploadBody`](#uploadbody)

###### options?

[`UploadOptions`](#uploadoptions)

###### Returns

`Promise`\<[`UploadRef`](#uploadref)\>

##### uploadInfo()

```ts
uploadInfo(id: string): Promise<UploadInfo>;
```

Read an upload's record: its name, how much has ARRIVED, and `complete`.

What a page watches a streamed upload with. `complete` is the field to branch
on — a `size` that stopped growing means only that nothing arrived recently,
which a slow link and a dead client both produce.

###### Parameters

###### id

`string`

###### Returns

`Promise`\<[`UploadInfo`](utils.md#uploadinfo)\>

##### uploadStream()

```ts
uploadStream(
   id: string, 
   file: UploadBody, 
options?: UploadOptions): Promise<UploadRef>;
```

Store a file under an id YOU chose, so a run can start before it is all in.

The counterpart of [WorkflowApi.upload](#upload), and the difference is the order
it makes possible: `upload` answers with an id once the last byte is stored, so
a run that needs the id in its input has to wait for the whole upload. Here the
caller already has the id.

`id` must be 1-64 characters of letters, digits, `-` and `_` (a
`crypto.randomUUID()` qualifies) and must not already exist — a second call on
one id is a 409, never an append.

`{ parallel: true }` applies here too, and composes with the ORDER this method
exists for: the run reads the contiguous prefix as the parts fill it in,
exactly as it reads a single streaming `PUT`.

###### Parameters

###### id

`string`

###### file

[`UploadBody`](#uploadbody)

###### options?

[`UploadOptions`](#uploadoptions)

###### Returns

`Promise`\<[`UploadRef`](#uploadref)\>

##### wake()

```ts
wake(runId: string): Promise<number>;
```

End a run's `sleep()` early, resolving how many pending sleeps were
interrupted.

`0` is an answer, not a failure — the run finished, was never sleeping, or is
gone. Same shape as [WorkflowApi.cancel](#cancel) answering false, and for the
same reason: two tabs pressing "send it now" is ordinary.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`number`\>

##### watch()

```ts
watch(runId: string, signal?: AbortSignal): Promise<Response>;
```

Open a server-sent-event stream of one run's state.

Resolves the raw `Response` rather than parsed frames, because what a caller
needs to decide first is whether the agent SERVES this at all — an older
deploy answers 404 and the caller falls back to polling, which is a normal
path rather than an error.

###### Parameters

###### runId

`string`

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`Response`\>

***

### WorkflowApiClientOptions

```ts
type WorkflowApiClientOptions = {
  baseUrl: string;
  timeoutMs?: number;
  token?: string;
};
```

What a client needs to know: which agent, on whose authority, and for how
long.

#### Properties

##### baseUrl

```ts
baseUrl: string;
```

The AGENT's base URL — `https://agents.example/my-agent`, with or without a
trailing slash. [WORKFLOW\_API\_PREFIX](#workflow_api_prefix) is resolved under it, so a
caller never spells the prefix and the three call sites that used to
concatenate it cannot drift.

Required, and deliberately: `location` does not exist in this half of the
SDK, so "the page's own origin" is a browser default and belongs with the
browser client (`createWorkflowApi` in `@alexkroman1/aai-ui`).

##### timeoutMs?

```ts
optional timeoutMs?: number;
```

Per-request deadline, in ms. Absent means none, which is what a page with
its own retry loop wants.

Worth setting for anything a human is waiting on, because **a hung request
is not a failure**: `fetch` carries no timeout of its own, so a request
issued while the platform is restarting or saturated never settles and no
error path, retry, or backoff ever runs. The one thing it must not bound is
the event stream — a healthy SSE connection IS a request that stays open and
says nothing for minutes — so [WorkflowApi.watch](#watch) is exempt, and the
two waiting paths get the run's own `wait` budget added on top rather than
being cut in the middle of a wait the agent agreed to.

##### token?

```ts
optional token?: string;
```

Bearer for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`.

A page served to the public has nothing to put here and should not — it
would be readable in the bundle. This is for a programmatic caller: a
script, a cron job, `aai workflow --token`.

`| undefined` is explicit, and that is the whole point of it: under
`exactOptionalPropertyTypes` — which this repo and the scaffold both set —
`token?: string` REFUSES `token: process.env.AAI_WORKFLOW_API_TOKEN`, which
is the one line every caller writes. Absent and present-and-undefined mean
the same thing here (no bearer), so the type says so rather than making a
reader reach for a `!` or a conditional spread.

## Variables

### WORKFLOW\_API\_PREFIX

```ts
const WORKFLOW_API_PREFIX: "/workflows" = "/workflows";
```

Path prefix every route lives under, relative to the agent's own base URL.

Defined on this side and re-exported by `host/workflow-api.ts` (and so by
`@alexkroman1/aai/runtime`, which is where the server and the `aai dev` proxy
table read it from). One literal for both ends: a client asking for a path the
server does not serve is a 404 that reads as a missing feature, and the dev
proxy getting it wrong is a workflow app that is dead on arrival under
`aai dev` while the backend serves the whole API one port over. It could not
live in `host/` and be shared, because a browser cannot import that half.

## Functions

### createAgentClient()

```ts
function createAgentClient(opts: WorkflowApiClientOptions): AgentClient;
```

Create a client for one agent.

Same options as [createWorkflowApiClient](#createworkflowapiclient) — which agent, on whose
authority, and for how long — and the same advice: hoist it out of anything
that re-runs.

#### Parameters

##### opts

[`WorkflowApiClientOptions`](#workflowapiclientoptions)

#### Returns

[`AgentClient`](#agentclient)

***

### createWorkflowApiClient()

```ts
function createWorkflowApiClient(opts: WorkflowApiClientOptions): WorkflowApi;
```

Create a workflow API client.

Hoist it out of anything that re-runs. In React it belongs at module scope —
`useWorkflowRun` holds the client in a ref precisely so a fresh object per
render does not restart its watch, but a client built in render is still a new
`fetch` closure every time and reads as though it were free.

#### Parameters

##### opts

[`WorkflowApiClientOptions`](#workflowapiclientoptions)

#### Returns

[`WorkflowApi`](#workflowapi)

***

### readEventStream()

```ts
function readEventStream(body: ReadableStream<Uint8Array<ArrayBufferLike>>, signal?: AbortSignal): AsyncGenerator<EventStreamFrame>;
```

Parse an SSE byte stream into frames, with `eventsource-parser`.

The parser is a dependency rather than a hand-rolled line splitter, and the
three edges that decided it are the three a splitter gets wrong:

- Splitting on `"\n\n"` only. The spec permits `\n`, `\r\n` and `\r`, and a
  CRLF stream is `\r\n\r\n` — no two adjacent `\n`, so **not one frame ever
  parsed**, and an intermediary re-terminating lines is not our choice to
  make.
- `line.startsWith("event: ")` requires the space the spec makes optional.
- Keeping only the LAST `data:` line rather than joining a multi-line one.

Three properties of the parser this leans on. `feed` invokes `onEvent`
SYNCHRONOUSLY for every complete event in the chunk, so a batch is collected
per read and yielded in arrival order. An event with no `data:` line at all is
not dispatched (also per spec); every frame these routes emit carries one. And
a chunk ending in a lone `\r` holds that byte back, because it may yet turn
out to be the first half of a `\r\n` — so a CR-ONLY stream chunked per frame
dispatches one frame behind, and its last frame not at all. Nothing emits
CR-only endings, and the outcome if anything did is the safe one for every
reader here: a stream that ends with no final frame is read as a dropped
connection.

`signal` is optional because most callers already own the `fetch` that opened
the body — aborting that ends the read. Pass one when the reader's lifetime is
shorter than the request's.

#### Parameters

##### body

`ReadableStream`\<`Uint8Array`\<`ArrayBufferLike`\>\>

##### signal?

`AbortSignal`

#### Returns

`AsyncGenerator`\<[`EventStreamFrame`](#eventstreamframe)\>

## References

### UploadInfo

Re-exports [UploadInfo](utils.md#uploadinfo)

***

### UploadRange

Re-exports [UploadRange](utils.md#uploadrange)
