---
"@alexkroman1/aai": minor
"aai-server": minor
---

Make `allowedHosts` declarable in `agent()` and enforce the same tool-fetch policy in `aai dev` as in production, from one shared implementation. Adds the missing `send`/`state` fields to the `agent()` parameter type.
