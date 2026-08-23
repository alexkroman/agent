---
"@alexkroman1/aai": patch
---

Five authoring-surface fixes found by manual testing.

- `multipartBody` escapes a part's `name` and `filename`. An uploader-supplied
  filename (`uploadInfo().name`, which `stepTranscribeSync` forwards) could
  close the quoted header value and append headers of its own to a step's
  request.
- An AssemblyAI TTS `language` the declared voice cannot speak is now a config
  error naming the voices that can, instead of an agent that connects, reports
  ready and never speaks. Includes the pair the SDK built itself:
  `assemblyAITts({ language: "fr" })` filled in the English default voice. A
  voice this release's catalog does not list is still passed through.
- Every `ctx.send` drop is logged. The two wire caps — an over-long event name
  and an over-64 KB payload — returned silently while `ToolContext.send`
  documented "dropped (with a warning log)".
- `createToolContext()`'s `send` applies that same rule, so `ctx.sent` records
  what the client would receive. It used to record events production throws
  away, passing a spec for a notification nobody ever got.
- `pcmDurationMs` refuses a `Uint8Array` where a byte count goes rather than
  answering `NaN`, and names itself instead of `encodeWav` in the format check
  the two share.
