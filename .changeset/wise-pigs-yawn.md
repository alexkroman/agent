---
"@alexkroman1/aai-runtime": minor
---

Share the workflow API's one-shot run reads, bound the platform pool's reserve, and answer a platform shortage as 503 rather than 500. `GET /runs/:id` and `/runs/:id/stream` each opened their own journal read, so N concurrent readers of one run cost N round trips against a four-connection admin pool; they now join the same coalesced read. `createPostgresDb` gains an optional `reserveTimeoutMs`, and an exhausted pool is reported rather than waiting forever behind a caller that has already given up.
