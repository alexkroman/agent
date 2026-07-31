---
"aai-server": patch
"aai-studio-client": patch
---

Default the studio coding agent to a cascaded pipeline (AssemblyAI STT, gpt-5.5 on the LLM Gateway, AssemblyAI TTS); the S2S voice agent API is now used only when the user asks for it. Codegen evals updated to grade the new default.
