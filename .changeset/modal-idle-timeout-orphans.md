---
"aai-server": patch
---

Guest sandboxes now set Modal's `idleTimeoutMs` (default 15 min, override
with `SANDBOX_IDLE_TIMEOUT_SECS`), so sandboxes orphaned by a host crash
self-terminate once their harness exec exits instead of billing until the
4h lifetime cap. Healthy sandboxes are unaffected — the harness exec runs
for the sandbox's whole life, so its idle timer never starts.
