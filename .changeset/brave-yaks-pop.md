---
"@alexkroman1/aai": patch
---

Flush pipeline-mode TTS sends only on sentence-terminal punctuation (.!?…). Clause marks (,;:) no longer end a batch: a comma is mid-sentence, and flushing there handed the provider a fragment to synthesize with a falling final intonation. The 32-character coalescing cap still bounds how long an unterminated batch waits.
