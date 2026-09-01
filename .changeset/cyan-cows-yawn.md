---
"@alexkroman1/aai": patch
---

Re-enqueue durable runs the queue has lost. Abandonment was backed by the DevKit world's boot-time re-enqueue, which went with it, so a stalled run stayed stalled forever.
