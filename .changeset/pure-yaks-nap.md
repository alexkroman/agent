---
"@alexkroman1/aai-cli": patch
---

aai dev: report a missing ASSEMBLYAI_API_KEY as a credential problem, not a login one. The failure now names the two purely local remedies (.env, a shell export) before `aai login`; the scaffold's .env.example documents the key the default pipeline needs; and the generated README runs the CLI through npm (it is a devDependency, not on PATH) and names `aai login` where publishing actually needs it.
