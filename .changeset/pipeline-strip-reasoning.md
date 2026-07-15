---
"@alexkroman1/aai": patch
---

Strip `reasoning` parts from assistant messages persisted to the pipeline's LLM history. Reasoning is an ephemeral per-turn trace, not conversation the model should re-read; replaying it (introduced with cross-turn tool memory) also made the Anthropic provider warn "unsupported reasoning metadata" on every subsequent request because the persisted reasoning carries no valid thinking signature. Assistant messages that contained only reasoning are dropped entirely.
