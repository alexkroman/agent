# step

`@alexkroman1/aai/step` — the surface a step body is written
against.

**The reader is a `workflows/*.ts` module in an agent project.** Nothing here
is durable on its own: a call becomes a journaled step only when the body puts
it inside `ctx.step(name, fn)`, and outside one it runs inline on every replay
with no journal and no retry. So the loop is: `workflow` on the root DECLARES
the run and types its input, a `workflows/*.ts` module holds the body, this
subpath is what that body is written against, and
`useWorkflowRun` in `@alexkroman1/aai-ui` renders it.

What is here is one reader's whole vocabulary, in the order a pipeline needs
it:

- **Bounded fan-out** — [mapConcurrent](#mapconcurrent), a WINDOW over a cursor so a
  slow item costs only itself. Replay-safe at any width; its own doc carries
  the rule that makes it so.
- **Environment** — [stepEnv](#stepenv) / [requireStepEnv](#requirestepenv). A step body has
  no `ToolContext`, so this is how it reads `agent({ requiredEnv })`.
- **HTTP** — [stepFetch](#stepfetch) (HTTP/1.1-pinned; `fetch` speaks h2 and a
  fan-out on one connection turns a rate limit into an unreadable stream
  reset) and [multipartBody](#multipartbody-1).
- **Narration** — [stepReport](#stepreport) / [stepEmit](#stepemit), what a page's progress
  stream renders.
- **Being woken** — [stepWebhookUrl](#stepwebhookurl), the public callback URL a step
  hands a third party so a delivery resolves the body's `ctx.waitFor` instead
  of the run polling for an answer. The tool-side spelling of the same URL is
  `ctx.workflows.publicWebhookUrl`, which a body and its steps cannot reach.
- **The model** — [stepGenerate](#stepgenerate) (one `fetch` to the LLM gateway on the
  agent's own key, because the AI SDK would be megabytes in a ~7 KB artifact)
  and [stepGenerateJson](#stepgeneratejson) / [stripJsonFence](#stripjsonfence).
- **Audio, both directions** — [stepWriteUpload](#stepwriteupload) / [stepReadUpload](#stepreadupload) /
  [stepUploadInfo](#stepuploadinfo), [stepSpeak](#stepspeak) and [encodeWav](#encodewav) out, and
  [stepTranscribeUpload](#steptranscribeupload) / [stepTranscribeSubmit](#steptranscribesubmit) /
  [stepTranscribePoll](#steptranscribepoll) for the async job API or
  [stepTranscribeSync](#steptranscribesync) for the one-request one, back in.
- **Retry classification** — [isTransientStatus](#istransientstatus) / [retryAfter](#retryafter-2),
  for a body deciding whether a failure is worth another round, and
  [stepInfo](#stepinfo-1), which says which ATTEMPT this is and whether it is the
  last. That is what lets a step degrade rather than fail — a smaller model on
  the final try beats a failed run — and it is the DevKit's `getStepMetadata()`
  with the two differences its own module doc gives.

The zod-free budget still applies here and is now a property of BOTH
subpaths rather than the reason one of them exists: a `workflows/*.ts` module
is bundled separately, so the root barrel's graph would ride into the step
bundle. That is also why `stepSpeak` carries the SLOT and the WAV framing
rather than a synthesizer, the same split [stepFetch](#stepfetch) makes with its
undici dispatcher.

Two neighbours that are deliberately elsewhere. The failure a body THROWS
(`toStepError` / `throwStepError` / `throwFatalStepError`, and the
`FatalError` / `RetryableError` they resolve to) is on
`@alexkroman1/aai/step-errors`, so that importing a classifier is an opt-in
rather than something every `/step` reader pays for. And the durable wait is
`ctx.sleep` on the `WorkflowContext` the engine hands the body — this SDK
owns what is INSIDE a step and never the steps.

## Functions

### encodeWav()

```ts
function encodeWav(samples: 
  | Uint8Array<ArrayBufferLike>
| readonly Uint8Array<ArrayBufferLike>[], format: PcmFormat): Uint8Array<ArrayBuffer>;
```

Wrap raw linear-PCM samples in a WAV container.

#### Parameters

##### samples

  \| `Uint8Array`\<`ArrayBufferLike`\>
  \| readonly `Uint8Array`\<`ArrayBufferLike`\>[]

The PCM bytes, little-endian and channel-interleaved. A
  LIST is joined in order, which is what a synthesizer's or a capture's
  frames arrive as.

##### format

[`PcmFormat`](#pcmformat)

How to read them. See [PcmFormat](#pcmformat) for the two defaults.

#### Returns

`Uint8Array`\<`ArrayBuffer`\>

A complete `.wav` file: [WAV\_HEADER\_BYTES](#wav_header_bytes) of header followed
  by `samples` unchanged.

#### Throws

for a format no header can describe — a non-integer or
  non-positive rate or channel count, or a bit depth that is not a positive
  multiple of 8.

***

### isTransientStatus()

```ts
function isTransientStatus(status: number): boolean;
```

Will another attempt plausibly answer differently?

`408` counts because it is the far side saying "too slow", not "no"; `429` and
every `5xx` are the ordinary transient pair. Everything else — a 400, a 401, a
404 — answers the same way on the fourth attempt, and retrying it spends the
step's whole budget to arrive at the same failure several seconds later.

#### Parameters

##### status

`number`

#### Returns

`boolean`

***

### mapConcurrent()

```ts
function mapConcurrent<T, R>(
   items: readonly T[], 
   width: number, 
   run: (item: T, index: number) => R | Promise<R>
): Promise<R[]>;
```

Map `items` through `run`, at most `width` at a time, in a replay-safe order.

Results come back in ITEM order however the individual calls settle, so it
substitutes directly for `Promise.all(items.map(run))` where a bound is
needed.

A rejection stops the window taking new items and then propagates once the
calls already in flight have SETTLED — not the instant it happens. That order
is what a workflow body wants: every sibling that finished is journaled, so a
resume replays it for free and re-issues only what is missing, where throwing
immediately would discard siblings that were mid-call and have the resume pay
for them a second time. Catching per item to salvage a partial result is a
decision only the caller can make — do it inside `run`.

#### Type Parameters

##### T

`T`

##### R

`R`

#### Parameters

##### items

readonly `T`[]

What to map. An empty list runs nothing and resolves `[]`.

##### width

`number`

Most calls in flight at once. Rounded down, and floored at 1.
  A width of zero would otherwise start no slot at all — a hang, not an error,
  and a hang inside a workflow body is a run that never completes. A
  non-finite width is worse and needs the same floor for a different reason:
  `Math.min(NaN, n)` is `NaN`, so `Array.from({ length: NaN })` is empty and
  the map silently does NOTHING, which reads as an empty input.

##### run

(`item`: `T`, `index`: `number`) => `R` \| `Promise`\<`R`\>

Called once per item, with the item and its index in `items`.
  Inside a workflow body this is where a `ctx.step` call goes, and **it must
  be the only one, issued synchronously** — a callback that awaits before its
  step call, or issues two in a row, interleaves with its siblings by
  completion order and a resume hands the Nth journal entry to a different
  call. A body needing two steps per item runs them as two fan-outs. The
  module doc above carries why, and why the window itself needs no barrier.

#### Returns

`Promise`\<`R`[]\>

#### Example

```ts no-check
// In a workflow body: one step per segment, four in flight.
const cleaned = await mapConcurrent(segments, 4, (text) => postProcess(text));
```

***

### multipartBody()

```ts
function multipartBody(...parts: readonly MultipartPart[]): MultipartBody;
```

Encode `multipart/form-data` as BYTES.

The reason this exists rather than `new FormData()`: a `FormData` is a branded
object, and handing one to a `fetch` from a different undici than your realm's
global silently sends the string `[object FormData]` — see
[StepFetchInit](#stepfetchinit). Bytes cannot be got wrong that way, and a step's
multipart body is always one or two known parts rather than a form somebody
filled in.

The boundary is generated per call and is not derived from the content, so a
body containing the boundary token is astronomically unlikely rather than
impossible; endpoints behave the same way.

**A part's `name` and `filename` are ESCAPED, because they are the one thing
here that is routinely not the author's own string.** An upload's `name` is
"the filename the uploader gave" (`stepUploadInfo`), so it reaches a step from a
browser form and lands in a header this function writes — and a `"`, a CR or
an LF in it closed the quoted string and appended headers of the caller's
choosing to the request. The escaping is the HTML form-encoding algorithm's,
which is what the `FormData` this replaces would have applied: `"` becomes
`%22`, CR `%0D`, LF `%0A`.

#### Parameters

##### parts

...readonly [`MultipartPart`](#multipartpart)[]

#### Returns

[`MultipartBody`](#multipartbody)

***

### pcmDurationMs()

```ts
function pcmDurationMs(byteLength: number, format: PcmFormat): number;
```

How long a run of PCM samples lasts, in milliseconds.

Beside the encoder because it divides by the same derived `blockAlign` the
header states, and a duration computed from a different one is how a
progress bar and a file disagree. Rounded, since a caller reporting
milliseconds has no use for the fraction.

It takes a LENGTH where its neighbours take bytes, so a `Uint8Array` handed
to it is refused rather than divided: `bytes / blockAlign` is `NaN`, and a
`NaN` duration is journaled by a step, rendered into a progress bar and
reported to a caller without anything on the way saying which call produced
it. That is the one misuse this signature invites — `encodeWav`, `stepSpeak`
and `stepReadUpload` all deal in the bytes themselves. [wavHeader](#wavheader) is the
other function here taking a count, and shares this check for that reason.

#### Parameters

##### byteLength

`number`

##### format

[`PcmFormat`](#pcmformat)

#### Returns

`number`

#### Throws

for a format no header can describe — the same check
  [encodeWav](#encodewav) makes, so the two cannot disagree about what is legal —
  or for a `byteLength` that is not a length.

***

### requireStepEnv()

```ts
function requireStepEnv(name: string): string;
```

[stepEnv](#stepenv), failing by name when the key is not set.

The failure a step wants for a credential: an absent key is not transient, so
it should say which key and how to set it rather than surface three layers
down as an HTTP 401 the engine then retries.

It throws a plain `Error` rather than a `FatalError` on purpose — that class
is `/step-errors`' and this module must stay importable from a tool body and a
spec, neither of which has a workflow around it. A step that wants the retries
skipped wraps the call:

```ts no-check
try {
  key = requireStepEnv("ASSEMBLYAI_API_KEY");
} catch (err) {
  throw new FatalError(errorMessage(err));
}
```

#### Parameters

##### name

`string`

#### Returns

`string`

***

### retryAfter()

```ts
function retryAfter(from: 
  | {
  headers: Headers;
}
  | Headers): Date | undefined;
```

When the far side asked to be called back, as a `Date`.

Reads `Retry-After` in both spellings RFC 9110 allows — delta-seconds
(`Retry-After: 30`) and an HTTP date (`Retry-After: Wed, 21 Oct 2026 07:28:00
GMT`) — and answers `undefined` for a header that is absent, unparsable, or in
the past. `undefined` is what a caller wants there: it means "you decide",
which is the engine's own default delay, rather than a date that would retry
instantly or never.

#### Parameters

##### from

  \| \{
  `headers`: `Headers`;
\}
  \| `Headers`

A `Response`, or its headers. Both spellings are accepted
  because a caller holding only the headers should not have to fake a
  response to ask.

#### Returns

`Date` \| `undefined`

***

### stepEmit()

```ts
function stepEmit<T>(namespace: string, chunk: T): Promise<void>;
```

Write one structured chunk into a NAMED stream of this run.

The other half of [stepReport](#stepreport), and the split is what each is FOR:
`stepReport` writes a sentence for a person, into the run's default stream and
the server log. This writes a VALUE for a program — a partial result, as the step produces
it — into a stream a reader asks for by name.

That is what makes a long run's output streamable rather than only its
narration. A run's snapshot carries a status and, once terminal, an output, so
a fan-out that has transcribed forty of sixty segments has forty results and no
way to hand any of them over. Emitting each one as it lands means a page renders
the answer growing instead of a spinner:

```ts no-check
import { stepEmit } from "@alexkroman1/aai/step";

export async function transcribeSegment(index: number) {
  const text = await transcribe(index);
  await stepEmit("transcript", { index, text });
  return { index, text };
}
```

```tsx no-check
// The reader, which the SDK already had: one stream per namespace.
const { progress } = useWorkflowProgress<{ index: number; text: string }>(runId, {
  namespace: "transcript",
});
```

**The namespace is REQUIRED, and that is the point of the argument.** The
default stream is `stepReport()`'s, carrying lines a page renders verbatim —
an object written into it comes back as `[object Object]` in the middle of the
progress log, which is a trap rather than a decision. A named stream is also
how a reader gets ONE kind of chunk per subscription, so
`useWorkflowProgress<T>` can be typed at all.

**Call it from a STEP, never from the workflow body**, for the reason `stepReport`
says: a body replays from the top on every resume, so a chunk written there is
re-emitted on each one.

Chunks are RETAINED with the run, so a reader that arrives late or reloads gets
the whole stream from the beginning rather than only what arrives next.

Failures are swallowed, exactly as `stepReport`'s are: a run must not fail
because a reader could not be told about a result the run itself has.

#### Type Parameters

##### T

`T`

#### Parameters

##### namespace

`string`

Which of the run's streams this belongs in. A short,
  stable name — a reader subscribes by it.

##### chunk

`T`

The value, which must survive the run's own serialization.

#### Returns

`Promise`\<`void`\>

***

### stepEnv()

```ts
function stepEnv(name: string): string | undefined;
```

Read one key of the agent's env from inside a step.

#### Parameters

##### name

`string`

The env key, as declared in `.env` or set with
  `aai secret put`. Listing it in `agent({ requiredEnv })` is what makes a
  deploy check it is there.

#### Returns

`string` \| `undefined`

The value, or `undefined` when the agent env does not declare it.

#### Example

```ts
import { stepEnv } from "@alexkroman1/aai/step";

export async function fetchReport(id: string): Promise<string> {
  const base = stepEnv("REPORT_BASE_URL") ?? "https://reports.example.com";
  return await (await fetch(`${base}/${id}`)).text();
}
```

***

### stepFetch()

```ts
function stepFetch(url: string, init?: StepFetchInit): Promise<Response>;
```

Make one HTTP request from inside a step.

Prefer this to `fetch` in any step, and especially in a
fan-out: it pins HTTP/1.1 (so a concurrent batch gets a socket each rather
than N streams on one connection), reuses connections across a fan-out's
calls, and reports a connection failure with its whole `cause` chain instead
of a bare `TypeError: fetch failed`.

#### Parameters

##### url

`string`

##### init?

[`StepFetchInit`](#stepfetchinit)

#### Returns

`Promise`\<`Response`\>

#### Remarks

**`globalThis.fetch` speaks HTTP/2 now, and a fan-out is the worst case for
that.** undici 8 — the copy backing it from Node 26 — defaults `allowH2` to
true, so every concurrent request from one process is multiplexed onto ONE TCP
connection sharing one flow-control window. Measured against AssemblyAI's sync
transcription endpoint, 8 concurrent 17.66 MB uploads, same bytes and key, one
minute apart:

| transport | landed | p50 | throughput |
| --- | --- | --- | --- |
| `globalThis.fetch` (h2) | 14/16 | 8094ms | 20.8 MB/s |
| HTTP/1.1 | 16/16 | 3719ms | 29.9 MB/s |
| HTTP/1.1, keep-alive pool | 16/16 | 3037ms | 38.6 MB/s |

**The two lost requests matter more than the 2.7x.** On HTTP/2 a capacity
limit arrives as a stream reset, and a stream error carries no HTTP status —
so neither [isTransientStatus](#istransientstatus) nor [retryAfter](#retryafter-2) can see it, every
sibling in a bounded fan-out retries in lockstep into the same reset, and the
run dies on `TypeError: fetch failed` with its real cause two `cause` hops
down. Over HTTP/1.1 the identical limit arrives as a `503` or `429` carrying
`retry-after`, which those helpers already read. Verified end to end: the same
65-segment run that failed on `fetch` completes on HTTP/1.1 at every
concurrency up to 48, and at 64 pays 20 retried `503`s instead of dying.

#### Throws

when the request never got an answer — a reset
  connection, a DNS failure, a timeout. Distinct from a response with a bad
  status, which is returned like any other: only the caller knows whether a
  `404` is fatal.

**From a step, prefer `stepFetchOrFail`
(`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
error a step throws, and raw every failure looks alike to it — a bad API key is
retried until the attempts run out. It also turns a non-2xx into a throw, which `stepFetch` deliberately does not.

***

### stepGenerate()

```ts
function stepGenerate(prompt: string, options?: StepGenerateOptions): Promise<string>;
```

Ask the AssemblyAI LLM Gateway one question and return its reply.

**From a step, prefer `stepGenerateOrFail` (`@alexkroman1/aai/step-errors`).**
It is this call plus `throwStepError`, and the engine decides its retry policy
from WHICH error a step throws: raw, a terminal failure burns every remaining
attempt and a rate limit backs off for one second while the delay the far side
named sits unread. Reach for the raw call where the failure is not simply a
failure — a `404` that means "already deleted".

#### Parameters

##### prompt

`string`

The user message.

##### options?

[`StepGenerateOptions`](#stepgenerateoptions)

#### Returns

`Promise`\<`string`\>

The reply, trimmed. Never empty — a 200 carrying no content is a
  [StepGenerateError](#stepgenerateerror) with `retryable: true`, because it is a real and
  transient thing a gateway does and a step returning `""` would file a blank
  report and report success.

#### Example

```ts
import { stepGenerate, StepGenerateError } from "@alexkroman1/aai/step";
import { FatalError } from "@alexkroman1/aai/step-errors";

export async function summarize(text: string): Promise<string> {
  try {
    return await stepGenerate(text, { system: "Summarize in two sentences." });
  } catch (err) {
    if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
    throw err;
  }
}
```

#### Throws

On EVERY failure of this call, which is the point
  of the class: a non-2xx, an empty completion, a reply that is not JSON, a
  request that never got an answer (a reset, a DNS failure, this call's own
  deadline), and a missing API key. Only the last is `retryable: false` —
  three more attempts find the same gap.

***

### stepGenerateJson()

```ts
function stepGenerateJson<S extends StandardSchemaV1<unknown, unknown>>(prompt: string, options: StepGenerateJsonOptions<S>): Promise<InferSchemaOutput<S>>;
```

Ask the model for JSON and return it validated.

The reply is unfenced, parsed, and checked against `schema`; the validated
value is what comes back, typed as the schema's output.

**From a step, prefer `stepGenerateJsonOrFail` (`@alexkroman1/aai/step-errors`).**
It is this call plus `throwStepError`, and the engine decides its retry policy
from WHICH error a step throws: raw, a terminal failure burns every remaining
attempt and a rate limit backs off for one second while the delay the far side
named sits unread. Reach for the raw call where the failure is not simply a
failure — a `404` that means "already deleted".

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\>

#### Parameters

##### prompt

`string`

The user message. The SHAPE belongs in `system` — this says
  nothing about JSON on the caller's behalf, because the wording that gets a
  model to comply is part of the prompt a template is demonstrating.

##### options

[`StepGenerateJsonOptions`](#stepgeneratejsonoptions)\<`S`\>

#### Returns

`Promise`\<[`InferSchemaOutput`](index.md#inferschemaoutput)\<`S`\>\>

The validated reply.

#### Throws

A plain error — retryable by the engine's default, which is
  the point — when the reply is not JSON, is not an object, or does not
  satisfy `schema`. All three are things a model may get right next time.

#### Throws

On any gateway
  failure, exactly as [stepGenerate](#stepgenerate) does. Classify it with
  `toStepError` from `@alexkroman1/aai/step-errors`.

#### Example

```ts
import { stepGenerateJson } from "@alexkroman1/aai/step";
import { z } from "zod";

const Digest = z.object({ headline: z.string(), points: z.array(z.string()) });

export async function summarize(article: string): Promise<{ headline: string }> {
  return await stepGenerateJson(article, {
    schema: Digest,
    system: 'Reply with JSON only: {"headline": string, "points": string[]}.',
  });
}
```

***

### stepInfo()

```ts
function stepInfo(): StepInfo | undefined;
```

Which step this code is running inside, or `undefined` when it is not in one.

`undefined` is ORDINARY and is not an error: a workflow BODY is not a step, a
tool is not a step, and a spec calling an exported step directly has no run at
all. A body that branches on the attempt should read the `undefined` case as
"not retrying", which is what a spec wants and what a first attempt would have
said anyway.

**Read it once, at the top.** The value is a snapshot of the attempt in
flight, so calling it again after an `await` inside the same step answers the
same thing — but a helper that reads it per call is asking a question whose
answer cannot change and reads as though it could.

#### Returns

[`StepInfo`](#stepinfo) \| `undefined`

***

### stepReadUpload()

```ts
function stepReadUpload(id: string, options?: ReadUploadOptions): Promise<UploadSlice>;
```

Read a window of an uploaded file.

Omitting both bounds reads the whole file, which is the right call only when
the file is small: everything else names the window it needs, so a fan-out
over a large file moves each byte once.

Bounds are CLAMPED rather than rejected — a plan computed from a file's own
header can legitimately end one byte past it, and the returned `start`/`end`
say what was actually read. That is also exactly what makes a STREAMED upload
readable: the clamp is to what has ARRIVED, so a window that runs past the
bytes stored so far comes back short rather than failing, and `end` is how a
caller learns which it got.

#### Parameters

##### id

`string`

##### options?

[`ReadUploadOptions`](#readuploadoptions)

#### Returns

`Promise`\<[`UploadSlice`](#uploadslice)\>

#### Example

Write in one step, read a window back in another — an id crosses the journal,
bytes never do.
```ts
import { stepReadUpload, stepWriteUpload } from "@alexkroman1/aai/step";

export async function store(bytes: Uint8Array): Promise<string> {
  const { id } = await stepWriteUpload(bytes, { name: "summary.wav" });
  return id;
}

export async function firstSecond(uploadId: string): Promise<Uint8Array> {
  const { bytes } = await stepReadUpload(uploadId, { start: 44, end: 44 + 32_000 });
  return bytes;
}
```

***

### stepReport()

```ts
function stepReport(line: string): Promise<void>;
```

Write one progress line for the run this step belongs to.

The line reaches two readers: the run's own output stream, which
`GET /workflows/runs/:id/stream` serves and `useWorkflowProgress` in
`@alexkroman1/aai-ui` renders,
and the server log, so an operator watching a deploy can see which step is
running without a page open.

**Call it from a STEP, never from the workflow body.** A body replays from the
top on every resume, so a line written there is re-emitted on each one — the
same rule `ctx.db` follows.

Failures are swallowed: narration must never fail a run. It resolves either
way, so awaiting it is safe and is what keeps the ordering of a step's own
lines.

#### Parameters

##### line

`string`

One line of progress, as a reader should see it. Prefer a
  sentence naming what is happening and to what (`"Transcribing 0:00–0:58."`)
  over a machine token — the page renders these verbatim.

#### Returns

`Promise`\<`void`\>

***

### stepRequireCompleteUpload()

```ts
function stepRequireCompleteUpload(id: string): Promise<UploadInfo>;
```

One upload's metadata, refused unless every byte is in.

The read for a step that consumes a file END TO END — an upload to a provider,
a copy to local disk, a length a segment plan is computed from. A step that
works on a WINDOW wants [stepUploadInfo](#stepuploadinfo) and clamping, which is what
`stepReadUpload` already does.

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`UploadInfo`](#uploadinfo)\>

#### Example

```ts
import { stepRequireCompleteUpload } from "@alexkroman1/aai/step";

export async function wholeFileSize(uploadId: string): Promise<number> {
  const stored = await stepRequireCompleteUpload(uploadId);
  return stored.size;
}
```

#### Throws

when the upload is still arriving — see this
  module's doc for why that is a refusal rather than a wait.

#### Throws

when the id names no upload, exactly as [stepUploadInfo](#stepuploadinfo) does.

***

### stepSpeak()

```ts
function stepSpeak(text: string, options?: SpeakOptions): Promise<SpokenAudio>;
```

Speak `text`, and answer with the whole utterance as a WAV.

#### Parameters

##### text

`string`

What to say. Refused when it is blank: a synthesizer answers
  an empty request with an empty file, which is a zero-length audio element
  on somebody's page rather than an error, and no retry finds the missing
  words.

##### options?

[`SpeakOptions`](#speakoptions)

#### Returns

`Promise`\<[`SpokenAudio`](#spokenaudio)\>

#### Throws

when no synthesizer is published — the message names both
  causes (a process serving no agent, and a spec calling the step directly).

#### Throws

when the credential named by `apiKeyEnv` is not in the
  agent's env, which `requireStepEnv` reports by name.

#### Example

Speak and STORE in one step, and return the id. A step is journaled by what
it returns, so an id is replayed on a resume and bytes are not — splitting
this in two would carry the audio across the queue on every resume.
```ts
import { stepSpeak, stepWriteUpload } from "@alexkroman1/aai/step";

export async function narrate(summary: string): Promise<string> {
  const spoken = await stepSpeak(summary, { voice: "jane" });
  const stored = await stepWriteUpload(spoken.audio, {
    name: "summary.wav",
    type: "audio/wav",
  });
  return stored.id;
}
```

***

### stepTranscribePoll()

```ts
function stepTranscribePoll(transcriptId: string, options?: TranscribeRequestOptions): Promise<TranscribeProgress>;
```

Ask once whether a job has finished, and read it when it has.

#### Parameters

##### transcriptId

`string`

##### options?

[`TranscribeRequestOptions`](#transcriberequestoptions)

#### Returns

`Promise`\<[`TranscribeProgress`](#transcribeprogress)\>

#### Remarks

**Polling READS, so there is no separate read.** Both templates this replaced
polled `GET /v2/transcript/:id` for a status and then fetched the identical
URL again for the text — the completed poll had the transcript in its hand and
threw it away. This answers with it, so a finished job costs one round trip
rather than two and the value journaled by the last poll IS the transcript.

The provider's vocabulary stays inside: branch on `done`, never on a status
string, so a new status the service invents cannot read as "not finished yet"
forever.

#### Throws

, NOT retryable, when the provider failed the job or
  transcribed no words at all. A recording of silence succeeds and answers
  with an empty string, which is the failure this flow is most likely to meet
  and the one that reads least like a failure: everything downstream would
  otherwise be handed no words and asked to work anyway.

**From a step, prefer `stepTranscribePollOrFail`
(`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
error a step throws, and raw every failure looks alike to it — a bad API key is
retried until the attempts run out.

***

### stepTranscribeSubmit()

```ts
function stepTranscribeSubmit(audioUrl: string, options?: TranscribeSubmitOptions): Promise<{
  id: string;
}>;
```

Create the transcription job, and answer with the id that outlives this run.

#### Parameters

##### audioUrl

`string`

What to transcribe. [stepTranscribeUpload](#steptranscribeupload)'s answer,
  or any URL the service can reach — a recording already sitting in a bucket
  never needs to pass through this process at all.

##### options?

[`TranscribeSubmitOptions`](#transcribesubmitoptions)

#### Returns

`Promise`\<\{
  `id`: `string`;
\}\>

#### Throws

on a refusal, or when the API creates no id.

#### Remarks

**This trio is for a recording of arbitrary length; [stepTranscribeSync](#steptranscribesync)
is for one that fits in a single request.** That endpoint answers with the
words in the response and pays for it with a hard 120-second, 40 MB ceiling.
Under the ceiling it is one round trip against these three steps plus a
polling loop; over it, the job API is the only thing that works. Choosing
between them is the one decision this subpath forces, and it is decided by
what the audio IS rather than by anything either function can see.

#### Example

The whole job, as three steps and a durable wait. The submit is journaled, so
a resumed run polls the same job rather than paying for a second one.
```ts
import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
} from "@alexkroman1/aai/step";

export async function startJob(uploadId: string): Promise<string> {
  const { audioUrl } = await stepTranscribeUpload(uploadId);
  const { id } = await stepTranscribeSubmit(audioUrl);
  return id;
}

export async function checkJob(id: string): Promise<string | undefined> {
  const progress = await stepTranscribePoll(id);
  // Branch on `done`, never on a provider status string.
  return progress.done ? progress.transcript.text : undefined;
}
```

**From a step, prefer `stepTranscribeSubmitOrFail`
(`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
error a step throws, and raw every failure looks alike to it — a bad API key is
retried until the attempts run out.

***

### stepTranscribeSync()

```ts
function stepTranscribeSync(bytes: 
  | Uint8Array<ArrayBufferLike>
  | readonly Uint8Array<ArrayBufferLike>[], options?: TranscribeSyncOptions): Promise<{
  text: string;
}>;
```

Transcribe one complete audio file.

**From a step, prefer `stepTranscribeSyncOrFail` (`@alexkroman1/aai/step-errors`).**
It is this call plus `throwStepError`, and the engine decides its retry policy
from WHICH error a step throws: raw, a terminal failure burns every remaining
attempt and a rate limit backs off for one second while the delay the far side
named sits unread. Reach for the raw call where the failure is not simply a
failure — a `404` that means "already deleted".

#### Parameters

##### bytes

  \| `Uint8Array`\<`ArrayBufferLike`\>
  \| readonly `Uint8Array`\<`ArrayBufferLike`\>[]

A whole file, header included. The endpoint decodes each
  request independently, so a headerless tail is bytes it will refuse. A LIST
  is still a whole file — the same bytes in the same order, just not
  contiguous in memory — which is what lets a caller cutting a WAV hand over
  `[wavHeader(format, window.byteLength), window]` rather than joining the two
  into a buffer this function would then copy into the body a second time.

##### options?

[`TranscribeSyncOptions`](#transcribesyncoptions)

#### Returns

`Promise`\<\{
  `text`: `string`;
\}\>

The text, trimmed. An EMPTY string is a legitimate answer here and
  is not refused, unlike the async API's: a caller fanning out over segments
  routinely gets silent ones, and a throw would fail the whole recording over
  a pause in it. A caller transcribing exactly one clip should check for it.

#### Throws

on a refusal, carrying the verdict `toStepError`
  reads — which matters most here, because a fan-out hits a rate limit all at
  once and `retryAfter` is what makes the batch drain instead of colliding a
  second later.

#### Remarks

**The ceiling is the whole decision: 120 seconds and 40 MB per request**, both
enforced by the service. Under it, this is one round trip against
[stepTranscribeUpload](#steptranscribeupload)/[stepTranscribeSubmit](#steptranscribesubmit)/[stepTranscribePoll](#steptranscribepoll)'s three steps and a polling loop — no job id, nothing to
journal between phases, no wait to make durable. Over it, the audio has to be
CUT into segments and fanned out, which is a subject of its own: where to cut
so a word is not split, how to re-attach a header to each piece, how wide to
run the fan-out, and how to stitch the results back together. So reach for
this when one request is enough and for the async trio when it is not; the cut
is not a decision this function can make, because it depends on what the audio
IS.

**Whole files only.** A caller cutting a WAV re-attaches a header to every
window — [encodeWav](#encodewav) is the 44 bytes, or [wavHeader](#wavheader) and the
window as two chunks — and a caller handed complete files (parts of a
multi-file upload, [stepSpeak](#stepspeak)'s output) passes them through untouched.

#### Example

One clip, one request. Compare [stepTranscribeSubmit](#steptranscribesubmit) for a recording
that cannot fit in one.
```ts
import { stepReadUpload, stepTranscribeSync } from "@alexkroman1/aai/step";

export async function transcribeClip(uploadId: string): Promise<string> {
  const clip = await stepReadUpload(uploadId);
  const { text } = await stepTranscribeSync(clip.bytes);
  return text;
}
```

***

### stepTranscribeUpload()

```ts
function stepTranscribeUpload(uploadId: string, options?: TranscribeRequestOptions): Promise<{
  audioUrl: string;
}>;
```

Send a stored upload to the provider, and answer with the URL it gave.

The recording STREAMS out of the app's own store: `stepReadUpload` hands back
bytes and a two-hour recording is not a value this process can hold, so the
body is an async iterable of windows — which `stepFetch` accepts precisely
for this. Nothing is buffered beyond one window, and one window of READ-AHEAD
keeps the store and the socket busy at the same time.

**The upload has to be FINISHED, and that is checked rather than assumed.**
`UploadInfo.size` is the contiguous readable prefix, so reading it off a
still-arriving recording used to upload only what had landed and transcribe a
truncated file — a plausible wrong answer with no error anywhere.
`stepRequireCompleteUpload` refuses instead, BEFORE the expensive leg; its module
doc carries why that is a refusal rather than a wait.

#### Parameters

##### uploadId

`string`

An upload in the agent's own store, as `stepWriteUpload` or a
  page's `api.upload(file)` produced. Must be complete.

##### options?

[`TranscribeRequestOptions`](#transcriberequestoptions)

#### Returns

`Promise`\<\{
  `audioUrl`: `string`;
\}\>

#### Throws

when the upload is still arriving.

#### Throws

on a refusal, carrying the verdict `toStepError`
  reads. Give this step extra retries: it is the one call here worth another
  attempt, and the only one whose cost is the file.

**From a step, prefer `stepTranscribeUploadOrFail`
(`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
error a step throws, and raw every failure looks alike to it — a bad API key is
retried until the attempts run out.

***

### stepUploadInfo()

```ts
function stepUploadInfo(id: string): Promise<UploadInfo>;
```

Read one upload's metadata: its name, what has ARRIVED, and whether that is all
of it.

The poll a body waiting on a streamed upload runs.

**`complete` is the field to branch on, never `size`.** A size that stopped
growing means "nothing arrived recently", which is what a slow link and a dead
client both look like; only `complete` says the file is all there. A body that
treated a stalled size as the end would return a transcript of most of a
recording and report success.

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`UploadInfo`](#uploadinfo)\>

#### Throws

when the id names no upload — a step that reaches for one and finds
  nothing has been handed a stale or invented id, which no retry fixes. Note a
  streamed upload EXISTS from its first byte, so this answers for one that is
  still arriving.

***

### stepWebhookUrl()

```ts
function stepWebhookUrl(token: string): string;
```

The public URL a third party POSTs to in order to resolve `ctx.waitFor(token)`
for the run this step belongs to.

The same URL `ctx.workflows.publicWebhookUrl(token)` mints for a tool, reached
from a step — which is what lets a `workflowApp()` with no tools hand a
provider a callback instead of polling it. Hand it out in the step that
submits the work, so the far side is told about the waitpoint before the body
parks on it.

**One `waitFor` park per token per run, with a poll as the backstop.** A
token can be claimed at most ONCE per run — a second claim under a different
occurrence key THROWS, and the token is only released when the run goes
terminal (`onRunSettled` in `aai-runtime/workflow-journal-memory.ts`, whose
comment records a template bitten by exactly this: a derived token served one
run, the second claim conflicted, the conflict is not a suspend, and the saga
compensated a transcript away). So this belongs in a submit-then-park shape,
never a `waitFor` inside a loop — and because a delivery can be lost, missed
or never sent, the reconciling backstop is a `waitFor(token, { timeoutMs })`
whose `undefined` sends the body to poll the provider once. The callback is
what makes the common case fast; the poll is what makes it correct.

**Under `aai dev` this throws, and even where a local origin IS configured it
is not reachable from the internet.** A public URL is a property of a
deployment: the platform bakes it into the guest's exec env, a self-hosted
server passes `publicUrl`. A laptop has none, so a real third-party callback
cannot be exercised locally — drive that path against a deployed agent, or
point a tunnel at the dev server's BACKEND port (the Vite port a developer
opens does not proxy `/.well-known/`) and set `PUBLIC_URL` to the tunnel. A
spec drives it by publishing a minter of its own.

#### Parameters

##### token

`string`

The waitpoint's token, exactly as the body passes it to
  `ctx.waitFor`. Derived from the run's input, never random.

#### Returns

`string`

The absolute URL, encoded for the route's single token segment.

#### Example

Submit the work and hand the callback over in the same step, so the far side
is told about the waitpoint before the body parks on it.
```ts
import { stepReport, stepFetch, stepWebhookUrl } from "@alexkroman1/aai/step";

// The token is DERIVED from the run's own input, so the step handing the URL
// out and the body parking on it agree — the rule `ctx.waitFor` states.
export const renderToken = (id: string) => `render:${id}`;

export async function submitRender(id: string): Promise<void> {
  await stepReport(`Submitting render ${id}.`);
  await stepFetch("https://renders.example.com/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, callbackUrl: stepWebhookUrl(renderToken(id)) }),
  });
}
```

#### Throws

when this process cannot mint one — the message names the
  configuration and says what `aai dev` can and cannot do.

#### Throws

when `token` is empty: that composes to the route's own
  prefix, which the parser refuses, so the failure would otherwise arrive at
  the far end as a 404 on a URL nobody can re-issue.

***

### stepWriteUpload()

```ts
function stepWriteUpload(bytes: 
  | Uint8Array<ArrayBufferLike>
  | readonly Uint8Array<ArrayBufferLike>[]
| AsyncIterable<Uint8Array<ArrayBufferLike>, any, any>, options?: WriteUploadOptions): Promise<UploadInfo>;
```

Store a file a step PRODUCED, and answer with the record naming it.

The other direction of [stepReadUpload](#stepreadupload), and the half a workflow app needs
the moment its output is not text. A run's output is journaled and read back
as JSON, so audio, an image or a PDF cannot travel in one — the same rule
that keeps a recording's bytes out of a run's INPUT, arriving at the other
end of the run. So the bytes go to the store and the output carries the id,
which a page turns back into a file with `api.download(id)`.

```ts
import { stepSpeak, stepWriteUpload } from "@alexkroman1/aai/step";

export async function narrate(summary: string) {
  const spoken = await stepSpeak(summary);
  const stored = await stepWriteUpload(spoken.audio, { name: "summary.wav", type: "audio/wav" });
  return { audio: stored.id, durationMs: spoken.durationMs };
}
```

**Write it in the step that MAKES it, and return the id.** A step is
journaled by what it returns, so an id is replayed and bytes are not: a
resumed run re-reads the same file rather than re-synthesizing it. The
corollary is that a RETRIED step writes a second upload and abandons the
first, which is the cost of the store having no way to know two calls meant
one file — worth knowing, and cheap next to the alternative of a step that
cannot retry at all.

#### Parameters

##### bytes

  \| `Uint8Array`\<`ArrayBufferLike`\>
  \| readonly `Uint8Array`\<`ArrayBufferLike`\>[]
  \| `AsyncIterable`\<`Uint8Array`\<`ArrayBufferLike`\>, `any`, `any`\>

The file. A LIST is stored in order and an async iterable is
  streamed, so a step producing something large — a long recording, a
  concatenation of many utterances — never has to hold it whole.

##### options?

[`WriteUploadOptions`](#writeuploadoptions)

What to declare about it. Both fields are stored verbatim and
  neither is inferred; see [WriteUploadOptions](#writeuploadoptions).

#### Returns

`Promise`\<[`UploadInfo`](#uploadinfo)\>

#### Throws

when the process published no store, or published a READ-ONLY one —
  two different sentences, because the remedies differ and the call site
  cannot tell them apart. Also when the deployment has nowhere durable to put
  bytes at all, which the store reports by naming the variable that is
  missing.

***

### stripJsonFence()

```ts
function stripJsonFence(reply: string): string;
```

Unwrap a ```` ```json ```` fence, which models add however firmly they are
told not to.

Refusing one would cost a whole retry for a reply that was otherwise correct.
Text that carries no fence is returned trimmed and otherwise untouched.

#### Parameters

##### reply

`string`

#### Returns

`string`

***

### wavHeader()

```ts
function wavHeader(format: PcmFormat, byteLength: number): Uint8Array<ArrayBuffer>;
```

The WAV header for a payload of `byteLength` bytes, and nothing else.

For a caller handing the header and the samples to something that takes a
LIST — [multipartBody](#multipartbody-1), a stream — where [encodeWav](#encodewav)'s joined
buffer would be a second full copy of the audio held at the same time. Two
chunks are the same bytes in the same order on the wire.

#### Parameters

##### format

[`PcmFormat`](#pcmformat)

How to read the samples the header will sit in front of. See
  [PcmFormat](#pcmformat) for the two defaults.

##### byteLength

`number`

How many bytes of PCM follow. The header states TWO
  lengths and both derive from this one, so a value that does not match what
  is actually sent is a file a decoder reads past the end of or stops short
  inside.

#### Returns

`Uint8Array`\<`ArrayBuffer`\>

Exactly [WAV\_HEADER\_BYTES](#wav_header_bytes) bytes.

#### Throws

for a format no header can describe — the same check
  [encodeWav](#encodewav) makes, so the two cannot disagree about what is legal —
  or for a `byteLength` that is not a length.

## Classes

### StepGenerateError

A model call that failed, with the one thing a step has to decide from.

`retryable` is the whole point. The engine retries a step that throws
and a caller has to choose between letting it (a rate limit, a 5xx) and
refusing (a bad key, a rejected request) — and getting that backwards is
either five pointless attempts against a 401 or one attempt against a blip.

It is a BOOLEAN on the error rather than a `FatalError` thrown for you,
because `FatalError` lives on `@alexkroman1/aai/step-errors` and reaching for
it is the caller's opt-in: whether a terminal failure should burn a step's
remaining attempts is not this module's call. The mapping is one line at
the call site:

```ts no-check
try {
  return await stepGenerate(prompt, { system });
} catch (err) {
  if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
  throw err;
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new StepGenerateError(message: string, options: {
  cause?: unknown;
  retryable: boolean;
  retryAfter?: Date;
  status?: number;
}): StepGenerateError;
```

###### Parameters

###### message

`string`

###### options

###### cause?

`unknown`

###### retryable

`boolean`

###### retryAfter?

`Date`

###### status?

`number`

###### Returns

[`StepGenerateError`](#stepgenerateerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### retryable

```ts
readonly retryable: boolean;
```

Will another attempt plausibly answer differently?

##### retryAfter

```ts
readonly retryAfter: Date | undefined;
```

When the gateway asked to be called back, from its own `Retry-After`.

Present on a rate limit that named a delay, and what a caller should hand
to `RetryableError` — the engine's default delay is a guess, and this is
the number the far side chose.

##### status

```ts
readonly status: number | undefined;
```

The gateway's status, when there was a response at all.

***

### StepTransportError

A request that never got an answer.

Its own class because the DISTINCTION is what a retry policy turns on: a
response with a status can be classified ([isTransientStatus](#istransientstatus),
[retryAfter](#retryafter-2)), and this cannot — so a caller's choice is between
retrying a connection failure and giving up on one, with nothing to read.
Retrying is almost always right, which is why [StepTransportError](#steptransporterror) is
what the SDK raises rather than making every step write the `catch`.

The message carries the whole `cause` chain, because the top of one never says
anything useful: `TypeError: fetch failed` and `socket hang up` are wrappers,
and the code that identifies the failure — `ECONNRESET`, `UND_ERR_SOCKET`,
`ETIMEDOUT`, `ERR_HTTP2_STREAM_ERROR` — is a hop or two below.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new StepTransportError(url: string, options: {
  cause: unknown;
}): StepTransportError;
```

###### Parameters

###### url

`string`

###### options

###### cause

`unknown`

###### Returns

[`StepTransportError`](#steptransporterror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### codes

```ts
readonly codes: readonly string[];
```

Every `code` in the chain, outermost first — what a caller would branch on.

***

### TranscribeError

A failure from either endpoint, carrying what the caller needs to classify it.

The SDK does not decide fatal-vs-retryable, for the same reason [stepSpeak](#stepspeak)
does not: a helper that guessed would be guessing for every caller. What it can
do is carry the evidence, which is what `retryable` and `retryAfter` are —
read by `toStepError` on `@alexkroman1/aai/step-errors`, exactly as
`StepGenerateError`'s are. So a step body says `.catch(throwStepError)` and
gets the three-way call for free.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new TranscribeError(message: string, init: {
  retryable: boolean;
  retryAfter?: Date;
  status?: number;
}): TranscribeError;
```

###### Parameters

###### message

`string`

###### init

###### retryable

`boolean`

###### retryAfter?

`Date`

###### status?

`number`

###### Returns

[`TranscribeError`](#transcribeerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### retryable

```ts
readonly retryable: boolean;
```

Whether asking again could plausibly answer differently.

##### retryAfter

```ts
readonly retryAfter: Date | undefined;
```

How long the service asked us to wait, when it said.

##### status

```ts
readonly status: number | undefined;
```

HTTP status the endpoint answered, when it answered one.

***

### UploadIncompleteError

An upload that is still arriving, where the whole file was needed.

`retryable: false`, and that is the interesting field: `toStepError`
(`@alexkroman1/aai/step-errors`) recognises a carried verdict STRUCTURALLY, so
a step ending `.catch(throwStepError)` turns this into a `FatalError` and the
run stops on the spot with this sentence. Which is right — the default retry
cadence is ~0 ms, so three attempts would spend the whole budget of the most
expensive step in the flow inside a millisecond and still find the upload
unfinished. What has to change is the run's ORDER, and no number of attempts
changes that.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new UploadIncompleteError(message: string, stored: number): UploadIncompleteError;
```

###### Parameters

###### message

`string`

###### stored

`number`

###### Returns

[`UploadIncompleteError`](#uploadincompleteerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### retryable

```ts
readonly retryable: false = false;
```

Whether asking again could plausibly answer differently. It cannot.

##### stored

```ts
readonly stored: number;
```

Bytes readable when the check ran — the PREFIX, never a total.

## Type Aliases

### MultipartBody

```ts
type MultipartBody = {
  body: Uint8Array;
  headers: {
     Content-Type: string;
  };
};
```

A ready-to-send multipart body, as [multipartBody](#multipartbody-1) returns it.

#### Properties

##### body

```ts
body: Uint8Array;
```

The whole encoded body.

##### headers

```ts
headers: {
  Content-Type: string;
};
```

The `Content-Type` naming the boundary — spread into `headers`.

###### Content-Type

```ts
Content-Type: string;
```

***

### MultipartPart

```ts
type MultipartPart = {
  bytes: Uint8Array | readonly Uint8Array[];
  filename?: string;
  name: string;
  type?: string;
};
```

One file part, as [multipartBody](#multipartbody-1) takes it.

#### Properties

##### bytes

```ts
bytes: Uint8Array | readonly Uint8Array[];
```

The bytes, as one buffer or as the chunks they already are.

A LIST is concatenated into the body in order and is indistinguishable on
the wire from the same content passed as one buffer. It exists so a caller
holding a payload in pieces — a [wavHeader](#wavheader) in front of the samples it
describes, a file read window by window — need not JOIN them first only for
this function to copy the join into the body: for a multi-megabyte part that
intermediate buffer is a second full copy of the payload, held at the same
time as the first. The body itself is still one buffer, which is what buys
`Content-Length` and a retryable request; this removes the copy in front of
it, not the one it is.

##### filename?

```ts
optional filename?: string;
```

Filename to declare. Omitted makes this an ordinary field rather than a file.

##### name

```ts
name: string;
```

The form field name the endpoint reads.

##### type?

```ts
optional type?: string;
```

Content type of the part. Defaults to `application/octet-stream` for a file.

***

### PcmFormat

```ts
type PcmFormat = {
  bitsPerSample?: number;
  channels?: number;
  sampleRate: number;
};
```

How to read the samples handed to [encodeWav](#encodewav).

Only `sampleRate` is required, because the other two have an answer that is
right for every synthesizer and every phone call this SDK talks to, and a
caller repeating `channels: 1, bitsPerSample: 16` at every site is a caller
who will one day repeat it beside samples that are neither.

#### Properties

##### bitsPerSample?

```ts
optional bitsPerSample?: number;
```

Bits per sample. Defaults to `16`, and must be a multiple of 8.

DESCRIBES the bytes rather than requesting a conversion: nothing here
transcodes, so a wrong value writes a header that misreads samples it
never touched.

##### channels?

```ts
optional channels?: number;
```

Interleaved channel count. Defaults to `1` — mono, which speech is.

##### sampleRate

```ts
sampleRate: number;
```

Samples per second, e.g. `24_000`. Must be a positive integer.

***

### ReadUploadOptions

```ts
type ReadUploadOptions = {
  end?: number;
  start?: number;
};
```

Options for [stepReadUpload](#stepreadupload).

Both bounds admit `undefined` explicitly rather than being merely optional:
a step computes them from a plan, and under `exactOptionalPropertyTypes` a
`{ start: maybe }` would otherwise be a compile error at every call site that
has one — which is most of them, since "no start" and "start 0" mean the same
thing here.

#### Properties

##### end?

```ts
optional end?: number;
```

One past the last byte to read. Defaults to the end of the file.

##### start?

```ts
optional start?: number;
```

First byte to read. Defaults to 0.

***

### SpeakOptions

```ts
type SpeakOptions = {
  apiKeyEnv?: string;
  language?: string;
  sampleRate?: number;
  signal?: AbortSignal;
  voice?: string;
};
```

What [stepSpeak](#stepspeak) accepts.

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding the credential, replacing `ASSEMBLYAI_API_KEY`.

Names a VARIABLE, not a key — the same contract every provider descriptor
keeps, so nothing here can end up in a journaled step argument.

##### language?

```ts
optional language?: string;
```

Spoken language as an ISO 639-1 code (`"en"`, `"fr"`, `"de"`, `"es"`,
`"it"`, `"pt"`). Omitted by default so the service infers it from the
voice — set it only alongside a voice that speaks it.

##### sampleRate?

```ts
optional sampleRate?: number;
```

Samples per second to synthesize at. Defaults to
[STEP\_SPEAK\_SAMPLE\_RATE](#step_speak_sample_rate).

Worth lowering only when the audio is going somewhere that resamples it
anyway (a phone line is 8 kHz), since the file scales linearly with it.

##### signal?

```ts
optional signal?: AbortSignal;
```

Abort the synthesis. Combined with [STEP\_SPEAK\_TIMEOUT\_MS](#step_speak_timeout_ms) rather
than replacing it, so a caller passing one still cannot hang forever.

##### voice?

```ts
optional voice?: string;
```

Voice id, e.g. `"jane"`, `"michael"`, `"vera"`. Defaults to
`ASSEMBLYAI_TTS_DEFAULT_VOICE`; the catalog is `ASSEMBLYAI_TTS_VOICES` on
`@alexkroman1/aai/tts`, and every voice speaks exactly one language.

***

### SpokenAudio

```ts
type SpokenAudio = {
  audio: Uint8Array<ArrayBuffer>;
  durationMs: number;
  pcm: Uint8Array;
  sampleRate: number;
  voice: string;
};
```

What [stepSpeak](#stepspeak) resolves with.

#### Properties

##### audio

```ts
audio: Uint8Array<ArrayBuffer>;
```

A complete `.wav` file — the container a browser, a bucket and a
transcription API all accept.

##### durationMs

```ts
durationMs: number;
```

How long it lasts. Derived from the byte count, not claimed by the service.

##### pcm

```ts
pcm: Uint8Array;
```

The same samples WITHOUT the header, for a caller joining several
utterances and framing them once.

##### sampleRate

```ts
sampleRate: number;
```

Samples per second the audio was synthesized at.

##### voice

```ts
voice: string;
```

The voice that actually spoke, with the default filled in.

***

### StepFetchInit

```ts
type StepFetchInit = {
  body?: Uint8Array | string | AsyncIterable<Uint8Array>;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
};
```

What [stepFetch](#stepfetch) accepts.

Deliberately NARROWER than `RequestInit`, and the narrowing is the API's main
safety property. A `FormData`, `Blob`, `File`, `Headers` or `Request` handed
to a `fetch` that is not the one your realm's global came from is
brand-checked against that other undici's classes, matches no branch, and is
silently stringified — `Content-Type: text/plain` with the 17-byte body
`[object FormData]`, answered `415` by a server that was told nothing.
`body` therefore takes BYTES or a string, and [multipartBody](#multipartbody-1) is how a
file becomes bytes.

#### Properties

##### body?

```ts
optional body?: Uint8Array | string | AsyncIterable<Uint8Array>;
```

The request body: bytes, a string, or an async iterable of chunks.

The iterable form is what lets a step send a file it must not hold in memory —
a stored upload read window by window, which is the only way a step can hand a
multi-gigabyte recording to another service. It requires `duplex: "half"`, which
the published fetch adds; the caller passes only the iterable.

Note a streaming body cannot be RETRIED by the transport, because an iterable is
consumed once. That is a property of streaming rather than of this option, and it
is why a step sending one should be the step the engine retries — a fresh attempt
re-reads the upload from the start.

##### headers?

```ts
optional headers?: Record<string, string>;
```

Plain record, not a `Headers` — see the type's own doc for why.

##### method?

```ts
optional method?: string;
```

##### signal?

```ts
optional signal?: AbortSignal;
```

***

### StepGenerateJsonOptions

```ts
type StepGenerateJsonOptions<S extends StandardSchemaV1> = StepGenerateOptions & {
  schema: S;
};
```

Options for [stepGenerateJson](#stepgeneratejson): [StepGenerateOptions](#stepgenerateoptions) plus the shape.

#### Type Declaration

##### schema

```ts
schema: S;
```

The shape the reply must satisfy — any
[Standard Schema](https://standardschema.dev), zod being the documented
default. Its OUTPUT type is what this call returns, so a schema that
coerces (dropping the elements a model got wrong, say) is a supported and
often better answer than one that rejects the whole reply.

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1`

***

### StepGenerateOptions

```ts
type StepGenerateOptions = {
  apiKeyEnv?: string;
  gatewayUrl?: string;
  maxTokens?: number;
  model?: string;
  system?: string;
  temperature?: number;
  timeoutMs?: number;
};
```

Options for [stepGenerate](#stepgenerate).

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env key holding the AssemblyAI API key. Defaults to `ASSEMBLYAI_API_KEY`
— the same name every AssemblyAI stage reads.

##### gatewayUrl?

```ts
optional gatewayUrl?: string;
```

Gateway base URL, e.g. `ASSEMBLYAI_LLM_GATEWAY_EU_URL` for EU residency.

##### maxTokens?

```ts
optional maxTokens?: number;
```

Cap on the reply, forwarded only when set.

##### model?

```ts
optional model?: string;
```

Gateway model id. Defaults to `ASSEMBLYAI_LLM_DEFAULT_MODEL`, the same one
an agent's own pipeline resolves, so a workflow and its agent do not
silently run on different models.

##### system?

```ts
optional system?: string;
```

The system instruction. Omitted entirely when unset, rather than sent
empty — an empty system message is a message the model still reads.

##### temperature?

```ts
optional temperature?: number;
```

Sampling temperature, forwarded only when set. Left to the model's own
default otherwise, which is what an unset knob should mean.

##### timeoutMs?

```ts
optional timeoutMs?: number;
```

Request deadline in milliseconds. Defaults to 60s.

***

### StepInfo

```ts
type StepInfo = {
  attempt: number;
  isLastAttempt: boolean;
  key: string;
  maxAttempts: number;
  name: string;
};
```

Which step is running, and which attempt of it.

#### Properties

##### attempt

```ts
readonly attempt: number;
```

Which try this is, 1-based.

The WALK's count, not the journal's charge. Two overlapping deliveries of
one run each start at 1, because `maxAttempts` means how many times to try
and how many workers happen to be trying is not that number — see "An
attempt is a LEASE, not a tally" in `packages/aai-runtime/CLAUDE.md`.

##### isLastAttempt

```ts
readonly isLastAttempt: boolean;
```

Is this the last try, so that a throw fails the step for good?

Provided rather than left as `attempt === maxAttempts` because the
subtraction is where the mistake is: a body that hard-codes the ceiling
degrades early on every run when the call site's `maxAttempts` changes, and
nothing reports it.

A `FatalError` still ends the step wherever it is thrown, so this being
`false` is not a promise that another attempt will happen.

##### key

```ts
readonly key: string;
```

`name#occurrence` — the journal key, which is what makes a loop's rounds distinct.

##### maxAttempts

```ts
readonly maxAttempts: number;
```

The ceiling this step was given — `StepOptions.maxAttempts`, or its default.

##### name

```ts
readonly name: string;
```

The step's own name, as `ctx.step` was given it.

***

### TranscribeProgress

```ts
type TranscribeProgress = 
  | {
  done: false;
  status: string;
}
  | {
  done: true;
  status: string;
  transcript: Transcript;
};
```

Where a submitted job has got to.

A discriminated union rather than `{ done, transcript? }`, so a caller that
checks `done` has the transcript without a second narrowing and one that
forgets cannot read `undefined` text.

***

### TranscribeRequestOptions

```ts
type TranscribeRequestOptions = {
  apiKeyEnv?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
```

Options every call in this family accepts.

#### Properties

##### apiKeyEnv?

```ts
optional apiKeyEnv?: string;
```

Env var holding the credential, replacing `ASSEMBLYAI_API_KEY`.

Names a VARIABLE, not a key — the same contract every provider descriptor
keeps, so nothing here can end up in a journaled step argument.

##### signal?

```ts
optional signal?: AbortSignal;
```

Abort the request. Combined with the deadline rather than replacing it, so
a caller passing one still cannot hang forever.

##### timeoutMs?

```ts
optional timeoutMs?: number;
```

Deadline for this one request. Defaults to [TRANSCRIBE\_TIMEOUT\_MS](#transcribe_timeout_ms).

***

### TranscribeSubmitOptions

```ts
type TranscribeSubmitOptions = TranscribeRequestOptions & {
  models?: readonly string[];
  params?: Record<string, unknown>;
};
```

What [stepTranscribeSubmit](#steptranscribesubmit) accepts.

#### Type Declaration

##### models?

```ts
optional models?: readonly string[];
```

Models to ask for. Defaults to [TRANSCRIBE\_MODELS](#transcribe_models).

##### params?

```ts
optional params?: Record<string, unknown>;
```

Extra fields merged into the create-job body, VERBATIM.

The async API has a large surface this deliberately does not mirror —
`speaker_labels`, `language_code`, `redact_pii`, `auto_chapters` — and
mirroring it would mean a wrapper that goes stale against the service every
time it grows a feature. Nothing here interprets these; they are the
caller's request, sent as given.

`audio_url` and `speech_models` are set from this function's own arguments
and cannot be overridden here, so the two ways to say the same thing cannot
disagree.

***

### TranscribeSyncOptions

```ts
type TranscribeSyncOptions = TranscribeRequestOptions & {
  filename?: string;
  label?: string;
  model?: string;
  type?: string;
};
```

What [stepTranscribeSync](#steptranscribesync) accepts.

#### Type Declaration

##### filename?

```ts
optional filename?: string;
```

Filename to declare in the multipart part. Defaults to `"audio.wav"`.

The endpoint reads the CONTENT, so this is for the service's logs and for a
failure that names something a reader recognises — a segment's timestamp, a
part's index — rather than for routing.

##### label?

```ts
optional label?: string;
```

How this piece is named in a failure message. Defaults to `filename`.

The CALLER's vocabulary, because a fan-out's log is read by someone holding
segment numbers rather than filenames.

##### model?

```ts
optional model?: string;
```

Model to route to. Defaults to [TRANSCRIBE\_SYNC\_MODEL](#transcribe_sync_model).

Singular and a header rather than a body field — this endpoint's shape, not
the async API's, and the two are deliberately not unified here because
unifying them would mean inventing a name for something the service has two
different names for.

##### type?

```ts
optional type?: string;
```

Content type of the part. Defaults to `"audio/wav"`.

Worth setting for anything that is not linear PCM in a WAV container; the
endpoint accepts the common encodings and decodes on what it is told.

***

### Transcript

```ts
type Transcript = {
  durationMs: number;
  id: string;
  text: string;
};
```

A finished transcript, as [stepTranscribePoll](#steptranscribepoll) answers with one.

#### Properties

##### durationMs

```ts
durationMs: number;
```

How long the recording runs, from the PROVIDER's own measurement rather
than from a byte count — it decoded the file and this did not.

##### id

```ts
id: string;
```

The job id, so a caller can quote it in a log or fetch it again later.

##### text

```ts
text: string;
```

What was said, trimmed. Never empty — see [stepTranscribePoll](#steptranscribepoll).

***

### UploadInfo

```ts
type UploadInfo = {
  complete: boolean;
  id: string;
  name: string;
  ranges?: readonly UploadRange[];
  size: number;
  type: string;
};
```

What a stored upload is, minus its bytes.

#### Properties

##### complete

```ts
complete: boolean;
```

Whether every byte is in.

The one field a body waiting on a streamed upload may branch on. `false` means
more may arrive; a `size` that has stopped growing means only that nothing
arrived recently, which a slow link and a dead client both produce. An
ordinary upload is `true` from the moment it exists, because it does not exist
until it is finished.

##### id

```ts
id: string;
```

The handle a run input carries.

Minted by the store for an ordinary upload, and CHOSEN BY THE CALLER for a
streamed one — see `UPLOAD_TOKEN_RE`, which is what a chosen id has to satisfy.

##### name

```ts
name: string;
```

Filename the uploader gave, or `""` when it named none.

##### ranges?

```ts
optional ranges?: readonly UploadRange[];
```

Which windows have LANDED, for an unfinished upload that arrived as parts.

Absent for every other upload, and that absence is the honest answer rather
than an omission: a whole-file write has no windows (its bytes are one
contiguous prefix, which [UploadInfo.size](#size) already states), and a
finished parts upload is covered end to end by construction.

**A READER may act on it, and [stepReadUpload](#stepreadupload) already does.** This used to
say `size` was the only field a reader could trust, on the ground that a range
past the prefix names bytes with a hole in front of them. The bytes are still
there — the store maps a window onto the objects covering it and never
consults the prefix — so what the rule really protected was a read STRADDLING
a hole, and clamping to the containing run protects that exactly while making
a landed window readable. Without it a parts upload publishes nothing a run
can use until its first window lands, which under a fan-out is the end of the
upload; `readableEnd` carries the measurement.

The other reader is the UPLOADER: a client re-sending a parts upload can skip
the windows that are already stored instead of sending the file again, which
is the difference between resuming a recording and starting it over.

Sorted, non-overlapping, and half-open like every other range here.

**A LIST rather than a single offset, and that is the whole of what it buys.**
The obvious cheaper shape is one number — "everything up to here has landed" —
which is what a sequential append protocol reports (tus's `Upload-Offset`,
where a `PATCH` at any other offset is a 409). A single cursor cannot represent
a GAP at all, so under it an upload whose second part was lost has to re-send
everything after the first, and a fan-out that lands parts out of order has
nothing to report until they happen to join up. [UploadInfo.size](#size) already
IS that number. This is the strictly larger fact.

Absent also means "cannot say", not "nothing landed" — the store may decline
to report windows, and an agent too old to have this field says nothing
either. A reader's answer to an absent list is therefore to assume nothing
about what is stored, which for an uploader means sending the file.

##### size

```ts
size: number;
```

Bytes STORED so far.

The whole file for a finished upload, and a growing number for one still
arriving — which is why [stepReadUpload](#stepreadupload) clamps to it rather than to
anything the uploader declared. Never trust it as a total: see
[UploadInfo.complete](#complete).

##### type

```ts
type: string;
```

MIME type the uploader declared, or `""`. Never sniffed from the bytes.

***

### UploadRange

```ts
type UploadRange = {
  end: number;
  start: number;
};
```

A half-open window of an upload's bytes, `[start, end)`.

#### Properties

##### end

```ts
end: number;
```

##### start

```ts
start: number;
```

***

### UploadSlice

```ts
type UploadSlice = {
  bytes: Uint8Array;
  end: number;
  info: UploadInfo;
  start: number;
};
```

One window of an upload, as [stepReadUpload](#stepreadupload) resolves it.

#### Properties

##### bytes

```ts
bytes: Uint8Array;
```

The requested bytes, clamped to the file.

##### end

```ts
end: number;
```

One PAST the last byte offset returned, after clamping.

##### info

```ts
info: UploadInfo;
```

The upload this came from — `size` is the WHOLE file, not this window.

##### start

```ts
start: number;
```

First byte offset returned, after clamping.

***

### WriteUploadOptions

```ts
type WriteUploadOptions = {
  name?: string;
  type?: string;
};
```

Options for [stepWriteUpload](#stepwriteupload).

#### Properties

##### name?

```ts
optional name?: string;
```

Filename to store, e.g. `"summary.wav"`.

Worth passing even though nothing reads it: it is what
[UploadInfo.name](#name-2) answers, so it is the name a page puts on a
download link and the string a person sees instead of an opaque id.

##### type?

```ts
optional type?: string;
```

MIME type to store, e.g. `"audio/wav"`.

This one IS read — the byte route serves it as `Content-Type`, so a
browser given an upload with none downloads a file it will not play
inline. There is no sniffing anywhere in the store, by design.

## Variables

### STEP\_SPEAK\_SAMPLE\_RATE

```ts
const STEP_SPEAK_SAMPLE_RATE: 24000 = 24000;
```

Sample rate [stepSpeak](#stepspeak) asks for when a caller names none.

***

### STEP\_SPEAK\_TIMEOUT\_MS

```ts
const STEP_SPEAK_TIMEOUT_MS: 120000 = 120000;
```

How long one [stepSpeak](#stepspeak) call may take before it is abandoned.

Generous, and sized for the JOB rather than for a round trip: synthesis runs
at a multiple of real time, so a long digest is legitimately tens of
seconds. What it is really there to bound is the failure this endpoint
actually has — a socket that opens, accepts the text and then says nothing,
which without a deadline is a step that hangs until the run's own budget
runs out with nothing anywhere naming the cause.

***

### TRANSCRIBE\_API

```ts
const TRANSCRIBE_API: "https://api.assemblyai.com" = "https://api.assemblyai.com";
```

The async API's base.

***

### TRANSCRIBE\_MODELS

```ts
const TRANSCRIBE_MODELS: readonly ["universal-3-5-pro"];
```

The models a job asks for when a caller names none.

`speech_models`, PLURAL and an array. The singular `speech_model` is
deprecated on the async API and answers **400** for any current model name —
which is exactly the fault that produced the retry measurement in the module
doc. Omitting the field entirely is legal and routes to the service's
default; naming it is what stops a default change silently moving a
workflow's output.

***

### TRANSCRIBE\_SYNC\_ENDPOINT

```ts
const TRANSCRIBE_SYNC_ENDPOINT: "https://sync.assemblyai.com/transcribe" = "https://sync.assemblyai.com/transcribe";
```

The synchronous endpoint. Global — it routes to the nearest region.

***

### TRANSCRIBE\_SYNC\_MODEL

```ts
const TRANSCRIBE_SYNC_MODEL: "universal-3-5-pro" = "universal-3-5-pro";
```

Required on every sync request; the endpoint routes on it.

***

### TRANSCRIBE\_SYNC\_TIMEOUT\_MS

```ts
const TRANSCRIBE_SYNC_TIMEOUT_MS: 60000 = 60000;
```

The endpoint's own per-request deadline, plus room to upload.

Longer than the async API's default because the audio and the transcription
share one request here: the far side is doing the work while this waits,
where a submit merely queues it.

***

### TRANSCRIBE\_TIMEOUT\_MS

```ts
const TRANSCRIBE_TIMEOUT_MS: 60000 = 60000;
```

Per-request deadline when a caller names none.

Sized for a JSON round trip, which is what every call here is EXCEPT the
upload — that one is a function of the file rather than of the service and
carries its own budget. Nothing in the async API blocks: a submit answers
with an id and a poll answers with a status, both immediately.

***

### TRANSCRIBE\_UPLOAD\_TIMEOUT\_MS

```ts
const TRANSCRIBE_UPLOAD_TIMEOUT_MS: 1800000 = 1800000;
```

Deadline for the upload leg.

Its own budget because it is the one request whose duration is a function of
the FILE rather than of the service, and a deadline sized for a JSON round
trip would cancel exactly the uploads this exists to handle.

***

### TRANSCRIBE\_WINDOW\_BYTES

```ts
const TRANSCRIBE_WINDOW_BYTES: 4194304 = 4194304;
```

How much of a stored upload one outbound window carries.

The recording is never held whole — see [stepTranscribeUpload](#steptranscribeupload).

***

### WAV\_HEADER\_BYTES

```ts
const WAV_HEADER_BYTES: 44 = 44;
```

Bytes of WAV header [encodeWav](#encodewav) writes — `RIFF`, `fmt `, and `data`.
