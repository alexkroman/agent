---
"@alexkroman1/aai-cli": patch
---

`aai dev` serves its fallback page for `/` and `/index.html` with a query string too. It matched the raw URL, so any page opened with one — `?resume=1`, or an OAuth provider returning to the page with `?status=success` — was a 404. Production (`aai start`) already matched by path.
