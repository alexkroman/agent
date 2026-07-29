---
"@alexkroman1/aai": patch
---

Harden unhandled-error paths across the SDK, CLI, and UI: missing WebSocket/stream/child-process error listeners, floating `void` promises without rejection handlers, unguarded JSON parsing, and event-handler throws that could crash the process or silently wedge a session now fail safely with clear errors.
