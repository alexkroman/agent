---
"@alexkroman1/aai": major
---

A session takes two vocabularies, not nineteen callbacks. `SessionCore` and `TransportCallbacks` (on `@alexkroman1/aai/runtime`) replace their per-event `on*` methods with `command(cmd)` for the client's command vocabulary and `report(event)` for the transport's event vocabulary — the same names `sdk/protocol-commands.ts` and `sdk/protocol-events.ts` already carry. Breaking for anything implementing either type; the authoring surface is untouched. `TransportEventBody`/`TransportEventType` are new exports, `host/session-commands.ts` is a new internal module, and `guard-invariants` rule 16 holds the per-file count.
