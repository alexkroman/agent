---
"aai-server": patch
---

Allow ':' in KV keys. The previous ban was stale (from when keys used ':' as a namespace separator); the prefix scheme is now 'agents/${slug}/kv' using '/'. Banning ':' broke any agent using Redis-style hierarchical keys like 'incident:INC-0001'.
