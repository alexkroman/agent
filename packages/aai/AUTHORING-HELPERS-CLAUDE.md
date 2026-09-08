# packages/aai — the small authoring helpers

A SIBLING of `CLAUDE.md`, not a second package guide: Claude Code auto-loads
only `CLAUDE.md`, so this is read on demand, which is the right shape for
REFERENCE. That guide is at its 120,000-char cap and carries the one-paragraph
version of each section below.

What is here is the handful of helpers a tool body reaches for that are neither
a primitive (`sessionSlot`, `dialog`, `workflow`) nor a provider: the speech
boundary in both directions, the argument shapes it meets at, randomness, and
the `T | ToolFailure` union's control flow. They share one property worth
stating once — **every one of them replaced a private copy that had already
drifted in a shipped template**, which is the standard a fifth should have to
meet.

## The speech boundary has two directions, and only one had helpers

`sdk/spoken.ts` turns what a caller SAID into one thing they meant.
`sdk/spoken-render.ts` goes the other way. The two are the same problem seen
from each end, and for a long time the SDK owned only the first.

### Inbound: `resolveOne` and the readings it consults

A voice agent's tool arguments do not arrive as ids: "cancel my second order",
"the blue medium one", "eight six four two, one nine…". `resolveOne(candidates,
spoken, { describe, label?, score? })` on the root barrel picks one, and the
interesting part is what it does when the utterance picks NONE or MORE THAN ONE
— a `ToolFailure` that LISTS the candidates, which is the one shape that lets
the model recover on its own turn instead of acting and apologizing.
`spokenDigits` and `spokenOrdinal` are the two readings it consults, exported
because an agent narrowing by its own vocabulary needs them before the pick;
`spokenAlphanumeric` is `spokenDigits` for an id that carries letters (a policy
number, a `#W…` order id — upper-cased ASCII), which two templates had each
normalized with a regex of their own.

Three things the API is load-bearing about:

- **The ORDER is the contract**, and it is why this is a function rather than a
  pattern: no candidates → say so; a POSITION ("the second one", "the last one")
  → take it, since a caller who counts is unambiguous even when nothing else is;
  the scorer, whose tie FAILS rather than resolving; exactly one left → it;
  anything else → ambiguous. The caller narrows first, by whatever its domain
  understands.
- **`spokenOrdinal` matches on word boundaries and cannot do better.** "firstly"
  and "the 21st" are correctly not positions; "the first aid kit" IS one, because
  it really does contain the word "first". That is the reason positions are
  consulted after the caller's own narrowing rather than before, and
  `spoken.test.ts` pins the limitation as a test rather than leaving it to be
  rediscovered.
- **It is on the ROOT and not `/utils`**, which every other tool-body helper
  reaches through. `spoken.ts` imports `toolFailure` from `sdk/utils.ts` — the
  `/utils` subpath module itself — so re-exporting it there would be a cycle.
  The root is where an agent author works anyway.

`retail`'s `resolve.ts` is the worked example, and the split there is the one to
copy: the SDK owns never-guess, the template owns what an order id looks like
when a caller reads it aloud and which words name a status.

### Outbound: `spokenMoney`, `spokenDate`, `spokenTime`, `mintCode`

**The failure these prevent is not ugliness, it is being MISHEARD.** A TTS
engine handed `$240.50` may say "dollar sign two hundred forty point five zero";
handed `2026-06-08` it may spell the digits; handed `19:30` it may say "nineteen
thirty" to a caller who thinks in AM and PM. None of those is a crash and none
shows up in a transcript diff — the text was right and the call still went
wrong. Rendering the words explicitly is the fix, and it has to happen before
the string reaches the model, because the model is not reliably going to do it
for you.

Every voice template had grown a private copy: `hotel-desk` alone carried four,
and `roadside-assist` rendered `$150` where every other desk rendered `$150.00`.

- **`spokenMoney(amount)` takes DOLLARS**, the same unit as `formatMoney`, and
  derives from the same `toFixed(2)` — so the written total on a page and the
  spoken total on the call cannot disagree about a half-cent. A desk counting in
  cents divides on the way in, exactly as it already does for `formatMoney`.
  Singular is respected on both halves ("1 dollar and 1 cent"), and a negative
  amount leads with the WORD "minus": a `-` renders as silence or as "dash"
  depending on the engine, and a refund read as a charge is the worst available
  outcome. Under a dollar the dollar half is dropped ("75 cents"), which is what
  a person says.
