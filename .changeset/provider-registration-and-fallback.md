---
"@alexkroman1/aai": major
"@alexkroman1/aai-runtime": major
---

Provider failover and one registration per vendor.

- **`fallback([primary, secondary, …])`** on `@alexkroman1/aai/stt`, `/llm` and
  `/tts` tries the next provider when one fails before it has produced
  anything: an STT/TTS connection that fails to open or errors before its first
  transcript/audio (unspoken TTS text is replayed into the next one), or an LLM
  request that throws or whose stream errors before the first content part
  (decided per request). Never on an interruption or after output. Each switch
  is a new `provider.failedOver` session event (`stage`, `from`, `to`,
  `reason`), and every member's key is required by the credential preflight.
  **Breaking:** the event vocabulary grew, so an exhaustive `switch` over
  `SessionEvent["type"]` must handle it (`aai:events` epoch 2, epoch 1
  dropped).
- Each built-in vendor is now one `defineProvider` record in the SDK
  (`PROVIDER_CATALOG` on `@alexkroman1/aai/host-internal`), which its factory,
  the runtime's opener registry, `requiredProviderEnvVars` and the docs site's
  provider table all derive from. `registerSttKind` / `registerTtsKind` /
  `registerLlmKind` are documented as the way a host adds its own provider.
