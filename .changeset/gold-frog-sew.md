---
"@alexkroman1/aai": patch
---

Classify a step's Response failures again: `toStepError` recognised a `Response` with `instanceof`, which is false inside a step bundle's own realm, so every fatal status was retried to exhaustion and every `Retry-After` ignored.
