---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

Make the durable-workflow journal's first-write-wins claims one statement each and retry the indeterminate answer, escape the characters PostgreSQL cannot store, and give the reconcile pass an end so a run its guest can never finish is failed rather than re-walked forever.
