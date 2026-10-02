---
"@alexkroman1/aai-runtime": patch
---

Make `EgressPool.close()` idempotent as documented: a second call now returns
the first call's settlement instead of rejecting with undici's
`ClientClosedError`
