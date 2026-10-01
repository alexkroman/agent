# step-errors

`@alexkroman1/aai/step-errors` — the failure a step should throw, and the helpers that throw it.

A FACADE. The subpath resolves here rather than at `step-errors.ts`, which buys two
things the direct form could not. That module can be SPLIT as it grows without
moving the published entry point — the path an implementation file happens to
have is not a thing to promise anyone — and a name it gains next reaches the
public surface only when a line is added below, rather than the moment it is
written.

Named re-exports rather than `export *` for the second half of that: the
wildcard form re-exports whatever arrives, and needs a `noReExportAll`
suppression the escape-hatch ratchet only lets move down.

## Functions

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

#### Extended by

- [`ClientUnreachableError`](step.md#clientunreachableerror)

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
const DEFAULT_RETRY_DELAY_MS: number;
```

How long a [RetryableError](#retryableerror) that names no delay waits.

One second, which is what the DevKit's class defaulted to — kept so the
migration changes no timing it does not have to. It is not a considered
number, and a caller who has the far side's own `Retry-After` should pass it:
this SDK encourages fan-out, so N segments meet a rate limit together and a
second later all N ask again.

## References

### orFail

Re-exports [orFail](index.md#orfail)
