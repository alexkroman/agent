---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Fewer store round trips on three hot paths:

- `FindByKeyOptions.withOutput: false` leaves a completed run's `output` unread (`undefined` on every snapshot). `ctx.workflows.findByKey` also applies `since`/`statuses` to the raw run record before building a snapshot, so a run the filters drop never costs an output read. `clientRunsRoutes()`'s `/tasks` poll passes `withOutput: false` unless the app supplied an `include` or `detail` that may read `output`.
- The Postgres session-state backend now moves a client-bound session's `last_event_at` at most once per 30 s while the session is live, instead of with a second query after every event flush, plus once when the session stops. A live session's `last_event_at` may trail its newest event by up to 30 s; the `since` filters that read it are coarse, and events are re-filtered on their own timestamps.
- Internal: the runtime composes a session's greeting (the resume skip, `sessionContext`'s answer, the agent's own line) in one place before building its transport. Greeting behaviour is unchanged.
