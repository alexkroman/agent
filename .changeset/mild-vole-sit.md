---
"@alexkroman1/aai": patch
---

Fix all host-side egress failing with `TypeError: fetch failed`: the SSRF pinning dispatcher is built from this package's undici 8, but was handed to Node's built-in fetch (undici 7), which undici 8 rejects with `invalid onRequestStart method`. Pair the dispatcher with undici's own fetch.
