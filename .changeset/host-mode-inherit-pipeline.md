---
"@alexkroman1/aai": minor
"@alexkroman1/aai-cli": minor
---

Host mode now inherits the deployed agent's `stt`/`llm`/`tts` provider config, so a `?host=1` session runs the operator's configured pipeline (e.g. AssemblyAI Universal-3.5 Pro STT + LLM + TTS, with agent_context/voice_focus) with only the client's system prompt, greeting, and tools injected — instead of falling back to the default S2S path. The dev server passes its loaded agent as `hostBaseAgent`.
