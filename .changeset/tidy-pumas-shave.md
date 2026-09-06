---
"@alexkroman1/aai-runtime": minor
---

Resolve the system prompt per turn rather than once per session, so a phase-aware prompt can reach the model on turns that call no tool.

`TransportSessionConfig.systemPrompt` accepts a thunk as well as a string, and `Transport.refreshSystemPrompt()` pushes a changed prompt to a live OpenAI Realtime session as an `instructions`-only `session.update`, sent only on a change. A speculation now records the prompt it launched on and is discarded as `prompt-moved` when that has since changed, because a request in flight cannot have its `system` amended. AssemblyAI S2S resolves once at construction — its tool loop is service-side and has no per-turn moment. A plain string behaves exactly as before.
