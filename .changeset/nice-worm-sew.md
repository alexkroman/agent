---
"@alexkroman1/aai": patch
---

Refactor pipeline provider internals: extract a shared session shell for STT/TTS openers, define each provider's API-key env var once next to its kind tag, and make the LLM resolver table-driven. No behavior changes.
