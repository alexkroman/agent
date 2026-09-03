# step-errors

The failure a step should throw (the
`@alexkroman1/aai/step-errors` subpath).

The engine retries a step that throws, gives up on a `FatalError`,
and honours the delay on a `RetryableError` — so every step body that calls
an HTTP API owns the same three-way decision, and `@alexkroman1/aai/step`
already carries the two halves it can answer with no verdict vocabulary at all
(`isTransientStatus` and `retryAfter`). What it could not do is
CONSTRUCT the error. So the mapping was left as a snippet in a module doc — and
both templates that needed it copied the snippet out, verbatim and
character-identical. That is what this module is: the last function of an
extraction that stopped one function short.

## Why this is not simply part of `@alexkroman1/aai/step`

`@alexkroman1/aai/step` is the sibling, and the question a reader arriving
here actually has is why [throwStepError](#throwsteperror) is not next to
`stepFetch`.

The answer is that IMPORTING FROM HERE IS THE OPT-IN, and `/step` is not
written only for a step. Its vocabulary is reached from a tool body and from a
spec as well — `mapConcurrent` bounds a rate-limited API call anywhere,
`stepFetch` is an ordinary HTTP client, and an exported step is driven
directly by every workflow template's tests. None of those callers has a
retry budget to burn, so none of them should meet a vocabulary whose whole
subject is one.

The split used to be a DEPENDENCY boundary — this was the one authoring module
allowed to import the Workflow DevKit's `workflow` package, which owned
`FatalError` and `RetryableError`. That package is gone and the two classes are
ours (`step-error-classes.ts` says why), so nothing here costs a caller
anything at install time. What survives is the audience boundary above, which
is the half that was ever load-bearing for a reader.

It is in `sdk/` rather than `host/`, and that is the rule rather than an
exception to it: the split is about
`node:` builtins, which this has none of (it compiles under
`sdk/tsconfig.json`, which sets `types: []`), and `host/` is the half that
never runs inside a guest sandbox — where every step in fact runs.

## Three outcomes, and the third is the one worth having

A `FatalError` stops the engine retrying something that will answer the same
way. A bare `RetryableError` retries in ONE SECOND, which is that class's own
default and not a considered number. A `RetryableError` carrying `retryAfter`
waits exactly as long as the far side asked — which matters most where this
SDK encourages a fan-out, because N segments hit a rate limit together, and a
second later all N ask again.

`StepGenerateError` already carries both the verdict (`retryable`) and
that delay, and until this module existed **no caller read the delay**: both
templates re-threw the error unchanged, so a rate-limited model call fell back
to the default backoff with the gateway's own number sitting unread on the
error. [toStepError](#tosteperror) reads it.

## The callers that come pre-classified

`.catch(throwStepError)` is not an interesting line, and it was on **17 call
sites across eight templates** — every LLM and transcription call any of them
makes. Two had already wrapped it in a local `ask()` whose only content was
that `.catch`, each paying a doc block to say why, and the second one records
that two OTHER templates wrote the same mapping before it was extracted. So it
is hoisted one level further: [stepGenerateClassified](#stepgenerateclassified) and its
siblings are the `/step` call and [throwStepError](#throwsteperror), nothing else.

They live here rather than in `/step` because IMPORTING THEM IS THE OPT-IN.
`/step` names no verdict vocabulary at all, and whether a terminal failure should
burn a step's remaining attempts is the caller's decision — a `404` meaning
"already deleted" wants the raw call. The `Classified` suffix keeps the `/step`
name intact, so a wrapper reads as the call it wraps.

## Functions

### sendToChannelClassified()

```ts
function sendToChannelClassified(channel: Channel, message: ChannelMessage): Promise<string>;
```

`sendToChannel` (`@alexkroman1/aai/channels`), with its failure classified —
see [stepGenerateClassified](#stepgenerateclassified) for the family, and this module's doc for
why the wrapper lives here rather than beside the call it wraps.

`ChannelDeliveryError` carries the platform's verdict AND its `Retry-After`,
so a rate-limited post waits the delay the platform named rather than the
default one-second delay, and a 4xx — a revoked webhook, an unpublished
Slack workflow, a variable name that matches nothing — stops immediately
with the sentence a person can act on instead of burning three more attempts
on an answer that will not change.

Reach for `sendToChannel` directly where the refusal is not simply a
failure: a body deciding to fall back to a second destination, or a run that
treats an unreachable channel as a warning rather than an outcome.

#### Parameters

##### channel

[`Channel`](channels.md#channel)

##### message

[`ChannelMessage`](channels.md#channelmessage)

#### Returns

`Promise`\<`string`\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

#### Example

```ts
import { slackChannel } from "@alexkroman1/aai/channels";
import { sendToChannelClassified } from "@alexkroman1/aai/step-errors";

export async function announce(webhookUrl: string, headline: string): Promise<string> {
  return await sendToChannelClassified(slackChannel({ webhookUrl }), { text: headline });
}
```

***

### stepFetchOk()

```ts
function stepFetchOk(url: string, init?: StepFetchInit): Promise<Response>;
```

`stepFetch`, with the non-2xx branch every caller was writing by hand.

A step whose job is one HTTP call ends up writing the same three lines —
make the request, check `ok`, hand the `Response` to [toStepError](#tosteperror) —
and three templates had each arrived at their own copy of it: `recap-workflow`
wrapped it in a local `request()`, `link-digest` inlined it, and
`podcast-digest` wrote a `fetchText` around it. This is that line, and the
argument for hoisting it is the one in this module's own doc: a snippet
copied verbatim into three places is a function that has not been written
yet.

It answers a `Response` on 2xx, so nothing about the success path changes —
the caller still chooses `.text()`, `.json()` or the stream. It is only the
failure path that is taken over, and the takeover is worth having for two
reasons beyond the line count:

- **The body reaches the error.** `responseErrorMessage` prefers a JSON
  `error` field when the far side sent one and falls back to the status with
  a bounded preview. Hand-written versions throw away the body — so a `400`
  that said exactly what was wrong with the request arrives as the number
  `400`, and whoever reads the run has to reproduce the call to find out.
- **The verdict stays with `toStepError`.** Transient by `isTransientStatus`,
  waiting out a `Retry-After` the server named rather than the default
  one-second delay. That distinction is the reason a step should never
  throw a bare `Error` on a bad response, and it is easy to forget in the
  fourth call site of a file.

Reach for `stepFetch` directly where the failure is not simply a
failure: a `404` that means "already deleted", or a `4xx` whose body decides
which advice to print. `podcast-digest`'s Slack step is the worked example of
that second case.

#### Parameters

##### url

`string`

##### init?

[`StepFetchInit`](step.md#stepfetchinit)

#### Returns

`Promise`\<`Response`\>

#### Example

```ts
import { stepFetchOk } from "@alexkroman1/aai/step-errors";

export async function readFeed(url: string): Promise<string> {
  return await (await stepFetchOk(url, { signal: AbortSignal.timeout(30_000) })).text();
}
```

#### Throws

a `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### stepGenerateClassified()

```ts
function stepGenerateClassified(prompt: string, opts?: StepGenerateOptions): Promise<string>;
```

`stepGenerate`, with its failure classified — the whole of what the wrapper
adds is [throwStepError](#throwsteperror), and see this module's doc for why that is
worth an export rather than a line at each of the eight templates that wrote
it. `StepGenerateError` carries the gateway's own verdict AND its
`Retry-After`, so a rate-limited call waits the delay the gateway named
instead of the default one-second delay.

None of them takes a `message`: a caller with a label worth attaching wants
the explicit `.catch((err) => throwStepError(err, …))`.

#### Parameters

##### prompt

`string`

##### opts?

[`StepGenerateOptions`](step.md#stepgenerateoptions)

#### Returns

`Promise`\<`string`\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

#### Example

```ts
import { stepGenerateClassified } from "@alexkroman1/aai/step-errors";

export async function summarize(text: string): Promise<string> {
  return await stepGenerateClassified(text, { system: "Summarize in two sentences." });
}
```

***

### stepGenerateJsonClassified()

```ts
function stepGenerateJsonClassified<S extends StandardSchemaV1<unknown, unknown>>(prompt: string, opts: StepGenerateJsonOptions<S>): Promise<InferSchemaOutput<S>>;
```

`stepGenerateJson`, with its failure classified — see
[stepGenerateClassified](#stepgenerateclassified). The most-copied member of the family (**7 of the
17 sites**): a workflow that asks a model for a SHAPE is the usual shape.

Worth knowing what it does NOT flatten: a gateway refusal arrives as a
`StepGenerateError` carrying its own verdict, while a reply that was not JSON
or missed the schema throws a plain `Error`, which [toStepError](#tosteperror) passes
through retryable — correctly, since a model that answered with prose may obey
next attempt.

#### Type Parameters

##### S

`S` *extends* `StandardSchemaV1`\<`unknown`, `unknown`\>

#### Parameters

##### prompt

`string`

##### opts

[`StepGenerateJsonOptions`](step.md#stepgeneratejsonoptions)\<`S`\>

#### Returns

`Promise`\<[`InferSchemaOutput`](index.md#inferschemaoutput)\<`S`\>\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### stepTranscribePollClassified()

```ts
function stepTranscribePollClassified(id: string, opts?: TranscribeRequestOptions): Promise<TranscribeProgress>;
```

`stepTranscribePoll`, with its failure classified — see
[stepTranscribeSubmitClassified](#steptranscribesubmitclassified). A poll that answers is not a poll that
SUCCEEDED: an unfinished job comes back as a `TranscribeProgress` and only a
transport or API failure rejects, so this classifies the rejection and says
nothing about the job's own status.

#### Parameters

##### id

`string`

##### opts?

[`TranscribeRequestOptions`](step.md#transcriberequestoptions)

#### Returns

`Promise`\<[`TranscribeProgress`](step.md#transcribeprogress)\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### stepTranscribeSubmitClassified()

```ts
function stepTranscribeSubmitClassified(audioUrl: string, opts?: TranscribeSubmitOptions): Promise<{
  id: string;
}>;
```

`stepTranscribeSubmit`, with its failure classified — see
[stepTranscribeSyncClassified](#steptranscribesyncclassified). Half of the async job API, whose other
half is [stepTranscribePollClassified](#steptranscribepollclassified); both are wrapped because a submit
and its poll are separate steps with separate attempt budgets — classify one
and not the other and the run gives up in one place and never in the other.

#### Parameters

##### audioUrl

`string`

##### opts?

[`TranscribeSubmitOptions`](step.md#transcribesubmitoptions)

#### Returns

`Promise`\<\{
  `id`: `string`;
\}\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### stepTranscribeSyncClassified()

```ts
function stepTranscribeSyncClassified(bytes: Uint8Array, opts?: TranscribeSyncOptions): Promise<{
  text: string;
}>;
```

`stepTranscribeSync`, with its failure classified — see
[stepGenerateClassified](#stepgenerateclassified).

This is the arm where classifying earns the most. `TranscribeError` carries
`retryable`, and a refusal the PROVIDER decided — a recording with no speech in
it, a container it will not read — arrives with `retryable: false`. Unclassified,
a step re-uploads the same bytes until its attempts run out on a file that was
never going to transcribe.

#### Parameters

##### bytes

`Uint8Array`

##### opts?

[`TranscribeSyncOptions`](step.md#transcribesyncoptions)

#### Returns

`Promise`\<\{
  `text`: `string`;
\}\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### stepTranscribeUploadClassified()

```ts
function stepTranscribeUploadClassified(uploadId: string, opts?: TranscribeRequestOptions): Promise<{
  audioUrl: string;
}>;
```

`stepTranscribeUpload`, with its failure classified — see
[stepTranscribeSyncClassified](#steptranscribesyncclassified) for what a transcription verdict carries.

#### Parameters

##### uploadId

`string`

##### opts?

[`TranscribeRequestOptions`](step.md#transcriberequestoptions)

#### Returns

`Promise`\<\{
  `audioUrl`: `string`;
\}\>

#### Throws

A `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### throwFatalStepError()

```ts
function throwFatalStepError(cause: unknown, message?: string): never;
```

Stop the engine retrying: throw a `FatalError` whatever the cause was.

For the failure a step has DECIDED is terminal on grounds no status code
carries — a missing API key, a recording in a format the step cannot cut.
Three more attempts find the same gap, and spending them turns an immediate
failure into one that arrives a minute later saying the same thing.

Separate from [toStepError](#tosteperror) precisely because that one refuses to guess:
"I could not classify this" and "I classified this as terminal" are different
claims, and collapsing them would make every unclassified failure silently
unretryable.

#### Parameters

##### cause

`unknown`

##### message?

`string`

#### Returns

`never`

#### Example

```ts
import { requireStepEnv } from "@alexkroman1/aai/step";
import { throwFatalStepError } from "@alexkroman1/aai/step-errors";

export function apiKey(): string {
  try {
    return requireStepEnv("ASSEMBLYAI_API_KEY");
  } catch (err) {
    return throwFatalStepError(err);
  }
}
```

***

### throwFfmpegStepError()

```ts
function throwFfmpegStepError(cause: unknown, message?: string): never;
```

The verdict a failed ffmpeg run deserves: retry a `timeout` or an `aborted`,
stop on everything else.

`FfmpegError.kind` (`@alexkroman1/aai/ffmpeg`) is what makes this decidable. An
`exit` is ffmpeg having READ the file and refused it, so every retry re-reads
the same bytes and reaches the same conclusion while burning the budget a real
transient needs; a `missing-binary` is `aai dev` on a laptop with no ffmpeg,
already carrying its install instructions; an `output-too-large` is a cap only
the caller can raise. A `timeout` or an `aborted` is worth another attempt.

**Everything it does not recognise is FATAL — the opposite of
[toStepError](#tosteperror)'s default — and that inversion is why this is its own
export.** `toStepError` refuses to invent a verdict, so an unclassified cause
passes through retryable; here the caller has already decided, this step having
run one subprocess over one file. Folding the two together would silently
disable retries for every unclassified failure in the SDK, so the
fatal/retryable choice stays visible in the name the author types.

**The retryable arm goes through [throwStepError](#throwsteperror) even though it
classifies nothing.** An `FfmpegError` is neither a `Response` nor an SDK error
carrying `retryable`, so it is rethrown UNCHANGED and the engine's unclassified default
retries it — where constructing a `RetryableError` would replace ffmpeg's own
message and its `argv` with a sentence, and the argv is what you paste into a
shell.

**The failure is recognised STRUCTURALLY rather than with `instanceof`, and
that is forced.** `FfmpegError` types its `signal` as `NodeJS.Signals`, and
this module compiles under `sdk/tsconfig.json`, which sets `types: []` — so no
module reachable from here may name a Node type, let alone import
`node:child_process`. That budget is the whole reason this subpath can be named
from a `workflows/` module: that bundle keeps everything a module holds at
MODULE scope, so one surviving reference to `@alexkroman1/aai/ffmpeg` puts a
child-process spawn inside a `node:vm` with no `require`, and every run dies at
replay with `ReferenceError: require is not defined`. Two templates each carried
a whole one-function FILE to keep that reference on the far side of a boundary
only a step body crosses; owning the decision here retires both.

#### Parameters

##### cause

`unknown`

What the ffmpeg call threw. Anything at all — see above.

##### message?

`string`

The sentence to report. Defaults to the cause's own, which
  for an `FfmpegError` is ffmpeg's log tail.

#### Returns

`never`

#### Example

```ts
import { transcodeToWav } from "@alexkroman1/aai/ffmpeg";
import { throwFfmpegStepError } from "@alexkroman1/aai/step-errors";

export async function toPcm(bytes: Uint8Array): Promise<Uint8Array> {
  return await transcodeToWav(bytes, { sampleRate: 16_000 }).catch(throwFfmpegStepError);
}
```

***

### throwStepError()

```ts
function throwStepError(cause: unknown, message?: string): never;
```

[toStepError](#tosteperror), thrown.

The form a `.catch()` takes, which is the shape both LLM templates want:
`stepGenerate` rejects with a `StepGenerateError` and the step wants
that classified before it reaches the engine.

It is a function taking the cause as an ARGUMENT rather than a `throw` inside
a `catch` block, and that is mechanical rather than stylistic: what Biome's
`useErrorCause` asks of an error constructed inside a `catch` is that it carry
the one being handled, and a call site cannot forget to do that here — the
cause is the first parameter, and both of these attach it. Nothing is being
swallowed either way: the original is what was passed in.

#### Parameters

##### cause

`unknown`

##### message?

`string`

#### Returns

`never`

#### Example

```ts
import { stepGenerate } from "@alexkroman1/aai/step";
import { throwStepError } from "@alexkroman1/aai/step-errors";

export async function summarize(text: string): Promise<string> {
  return await stepGenerate(text, { system: "Summarize in two sentences." }).catch(
    throwStepError,
  );
}
```

***

### toStepError()

```ts
function toStepError(cause: unknown, message?: string): Error;
```

The step error one failure deserves.

`cause` decides how the verdict is reached, and the three cases are the three
ways a step learns it failed:

- A **`Response`** — a non-2xx from an API the step called. Transient by
  `isTransientStatus` (`/step`), with the delay from its `Retry-After`
  when it named one.
- A **`ChannelDeliveryError`** (`@alexkroman1/aai/channels`) — a platform
  that refused a post, having already reached the same verdict. A 4xx from a
  webhook is terminal by construction: a revoked webhook and a wrong
  variable name answer identically on every attempt.
- A **`StepGenerateError`** or a **`TranscribeError`** (both `/step`) — the
  LLM gateway and the transcription endpoints, each of which has already made
  the same judgement and recorded it on `retryable`/`retryAfter`. A
  transcription refusal the PROVIDER decided — a failed job, a recording with
  no speech in it — arrives with `retryable: false`, which is the whole reason
  it is carried rather than re-derived from a status that is not there.
- **Anything else** — a verdict this function cannot reach, so it does not
  invent one: the value is returned unchanged if it is an `Error` and wrapped
  in a plain `Error` if it is not. Both are retryable by the engine's default,
  which is the safe direction — the alternative is silently disabling retries
  for a failure nobody classified. Reach for [throwFatalStepError](#throwfatalsteperror) where
  the step really has decided a failure is terminal.

#### Parameters

##### cause

`unknown`

What failed.

##### message?

`string`

The sentence to report. Defaults to the response's status
  line, or the cause's own message.

#### Returns

`Error`

#### Example

```ts
import { toStepError } from "@alexkroman1/aai/step-errors";

export async function fetchOrder(id: string): Promise<unknown> {
  const response = await fetch(`https://api.example.com/orders/${id}`);
  if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
  return await response.json();
}
```

## Classes

### FatalError

A failure that another attempt cannot fix.

Throwing one fails the RUN, not merely the step — a step whose remaining
attempts are pointless has nothing left to contribute. Reach for it where the
far side has already given a terminal answer: a `404` on a resource that was
deleted, a `422` on input that will be malformed on every attempt, a provider
saying the recording has no speech in it.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new FatalError(message: string, options?: {
  cause?: unknown;
}): FatalError;
```

###### Parameters

###### message

`string`

###### options?

###### cause?

`unknown`

###### Returns

[`FatalError`](#fatalerror)

###### Overrides

```ts
Error.constructor
```

#### Methods

##### is()

```ts
static is(value: unknown): value is FatalError;
```

Is `value` a [FatalError](#fatalerror), including one from another copy of this module?

###### Parameters

###### value

`unknown`

###### Returns

`value is FatalError`

#### Properties

##### fatal

```ts
readonly fatal: true = true;
```

Always `true`.

A readable field rather than only the brand, because it is what shows up in
a journaled failure and in a log line — `fatal: true` in a run's history
answers "why did this stop after one attempt" without the reader knowing
this class exists.

***

### RetryableError

A failure another attempt might survive, with an optional "not before".

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new RetryableError(message: string, options?: RetryableErrorOptions): RetryableError;
```

###### Parameters

###### message

`string`

###### options?

[`RetryableErrorOptions`](#retryableerroroptions)

###### Returns

[`RetryableError`](#retryableerror)

###### Overrides

```ts
Error.constructor
```

#### Methods

##### is()

```ts
static is(value: unknown): value is RetryableError;
```

Is `value` a [RetryableError](#retryableerror), including one from another copy of this module?

###### Parameters

###### value

`unknown`

###### Returns

`value is RetryableError`

#### Properties

##### retryAfter

```ts
readonly retryAfter: Date;
```

When the next attempt may run. Always a `Date` — a number passed to the
constructor is resolved against the clock AT CONSTRUCTION, which is the
moment the caller meant.

## Type Aliases

### RetryableErrorOptions

```ts
type RetryableErrorOptions = {
  cause?: unknown;
  retryAfter?: number | Date;
};
```

What [RetryableError](#retryableerror) accepts for its delay.

#### Properties

##### cause?

```ts
optional cause?: unknown;
```

##### retryAfter?

```ts
optional retryAfter?: number | Date;
```

When the next attempt may run: a delay in MILLISECONDS, or the absolute
`Date` the far side named.

Defaults to [DEFAULT\_RETRY\_DELAY\_MS](#default_retry_delay_ms) from now. The DevKit accepted a
duration STRING here too (`"5s"`) and this does not — a string delay is one
more parser to own and no call site in the repo passed one, every one of
them having a `Retry-After` header or nothing.

## Variables

### DEFAULT\_RETRY\_DELAY\_MS

```ts
const DEFAULT_RETRY_DELAY_MS: 1000 = 1000;
```

How long a [RetryableError](#retryableerror) that names no delay waits.

One second, which is what the DevKit's class defaulted to — kept so the
migration changes no timing it does not have to. It is not a considered
number, and a caller who has the far side's own `Retry-After` should pass it:
this SDK encourages fan-out, so N segments meet a rate limit together and a
second later all N ask again.
