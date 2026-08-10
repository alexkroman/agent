---
"@alexkroman1/aai": minor
---

Add `workflow()` — durable, journaled work that outlives the session that started it.

A `workflow()` sits beside `agent()` and `tool()` in the same `agent.ts`: declared as `agent({ workflows })`, started from tool code with `ctx.workflows.start(name, input)`, which resolves as soon as the run is journaled — so a tool answers its turn while the run keeps going past the hangup. `ctx.workflows.get(runId)` reads status back.

Inside a run, `ctx.step(name, fn)` journals its result and is never re-run on replay, and `ctx.sleep(ms)` suspends durably without holding a process open. A run whose sandbox dies mid-step resumes on another one from its last recorded step, because a claim is leased (120s) rather than held. `ctx.env`, `ctx.db` and `ctx.generate` are all available, so an existing tool body moves into a step unchanged.

Steps are at-least-once: a crash between the function returning and the journal write re-runs it, so an external side effect wants an idempotency key. The sequence of `step` calls must be deterministic across replays — branch on values that came out of a step or the input, not on `Date.now()`. Workflows require storage (`aai storage enable`, or DATABASE_URL under `aai dev`); the journal is two tables in the app's own schema. An agent that declares workflows without storage still boots and answers calls — `ctx.workflows` rejects with a message naming the fix.

Not yet wired, both platform-side: nothing wakes an idle-exited sandbox to serve a due run (a sleep longer than 60s resumes on the next boot instead of on time), and there is no webhook or cron trigger surface, so runs start from a session or the browser client.

**Migration:** `createToolContext` from `@alexkroman1/aai/testing` supplies `workflows` (rejecting by default, like `db` and `generate`), so tests built on it need no change. Code that still hand-builds a `ToolContext` must add the field. Consuming `ctx.workflows` needs no change.

Also ships the `nightly-digest` template as a worked example.
