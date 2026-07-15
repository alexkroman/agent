---
"@alexkroman1/aai": patch
---

Internal cleanup of the aai package: dedupe the header-WebSocket adapter and ToolSchema types across transports, extract a shared runReply scaffold in the pipeline transport, consolidate PCM16/base64/error-message helpers, replace per-audio-chunk idle-timer re-arming and per-chunk STT carry reallocation with cheap accumulators, serialize KV values once, move STT/TTS resolution onto registries, and remove dead API surface (S2sHandle.sendAudioRaw, Transport.updateSession, user_transcript.turnOrder).
