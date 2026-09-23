---
"@alexkroman1/aai-runtime": patch
---

Cancelling or timing out now stops the underlying work instead of only the
wait. A workflow cancel that lands during a step's retry backoff ends the walk
immediately rather than after the full `retryAfter`; a platform RPC that times
out aborts its HTTP request instead of leaving it open on the shared RPC pool;
and a brokered upload byte operation that times out aborts its request instead
of continuing to send (or hold a pool connection for) a window nobody will read.
