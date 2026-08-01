---
"@alexkroman1/aai": patch
---

Strip $schema and propertyNames from tool schemas sent to the AssemblyAI LLM Gateway — without it every Gemini model 500s on any agent that has tools.
