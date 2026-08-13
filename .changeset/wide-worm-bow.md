---
"@alexkroman1/aai": minor
---

Add a text session mode to the agent API, and drive the studio coding agent through it.

`agent({ text: true })` declares an agent with no audio path — an LLM, a system prompt and its tools — and `createTextAgent` (`@alexkroman1/aai/runtime`) runs it over a message list, returning the AI SDK's own `streamText` result. Every other `AgentDef` field means what it means in a voice agent, so a tool runs unchanged in either; `stt`/`tts`/`s2s`, `sttPrompt` and the voice-UX knobs are compile errors on it. The mode is explicit for the same reason `s2s` is, and `createRuntime`/`createTextAgent` refuse each other's agents by name.

The studio's coding agent is now such an agent rather than a hand-assembled `streamText` call, so model resolution, the keyless web builtins, the tool executor and its `ctx`, the per-call deadline, the reserved final-answer step and tool-call repair all come from the SDK. Tool-call repair gained the studio's cheap JSON-salvage tier, which now benefits the voice pipeline too, and `executeToolCall` takes a `timeoutMs`.
