---
"aai-server": patch
---

Rate-limit `/:slug/workflows/*` per client IP, and route DELETE.

Two limits: the surface one is sized for a polling page, and starting a run takes
a much tighter one, because a POST there queues work that outlives its request.
Both are checked before the handler, so a refused request never brokers — and
brokering boots a sandbox, which is what made a loop of cheap GETs a loop of
container starts.

The route answered only GET and POST, so `api.cancel(runId)` — a DELETE — 404'd
at the platform and every Stop button on a deployed agent was dead, while the same
page worked under `aai dev`.
