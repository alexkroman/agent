---
"aai-studio-server": patch
---

Serve the agent surface's default browser client from an injected directory. `aai-server` no longer resolves `@alexkroman1/aai-ui` itself — compiled into the studio entry, that resolution put `defaultClientDir()` outside the package it self-references and every deployed agent page answered 500 with "Could not locate the default client UI".
