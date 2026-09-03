---
"@alexkroman1/aai": minor
---

Workflows can declare an `output` schema beside `input`: what a completed run answers with, validated where the engine records the run — a body that misses its own declaration fails the run rather than reporting `completed` with an output the declaration denies — served to a page as `WorkflowSummary.outputSchema`, and read by `WorkflowOutputOf`, which now derives from the declared schema rather than from inferring the body. That fixes `WorkflowOutputOf` resolving to `never` for an annotated def, and lets an annotated `agent.ts` state its output type once, in the schema.
