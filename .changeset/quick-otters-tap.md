---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

Cut three sources of durable-workflow latency, and make a run's journal RPCs
readable in production logs.

- **A run that settles in this process wakes its watchers immediately.** The
  synchronous `wait=`, the SSE stream and the notify watcher discovered a
  finished run on their own timer, so a run that completed here was reported up
  to a full poll interval later. The engine now signals the shared reads, which
  brings their next journal READ forward — no snapshot is pushed and nothing is
  resolved from it, so a run walked by another replica is unaffected.
- **A sleep shorter than the queue's poll interval no longer costs a whole
  one.** A short park is announced, and the pass it wakes reads the deadline out
  of the queue and arms one extra look at it — which is how "due at T" gets
  expressed without giving the notification a payload. A long park still
  announces nothing.
- **The journal method rides the path** (`/:slug/workflow-journal/<method>`), so
  a per-request log line decomposes per operation at zero added volume. The
  method is still sent in the body and the bare route still answers it, because
  a deployed agent bundle carries its own copy of the runtime.
