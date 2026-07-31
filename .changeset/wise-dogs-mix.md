---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
---

Make a voice reply's transcript and audio reach the client together. Pipeline mode published a reply's transcript once, when the reply ended: a turn that opens with a tool chain speaks its hold phrase and dead-air cover tens of seconds before that, so any client pairing text with audio (live captions, a voice harness) had already played the audio by the time the words arrived. `agent_transcript` is now cumulative within a reply and sent as each piece of text reaches TTS; `aai-ui` renders it as the live assistant bubble and commits it to the conversation on `reply_done`. Host-mode sessions also opt out of audio pacing (`UNPACED_AUDIO_LEAD_MS`) — pacing assumes a client that plays at one second per second, and metering audio to the wall clock starves a programmatic client that keeps its own.
