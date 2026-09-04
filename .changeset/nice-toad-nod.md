---
"@alexkroman1/aai-ui": patch
---

Cut duplication and wasted render work in the browser client: one guarded web-storage helper behind the three stores, a shared submission scaffold for the two workflow form hooks, coalesced upload progress reports, and lazy tool-call result formatting.
