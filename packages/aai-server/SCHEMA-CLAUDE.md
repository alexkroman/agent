# packages/aai-server — what the platform's workflow tables may be indexed for

A SIBLING of `packages/aai-server/CLAUDE.md`, for the reason
[`MODAL-CLAUDE.md`](MODAL-CLAUDE.md) beside it is one: Claude Code auto-loads
only `CLAUDE.md`, so nothing here is resident, and that guide is at 99% of the
120,000-char cap with no other package to push a section into. The RULE lives
there, under "Queryable run state is not `workflow_runs`' job", because a
decision somebody needs resident while editing a migration belongs in the
resident guide. What is HERE is the evidence, which is reference: the index
inventory as measured, and what three other durable-execution engines did with
the same table.

## The write path's current cost, measured

`aai_platform.workflow_runs` (`20260901000000_platform_workflow_journal.sql`)
carries its primary key `(slug, run_id)` and **three** secondary indexes, all
serving a SWEEP rather than a caller's query:

- `workflow_runs_listing_idx` `(slug, workflow, created_at desc, run_id desc)` —
  the one `listRuns` reads;
- `workflow_runs_stalled_idx` `(created_at) where status in ('pending',
  'running')` — the reconcile pass (`20260901020000`);
- `workflow_runs_terminal_idx` `(created_at) where status in ('completed',
  'failed', 'cancelled')` — the retention sweep (`20260902120000`).

Two of the three are PARTIAL on `status`, so the run's one terminal transition
already moves the row out of one index and into the other. That is the floor,
not zero, and it is what the two sweeps cost.

`aai_platform.workflow_steps` carries its primary key `(slug, run_id, key)` and
**nothing else** — every step insert is a heap append plus one index entry.
`20260902130000` added `started_at` and wrote "no index: nothing filters or
orders on it"; `20260902140000` added `code_version` to `workflow_runs` on the
same terms. The rule in `CLAUDE.md` is that precedent generalized, written down
before the first listing feature makes it a judgement call each time.

## What the other three engines did

- **DBOS Transact** indexed the status row directly. Its
  `src/sysdb_migrations/internal/migrations.ts` issues twenty `create index`
  statements against `workflow_status` and seven drops — two of the drops are
  followed immediately by a re-create narrowing a broad index to a partial, and
  one names an index created elsewhere — leaving **fourteen live**, of which
  **five** are partial with a `status` predicate (`idx_workflow_status_delayed`,
  `_pending`, `_failed`, `_in_flight`, `_partition_dequeue_v2`) and two more are
  partial on a column a transition sets (`completed_at`,
  `started_at_epoch_ms`). Every status write is maintenance across that set.
  Counted off `main` on 2026-09-03 by resolving creates against drops, because
  the file is append-only and its gross statement count over-states the live set
  by six.
- **Temporal** splits the two. `executions` is one row per run, blob columns,
  PK-ordered inserts, deliberately index-poor; everything queryable lives in
  `executions_visibility`, a wide table of generated columns that a visibility
  task updates ASYNCHRONOUSLY, off the critical path. The query surface is a
  different table with a different write budget, and it is allowed to lag.
- **Vercel's Workflow DevKit** keeps the event log lean and serves queries from
  a separate analytics API — the same split, drawn at the service boundary.

Ours is currently the cheapest of the four. Filling in the query surface on
`workflow_runs` is how that stops being true, one reasonable-looking migration
at a time; DBOS did not add fourteen indexes in one commit either.

## What would make this wrong

Three things, and none of them is "the projection is more work":

- **A caller for whom the lag is unaffordable.** A projection updated off the
  write path is behind, and a console listing runs does not care. A read that
  has to be transactional with the status write does, and that is the one
  argument for putting the column on the row itself. Name the caller.
- **The filter is already indexed.** `workflow_runs_stalled_idx` and
  `workflow_runs_terminal_idx` between them cover both halves of `status`
  ordered by `created_at`. A listing that wants exactly "live runs, newest
  first" is a query the sweeps have already paid for, and re-serving it from a
  projection would be a second copy for nothing. This is a narrow exemption for
  a predicate that already exists, not a licence to add a fourth index.
- **Steps stop being append-only.** `workflow_steps` is at one index entry per
  insert BECAUSE nothing reads it by anything but the primary key. If a run's
  steps become a real HTTP read (`GET /runs/:id/steps`, which does not exist
  today), that read is by `(slug, run_id)` — a primary-key prefix — so it still
  needs no index. Anything that filters steps by `status` or `name` does, and is
  the point at which this decision has to be re-argued rather than extended.
