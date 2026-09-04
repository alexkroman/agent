# utils

Shared utility functions (the `@alexkroman1/aai/utils` subpath).

For user tool code: `errorMessage`, `errorDetail`, `safeJsonParse`,
`toolFailure`, `isToolFailure`, `pushCapped`, `createKeyedLock`,
`decodeHtmlEntities`, and the four
narration formatters (`formatBytes`, `formatDuration`, `countWords`,
`plural`). The remaining exports are framework
plumbing shared with the sibling packages. The module stays free of zod and
other heavy runtime dependencies so the CLI can import it on every
invocation without a startup cost.

That budget is also why `stepSpeak` is here at all rather than beside the TTS
providers: the synthesizer needs a WebSocket client, so what this module
carries is the SLOT and the WAV framing — the same split `stepFetch` makes
with its undici dispatcher, and for the same measured reason.

That zod-free property is why `omitUndefined` lives here rather than on
`/internal` alongside the other cross-package infrastructure: `/internal`
re-exports a schema helper that pulls zod, so importing anything from it pulls
zod's whole module graph — and the CLI loads this module on every invocation.

`createKeyedLock` is the one export with a runtime dependency (`p-timeout`,
for its optional acquire deadline). Deliberate, and measured against the
rule above rather than around it: p-timeout is 2.4 KB with an empty
dependency list, where the cost this rule exists to keep off the startup
path is zod's module graph. It belongs on the PUBLIC subpath because the
hazard it addresses is an agent author's — the LLM loop runs a step's tool
calls concurrently, so two async mutators of one external resource interleave
— and `/internal` would be telling users to import internal API. (Per-session
state is not that case any more: `sessionSlot`'s `update` window is
synchronous, so it has nothing to serialize.)

## Functions

### countWords()

```ts
function countWords(text: string): number;
```

How many words a string holds — whitespace-separated runs, after trimming.

Every kind of whitespace separates (spaces, tabs, newlines, the non-breaking
space a pasted transcript carries), and a run of them counts once, so a
transcript stitched with `"\n\n"` between segments counts the same as one
joined with single spaces. An empty or whitespace-only string is `0`, which
is the case a naive `split(/\s+/).length` gets wrong by returning `1`.

Deliberately naive about what a "word" is: it does not know about
hyphenation, contractions, CJK text with no spaces in it, or numerals. It
exists for the one thing every template used it for — "~1,200 words" in a
progress line beside a transcript — where the count is a SCALE a reader
calibrates against, not a figure anything is computed from.

#### Parameters

##### text

`string`

#### Returns

`number`

#### Example

```ts
import { countWords } from "@alexkroman1/aai/utils";

countWords("  hello   there\nfriend "); // 3
countWords("   "); // 0
```

***

### decodeHtmlEntities()

```ts
function decodeHtmlEntities(text: string): string;
```

Decode the five XML/HTML entities that matter, plus a numeric apostrophe.

`&lt;` `&gt;` `&quot;` `&nbsp;` and `&amp;`, plus `&#39;` / `&#039;` /
`&apos;` for the apostrophe — the one that arrives numeric as often as named,
because `&apos;` is XML and not in HTML 4. A non-breaking space becomes an
ordinary space rather than U+00A0, since the caller is feeding text to a model
or a word count, and `countWords` treating the two alike is the same decision.

Anything else is left exactly as it stands, including a malformed or unknown
entity: `&hellip;` and a bare `&` both come back unchanged. Decoding is a
single pass, so an entity produced BY the decoding is not decoded again —
which is the property that makes `&amp;lt;` round-trip to the literal `&lt;`
the document meant.

#### Parameters

##### text

`string`

#### Returns

`string`

#### Example

```ts
import { decodeHtmlEntities } from "@alexkroman1/aai/utils";

decodeHtmlEntities("Fish &amp; Chips"); // "Fish & Chips"
decodeHtmlEntities("it&#39;s here"); // "it's here"
// One pass, so an entity the decoding produced stays literal.
decodeHtmlEntities("&amp;lt;b&amp;gt;"); // "&lt;b&gt;"
```

