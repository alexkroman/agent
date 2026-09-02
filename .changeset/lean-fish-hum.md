---
"@alexkroman1/aai": major
---

Durable-workflow SUSPENSION is no longer observable by a workflow body. `ctx.sleep` and `ctx.waitFor` used to suspend by THROWING a branded signal, so a `catch` in a body caught it — one shipped template did, unwound its compensation stack and deleted the transcript its run was waiting for, then re-threw, and the engine recorded the run as healthily suspended. A wait now returns a promise that never settles and the engine races the body against an out-of-band interruption channel, so there is nothing for a `catch` to catch and nothing for a `finally` to run on. `isWorkflowSuspend` is removed (there is nothing left for it to test) along with the internal suspend brand. Concurrent waits are also aggregated now: a `Promise.race` or `Promise.all` over several waits suspends ONCE, carrying the earliest outstanding timer deadline, so racing a hook against a sleep composes where it previously stopped the body at whichever wait was reached first.
