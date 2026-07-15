---
"@alexkroman1/aai": patch
---

Fix Cartesia TTS killing the session with a fatal `tts_stream_error` on a benign barge-in race. When a `cancel`/`flush` crosses the context's `done` on the wire, Cartesia emits a per-context 400 "Invalid context ID" error frame on the shared socket; the handler now recognizes dead-context error frames (and frames tagged with a non-active `context_id`) and drops them, while still surfacing genuine socket failures.
