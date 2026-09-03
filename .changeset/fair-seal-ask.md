---
"aai-server": patch
"@alexkroman1/aai-runtime": patch
---

The durable-workflow queue claim reads two new columns instead of re-deriving them every tick: `workflow_queue.run_id` (generated from the payload envelope) and `workflow_queue.kind` (written at enqueue from the DevKit queue-name grammar). A busy tick goes 516 ms to 20 ms and an idle one 1.7 ms to 0.9 ms on a 200,000-row queue, and the expression index the old spelling needed is dropped with nothing in its place. Also: a zero-delay re-park now notifies, so a guest parking a busy walk no longer waits out a whole poll interval; and `STEP_QUEUE_NAME_PATTERN`/`WORKFLOW_QUEUE_NAME_PATTERN` leave `@alexkroman1/aai-runtime/internal`, which existed only to cross into that SQL.
