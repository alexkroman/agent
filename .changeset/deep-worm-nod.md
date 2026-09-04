---
"aai-server": patch
---

Declare MemorySandboxDirectory and MemoryPreviewQueue as named interfaces so each store factory returns the contract it implements, which is what lets konsistent check both arms of every platform store. Type declarations only — no call site, test seam or runtime path changed.
