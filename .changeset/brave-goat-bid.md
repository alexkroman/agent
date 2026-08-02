---
"@alexkroman1/aai": patch
---

Route a tool's `ctx.send` and `syncState` pushes to whichever client socket currently holds the session id, rather than the one captured when the tool was dispatched. A reconnect landing mid-tool-call sent both to the superseded socket; for `syncState` the lost push also recorded the projection as delivered, leaving the resumed client stale indefinitely.
