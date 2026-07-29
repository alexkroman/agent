---
"@alexkroman1/aai": patch
---

Fix AssemblyAI LLM Gateway streams dying on Claude models: the gateway's final usage-only chunk carries choices: null where the AI SDK schema requires an array, killing the turn after the reply had already streamed.
