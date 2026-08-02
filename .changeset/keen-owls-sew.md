---
"aai-guest": patch
---

Serialize the studio build child's worker and client bundles: two concurrent Rolldown passes peak at roughly the sum of their native allocations in the one process a sandbox memory cap would OOM-kill, and the sandbox's single CPU means serializing costs no meaningful wall clock.
