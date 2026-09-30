---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-runtime": patch
---

`@alexkroman1/aai/protocol` declares the `WS /inbox` frames once — `InboxServerFrame` (a notice header, `session_event`, `session_ended`) and `InboxClientFrame` (`ack`, `busy`), with their Zod schemas — and the runtime's inbox and aai-ui's inbox client are typed against them. The wire format is unchanged.

`useTapToTalk` no longer re-renders its host on every transcript delta: session activity reaches its hang-up clocks through a subscription to the session core outside React, and the hook renders only when the phase or its own view changes.

`fitToolResult` measures each node's JSON once and updates lengths as list items are removed, instead of re-serializing every list on every trimming pass. Its output is unchanged.
