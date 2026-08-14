---
"@alexkroman1/aai": minor
---

Add `stepFetch`/`multipartBody` — a step's HTTP, pinned to HTTP/1.1. Node's `fetch` offers h2 in ALPN, so a workflow fan-out multiplexes every concurrent request onto one connection: measured at 8 concurrent 17.66 MB uploads it lost 2 of 16 to NGHTTP2 stream resets at p50 8094ms, against 16 of 16 at p50 3037ms over HTTP/1.1. A reset carries no HTTP status, so `isTransientStatus`/`retryAfter` cannot classify it and a bounded batch retries in lockstep until the run dies. `stepGenerate` routes through it, `StepTransportError` names the whole cause chain, and `stubStepFetch` (`/testing`) is how a spec answers it.
