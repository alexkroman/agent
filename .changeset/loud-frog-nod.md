---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
"aai-studio-server": minor
---

Voice input for the studio composer via AssemblyAI's dictation API, with every
piece available to framework users. The SDK adds `transcribeDictation()`,
`handleDictationRequest()` (a web-standard `Request → Response` dictation route:
body cap, call, `{ text } | { error }` reply) and the `DICTATION_*` limits on
`@alexkroman1/aai/experimental`; `stepTranscribeSync` now builds on
`transcribeDictation`. aai-ui adds `useDictation` (record one clip, hand it to
your `transcribe` callback, get the words back; `buttonProps` and `disabled` for
the mic button), `dictationTranscriber` (the matching `transcribe`) and
`appendDictation`. The studio gains `POST /studio/dictation` on the caller's own
key and a mic button in the chat composer.
