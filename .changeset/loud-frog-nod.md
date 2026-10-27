---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
"aai-studio-server": minor
---

Voice input for the studio composer via AssemblyAI's dictation API. The SDK adds `transcribeDictation()` and the `DICTATION_*` limits on `@alexkroman1/aai/experimental` (`stepTranscribeSync` now builds on it); aai-ui adds the `useDictation` hook (record one clip, hand it to your own `transcribe` callback, get the words back); the studio gains `POST /studio/dictation` on the caller's own key and a mic button in the chat composer.
