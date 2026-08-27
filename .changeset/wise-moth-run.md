---
"@alexkroman1/aai-runtime": patch
---

Refuse the durable-workflow queue callbacks from any peer that is not loopback. `POST /.well-known/workflow/v1/flow` and `/step` were declared `guest-internal` on the argument that "loopback is the whole gate", and nothing checked: a deployed guest binds every interface behind a public Modal tunnel whose origin the public `/:slug/client-config` hands to any browser, so `step` would execute one of the tenant's registered step functions with a caller-supplied payload. The gate lives in `handleWorkflowRequest`, so it covers `aai dev`, host mode, studio mode and a self-hosted `createAgentServer` alike. The webhook route is deliberately untouched — its URL is handed to third parties and the DevKit's path token is its authorization.
