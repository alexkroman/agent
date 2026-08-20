---
"aai-server": patch
---

Bound the wake sweep's per-app database reads and a deploy's blob writes to declared widths, correct the connection-budget invariant they rest on, and take the second rate-limit round trip off the run-start path.
