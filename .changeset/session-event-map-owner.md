---
"@alexkroman1/aai": major
---

The session event vocabulary is one extendable, single-owner type. `SessionEventSchema`, `SessionEvent` and `SessionEventBody` moved from `@alexkroman1/aai/protocol` to the root `@alexkroman1/aai` (import them from there), alongside a new augmentable `SessionEventMap` derived from the schema: `SessionEvent<"tool.called">` and `SessionEventBody<"tool.called">` replace `Extract<…, { type: … }>`, and `SESSION_SOURCED_EVENT_TYPES` declares the events only the session emits. `aai-runtime`'s `TransportEventBody`/`TransportEventType` are derived from it instead of listing event names. New `eventsOf(events, type)` and `isEvent(event, type)` in `@alexkroman1/aai/testing`. `StandardSchemaV1`/`StandardSchemaIssue`/`StandardSchemaResult` and `DialogEventNames` are exported from the root, `ClientConfigResponseSchema` from `/workflow-api`. The `aai:agent` contract is split: new `events`, `turn-taking` and `standard-schema` capabilities.
