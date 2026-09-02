---
"@alexkroman1/aai": minor
---

Add ctx.now(), ctx.random() and ctx.uuid() to WorkflowCtx — three journaled non-deterministic reads, so a workflow body gets the same value on every replay instead of a determinism bug. Each is keyed in its own positional journal space, takes no step attempt lease, and is refused inside a ctx.step. The transcription-workflow and call-audit templates drop their hand-rolled clock steps.
