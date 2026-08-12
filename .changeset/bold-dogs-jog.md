---
"@alexkroman1/aai": minor
---

`ctx.continueAs(input)` ends a run and starts a successor with a fresh journal, so a workflow that would otherwise accumulate an unbounded step history — a poller, a scheduler, a per-cycle loop — stays inside the 500-step cap. The successor is created BEFORE the current run completes, so a crash in between leaves work queued rather than lost, and a `continuation_depth` column bounds a chain at 500 links: an unconditional `continueAs` is an infinite loop, which is how this guard was found (it hung the suite). Validation of the successor's input fails the CURRENT run with the reason instead of escaping as an unhandled throw and leaving it `running` forever.
