---
"@alexkroman1/aai-runtime": patch
---

Simplify the provider fallback and resolution internals: one failover decision across stages, a nanoevents emitter on the socket fallback, a piped LLM fallback stream, and one shared stage-member and env-var lookup. No behaviour change.
