---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"aai-server": patch
---

Place phone calls from a workflow step, and label workflow runs.

`stepPlaceCall` and `stepCallStatus` (`@alexkroman1/aai/step`) are the outbound half of telephony. The SDK already answered calls on `WS /phone`.

- `stepPlaceCall({ carrier: "twilio", to, from, agentUrl, parameters?, timeLimitS?, ringTimeoutS?, credentials? })` asks Twilio to dial and returns `{ callId }`. Once the call is answered, Twilio streams it to `<agentUrl>/phone?carrier=twilio`, and each entry in `parameters` becomes a `<Parameter>`, which the answering session reads as `call.parameters`. Everything in the TwiML is XML-escaped.
- `timeLimitS` defaults to `DEFAULT_CALL_TIME_LIMIT_S` (600). `ringTimeoutS` defaults to `DEFAULT_CALL_RING_TIMEOUT_S` (30).
- Credentials come from the step env keys `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (exported as `TWILIO_ACCOUNT_SID_ENV` and `TWILIO_AUTH_TOKEN_ENV`), unless a `credentials` object is passed.
- `stepCallStatus({ carrier, callId })` returns one of `queued`, `ringing`, `in-progress`, `completed`, `busy`, `no-answer`, `failed` or `canceled`. Twilio's `initiated` is reported as `queued`.
- Every failure is a `PlaceCallError` carrying `status`, `code` and `retryable`. `retryable` is true only for a 429, a 5xx or a request that got no answer, and `throwStepError` reads it. Twilio codes 20003, 21211/21217, 21210/21212, 21219 (trial account calling an unverified number) and 21215 get a sentence saying what to fix. The auth token, the account SID and the Basic credential are redacted from every message.
- A dial that Twilio accepted but returned no call SID for is not retryable, because the phone may already be ringing.
- Twilio only for now. Any other carrier gets a non-retryable error saying so.
- `stubPlaceCall()` (`@alexkroman1/aai/testing`) stands in for Twilio's Calls API in a spec. It records each dial as the answering session would see it, and answers status reads and staged refusals through the SDK's own classification.

`ctx.workflows.start(def, input, { key, label })` now takes a `label` that says what the run is, e.g. "Call the plumber, due 5 PM". The label is stored with the run in every journal (memory, Postgres, platform) and returned on every snapshot: `get`, `find`, `recent` and `GET /workflows/runs`.

- Control characters become spaces, and the label is trimmed and cut at `MAX_WORKFLOW_RUN_LABEL_CHARS` (200). An empty label means no label.
- A self-hosted Postgres journal gains a nullable `label` column, added at boot by `ensureWorkflowJournalSchema`. The platform's `aai_platform.workflow_runs` gains the same column through a migration (`20260929010000_workflow_run_label.sql`), and the platform bounds a guest's label the same way before storing it.
