---
---

Add a structural guard that every platform-events store decorator wraps all of
its store's mutating methods, so the next one added cannot silently reach no
watcher the way `patch` did. Test-only, private package (aai-server).
