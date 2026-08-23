---
"@alexkroman1/aai": minor
---

Stop erasing types the SDK already computed, and extract the helpers the
templates had copied past the third time.

`dialog.tool`, `slot.tool` and `slot.updateTool` each bound a result type
parameter and returned `ToolDef<P>` — that is, `unknown` — where `tool()` had
kept it all along. `InferToolOutput` was therefore useless for exactly the
tools a stateful agent writes, and the bill was a hand-rolled `ok<T>()` unwrap
in four template specs plus a couple of dozen casts. They return the body's
real type now.

`DialogToolDef.sendFrom` took `(result: R)`, putting `R` in both the callback's
parameter and `execute`'s return, so TypeScript's inference depended on the
order the two were written in an object literal: a `sendFrom` above `execute`
silently got `unknown` and its narrowing stopped meaning anything while still
compiling. It takes `Exclude<NoInfer<R>, ToolFailure>` now — the parameter
resolves to the success type identically in both orderings, and the `Exclude`
half stops the type lying about a failure arm the runtime already returns
before `sendFrom` ever runs.

`createToolContext` took a `Partial<ToolContext>`, which under
`exactOptionalPropertyTypes` refuses an explicitly-undefined value, so callers
wrote a conditional spread to pass an optional one — the shape the repo's own
invariant gate counts as debt. It admits `undefined` now. `runTool`'s `args` is
optional, which sixty-six call sites were passing `{}` to satisfy.

New on `@alexkroman1/aai/step-files`: `withTempDir`, `readUploadToFile` and
`writeUploadFromFile`, for the upload/local-file round trip ffmpeg needs a real
path for. A new subpath rather than `/step`, because `/step` is held at module
scope by every workflow file and a `node:fs` import there dies at replay.