- **`spokenDate(iso)` is `"Monday, June 8"`** — no year, because a date being
  agreed to on the phone is almost always within the year, and the WEEKDAY is
  included because it is the half a caller actually checks ("the 8th" gets
  agreed to and then turns out to be a Tuesday).
- **`spokenTime(hhmm)` drops the minutes on the hour** — `"7 PM"` rather than
  `"7:00 PM"`, which an engine reads as "seven zero zero PM". `AM`/`PM` are
  upper-cased because that is the spelling engines pronounce as letters most
  reliably.
- **`mintCode(prefix, options?)`'s alphabet IS its design.** `0`/`O`, `1`/`I`
  and `L` are all absent, because every code a voice agent issues gets read down
  a phone and read back, and those are the characters that come back wrong — a
  caller says "oh" for a zero, an STT writes `1` for a spoken "el". Removing
  them needs no correction logic anywhere downstream, and it is why this belongs
  beside `spokenAlphanumeric`, which is what parses the read-back. Its retry is
  BOUNDED: the `for (;;)` it replaced turned a full code space into a hung call.

**Fixed ASCII shapes, no `Intl`** — the same rule `format.ts` argues at length,
and it bites harder here. The `toLocaleDateString("en-US", …)` this replaced
answers to the host's ICU build, so a desk that reads dates correctly on a
laptop can read them differently inside a sandbox, and no spec catches it
because the spec runs on the laptop. The month and weekday names are written
out for exactly that reason. An agent that needs another language renders its
own; that is a different feature, not an option on this one.

A value the renderers cannot read is returned UNCHANGED rather than throwing —
degrade, like every formatter in `format.ts`. Declare the argument with
`isoDate()` and a caller never reaches that path.

## The argument shapes both directions meet at

`sdk/calendar.ts` and `sdk/tool-fields.ts`. A date reaches a tool as
`"2026-06-08"` and a time as `"19:30"`, because that is the one shape a model
reliably produces when the prompt asks for it. Both are CIVIL values — "the 8th
of June", not an instant — and nothing here converts either to a timestamp. That
is the point: the moment a `YYYY-MM-DD` becomes a `Date` in the host's zone,
"checkout on the 8th" is off by a day for half the planet, and the bug only
shows up on a machine configured differently from the author's. The arithmetic
goes through `Date.UTC` and comes straight back out as a string; UTC is not a
claim about where anyone is, it is the only zone with no DST, which makes
`addDays` add days rather than sometimes 23 or 25 hours.

- **`isIsoDate` is a real CALENDAR check, not a shape check.** `2026-02-30`
  matches the pattern and is not a date, and a desk that accepted February 30th
  booked a stay it could never honour — surfacing as a nonsense night count
  rather than as a rejected argument. The check is a `Date.UTC` round-trip,
  which normalizes out of range rather than rejecting, so the day no longer
  matches. **`Date.UTC` also maps a year of 0-99 onto 1900-1999** — legacy
  two-digit-year behaviour — so the round-trip needs a `setUTCFullYear` for
  those, or `0001-01-01` comes back as 1901 and a shape-valid date is refused
  for a reason nothing states. No voice agent sees such a year; the point is
  that the predicate agrees with its own documentation.
- **`isClockTime` requires zero padding**, deliberately rather than strictly:
  `"9:05"` and `"09:05"` sort differently as strings, so a desk that stores
  whichever the model produced cannot compare two of its own appointments.
- **`addDays` and `daysBetween` THROW a `RangeError`** on a value that is not a
  date. Arithmetic on one has no right answer and a silently wrong one becomes a
  booking. `daysBetween` is signed and counts NIGHTS — same day is `0`, the
  reading a hotel, a car rental and a subscription all want.

### `isoDate(what)` / `clockTime(what)` put the rule where the MODEL reads it

The duplication is not the interesting part; WHERE the rule lives is. A check in
the body runs after the model has already committed to an argument, so the model
learns the format by being refused — a wasted turn on every call, and a refusal
sentence the author had to write. Declared on the schema, the same rule reaches
the model as JSON Schema before it calls anything, and `parseToolInput`
rejects a bad value before `execute` runs.

