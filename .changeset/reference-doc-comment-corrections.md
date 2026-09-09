---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": patch
---

Correct the doc comments behind the generated SDK reference, which described an API the SDK no longer has.

`ctx.db` and `ctx.state` are gone, but seven published comments still taught them. `ToolContext`'s summary claimed it "provides access to the session environment, state, database, and conversation history" — four things, two of which do not exist, on a type with eleven fields — and omitted `signal` and `deadlineAt`, the two a tool doing slow work most needs. It now rosters the real fields, grouped by what a tool reaches for. `ctx.generate`, `workflow()` and `stepReport()` no longer explain themselves by analogy to a capability that was removed, and `aai-runtime`'s README no longer tells a self-hosting reader that `ctx.db` is whatever `Db` they passed: a self-hosted tool receives no database, and `RuntimeOptions.db` is spent on session-slot storage and the workflow run journal and key store. `TextAgentOptions.db` is documented as accepted-and-unused rather than as the thing that makes `ctx.db` work.

The reference front page taught `slot.projection()` where the guide teaches `slot.projected`; the `@module` table and its worked example now declare a `view` on the slot and pass `slot.projected`, and `AgentDef.syncState` leads with the same spelling, keeping `projection(view)` as the multi-view case. `mapConcurrent`'s only example issued no `ctx.step` at all, contradicting the hundred lines of module doc above it arguing the callback must issue exactly one, synchronously, under one literal name — it does now.
