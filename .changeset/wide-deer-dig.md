---
"@alexkroman1/aai-runtime": minor
---

Add `withToolsDir` to `@alexkroman1/aai-runtime`: a self-hosted Node process can now discover an agent's `tools/` directory at startup, so a tool is registered by existing on that path too rather than only where a bundler enumerates it.
