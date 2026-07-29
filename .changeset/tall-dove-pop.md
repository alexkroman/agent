---
"@alexkroman1/aai": patch
---

Harden the one-shot file-upload path: cap transcribe_file_start's sampleRate (memory-DoS guard), byte-budget the pre-ready WebSocket buffer so a whole upload survives session startup, auto-finalize fully-received uploads, discard in-flight transcriptions on reset/cancel, and mark turn-level transcription failures as non-fatal errors so the client session stays usable. The browser session core gains matching guards: uploads and the mic are mutually exclusive, resets abort in-flight uploads, and non-fatal server errors show a banner without ending the session.
