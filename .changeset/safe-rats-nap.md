---
"@alexkroman1/aai-runtime": patch
---

A step that suspends no longer spends its own retry budget. An attempt is now a lease: tries are counted in the walk, and the durable charge is given back when a body suspends, so overlapping deliveries of one run can no longer exhaust a budget between them and journal `failed` over a step that had succeeded. The refusal is a verdict about the walk rather than a journal entry, so only a walk whose own body threw can write a `failed` entry.
