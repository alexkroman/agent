---
"@alexkroman1/aai-cli": patch
---

Detect Deno Deploy from `DENO_DEPLOYMENT_ID` as well as `DENO_DEPLOY`. Either marker alone is half the signal: `std-env` tests the pair as one, and Nitro's own Deno preset reads the second.
