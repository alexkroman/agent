---
"@alexkroman1/aai": minor
---

Workflow apps can take a FILE. `POST /workflows/uploads` stores one, `readUpload` reads a byte window of it from inside a `"use step"` function, and `workflow({ uploads })` is what makes a form render a picker and store the file before the run starts — a run's input is journaled and replayed, so bytes may never travel in it. Steps also narrate now: `report()` writes to the run's stream AND the server log, with the attempt number appended past the first, and `isTransientStatus`/`retryAfter` let a rate-limited step retry when the provider asked to be called back.
