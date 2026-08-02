---
"@alexkroman1/aai": patch
---

Internal cleanup across the aai package: dedupe shared constants (WS_OPEN, WS_NORMAL_CLOSURE, tool User-Agent/Accept headers, default toolChoice), route JSON parsing and tool-arg coercion through the shared safeJsonParse/toArgsRecord helpers, share the TTS done-once latch between the Cartesia and Rime openers, fetch page-design stylesheets concurrently, drop the redundant web-search boundary re-scan, and fix manifest/validation drift: parseManifest no longer strips startFailurePhrase and requiredEnv, and assertPipelineTuning now covers startFailurePhrase.
