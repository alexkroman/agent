---
"@alexkroman1/aai-ui": minor
---

A browser session can mute its microphone without dropping the call: `setMicMuted(muted)` on `BrowserSession`, `useSession()` and `useSessionActions()`, read back as the snapshot's `micMuted`. While muted the session keeps streaming frames of the same length and cadence as silence, so the server's automatic endpointing still closes a turn on release — the building block for hold-to-talk on an agent that keeps `turnDetection: "auto"`. Muting sends no command and interrupts nothing, survives reconnects, `disconnect()`/`connect()` and `end()`, and can be set before `connect()`.
