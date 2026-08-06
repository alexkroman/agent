---
"@alexkroman1/aai": minor
---

Make S2S a provider registry like STT/TTS/LLM: credential derivation, the withHostCredentialFallback allowlist, and transport dispatch now share one `S2S_REGISTRY` instead of three hand-written kind comparisons that disagreed on unknown kinds. S2S descriptors also honour `apiKeyEnv` per-stage overrides, and each S2S module exports its own `*_API_KEY_ENV` constant.
