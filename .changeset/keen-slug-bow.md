---
"@alexkroman1/aai": minor
---

Add ElevenLabs Scribe (scribe_v2_realtime via @elevenlabs/elevenlabs-js) and Soniox (stt-rt-v3 via direct WebSocket) STT providers alongside assemblyai and deepgram. Both follow the existing typed-descriptor pattern; agent bundles stay free of provider SDKs and the host resolver constructs the live session at createRuntime time.
