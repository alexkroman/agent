---
"@alexkroman1/aai-runtime": minor
---

Bound how many workflow step bodies execute at once. The DevKit's world provided this and the replay engine did not, so a body's fan-out width became its execution concurrency and killed a guest.
