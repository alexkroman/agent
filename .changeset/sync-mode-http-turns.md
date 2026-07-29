---
"@alexkroman1/aai": minor
---

Add sync mode: connectionless HTTP turns with no WebSockets on either leg.

Server side (`@alexkroman1/aai`): pipeline-mode runtimes gain
`runtime.runSyncTurn()` and the self-hosted server a `POST /sync` route —
one request per conversational turn carrying committed text or one
endpointed utterance of PCM16 audio plus the client-held history. STT runs
through the provider's one-shot batch capability (`transcribeClip`,
AssemblyAI Sync API), the LLM loop runs host-side with the agent's tools,
and TTS runs through the new one-shot `TtsOpener.synthesizeClip`
capability (implemented for Cartesia via its `/tts/bytes` endpoint). The
request/response schemas ship from `@alexkroman1/aai/protocol`.

Client side (`@alexkroman1/aai-ui`): `createSyncSession()` (HTTP turns +
history replay), `startSyncMicrophone()` (WebRTC `getUserMedia` voice
capture through an inline AudioWorklet), and `createUtteranceDetector()`
(pure energy-VAD utterance endpointing) — speech is endpointed in the
browser and each utterance becomes one HTTP turn.
