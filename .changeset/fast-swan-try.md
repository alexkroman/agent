---
"@alexkroman1/aai": minor
---

Make workflow uploads faster and recoverable. Part retries back off with jitter and honour `Retry-After` instead of re-sending at once, the claim and the closing record read are retried too, the first failure aborts the parts still in flight, and a file is cut into parts by default — the single-request path cannot retry at all.
