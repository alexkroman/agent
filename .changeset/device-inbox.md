---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

A run can now reach a device after its voice session has closed — a reminder that fires an hour later, a job that finishes overnight.

- `WS /inbox?client=<id>` on `createRuntimeServer` (so `aai dev`, `aai start` and self-hosted servers) is an idle socket a device holds open. It sits behind the same session auth as `/websocket`.
- `stepNotifyClient(clientId, { id, event, data?, audio? })` on `@alexkroman1/aai/step` pushes a notice to it and resolves when the device acks. When the device is offline, busy, or never acks, it throws `ClientUnreachableError`, which is retryable, so the step's own retries redeliver.
- `sessionClientId(ctx)` on `@alexkroman1/aai` returns the id the device sent as `?client=` on its voice socket, so a tool can put it in the run's input (new `SessionStartOptions.clientId`).
