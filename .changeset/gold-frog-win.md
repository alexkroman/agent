---
"@alexkroman1/aai": patch
---

S2S: three fixes to how a session ends. (1) In-band service errors (`session.error` with a non-expiry code, a bare `error` frame, OpenAI Realtime's `error` event) are no longer reported as FATAL — they close nothing and the conversation continues through them, but a fatal frame makes the browser client release the microphone and end the call, so a recoverable complaint left a session that looked live and could not hear the user. (2) Retiring a session now closes its socket: an in-band `session_not_found` rejection of a `session.resume` previously left a live provider socket relaying frames to a client already told the call was over. (3) `stop()` now abandons a resume handshake that has not completed, which nothing could close before — `connectS2s` only returns a handle once the socket opens and `ws` sets no handshake timeout, so a client hanging up mid-resume pinned a half-open provider connection for the life of the process.
