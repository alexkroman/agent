---
"@alexkroman1/aai": major
---

Close the seven API shapes that produced contract churn, and generalize the channel API.

Provider factories, options types and resolve helpers are stage-qualified — `deepgramStt`, `cartesiaTts`, `openaiLlm`, `openaiS2s`, `ElevenLabsSttOptions` — so a vendor taking a second stage adds a name instead of renaming one. Every provider options interface extends `ProviderCredentialOptions`, so `apiKeyEnv` is spellable on all thirteen rather than the four the runtime had always honoured. Each LLM vendor has its own `*LlmOptions` extending `ModelOptions`.

Value-carrying constants now carry literal types, so their values are in the published .d.ts and cannot change unnoticed; the AssemblyAI voice catalog is typed by `AssemblyAITtsVoiceInfo` so re-accenting a voice is not an API change. An `async` slot mutation body is a compile error rather than a runtime throw.

Channels: `ChannelKind` and `registerChannelKind` make a destination a self-contained module, and `slack()` is `slackChannel()`.
