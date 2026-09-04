---
"@alexkroman1/aai-cli": minor
---

Add `aai build --target deno`, which emits a self-contained `.aai/deno/` for Deno Deploy: a bundled server, the built worker, the browser client and `.env.example`, with no install step. Voice works there unchanged — Deno runs `node:http` and the `ws` server path, so the session reaches the same AgentServer `aai dev` runs; verified against a live deployment with real speech. Also fixes the CLI's `enableCompileCache` import, a NAMED import of a Node-only export that made `bin.mjs` unusable on any runtime lacking it.
