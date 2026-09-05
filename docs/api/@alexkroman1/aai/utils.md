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
