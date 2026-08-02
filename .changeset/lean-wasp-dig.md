---
"@alexkroman1/aai": patch
---

Close the client socket when a session hits its idle timeout. Previously session-core emitted an `idle_timeout` event and left the connection open; clients treat that event as informational and wait for a close, so the session, its provider sockets, and (on the platform) its Modal input slot were all held indefinitely.
