---
"@alexkroman1/aai": minor
---

Export registerSttKind/registerTtsKind (plus OpenerRegistryEntry, SttOpener, TtsOpener) from @alexkroman1/aai/runtime: the speech-stage substitution seam a host application needs to drive a real pipeline session with faked STT and TTS. SttOpener and TtsOpener lose their @internal tags, being that seam's parameter type.