`hotel-desk` had ten `z.string().describe("YYYY-MM-DD")` + `if (!isIsoDate(...))
return toolFailure(...)` pairs, in four different sentences for one rule, plus
five hand-rolled `HH:MM` checks in three wordings and two different failure
shapes (`{ error }` and `toolFailure(…)`).

Each field takes what it is FOR — `isoDate("the arrival date")` — so the
description and the rejection both name the argument rather than making a caller
map a generic sentence back onto one of four date parameters.

**`refine(isIsoDate)` rather than zod's own `z.iso.date()`**, so the predicate an
agent's own code calls and the rule its schema enforces are one definition and
cannot disagree: `z.iso.date()` accepts `2026-02-30`.

## `ctx.random` — a tool's randomness as an argument

A tool that calls `Math.random()` directly cannot be tested. Not "is awkward to
test" — a spec asserting on what it produced has no way to say which value it
should have produced, so the assertion becomes a range check or the test is not
written. Seven shipped templates reached for the global in ten places (dice, a
shuffle, an ETA jitter, an order number, a reference code), and exactly one —
`word-wrangler`, which threads `random: () => number = Math.random` through as a
parameter — was covered.

`ToolContext.random` generalizes that one template's fix. In production it IS
`Math.random`, so it buys nothing at run time; what it buys is a tool whose
randomness a spec can state. `sdk/random.ts` publishes the three shapes a body
actually wants — `randomInt`, `pickOne`, `shuffled` — each taking a
`RandomSource` as its LAST argument, defaulting to `Math.random` so a call site
with no context still reads well.

Three edges the helpers exist to get right once: `randomInt` clamps a source
that returns exactly `1` (outside `Math.random`'s contract, well inside what a
hand-written stub does — unclamped it indexes one past the end of every list);
`pickOne` answers `undefined` for an empty list rather than being asserted away
with `as T`; and `shuffled` is a Fisher-Yates walk over a COPY, because
`sort(() => Math.random() - 0.5)` is not uniform and a shuffle applied in place
to a slot's frozen value is a `TypeError`.

**`createToolContext` defaults it to a SEEDED source** — the one default there
that deliberately differs from the runtime. A spec that never thinks about
randomness is then still deterministic, which is the whole reason the field
exists. Seeded rather than CONSTANT, and that distinction matters: `() => 0.5`
looks like the simplest deterministic source and is degenerate, since every draw
is identical, so `shuffled` returns a fixed permutation and `mintCode` re-draws
one code until it gives up. `createSeededRandom(seed)` (mulberry32) is public
for the same reason a seed script wants it: a catalog shuffled the same way on
every boot is reviewable, where one shuffled by `Math.random` makes every diff
of its output noise.

**Not journaled, and not a replay seam.** A tool call happens once; a WORKFLOW
body replays, and `WorkflowContext.random()` is the different mechanism that
makes a run re-derive the same number. `guard-invariants` rule 30 already
refuses the global in a workflow body. **Not cryptographic** either — anything
an attacker gains by guessing wants `crypto.getRandomValues`.

## `orFail` / `failable` — forwarding a `ToolFailure` out of a chain

`T | ToolFailure` is this SDK's Result: a helper answers with the thing or with
a sentence the model can recover from, and its caller passes the failure along
unchanged. The pattern is right; what is tedious is that the passing along is a
statement per lookup, and shipped templates carried 48 of them. Half those lines
say nothing about the domain, and each names its variable twice — so
`if (isToolFailure(order)) return user;` reads as noise rather than as the bug
it is.

`failable` plus `orFail` is the same function with the forwarding written once.

### Three things it is deliberately NOT

- **Not a change to how a tool reports failure.** `failable` answers
  `R | ToolFailure` — the same union, returned the same way. Nothing in the
  runtime knows this exists, no runner had to learn a new error type, and a
  function not wrapped in `failable` behaves exactly as before.
- **Not a general exception facility.** The sentinel is a private class and
  `failable` catches only that, so every other throw passes through untouched
  and a `TypeError` in a wrapped body still reaches the tool executor. `orFail`
  outside a `failable` is therefore a bug that behaves like one.
