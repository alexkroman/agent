---
"@alexkroman1/aai-runtime": patch
---

Workflow engine performance and concurrency: the divergence check scans the journal with a cursor rather than re-scanning every journaled step per fresh step, the step gate dequeues waiters through a head cursor rather than an O(n) shift, a walk issues its two opening journal reads together rather than one after the other, the memory journal answers readStep from its key index rather than a scan, and the in-process dispatcher collapses deliveries that arrive during a walk into one deferred re-delivery instead of racing concurrent walks of the same run.
