---
"aai-server": patch
---

Pass agent.s2s through IsolateConfigSchema and into the sandbox createRuntime call so OpenAI Realtime opt-in actually reaches the running runtime instead of being silently stripped during deploy validation
