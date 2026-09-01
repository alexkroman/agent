---
"@alexkroman1/aai-runtime": patch
---

Pin the runtime's own outbound fetch to HTTP/1.1, and answer a transport failure as a 503.

Every call the runtime made of its own — the upload broker's byte operations, the operator-bucket ones beside them, every platform RPC, and the run-event stream read — used `globalThis.fetch`, which undici 8 lets negotiate HTTP/2. A deployed guest's concurrent requests to one origin were therefore multiplexed onto one connection, where a capacity limit arrives as a stream reset carrying no HTTP status: a part claim's bucket probes and an unrelated run-event stream failed with `fetch failed` in the same instant, and the claim answered `500 Internal server error`, so the browser re-sent windows it had already stored into the same fault. They now share one HTTP/1.1 keep-alive pool, the same fix `stepFetch` already had, and a transport failure answers 503 with a `Retry-After` instead of an opaque 500.