***

### errorDetail()

```ts
function errorDetail(err: unknown): string;
```

Extract a detailed error string (message + stack) for diagnostic logging.

#### Parameters

##### err

`unknown`

#### Returns

`string`

***

### errorMessage()

```ts
function errorMessage(err: unknown): string;
```

Extract an error message from an unknown thrown value.

**It never answers with an empty string.** That is the contract, and it is
worth stating as one: `SessionError.message` is rendered directly by a
browser client, so `""` paints a banner that says an error occurred and
refuses to say what — strictly worse than a generic sentence, because an
absent message reads as absence rather than as a problem.

The shape that produced one is not exotic, it is the FIRST failure a new
project hits. The AI SDK builds an `APICallError` whose `message` is
`response.statusText` whenever the provider's error body does not match the
schema it expected (`createJsonErrorResponseHandler`), and a reason phrase is
optional in HTTP/1.1 and does not exist at all in HTTP/2 — so a rejected API
key arrived as `{"code":"llm","message":"","fatal":false}` with the status,
the URL, and the provider's own explanation all sitting unread on the error
object.

So a value that says nothing on its own is read one level down, in this
order: the HTTP fields an `APICallError`-shaped failure carries (the status,
the host that answered, the sentence in the response body), then `cause`,
then an `AggregateError`'s members. Detection is STRUCTURAL for the same
reason the schema-issue reading below it is — this module is published,
zod-free, and may not import `ai` to ask `APICallError.isInstance` — and it
costs nothing: a numeric `statusCode` beside a `responseBody` is the shape,
whoever built it.

