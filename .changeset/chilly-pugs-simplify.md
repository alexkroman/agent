---
"@alexkroman1/aai": patch
---

Export `MAX_SLUG_LENGTH` from the shared slug contract (`@alexkroman1/aai/utils`) so callers that truncate to fit the slug shape no longer hard-code 64.
