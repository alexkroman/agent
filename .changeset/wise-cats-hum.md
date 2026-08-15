---
"@alexkroman1/aai": patch
---

One spelling for splitting a request target, and it is the correct one. `req.url` was cut three different ways at fourteen sites, and the most common of the three — `split("?")[1]` — keeps only the segment between the first and second question mark, so a query value carrying a literal `?` was silently truncated. `requestPath`/`requestQuery` on `@alexkroman1/aai/internal` replace all of them, along with the four different dead `?? "/"` fallbacks that only ever existed to satisfy `noUncheckedIndexedAccess`. The workflow API's two SSE routes also share one header block and one frame encoder instead of byte-identical copies.
