---
"@alexkroman1/aai": minor
---

Session event handlers can maintain session state: `SessionEventContext` carries `slots`, and every `sessionSlot`/`dialog` accessor now takes a `SlotHolder` (a `ToolContext` still satisfies it, so no call site changes). The runtime commits a hook's write — the `syncState` push plus the store flush — and does not re-run hooks for the events a commit emits. A handler still has no `send`, so the event stream stays a record of the turn rather than a second way to drive it.
