---
"aai-server": patch
---

memoAsync: a build rejecting after reset() no longer evicts the successor build,
so the next caller joins it instead of starting a redundant third build
