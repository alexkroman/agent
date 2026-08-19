---
"@alexkroman1/aai": patch
---

Commit a parts upload in batches rather than one awaited statement per megabyte: the per-chunk round trip made the request body drain at the speed of the app's Postgres, which the platform's forward reads as a stalled guest, and held a pooled connection for the whole part.