- **Not for a `slot.update` body that has already written.** A mutator that
  RETURNS a failure keeps the mutations it made before returning; one that
  THROWS stores nothing, which `session-slot.ts` promises deliberately. `orFail`
  throws, so inside an `update` window it discards the draft. Reach for it where
  the guard comes before the writing.

### When it PAYS, measured on the templates

The wrapper is three lines when it has to be introduced, and each guard it
removes is one. So the arithmetic is simply whether the function is already a
declaration:

- **A named helper returning `T | ToolFailure`** — `retail`'s `planModifyItems`,
  `planExchange`, `assertCanCoverDiff` — pays immediately. `failable` replaces
  the `function` keyword, so it costs nothing and every guard is a line saved.
  Nine guards became three `orFail`s there.
- **An inline `slot.update` mutator with one or two guards does NOT.**
  `dispatch-center`'s six tools were converted and reverted: the wrapper cost
  more than the guards it removed, and the plain
  `if (isToolFailure(inc)) return inc;` is a perfectly good first line of a body.
  There is no rule here that a chain of two lookups needs this.

## Reading a WAV is the SDK's now too (`sdk/wav-parse.ts`)

`sdk/wav.ts`'s module doc used to disclaim the parse direction — "reading an
arbitrary WAV means walking a chunk list with `LIST`/`bext` chunks in it, which
is a template's business rather than a promise this makes" — and the template
that owned it is exactly why that was wrong. The chunk walk is not
recording-specific knowledge; it is the RIFF container, which is the same
everywhere and is got wrong the same way everywhere.

**The 44-byte assumption is the bug it exists to make unavailable.** `wavHeader`
writes exactly 44 bytes, so it is tempting to read 44 back. Real files do not
oblige: ffmpeg writes a `LIST`/`INFO` chunk naming its own version ahead of the
samples, so its WAV output has a **78-byte** header on ffmpeg 6.1 and a
different length the next time that version string changes. A reader that skips
44 bytes treats `INFO`, the encoder name and the `data` chunk header as PCM —
which does not fail, it transcribes as confident nonsense at the front of every
recording, and the length of the damage depends on a string in somebody else's
build.

Three more the walk has to get right, all on files that exist: a chunk payload
is padded to an even length and the pad byte is NOT counted by the declared
size; the declared data length is not the file's (a streaming encoder writes `0`
or `0xFFFFFFFF`, a truncated download declares more than it holds, so the range
is the INTERSECTION and `totalBytes` is a parameter); and `WAVE_FORMAT_EXTENSIBLE`
(`0xFFFE`) is not PCM whatever it usually wraps, so it is refused rather than
guessed.

**What is NOT there is policy** — a size cap, a segment plan, a minimum
duration. Those are the caller's and differ per provider endpoint.
`transcription-workflow` keeps `MAX_BYTES_PER_SECOND` and `planSegments`, and
the density cap it used to make inside `parseWav` is now a separate
`assertCuttable` pass — which is what lets `cuttable` and `heavierThanNormalized`
ask their two questions apart: a file that fails only the second is one
downsampling repairs.

## `roundMoney` shares `formatMoney`'s basis, on purpose

Money in a float is money in a type that cannot represent a cent, so every
arithmetic result that will be COMPARED, summed, or stored goes through
`roundMoney` (`sdk/format.ts`, `/utils`).

**It rounds through `toFixed(2)`, not `Math.round(n * 100) / 100`**, and the two
are not the same function — they disagree in BOTH directions. `2.675 * 100` is
`267.49999999999994`, so multiply-and-round answers `2.68` where `toFixed`
answers `2.67`; `3.005 * 100` is `300.50000000000006`, so it answers `3.01`
where `toFixed` answers `3.00`. Either is a defensible rounding of a value that
is not really 2.675. What is not defensible is a total that compares as `3.01`
and PRINTS as `$3.00`, which is exactly what `retail` did — its own spec pinned
`money(3.005) === 3.01` while `formatMoney` rendered `$3.00`. One basis, so they
cannot disagree.

`hotel-desk` counts in CENTS and divides on the way into both `formatMoney` and
`spokenMoney`; `retail` counts in float dollars and rounds at each step. Both
are legal — counting in integer cents end to end is stricter and is what a
ledger should do — but a template must pick one and say which.
