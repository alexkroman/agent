---
"@alexkroman1/aai": minor
---

`orFail(stepX)` is now the one way to classify a step call's failure.

- `orFail`, handed a FUNCTION, answers the same function with its failure classified for the step engine: what it throws, or a non-2xx `Response` it resolves to, becomes a `FatalError` or a `RetryableError` carrying the far side's `Retry-After`. Anything it cannot classify is rethrown unchanged. Write `orFail(stepFetch)(url)`, `orFail(stepGenerateJson)(prompt, { schema })`, `orFail(stepTranscribeSubmit)(audioUrl)` or `orFail(sendToChannel)(channel, message)`. It is the same `orFail` the root exports for forwarding a `ToolFailure`, and `@alexkroman1/aai/step-errors` now re-exports it.
- The eight `*OrFail` twins on `@alexkroman1/aai/step-errors` (`stepFetchOrFail`, `stepGenerateOrFail`, `stepGenerateJsonOrFail`, the four `stepTranscribe*OrFail` and `sendToChannelOrFail`) are deprecated aliases of `orFail(stepX)`. They behave as before and will be removed in a later epoch.
- The templates, the scaffold guide and the studio prompts use the new form.
