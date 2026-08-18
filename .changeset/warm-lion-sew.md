---
"@alexkroman1/aai": patch
---

AssemblyAI TTS: cancel a turn with the protocol's own `Cancel` frame instead of dropping and rebuilding the WebSocket. The adapter's doc claimed no cancel frame existed; probing the live service showed it does, and that it both discards buffered text and aborts synthesis in progress. Barge-in no longer pays a reconnect. The socket now survives a cancel, so the abandoned turn's trailing audio and acks are suppressed until the service's `Cancelled` frame marks the boundary; an unsendable or unacknowledged cancel still falls back to the reconnect.
