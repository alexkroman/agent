---
"@alexkroman1/aai": minor
---

Wake a workflow run when it comes due, and drain a backlog in one sweep. A ctx.sleep past the engine's in-process timer was recovered only at boot, so it resumed whenever someone next visited the agent; the platform now sweeps for agents whose journal has work and boots them. runDue drains in batches rather than capping at one query, and an expired blob counts as a reason to wake, so pruning is no longer boot-only.
