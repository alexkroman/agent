---
"@alexkroman1/aai": minor
---

Pipeline mode is now the default: an agent that declares no providers gets the all-AssemblyAI cascaded pipeline (assemblyAIPipeline()) injected at parse/config/runtime time. The S2S voice-agent API is now an explicit opt-in via the new s2s: assemblyAIS2s() descriptor (exported from the main entry and @alexkroman1/aai/s2s) — there is no longer any way to reach S2S by omission.
