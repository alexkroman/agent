---
"@alexkroman1/aai": patch
---

Fix runtime crash when loading the host runtime without the provider SDKs installed. `ai`, `assemblyai`, and `@cartesia/cartesia-js` are now regular dependencies instead of optional peer dependencies — the runtime eagerly imports `pipeline-session.ts`, so they were already required at module load even for S2S-mode agents. Optional peer deps described a design the code didn't enforce; now the metadata matches behavior.
