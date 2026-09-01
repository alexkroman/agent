---
"@alexkroman1/aai": minor
---

Stop a durable fan-out discarding work it has already paid for, and stop the platform answering a permanent storage failure with a retry.

`mapConcurrent` now drains the calls already in flight before propagating a rejection. `Promise.all` rejected the instant one slot did, which abandoned siblings mid-call — in a workflow those are steps whose provider call had often already succeeded, so their journal entries never landed and the resume re-issued and re-billed them. The DevKit reported them as "run failed with N uncommitted operation(s)".

The platform's `POST /:slug/workflow-storage` now classifies permanent world failures instead of letting them fall through to the blanket 503. A `RunExpiredError` (a write to a run in a terminal state) answers 410 and an `EntityConflictError` answers 409, and the guest turns those back into the DevKit's own classes so its runtime stops rather than retrying a call that can never succeed.

The transcription-workflow template no longer cuts a heavy WAV as-is: a file that parses but is denser than 16 kHz mono is converted first, because a 48 kHz stereo segment is six times the upload per request and was timing out against the sync endpoint's 30s deadline.
