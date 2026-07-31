---
"aai-server": patch
---

Pin Modal guest sandboxes to the platform server's region. Unpinned, Modal placed the web server in us-east-1 (AWS) and guest sandboxes in uk-london-1 (OCI), so every host↔guest RPC (ctx.db, Vector, guest fetch proxy, bundle/load) paid a transatlantic RTT inside voice turns. `modal-sandbox.ts` now passes `regions` to `sandboxes.create` from a new `MODAL_SANDBOX_REGION` env var (comma-separated for multiple regions; unset means unpinned, so local dev is unchanged), and `modal_deploy.py` pins the web server and studio_build functions to a single `REGION` constant and exports it as `MODAL_SANDBOX_REGION` — host and guests are co-located by construction.