An error that DOES state something keeps its own words — an HTTP failure has
the status appended to them, since `Unauthorized` alone answers neither "which
provider" nor "refused or fell over", and everything else is returned
verbatim. One message is replaced outright, and it has precedent:
`fetch failed` (and the browser's `failed to fetch`) is
Node's own placeholder, with the reason — `ECONNREFUSED`, a DNS failure, a
certificate rejection — one level down in `cause`. The AI SDK makes exactly
this substitution for its own calls (`handleFetchError`, which rewrites the
pair as "Cannot connect to API: …"); this extends the same reading to every
direct `fetch` in the SDK.

#### Parameters

##### err

`unknown`

#### Returns

`string`

***

### formatBytes()

```ts
function formatBytes(bytes: number): string;
```

A byte count at the scale a person reads it: `"17.7 MB"`, `"110 KB"`,
`"512 B"`.

The unit is the largest one the value reaches, stepping by 1024 (`B`, `KB`,
`MB`, `GB`, `TB`). Bytes and kilobytes are printed as whole numbers, because
a tenth of a kilobyte is noise in a sentence; megabytes and up carry exactly
one decimal, including a trailing zero (`"2.0 MB"`), so a column of them
aligns and a size that grew from 2.04 to 2.4 does not read as unchanged.

Rounding that carries into the next unit is PROMOTED rather than printed:
1,048,000 bytes is `"1.0 MB"`, never `"1024 KB"`.

A byte count is never negative and never `NaN`, so both are reported as
`"0 B"` rather than propagating into a sentence a caller shows a person —
this runs on the narration path, where the alternative is `"-0.0 MB"` in a
progress line.

#### Parameters

##### bytes

`number`

#### Returns

`string`

#### Example

```ts
import { formatBytes } from "@alexkroman1/aai/utils";

formatBytes(0); // "0 B"
formatBytes(112_640); // "110 KB"
formatBytes(18_559_795); // "17.7 MB"
```

***

### formatDuration()

```ts
function formatDuration(ms: number): string;
```

A duration as a clock reading: `"4:09"` under an hour, `"1:04:09"` over one.

Seconds are always two digits, minutes are two digits only once an hours
field exists, and the hours field is omitted when it is zero rather than
padded — so a two-minute clip reads `"2:26"` and only a long recording grows
a field. Input is milliseconds, rounded to the nearest second.

**The hours field is why this is shared.** A `m:ss` formatter is four lines
and looks finished, so every copy of it in this repo was written that way
and every one of them printed a 64-minute run as `"64:09"`. That is not a
cosmetic difference: `64:09` reads as sixty-four minutes to a person who
knows the format and as an error to everyone else, and the same run's other
copy said `1:04:09`.

Negative and non-finite inputs are `"0:00"` — a duration is an elapsed time,
and a caller subtracting two clock readings across a resume should not print
`"-1:-30"` into a progress line.

#### Parameters

##### ms

`number`

#### Returns

`string`

#### Example

```ts
import { formatDuration } from "@alexkroman1/aai/utils";

formatDuration(0); // "0:00"
formatDuration(249_000); // "4:09"
formatDuration(3_849_000); // "1:04:09"
```

***

### isToolFailure()

```ts
function isToolFailure(value: unknown): value is ToolFailure;
```

Whether a value is a [ToolFailure](#toolfailure).

The guard exists because failures PROPAGATE: a helper resolving an order
returns `Order | ToolFailure`, and its caller forwards the failure
unchanged rather than re-wording it. `if ("error" in value)` works only
once the value is known to be an object, which is the check this bundles.

#### Parameters

##### value

`unknown`

#### Returns

`value is ToolFailure`

#### Example

```ts
import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";

type Order = { id: string; total: number };

function findOrder(id: string): Order | ToolFailure {
  return { error: `Order ${id} not found.` };
}

function orderTotal(id: string): number | ToolFailure {
  const order = findOrder(id);
  if (isToolFailure(order)) return order;
  return order.total;
}
```

***

### plural()

```ts
function plural(
   n: number, 
   one: string, 
   many?: string
): string;
```

The right form of an English noun for a count: `plural(1, "risk")` is
`"risk"`, `plural(2, "risk")` is `"risks"`.

`many` defaults to `one + "s"`; pass it for a noun that does not take a bare
`-s` (`plural(n, "entry", "entries")`, `plural(n, "person", "people")`).

**It returns the WORD, not the count**, because the count almost always
needs its own formatting on the way into the sentence — a
[formatDuration](#formatduration), a thousands separator, or a word (`"no risks"`). The
call site writes `` `${n} ${plural(n, "risk")}` ``, which is the same shape
as the seventeen inline `` `${n === 1 ? "" : "s"}` `` this replaces, minus
the chance of pluralizing off a different variable than the one being
printed — which is exactly the bug that idiom hides, since both halves read
as noise.

Only exactly `1` takes the singular. Zero is plural (`"0 risks"`), which is
English, and so is a negative or fractional count. Non-localized by
construction: a language with more than two forms needs a different function,
not an option on this one.

#### Parameters

##### n

`number`

##### one

`string`

##### many?

`string`

#### Returns

`string`

#### Example

```ts
import { plural } from "@alexkroman1/aai/utils";

const risks = 3;
`Found ${risks} ${plural(risks, "risk")}.`; // "Found 3 risks."
`Read ${1} ${plural(1, "entry", "entries")}.`; // "Read 1 entry."
```

***

### pushCapped()

```ts
function pushCapped<T>(
   list: T[], 
   item: T, 
   max: number
): T[];
```

Append to a list, dropping the oldest entries so it never exceeds `max`.
Mutates `list` in place and returns it.

For the append-only lists an agent keeps in a `sessionSlot` — a timeline, an
activity feed, a session log. Every one of them feeds an LLM summary or a
`syncState` payload, so an uncapped list grows what the model reads and
what crosses the wire for the length of the call, unboundedly. In place
rather than returning a new array because the list is usually a property of
the state object (`incident.timeline`), and reassigning that is a second
thing to remember.

`max` below 1 keeps nothing — including the entry just appended — which is
what "a cap of zero" has to mean.

#### Type Parameters

##### T

`T`

#### Parameters

##### list

`T`[]

##### item

`T`

##### max

`number`

#### Returns

`T`[]

#### Example

```ts
import { pushCapped } from "@alexkroman1/aai";

const log: string[] = ["a", "b", "c"];
pushCapped(log, "d", 3); // ["b", "c", "d"]
```

***

### responseErrorMessage()

```ts
function responseErrorMessage(res: Response, label?: string): Promise<string>;
```

Read a failed `Response`'s error sentence — the one every route this SDK
serves answers with.

Each `4xx`/`5xx` an agent produces carries `{ "error": "<sentence>" }`, and
that sentence is the whole diagnostic: an unknown workflow names the ones
that are declared, a rejected input names the schema issues, a 404 from an
agent that declares no workflows names both of its causes. Anything ELSE in
the path — a proxy, a CDN, a platform broker answering while a sandbox boots
— replies with a body that shape does not fit, so the status is reported
instead, with a short preview of whatever did come back.

`label` names the surface that answered and appears ONLY in that fallback:
when the agent gave its own sentence, prefixing it would put our words in
front of the ones worth reading.

It never throws and never rejects — a body that cannot be read at all
degrades to the bare status, because this runs on a path that is already
reporting a failure and a second one there has nowhere to go.

It deliberately does NOT reuse [isToolFailure](#istoolfailure), whose object shape is
identical today: that guard answers for a TOOL's result union, and the two
contracts are free to move apart.

#### Parameters

##### res

`Response`

##### label?

`string`

#### Returns

`Promise`\<`string`\>

#### Example

```ts
import { responseErrorMessage } from "@alexkroman1/aai/utils";

async function startRun(url: string): Promise<string> {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(await responseErrorMessage(res, "Workflow API"));
  return ((await res.json()) as { runId: string }).runId;
}
```

***

### toolFailure()

```ts
function toolFailure(message: string): ToolFailure;
```

Build a [ToolFailure](#toolfailure) — the failure a tool `execute` RETURNS when the
model should see it and recover.

The pair to [isToolFailure](#istoolfailure), and named to say so. The object literal
`{ error: message }` means exactly the same thing and stays perfectly good
TypeScript; this exists so that a tool reaching for "how do I report a
failure?" finds the constructor next to the guard rather than the framework's
own internal wire form, which is a pre-serialized string this guard does not
narrow.

#### Parameters

##### message

`string`

#### Returns

[`ToolFailure`](#toolfailure)

#### Example

```ts
import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";

const orders = new Map<string, { id: string; total: number }>();

export const orderTotal = tool({
  description: "Look up an order's total",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => {
    const order = orders.get(id);
    if (!order) return toolFailure(`Order ${id} not found.`);
    return { total: order.total };
  },
});
```

## Type Aliases

### ToolFailure

```ts
type ToolFailure = {
  error: string;
};
```

A tool result that reports a recoverable failure to the LLM.

Return one from `execute` (instead of throwing) when the failure is
something the model should see and act on — "no order matches that
description, ask which one" — rather than an internal fault. The runtime
serializes it like any other result, so it reaches the model as
`{"error":"…"}` and reaches a test as an inspectable object.

A tool that returns failures declares them in its own result union
(`Order | ToolFailure`), which is what makes [isToolFailure](#istoolfailure) a
narrowing guard at every call site that forwards one.

#### Properties

##### error

```ts
error: string;
```

## References

### createKeyedLock

Re-exports [createKeyedLock](index.md#createkeyedlock)

***

### isRecord

Re-exports [isRecord](index.md#isrecord)

***

### KeyedLock

Re-exports [KeyedLock](index.md#keyedlock)

***

### KeyedLockOptions

Re-exports [KeyedLockOptions](index.md#keyedlockoptions)

***

### KeyedLockTimeoutError

Re-exports [KeyedLockTimeoutError](index.md#keyedlocktimeouterror)

***

### omitUndefined

Re-exports [omitUndefined](index.md#omitundefined)

***

### safeJsonParse

Re-exports [safeJsonParse](index.md#safejsonparse)

***

### withLock

Re-exports [withLock](index.md#withlock)
