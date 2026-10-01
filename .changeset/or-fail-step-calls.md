---
"@alexkroman1/aai": major
---

`orFail(stepX)` is now the one way to classify a step call's failure, and the eight `*OrFail` twins are removed.

- `orFail`, handed a FUNCTION, answers the same function with its failure classified for the step engine: what it throws, or a non-2xx `Response` it resolves to, becomes a `FatalError` or a `RetryableError` carrying the far side's `Retry-After`. Anything it cannot classify is rethrown unchanged. Write `orFail(stepFetch)(url)`, `orFail(stepGenerateJson)(prompt, { schema })`, `orFail(stepTranscribeSubmit)(audioUrl)` or `orFail(sendToChannel)(channel, message)`. It is the same `orFail` the root exports for forwarding a `ToolFailure`, and `@alexkroman1/aai/step-errors` now re-exports it.
- **Breaking:** `stepFetchOrFail`, `stepGenerateOrFail`, `stepGenerateJsonOrFail`, `stepTranscribeSyncOrFail`, `stepTranscribeUploadOrFail`, `stepTranscribeSubmitOrFail`, `stepTranscribePollOrFail` and `sendToChannelOrFail` are gone from `@alexkroman1/aai/step-errors`. Replace `stepXOrFail(args)` with `orFail(stepX)(args)`, importing `stepX` from `@alexkroman1/aai/step` (or `sendToChannel` from `@alexkroman1/aai/channels`). The behaviour is identical.
- The templates, the scaffold guide and the studio prompts use the new form.
