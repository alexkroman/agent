# step-errors

The failure a `"use step"` body should throw (the
`@alexkroman1/aai/step-errors` subpath).

The Workflow DevKit retries a step that throws, gives up on a `FatalError`,
and honours the delay on a `RetryableError` — so every step body that calls
an HTTP API owns the same three-way decision, and `@alexkroman1/aai/step`
already carries the two halves it can answer without the DevKit
(`isTransientStatus` and `retryAfter`). What it could not do is
CONSTRUCT the error, because `FatalError` and `RetryableError` belong to
`workflow`. So the mapping was left as a snippet in a module doc — and both
templates that needed it copied the snippet out, verbatim and
character-identical. That is what this module is: the last function of an
extraction that stopped one function short.

## Why this is not simply part of `@alexkroman1/aai/step`

`@alexkroman1/aai/step` is the sibling, and the question a reader arriving
here actually has is why [throwStepError](#throwsteperror) is not next to
`stepFetch`.

The answer is that these four functions are the ONE authoring module allowed
to import the DevKit's `workflow` package, and `/step` is not written only
for a step. Its vocabulary is reached from a tool body and from a spec as
well — `mapConcurrent` bounds a rate-limited API call anywhere,
`stepFetch` is an ordinary HTTP client, and an exported step is driven
directly by every workflow template's tests. Putting `workflow` in that
subpath's graph would put it in all of theirs.

A STEP, meanwhile, pays nothing for the extra import line: the DevKit's
builder externalizes `workflow` and `@workflow/*` from the artifact it
produces, so the dependency is only ever in the import graph of a caller
that asked for it. `workflow` is already a real dependency of this package,
so nothing new is installed either way.

(An earlier version of this section argued the same split against
`@alexkroman1/aai/utils`, which was the sibling at the time. It no longer is
— the step vocabulary moved to `/step` — and the zero-dependency budget it
named is now a property of BOTH subpaths rather than the reason one of them
exists. The boundary is unchanged; only what it is drawn against is.)

It is in `sdk/` rather than `host/` despite `workflow` being a Node package,
and that is the rule rather than an exception to it: the split is about
`node:` builtins, which this has none of (it compiles under
`sdk/tsconfig.json`, which sets `types: []`), and `host/` is the half that
never runs inside a guest sandbox — where every step in fact runs.

## Three outcomes, and the third is the one worth having

A `FatalError` stops the DevKit retrying something that will answer the same
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

## Functions

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
  waiting out a `Retry-After` the server named rather than the DevKit's
  one-second default. That distinction is the reason a step should never
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
  "use step";
  return await (await stepFetchOk(url, { signal: AbortSignal.timeout(30_000) })).text();
}
```

#### Throws

a `FatalError` or `RetryableError` — see [toStepError](#tosteperror).

***

### throwFatalStepError()

```ts
function throwFatalStepError(cause: unknown, message?: string): never;
```

Stop the DevKit retrying: throw a `FatalError` whatever the cause was.

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

### throwStepError()

```ts
function throwStepError(cause: unknown, message?: string): never;
```

[toStepError](#tosteperror), thrown.

The form a `.catch()` takes, which is the shape both LLM templates want:
`stepGenerate` rejects with a `StepGenerateError` and the step wants
that classified before it reaches the DevKit.

It is a function taking the cause as an ARGUMENT rather than a `throw` inside
a `catch` block, and that is mechanical rather than stylistic: `FatalError`
takes only a message — no `cause` — so constructing one directly inside a
`catch` trips Biome's `useErrorCause` with no way to satisfy it. Here nothing
is being swallowed, because the original is what was passed in.

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
  "use step";
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

The DevKit error one failure deserves.

`cause` decides how the verdict is reached, and the three cases are the three
ways a step learns it failed:

- A **`Response`** — a non-2xx from an API the step called. Transient by
  `isTransientStatus` (`/step`), with the delay from its `Retry-After`
  when it named one.
- A **`StepGenerateError`** or a **`TranscribeError`** (both `/step`) — the
  LLM gateway and the transcription endpoints, each of which has already made
  the same judgement and recorded it on `retryable`/`retryAfter`. A
  transcription refusal the PROVIDER decided — a failed job, a recording with
  no speech in it — arrives with `retryable: false`, which is the whole reason
  it is carried rather than re-derived from a status that is not there.
- **Anything else** — a verdict this function cannot reach, so it does not
  invent one: the value is returned unchanged if it is an `Error` and wrapped
  in a plain `Error` if it is not. Both are retryable by the DevKit's default,
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
  "use step";
  const response = await fetch(`https://api.example.com/orders/${id}`);
  if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
  return await response.json();
}
```
