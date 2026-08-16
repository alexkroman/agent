---
"@alexkroman1/aai": patch
---

Fix two durability bugs found by the turn/workflow durability audit.

**The Postgres workflow world never started.** `@workflow/world-postgres`'s
`setupDatabase` puts its `process.exit(0)` inside its own `try`, so the
`process.exit` stand-in's throw landed in that function's own `catch`, which
reported the migration as failed and exited 1 — every SUCCESSFUL migration read
as `exit 1`. The caller then threw before `getWorld().start?.()`, so a booting
guest never subscribed its queue and never ran `reenqueueActiveRuns`: a run
parked in a `sleep` or on a webhook was not picked up when its guest was woken,
and the orphaned-lock sweep was dead code on every boot. Runs started in the same
process still dispatched, which is why it went unnoticed. The stand-in now keeps
the FIRST exit code — a second `exit` is the CLI reacting to our own
interception.

**The session-state size cap counted UTF-16 code units against a byte budget.**
`json.length > MAX_SESSION_STATE_BYTES` let multi-byte content through at up to
~3x its real size — a slot the cap read as under 1 MiB writing 3 MiB into the
tenant's own schema, with the log naming the wrong number `bytes`. Now
`Buffer.byteLength`, the rule `_fetch-capped.ts` already states. Slots holding
CJK or emoji within ~3x of the cap that previously stored will now be refused and
reported, which is the cap doing what it documents.
