---
"@alexkroman1/aai-ui": patch
---

Deadline the pre-connection client-config lookup. It runs inside the session's WebSocket URL provider, which partysocket awaits before arming any timeout of its own, so a platform that hung rather than failed meant no socket was ever constructed and none of the reconnect attempts ever ran — the session stayed on "connecting" indefinitely, including after the server recovered. A timed-out lookup now degrades like every other failed one.
