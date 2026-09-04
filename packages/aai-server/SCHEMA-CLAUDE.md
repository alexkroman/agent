# packages/aai-server — the platform tables' write budget and their retention

A SIBLING of `packages/aai-server/CLAUDE.md`, for the reason
[`MODAL-CLAUDE.md`](MODAL-CLAUDE.md) beside it is one: Claude Code auto-loads
only `CLAUDE.md`, so nothing here is resident, and that guide is at 99% of the
120,000-char cap with no other package to push a section into. The RULE lives
there, under "Queryable run state is not `workflow_runs`' job", because a
decision somebody needs resident while editing a migration belongs in the
resident guide. What is HERE is the evidence, which is reference: the index
inventory as measured, what three other durable-execution engines did with the
same table, and — a second question about the same rows — which of these tables
are pruned on a timeframe and which are not.

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
- **The filter is already indexed — and check the LEADING COLUMN before
  believing it.** `workflow_runs_stalled_idx` and `workflow_runs_terminal_idx`
  between them cover both halves of `status` ordered by `created_at`, so "live
  runs, newest first" looks like a query the sweeps have already paid for. They
  have not paid for a CALLER's version of it: both are keyed `(created_at)` with
  no `slug`, because a sweep is deliberately cross-tenant. Every listing a
  caller wants is scoped to one agent, and against a `(created_at)` index that
  is a scan of every tenant's rows with a filter on top — which degrades as the
  platform grows, in exactly the way an index that "already exists" is assumed
  not to. So this exemption is real but nearly empty: it covers a cross-tenant
  read, which is what the sweeps are, and nothing a tenant asks for.
- **Steps stop being append-only.** `workflow_steps` is at one index entry per
  insert BECAUSE nothing reads it by anything but the primary key. If a run's
  steps become a real HTTP read (`GET /runs/:id/steps`, which does not exist
  today), that read is by `(slug, run_id)` — a primary-key prefix — so it still
  needs no index. Anything that filters steps by `status` or `name` does, and is
  the point at which this decision has to be re-argued rather than extended.

## Retention: twelve of the seventeen tables are pruned by time

The claim "everything outside `auth` is pruned on some timeframe" is **false**,
and `retention.test.ts` is the exact form of that answer: a verdict per table,
with the table list DERIVED from `supabase/migrations`, so a new table cannot
land without one and a deleted sweep fails the verdict that names it. Read the
verdicts there rather than here — this section is the summary and the argument
for the five exceptions.

| Pruned by | Tables | Window |
| --- | --- | --- |
| `aai-sweep-rate-limits` | `studio_rate_limits` | `reset_at` |
| `aai-sweep-studio-sessions` | `studio_sessions` | `expires_at` |
| `aai-sweep-session-state` | `session_slots`, `session_events` | `SESSION_STATE_RETENTION` (2 days) |
| `aai-sweep-upload-records` | `workflow_uploads` | `UPLOAD_RECORD_RETENTION` (7 days) |
| `aai-sweep-workflow-runs` | `workflow_runs` + `workflow_steps`, `workflow_attempts`, `workflow_attempt_leases`, `workflow_sleeps`, `workflow_hooks` | 30 days after the run started, once terminal |
| `aai-sweep-workflow-run-keys` | `workflow_run_keys` | when the run it names is gone |

Outside `aai_platform`, `aai-sweep-cron-history` prunes
`cron.job_run_details` and `aai-sweep-preview-archive` prunes
`pgmq.a_aai_studio_preview`, both at 7 days; `aai-sweep-blob-gc` reclaims
unreferenced `blobs/` and `uploads/` objects.

**The terminal-run window bounds the table only because every run REACHES a
terminal status**, which is a claim spanning SQL and TypeScript: the sweep's
predicate is `status in ('completed', 'failed', 'cancelled')`, and the only
platform-side writer of one is `abandonStalledRun` — bounded at
`RECONCILE_MAX_ATTEMPTS` re-walks, `STALL_GRACE_MS` apart. Before
`20260902120000` there was no such bound, so a run whose guest could never
finish it was immortal AND uncollectable. Neither half's own tests can see the
other, so the link is asserted here.

**And every child of a run is a hand-written CTE in
`sweep_terminal_workflow_runs`.** Those tables reference `agents`, not
`workflow_runs`, so there is no cascade underneath them: a new child added
without its own CTE leaks one row per retired run, forever. That is exactly what
`workflow_attempt_leases` would have done, and the gate is what says so now.

### The five that are NOT pruned by time

Each is a position, not an oversight — which is why the verdict carries its
EVIDENCE (a delete path in a named source file, or an `on delete cascade`) and
the gate checks it:

- `agents`, `studio_workspaces`, `studio_chats` — the author's own product: a
  deployed agent, a studio project, its chat history. A timer here deletes
  somebody's working agent while they are away from it. Note
  `aai-sweep-orphan-previews` DOES delete `agents` rows and is still not
  retention for the table: its predicate is the `%-preview` suffix, so it can
  never reach an agent an author deployed.
- `workflow_queue` — transient by construction and deliberately not by clock. A
  parked `sleep()` message may be due months out, and expiring it cancels the
  run; a message goes when it is delivered or its retry budget runs out
  (`ack`, `fail`, `failUnreachable`).
- `workflow_run_owner` — retired, written and read by nothing, owed a `drop`
  (`RETIRED_OBJECTS` in `platform-schema.test.ts`). Its rows are frozen rather
  than growing.

Adding a table means adding a verdict. If it is `unpruned`, the reason belongs
in the verdict, and the honest question to ask first is whether it is one of
these five kinds — the author's own data, a queue, or something retired — since
nothing else on this platform has an argument for growing forever.
