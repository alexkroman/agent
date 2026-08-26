---
"@alexkroman1/aai-runtime": patch
---

Tell the POSTGRES workflow world its callback base URL, not just the local world.

`configureWorkflowWorld` set `WORKFLOW_LOCAL_BASE_URL` only on the local
branch. The name reads like a local-world setting and is in fact the FIRST
branch of world-postgres's own `getExecutionBaseUrl()` — the origin its queue
dispatches `flow` and `step` callbacks to. Unset, that function fell through to
health-probe port AUTO-DETECTION on every dispatch.

Measured at ~45ms per dispatch, steady, against ~7ms of step work and ~1ms for
graphile-worker's whole enqueue-to-handler path. Two dispatches per step-to-step
hop made it ~90ms of a ~120ms hop, so a durable run spent roughly 40% of its
latency rediscovering a constant. A six-step run goes from 1.3-1.7s to 72ms on
the microVM backend (a 17x improvement in hop latency), and measured throughput
from 3.6 to 24.6 steps/sec. Nothing errored, which is why it is now pinned by a
test.
