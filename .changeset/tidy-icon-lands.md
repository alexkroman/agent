---
"@alexkroman1/aai": patch
---

Ship the agent page's favicon inline, so no page 404s on load.

Both HTML shells linked a `favicon.ico` that nothing produces and nothing serves — the default client's used `/favicon.ico`, the CLI's `./favicon.ico`, and neither resolved — so every agent page logged a 404 in the console. The icon is now the AssemblyAI mark as an inline `data:` URI (`AGENT_FAVICON`), which costs no request at all and needs no file in any of the four serving paths: `aai dev`'s Vite root, the CLI's client build, a self-hosted `clientDir`, or a deployed guest's assets. It is one definition shared by both shells — the default client's is injected at build time — and it is allowed by the agent CSP's `img-src 'self' data:`.

Also folds `WorkflowApiEngine` into `WorkflowClient & { putBlob, listing }`. It restated `WorkflowRunSnapshot` field for field with `status` widened to `string`, so a new field or status had to be propagated by hand and the widening guaranteed it would still compile if nobody did.
