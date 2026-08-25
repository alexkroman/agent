---
"@alexkroman1/aai": major
---

Remove legacy and deprecated code, and tighten the types that only existed to
tolerate it.

**Removed outright.** The deprecated `mapInBatches` alias is gone from
`@alexkroman1/aai/step` — use `mapConcurrent`. The `aai eject` command is gone:
every `aai init` and `aai pull` already layers in `server.mjs` and the
`prestart`/`start` pair, so no project needs retrofitting. `startAndWait` no
longer re-reads a run for an agent that predates `wait`. The parts-upload path no
longer treats a 404/405 as "this agent has no `/parts` routes".
`TransportCallbacks.onSessionReady` is gone — it had no production
implementation.

**Now required on the wire.** `error.reported.fatal` and
`ClientConfigResponse.page` are no longer optional. Absent used to mean "fatal"
and "voice"; every emitter and every server states it instead, so a turn-level
failure can no longer end a session by omission.

**One name per concept.** `@alexkroman1/aai/protocol` no longer publishes the
direction-named aliases `ClientMessage`, `ClientMessageSchema`,
`CLIENT_MESSAGE_TYPES`, `ServerMessage` and `ServerMessageSchema`. Use
`SessionCommand`, `SessionCommandSchema`, `SESSION_COMMAND_TYPES`,
`SessionEvent` and `SessionEventSchema`.

**A fix that came with it.** `toStepError` recognises a carried verdict
STRUCTURALLY rather than with `instanceof`, so a `retryable: false` refusal that
arrives rehydrated from the durable journal is still terminal instead of being
retried to exhaustion.

Platform-internal: the double-encoded-jsonb self-heal and the string-vs-object
read tolerance are gone (settled by the 2026-08-09 normalizing migration), as are
the pre-per-app-database schema drop, the pre-v2 harness-image bundle-URL gate,
and the studio account key-mapping backfill.
