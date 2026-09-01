---
"@alexkroman1/aai-runtime": patch
---

Stop an author's own data from forging a typed-JSON envelope, and decode base64 strictly.

The workflow wire codec tagged binary as `{ __type: "Uint8Array", data }` and dates as
`{ __type: "Date", iso }`, and both revivers recognised one structurally — so a plain
object of that shape, written by an author, decoded as a `Uint8Array` or a `Date` at any
nesting depth with nothing raised. A run's input arrives over public HTTP, so that was
reachable type confusion. An author's reserved keys are now escaped on the way out and
unescaped on the way in, which makes the round trip total for every JSON value.

Decoding a malformed base64 payload used to return arbitrary bytes, because
`Buffer.from(s, "base64")` drops characters outside the alphabet; it now throws. A date
envelope whose `iso` will not parse throws rather than reviving the `NaN` that previously
stalled durable runs.

A bare `__type` envelope still decodes exactly as before, so data already on the wire is
unaffected — deploy the decoder first.
