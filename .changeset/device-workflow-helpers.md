---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-cli": patch
---

Workflow helpers for apps that report to a device, so each app stops carrying its own copy:

- `ctx.workflows.start(def, input, { dedupeKey })` starts at most one run per workflow and key: a later (or racing) start with the same `dedupeKey` resolves the existing run's id, whatever its status. The run id is derived from the key, so no store changed.
- `ctx.workflows.findByKey(key, { since?, statuses?, limit? })` lists a correlation key's runs across every declared workflow, newest first; `ctx.workflows.cancelAll(def, key)` cancels that key's unfinished runs of one workflow and resolves how many it ended.
- `workflow({ onFailure })` — a hook (or `{ run, maxAttempts }`) the engine runs as the journaled step `onFailure` when a run fails for good, before the failure is recorded; never for a suspension, cancel, journal outage or divergence refusal.
- `ctx.poll(name, check, { everyMs, maxMs, done, maxAttempts? })` — a durable check-and-sleep loop resolving `{ value, done, checks }`; `stepPollUntil(check, { everyMs, maxMs, done, signal? })` (`/step`) is the in-step, non-durable sibling.
- `stepSayOnClient(clientId, { id, event, text, data?, sampleRate?, voice? })` (`/step`) speaks and pushes to a device in one call, with `data.said = text`, re-using the audio across the step's retries; `DEFAULT_CLIENT_DELIVERY_ATTEMPTS` (120) as the step's `maxAttempts` rides out an hour offline. `agent({ clientInbox: { sampleRate } })` sets its default rate.
- `stepEnvContext()` and the `EnvContext` type (`/step`): the whole step env plus the running step's cancel signal, in the shape a `ToolContext` already has. `StepInfo` gains `signal`.
- `spokenErrorReason(err, { max? })` (`/utils`): a failure as one short sayable sentence, credentials redacted and URLs removed.
