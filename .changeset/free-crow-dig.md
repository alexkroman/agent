---
"@alexkroman1/aai": patch
---

Pair the SSRF DNS-pinning dispatcher with its own undici at both tool-fetch call sites, fixing `TypeError: fetch failed` on every `fetch` made from an agent's tool code
