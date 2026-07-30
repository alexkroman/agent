---
"aai-server": major
"@alexkroman1/aai": patch
"aai-templates": patch
---

Migrate all sandboxing and deployment to Modal.

Agent guest sandboxes now run as remote Modal Sandboxes (`modal-sandbox.ts`,
via the `modal` SDK): network-blocked containers running the Deno harness,
speaking the same NDJSON JSON-RPC protocol over the exec'd process's stdio.
The gVisor (runsc) OCI backend, the dev-mode child-process fallback, and the
fake-VM harness are all removed — Modal credentials (`MODAL_TOKEN_ID` /
`MODAL_TOKEN_SECRET`) are now required to run sandboxes in dev and prod alike.

The server itself also deploys to Modal (`modal_deploy.py`,
`pnpm --filter aai-server deploy:modal`); the production Dockerfile, the
Docker test image, and the Fly.io configuration/deploy pipeline are removed.
