---
issue: "https://github.com/alexkroman/agent/issues/1105"
status: proposed
last_updated: 2026-08-14
---

# Reclaiming workflow queue locks after a Postgres outage

## The state of it

PR #1104 shipped a **startup** sweep (`packages/aai/host/workflow-lock-sweep.ts`):
at boot, before the runner begins polling, a session advisory lock establishes
that no other pool is alive, and every lock present is therefore an orphan and is
cleared through `graphile_worker.force_unlock_workers`.

That covers a process that restarts — a Modal sandbox reclaimed on idle or
superseded on redeploy, an `aai dev` killed and rerun. It does not cover the fault
that started this work: **Postgres going away under a process that survives it.**
No restart, no sweep.

## What was wrong in the first telling, and the corrected mechanism

The original chaos write-up (and the memory, two commit messages and a guide
paragraph that followed it) said recovery waited on graphile-worker's
`interval '4 hours'` reclaim. **There is no such reclaim.**

- `is_available` is a **stored generated column**:
  `(locked_at is null) and (attempts < max_attempts)` — graphile-worker migration
  `000011.sql`. No time term.
- graphile-worker **0.16.6 has no `jobExpiry` option** at all; the name appears
  nowhere in the package.
- The one `interval '4 hours'` surviving in the live schema is a clause inside
  `remove_job(job_key)`, which DELETES a job whose lock has staled rather than
  making it runnable. The other occurrences are default parameters of the LEGACY
  `get_job(worker_id, task_identifiers, job_expiry)` function, which the modern
  runner does not call — it issues its own query selecting on `is_available`.
- Empirically: a job wedged by one kill was still held by the same dead worker an
  hour later, with the run still `running`.

So a stranded lock is stranded for the life of the database, and the startup sweep
is the ONLY recovery rather than an accelerator of one. That makes this issue worth
more than it first looked.

## Why a periodic sweep cannot simply be added

A sweep that runs while the pool is live has to distinguish locks the pool is
still executing from locks it has abandoned. Neither identity nor time can do it:

- **Identity is unavailable.** `world-postgres` calls graphile-worker's `run()`
  with a closed option set (`dist/queue.js:456`: `pgPool`, `concurrency`,
  `logger`, `pollInterval`, `taskList`) — no `workerId`, no `events`, no `preset`.
  So this package cannot name its own pool's workers, and cannot be told them.
- **Postgres cannot be asked either.** Worker ids are
  `worker-<randomBytes(9).hex>`, assigned per worker at pool creation
  (`dist/worker.js:13`), and no `application_name` is set on the connections — so
  there is no join from `pg_stat_activity` to `locked_by`.
- **Time does not separate them.** After an outage the SAME worker id holds both
  kinds of lock: the runner survives the reconnect and keeps its ids, so a step
  that began before the outage and is still awaiting in-process is indistinguishable
  by `locked_at` from one whose completion can never land.

That last point is why the startup sweep's safety argument does not generalize.
At boot the pool provably holds nothing, so "every lock is an orphan" is a fact.
Mid-life it is a guess.

## Options

| # | Approach | Cost |
| --- | --- | --- |
| 1 | **Upstream**: graphile-worker renews a lock while its job runs, or `world-postgres` passes through `workerId`/`events`/`preset` | Not ours to schedule; fixes it for every consumer |
| 2 | **`pnpm patch` `@workflow/world-postgres`** to take a per-process worker-id prefix, then sweep by prefix | Safe and local; a patched dependency to carry across upgrades |
| 3 | **Time-based sweep** — clear locks older than N | A long step may execute TWICE. Within the DevKit's at-least-once contract, but a deliberate escalation: the current sweep never touches a live lock, and a billed provider call running twice is a real cost |
| 4 | **Restart the pool on reconnect** — new ids make the old ones attributable | Interrupts work that survived the outage; the heaviest hammer |

**Recommendation: 1, with 2 as the bridge if the outage case starts biting.**
3 is the only one needing a product decision rather than an engineering one,
because it changes what a caller can be billed for; do not take it quietly.

## What is already in place to build on

- `claimPoolPresenceAndSweep` (`workflow-lock-sweep.ts`) — the advisory-lock
  presence handle, its 15s re-assert, and `force_unlock_workers` plumbing. A
  periodic sweep would reuse all of it and change only which locks it selects.
- `tmp/transcribe-load/pg-chaos.mjs` — reproduces the outage wedge with a UX
  oracle that mirrors `useWorkflowRun`'s poll semantics.
- `packages/aai-cli/_fault-mode.ts` — the process-restart fault mode, which is how
  a fix here would be regression-tested in CI once a kill-during-a-run profile can
  be green.
