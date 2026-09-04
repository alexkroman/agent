---
"@alexkroman1/aai": minor
---

Attach 14 stranded doc blocks to the symbols they describe, and cut repeated work on three hot paths.

Fourteen JSDoc blocks sat directly above ANOTHER block, so TypeScript attached only the last one and the first was discarded — twelve published symbols shipped undocumented, including every LLM provider factory and ASSEMBLYAI_TTS_VOICES, whose doc carries the argument that a wrong voice id fails silently. Moving each block onto its own symbol restores the prose in the reference docs; no signature, parameter or export changed.

Also: html-to-text is compiled once instead of per call (116us -> 3.5us, identical output; parseFeed ran it twice per feed entry), encodeWav writes chunks straight into the output rather than joining them first (was allocating and copying the recording twice), pageMetadata builds its <meta> index once instead of per field, and the XHR upload's abort listener is detached on every outcome rather than only on abort (it was retaining a completed XMLHttpRequest per part on the caller's signal).

Plus small dedup: readApiJson and the shared Workflow API label replace six hand-spelled calls and two copied constants, the upload retry path uses the published retryAfter parser, one dialog actor now serves the gate instead of one per allowed state, and errorMessage/progressOf replace inline copies.
