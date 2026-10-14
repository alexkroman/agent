---
"aai-server": patch
"@alexkroman1/aai": patch
---

Route `agent({ routes })` on the managed platform: `/:slug/api/*` now forwards
to the agent's sandbox (per-IP rate limited), so a deployed page's
`fetch("api/…")` no longer 404s.
