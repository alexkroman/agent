# utils

`@alexkroman1/aai/utils` — the zero-dependency helpers a TOOL body reaches for.

A FACADE. The subpath resolves here rather than at `utils.ts`, which buys two
things the direct form could not. That module can be SPLIT as it grows without
moving the published entry point — the path an implementation file happens to
have is not a thing to promise anyone — and a name it gains next reaches the
public surface only when a line is added below, rather than the moment it is
written.

Named re-exports rather than `export *` for the second half of that: the
wildcard form re-exports whatever arrives, and needs a `noReExportAll`
suppression the escape-hatch ratchet only lets move down.

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

### fitToolResult()

```ts
function fitToolResult(value: unknown, options?: FitToolResultOptions): unknown;
```

`value` made to fit a tool result of `maxChars` characters of JSON without
cutting through its structure — nulls and empties dropped, long strings
clipped, the longest lists shortened from the end — plus a `note` saying so
when anything was trimmed from a list. See the module doc for the order.

Answers `value` compacted when that alone fits; `{ result, note }` when
lists were shortened; `{ result_start, note }` (the start of the JSON text)
when nothing structural could make it fit. Never mutates `value`.

#### Parameters

##### value

`unknown`

##### options?

[`FitToolResultOptions`](#fittoolresultoptions)

#### Returns

`unknown`

#### Example

```ts
import { fitToolResult } from "@alexkroman1/aai/utils";

export function emailsForModel(emails: unknown[]): unknown {
  return fitToolResult({ emails }, { maxChars: 12_000, maxString: 800 });
}
```

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

### formatMoney()

```ts
function formatMoney(amount: number, symbol?: string): string;
```

`$1,234.00` — an amount of money, grouped in threes and always to the cent.

`symbol` is a PREFIX and defaults to `"$"`; pass another (`"€"`, `"£"`) to
change the glyph. It does not change the SHAPE, which is fixed: this is not a
localization seam, for the reason the module doc gives. An agent that owes a
caller `1.234,56 €` formats it itself.

Always two decimal places, because the alternative drifts: a bare
`toLocaleString` renders `$1,234` for a round number and `$1,234.5` for a
change of fifty cents, so a price list rendered through it does not line up
and a total read aloud sounds like a different kind of number than the parts
that made it. Rounding is `toFixed`'s.

The sign LEADS (`-$4.99`), which is how a refund is written. An amount that
rounds to zero has no sign, so a rounding error just under zero prints
`$0.00` rather than `-$0.00`. Non-finite is `$0.00`, matching
[formatBytes](#formatbytes) and [formatDuration](#formatduration).

#### Parameters

##### amount

`number`

##### symbol?

`string`

#### Returns

`string`

#### Example

```ts
import { formatMoney } from "@alexkroman1/aai/utils";

formatMoney(0); // "$0.00"
formatMoney(17.5); // "$17.50"
formatMoney(2_292.371); // "$2,292.37"
formatMoney(-4.99); // "-$4.99"
formatMoney(1_234, "€"); // "€1,234.00"
```

***

### jsonClient()

```ts
function jsonClient(options: JsonClientOptions): JsonClient;
```

Declare a JSON REST API once, and call it from tools, routes and steps.

#### Parameters

##### options

[`JsonClientOptions`](#jsonclientoptions)

#### Returns

[`JsonClient`](#jsonclient)

#### Example

```ts
import { requireEnv } from "@alexkroman1/aai";
import { HttpError, jsonClient } from "@alexkroman1/aai/utils";

const mem0 = jsonClient({
  baseUrl: "https://api.mem0.ai/v1",
  headers: (env) => ({ authorization: `Token ${requireEnv({ env }, "MEM0_API_KEY")}` }),
  label: "mem0",
});

export async function forget(ctx: { env: Record<string, string> }, id: string) {
  try {
    await mem0(ctx, "DELETE", `/memories/${encodeURIComponent(id)}/`);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return false;
    throw err;
  }
}
```

***

### normalizePhone()

```ts
function normalizePhone(raw: string, options?: NormalizePhoneOptions): string | undefined;
```

`raw` as an E.164 number (`"+15125550123"`), or `undefined` when it is not
one. Spaces, dashes, dots and parentheses are formatting and are stripped.
With `defaultCountry`, a number said without its country code is read in
that country's plan.

#### Parameters

##### raw

`string`

##### options?

[`NormalizePhoneOptions`](#normalizephoneoptions)

#### Returns

`string` \| `undefined`

#### Example

```ts
import { normalizePhone } from "@alexkroman1/aai/utils";

normalizePhone("+44 20 7946 0958"); // "+442079460958"
normalizePhone("(512) 555-0123"); // undefined — no country code, no guess
normalizePhone("(512) 555-0123", { defaultCountry: "US" }); // "+15125550123"
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

### roundMoney()

```ts
function roundMoney(amount: number): number;
```

An amount snapped to whole cents — `roundMoney(0.1 + 0.2)` is `0.3`.

Money in a float is money in a type that cannot represent a cent: `0.1 + 0.2`
is `0.30000000000000004`, and a gift-card balance compared for equality
against a price difference is then a coin toss. Every arithmetic result that
is going to be COMPARED, summed into a running total, or stored goes through
here.

The alternative is counting in integer cents end to end, which is stricter
and is what a ledger should do. This is for the common case a template
actually has — dollars in a float, arriving that way from a catalog — where
the fix is to round at each step rather than to re-unit the whole domain.
[formatMoney](#formatmoney) rounds for DISPLAY and does not change the value, so a
total assembled without this can print `$0.30` and still fail `=== 0.3`.

**It rounds through `toFixed(2)`, not `Math.round(n * 100) / 100`**, and the
two are not the same function. `2.675 * 100` is `267.49999999999994`, so the
multiply-and-round spelling — the one three templates each wrote — answers
`2.68` where `toFixed` answers `2.67`. Either is a defensible rounding of a
value that is not really 2.675; what is not defensible is a total that
compares as `2.68` and PRINTS as `$2.67`, which is what you get when the
rounding here and [formatMoney](#formatmoney)'s disagree. One basis, so they cannot.

Non-finite passes through unchanged: there is no nearest cent to `NaN`, and
quietly answering `0` would hide the arithmetic that produced it.

#### Parameters

##### amount

`number`

#### Returns

`number`

#### Example

```ts
import { roundMoney } from "@alexkroman1/aai/utils";

0.1 + 0.2; // 0.30000000000000004
roundMoney(0.1 + 0.2); // 0.3
roundMoney(19.995); // 20
```

***

### spokenErrorReason()

```ts
function spokenErrorReason(err: unknown, options?: SpokenErrorReasonOptions): string;
```

Turn a failure into a short reason a person can hear: its FIRST sentence,
with credentials redacted and URLs removed, capped at about one spoken
sentence.

What a workflow's failure announcement says after "Sorry, I couldn't finish
that:". Redacts `key=`/`token=`/`secret=`/`password=`/`sig=` values (in a
query string or bare), `Bearer`/`Basic` credentials and vendor-shaped keys
(`sk-…`), drops URLs entirely, and answers `"something went wrong"` when
nothing sayable is left. Never throws, whatever it is handed.

#### Parameters

##### err

`unknown`

Anything thrown — an `Error`, a string, an object.

##### options?

[`SpokenErrorReasonOptions`](#spokenerrorreasonoptions)

`max` caps the length (default 160).

#### Returns

`string`

A trimmed, non-empty reason.

#### Example

```ts
import { spokenErrorReason } from "@alexkroman1/aai/utils";

const why = spokenErrorReason(
  new Error("Request to https://api.example.com/v1?key=abc123 failed with 403. Retry later."),
);
// "Request to failed with 403."
void why;
```

## Classes

### HttpError

A refused request from a [jsonClient](#jsonclient-1): the HTTP `status`, a `message`
of the form `"<label> <status>: <what the service said>"`, and the parsed
`body` (the raw text when it was not JSON; absent when empty).

Branch on `status` (`err instanceof HttpError && err.status === 404`), never
on the message's wording.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new HttpError(
   status: number, 
   message: string, 
   body?: unknown
): HttpError;
```

###### Parameters

###### status

`number`

###### message

`string`

###### body?

`unknown`

###### Returns

[`HttpError`](#httperror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### body?

```ts
readonly optional body?: unknown;
```

The response body — parsed JSON, else the raw text; absent when empty.

##### status

```ts
readonly status: number;
```

The HTTP status the service answered.

## Interfaces

### FitToolResultOptions

What [fitToolResult](#fittoolresult) takes.

#### Properties

##### hint?

```ts
optional hint?: string;
```

Appended to the note on a trimmed answer — where the rest can be had:
`"Use the workbench to go through all of them."`.

##### maxChars?

```ts
optional maxChars?: number;
```

Longest the serialized answer may be, in characters. Default `MAX_TOOL_RESULT_CHARS`.

##### maxString?

```ts
optional maxString?: number;
```

Longest any one string may be; longer ones are clipped with `…`. Default: no clip.

***

### JsonClientContext

The context a [JsonClient](#jsonclient) call reads: a tool's `ctx`, a route's
`ctx`, or `{ env: … }` built from `stepEnv` in a workflow step.

#### Properties

##### env

```ts
env: Readonly<Partial<Record<string, string>>>;
```

The agent's environment — what `headers` and `baseUrl` read.

##### signal?

```ts
optional signal?: AbortSignal;
```

Cancels the request: pass the tool's or route's own signal.

***

### JsonClientOptions

What [jsonClient](#jsonclient-1) takes.

#### Properties

##### baseUrl

```ts
baseUrl: 
  | string
  | ((env: Readonly<Partial<Record<string, string>>>) => string);
```

The API's base URL, e.g. `"https://api.mem0.ai/v1"`; a request's `path` is
appended to it. A FUNCTION reads it from the env on each call (a
self-hosted service's URL is configuration). Trailing slashes are dropped.

##### errorMessage?

```ts
optional errorMessage?: (body: unknown) => string | undefined;
```

The service's own sentence from a refused body — parsed JSON when it
parsed, else the raw text. Answer `undefined` to fall back to a preview of
the raw body. E.g. `(body) => isRecord(body) && isRecord(body.error) ?
String(body.error.message) : undefined`.

###### Parameters

###### body

`unknown`

###### Returns

`string` \| `undefined`

##### fetch?

```ts
optional fetch?: {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  (input: string | Request | URL, init?: RequestInit): Promise<Response>;
};
```

For TESTS: the `fetch` to call. Defaults to the global one.

###### Call Signature

```ts
(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

###### Parameters

###### input

`RequestInfo` \| `URL`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

###### Call Signature

```ts
(input: string | Request | URL, init?: RequestInit): Promise<Response>;
```

[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/fetch)

###### Parameters

###### input

`string` \| `Request` \| `URL`

###### init?

`RequestInit`

###### Returns

`Promise`\<`Response`\>

##### headers?

```ts
optional headers?: 
  | Record<string, string>
  | ((env: Readonly<Partial<Record<string, string>>>) => Record<string, string>);
```

Headers for every request, typically the credential:
`(env) => ({ authorization: \`Token ${requireEnv({ env }, "MEM0_API_KEY")}\` })`.
Read per call, so a secret set after start is picked up and a missing one
throws where the call is made. Merged over the JSON defaults
(`content-type`/`accept: application/json`).

##### label

```ts
label: string;
```

Names the service in every failure message: `"mem0"` → `"mem0 404: …"`.

***

### JsonRequestInit

Per-call extras for a [JsonClient](#jsonclient) request.

#### Properties

##### headers?

```ts
optional headers?: Record<string, string>;
```

Headers for this request only, merged over the client's.

***

### NormalizePhoneOptions

What [normalizePhone](#normalizephone) takes.

#### Properties

##### defaultCountry?

```ts
optional defaultCountry?: "US" | "CA";
```

The country a number WITHOUT a `+` is assumed to be in. `"US"` and `"CA"`
(North America, `+1`): ten digits, or eleven starting with `1`. Unset, a
number without its `+` is refused rather than guessed at.

## Type Aliases

### JsonClient

```ts
type JsonClient = <T>(ctx: JsonClientContext, method: string, path: string, body?: unknown, init?: JsonRequestInit) => Promise<T>;
```

One call to the API a [jsonClient](#jsonclient-1) describes. Resolves to the parsed
JSON body, or `{}` for an empty one (a `204`); rejects with an
[HttpError](#httperror) for a non-2xx, or a 2xx whose body is not JSON.

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### ctx

[`JsonClientContext`](#jsonclientcontext)

##### method

`string`

##### path

`string`

##### body?

`unknown`

##### init?

[`JsonRequestInit`](#jsonrequestinit)

#### Returns

`Promise`\<`T`\>

***

### SpokenErrorReasonOptions

```ts
type SpokenErrorReasonOptions = {
  max?: number;
};
```

Options for [spokenErrorReason](#spokenerrorreason).

#### Properties

##### max?

```ts
optional max?: number;
```

The most characters the reason may run to, cut on a word boundary where
there is one. Defaults to 160 — about one spoken sentence.

## References

### createKeyedLock

Re-exports [createKeyedLock](index.md#createkeyedlock)

***

### errorDetail

Re-exports [errorDetail](index.md#errordetail)

***

### errorMessage

Re-exports [errorMessage](index.md#errormessage)

***

### failable

Re-exports [failable](index.md#failable)

***

### isRecord

Re-exports [isRecord](index.md#isrecord)

***

### isToolFailure

Re-exports [isToolFailure](index.md#istoolfailure)

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

### orFail

Re-exports [orFail](index.md#orfail)

***

### pushCapped

Re-exports [pushCapped](index.md#pushcapped)

***

### responseErrorMessage

Re-exports [responseErrorMessage](index.md#responseerrormessage)

***

### safeJsonParse

Re-exports [safeJsonParse](index.md#safejsonparse)

***

### toolFailure

Re-exports [toolFailure](index.md#toolfailure-1)

***

### ToolFailure

Re-exports [ToolFailure](index.md#toolfailure)

***

### withLock

Re-exports [withLock](index.md#withlock)
