---
"@alexkroman1/aai-cli": patch
---

Sync `.env` secrets before the FIRST publish, not after it. `aai publish` gated the sync on whether the project had ever been deployed, then re-ran it post-deploy and printed "They apply on the next `aai publish`" — so every new agent's first deployment ran without its credentials and the documented remedy was to publish twice.

The gate was never needed: the sync writes to the project route, whose row `pushProject` has already created, and the server floors a newly minted slug from that record via its post-deploy hook.
