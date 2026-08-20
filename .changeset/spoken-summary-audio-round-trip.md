---
"@alexkroman1/aai": minor
---

A workflow can now produce AUDIO, and a page can play it. Three additions on
`@alexkroman1/aai/utils` close the return trip that a `"use step"` body could
not make before: `stepSpeak(text, opts?)` synthesizes an utterance from inside a
step and hands back a complete WAV (the session TTS surface cannot be used
there — a `TtsSession` is an event stream wired into a live pipeline's playback,
and a step has no turn to be part of and has to return a value); `writeUpload`
is `readUpload`'s other direction, so a step can store a file the run's JSON
output could never carry and return its id instead; and `encodeWav` /
`pcmDurationMs` are the 44 bytes of container arithmetic every project was
otherwise copying, with `byteRate` and `blockAlign` derived rather than passed.
`WorkflowApi.download(id)` is the browser half — a `Blob` rather than a URL,
because the byte route takes the same bearer every other route does and neither
`<audio src>` nor `<a href>` can send one.

For tests: `stubSpeech()` fills the speech slot and records what a step asked to
say, and `stubUploads(files, { writable: true })` accepts writes and mints
assertable ids (read-only by default, so a step that stored a file nobody meant
it to still fails).

The new `spoken-summary` template is the reference use, and it is the whole
round trip: upload a recording, it is transcribed by the async API, summarized
through the LLM Gateway, and read back as a WAV the page plays and offers as a
download.
