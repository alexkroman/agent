---
"@alexkroman1/aai": patch
---

Internal cleanup: shared safeJsonParse/LOG_PREVIEW_CHARS helpers, deduped s2s-transport connect and dev-server build paths, native base64 in the sandbox guest, single-source MAX_REQUEST_BODY_BYTES, and vendor-correct API-key fallback for pre-resolved STT/TTS openers. The aai dev server no longer prompts for an AssemblyAI API key when the agent uses no AssemblyAI provider.
