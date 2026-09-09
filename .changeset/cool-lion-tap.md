---
"aai-studio-server": patch
---

Serve the agent surface's default browser client from an injected directory. `aai-server` no longer resolves `@alexkroman1/aai-ui` itself — compiled into the studio entry, that resolution put `defaultClientDir()` outside the package it self-references and every deployed agent page answered 500 with "Could not locate the default client UI".

Keep `modal` and `microsandbox` out of the service bundle — both resolve files relative to their own package, which an inlined copy cannot do — and baseline the 25 npm packages still inlined into it (`pnpm check:bundled-deps`).
