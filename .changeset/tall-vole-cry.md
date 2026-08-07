---
"aai-server": patch
"aai-studio-server": patch
---

Unpin the Modal region for both web services so containers are placed by capacity. A pinned region (us-east-2) confined the always-warm agent replica to one region's spare capacity; when it ran dry Modal placed nothing and the app sat at deployed with zero tasks, requests hung with zero bytes, and no container logs existed at all because no container was ever created.
