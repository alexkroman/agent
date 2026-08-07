---
"aai-server": patch
---

Layer the Modal image dependencies-first: install from normalized workspace manifests before copying the source, so an ordinary code change reuses the installed node_modules instead of refetching the whole tree on every deploy.
