---
"aai-server": patch
---

Use the SDK's relocated SSRF module, drop the now-redundant local safeFetch wrapper, and check slug ownership on generated-slug deploys so a humanId collision can't overwrite an existing agent.
