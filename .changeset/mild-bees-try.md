---
"@alexkroman1/aai": patch
---

Fix uncaught exceptions that could crash the host process: shim assemblyai@4.36.3's discardPendingSocket so a timed-out streaming connect no longer emits an unhandled ws 'error' ("WebSocket was closed before the connection was established"), attach error handlers to HTTP upgrade sockets, and destroy unmatched upgrade sockets instead of leaving them dangling.
