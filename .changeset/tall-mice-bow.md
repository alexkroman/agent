---
"aai-server": patch
"aai-studio-client": patch
---

Remove the studio's per-request LLM model picker — chat always runs on the host-configured default model (gpt-5.5 on the AssemblyAI LLM Gateway)
