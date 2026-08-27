---
"@alexkroman1/aai-runtime": minor
---

Add the guest-side platform queue client: `queue()` becomes one authenticated POST to the agent's own `/:slug/workflow-enqueue` instead of a graphile-worker job against the tenant's database. No new credential — the per-sandbox bearer the guest already holds to verify inbound platform requests proves the reverse outbound, and it is bound to one sandbox name so it authorizes exactly one slug.
