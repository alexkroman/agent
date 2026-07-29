---
"@alexkroman1/aai": patch
---

Surface a provider-initiated STT socket close instead of going silently deaf. `createSessionShell` treated every clean (1000) close as expected, but only a close we initiate ourselves is — a graceful close from the provider (a session cap, an idle cutoff, an upstream deploy) still means no further transcripts will arrive. Because the `closed` latch stayed false, `sendAudio` kept forwarding frames to a dead socket: the session looked healthy, no error reached the caller, and the agent stopped responding to speech for the rest of the call. Closes now emit `stt_stream_error` for all four STT providers via a new opt-in `cleanCloseIsFatal`, keyed off the latch rather than the close code. TTS openers keep the lenient behavior, where a provider closing after it has finished sending audio is normal completion.
