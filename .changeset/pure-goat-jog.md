---
"@alexkroman1/aai": minor
---

One-shot transcription for short uploads: new `transcribe_file_start`/`transcribe_file_end` protocol messages buffer an uploaded clip host-side and transcribe it in a single request via AssemblyAI's Sync API (`syncTranscribe` from `@alexkroman1/aai/stt` — the preferred endpoint for files under two minutes), then run the transcript as one user turn. Non-AssemblyAI STT providers and longer files fall back to the realtime streaming path. `sendAudioFile()` in aai-ui picks the path automatically.
