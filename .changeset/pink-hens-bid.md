---
"@alexkroman1/aai": minor
---

Make the workflow fan-out concurrent and a run's results streamable. `mapConcurrent` (formerly `mapInBatches`, still exported) replaces sequential batches with a window over a cursor, so a slow item no longer holds back a whole round — the replay property needs the issue ORDER to be a pure function of the list, which a monotonic cursor gives at any width. New `emit(namespace, chunk)` writes structured partial results into a named stream that `streamOutput`/`useWorkflowProgress` already read, and `stubReporter()` on `/testing` is how a spec asserts either channel. The transcription template streams its transcript as each segment lands.
