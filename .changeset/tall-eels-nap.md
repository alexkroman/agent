---
"@alexkroman1/aai": minor
---

Curate the public API surface: internal plumbing is now tagged @internal (docs-hidden), provider barrels export every type their public signatures reference (KIND constants, Unsubscribe, AssemblyAITtsLanguage, default voices, OpenaiRealtimeVoice), the runtime barrel uses explicit named exports, aai-ui exports ClientConfig's tiers/WebSocketConstructor/Button variants and renames CustomEvent to AgentCustomEvent (deprecated alias kept), and stale doc comments are fixed (interruptionMinDurationMs and minTurnSilenceMs defaults, RuntimeOptions.fetch default, pipeline voice examples).
