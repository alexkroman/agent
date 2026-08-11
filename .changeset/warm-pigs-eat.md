---
"@alexkroman1/aai": patch
---

Route LLM observability through the AI SDK's own telemetry seams: per-turn timing now reports the provider-measured time to first output instead of counting stream parts, one-shot generations (ctx.generate and the studio's repair/compaction calls) are logged at all for the first time, and provider warnings reach the runtime logger.
