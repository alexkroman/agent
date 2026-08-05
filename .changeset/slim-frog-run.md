---
"@alexkroman1/aai-ui": patch
---

Fix two playback-drain races found by fuzzing aai-ui: a session torn down (hang up, fatal error, reconnect) mid-reply no longer has its dead state overwritten with "listening" when the drain settles, and a stale turn's worklet drain-stop can no longer settle the live turn early.
