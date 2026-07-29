---
"@alexkroman1/aai": patch
---

Fix text-only agents (tts: none()) rendering the voice UI when deployed: readyConfig read agent.tts, which the platform never sets since it passes providers as runtime options.
