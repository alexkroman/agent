---
"aai-server": patch
"aai-studio-server": patch
---

Count app databases in the platform connection budget, check it against the real instance at boot, and cap concurrent SSE streams per caller scope. MAX_CONTAINERS drops to 5 while the per-container input caps rise to 200/400 — measured, one replica holds 2,000 concurrent streams with no degradation and they cost zero database connections, so a replica is cheap in the scarce resource.
