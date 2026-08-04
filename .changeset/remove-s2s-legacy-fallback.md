---
"@alexkroman1/aai": patch
---

Remove the legacy descriptor-less S2S fallback in `buildTransport`. Configs
predating the pipeline-by-default flip that reach transport construction with
no resolved pipeline providers and no `s2s` descriptor now fail loudly with a
clear error instead of silently running an AssemblyAI S2S session.
