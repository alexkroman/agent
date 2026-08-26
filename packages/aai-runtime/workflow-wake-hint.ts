// Copyright 2026 the AAI authors. MIT license.
/**
 * The wake HINT: when does this agent's durable-run queue next need a process?
 *
 * A durable run outlives the call that started it, and on the platform the
 * SANDBOX does not — an agent guest self-exits after `AGENT_IDLE_EXIT_MS` with
 * zero sessions. The Postgres world's queue is graphile-worker POLLING the
 * database, so a run sleeping until tomorrow has nobody polling for it and
 * simply never resumes. Nothing errors; the run is just gone. The platform's
 * answer is to boot a sandbox when work comes due
 * (`aai-server/workflow-wake.ts`), and to do that it has to know WHEN — which
 * is what this module publishes.
 *
 * ## Why the guest publishes it, rather than the platform reading the queue
 *
 * Because the platform cannot ask the question. The DevKit's queue is one
 * `graphile_worker` schema per DATABASE and its rows carry no tenant column, so
 * "which of these jobs is agent X's" is answerable only from inside the process
 * whose world it is. The guest is that process. It therefore reduces its whole
 * queue to ONE timestamp — the earliest moment a job could be claimed — and
 * writes it into a table in the app's own `ctx.db` schema, which the platform
 * CAN read (it provisioned that schema; see `aai-server/app-database.ts`).
 *
 * So the boundary holds in both directions: tenant queue state is read only by
 * tenant code, and the platform learns a single `timestamptz` about an agent it
 * already knows exists.
 *
 * ## The hint is advisory, and that is a security property
 *
 * The table lives in the tenant's schema and the tenant's role owns it — the
 * same posture as the correlation-key index next door (`workflow-keys.ts`), and
 * for the same reason: there is no provisioning pass to hang a DDL step off, an
 * agent's first workflow may be its first ever deploy. So the value is
 * tenant-writable, and the platform must treat it as a HINT rather than as
 * authority. It can: the only thing a hint causes is a boot of the tenant's OWN
 * agent, which the tenant can already cause by fetching its public
 * `/client-config`. The platform's own rate limit on that is its per-slug wake
 * backoff.
 *
 * ## What "claimable" means, and why a locked job still counts
 *
 * `wake_at` is the earliest time this queue may have work a worker can take:
 *
 * - an unlocked job is claimable at its `run_at` (a `sleep()` writes that);
 * - a LOCKED job is claimable at its `locked_at`, i.e. **now**. That is not
 *   graphile-worker's answer — it lets no OTHER worker rescue a locked job until
 *   its 4-hour job expiry ({@link GRAPHILE_JOB_EXPIRY}) — and publishing that
 *   4-hour answer is a DEADLOCK against our own recovery, measured end to end:
 *   `workflow-lock-sweep.ts` clears a dead worker's locks and re-enqueues active
 *   runs, and it runs at GUEST STARTUP, so a boot is precisely what makes such a
 *   job claimable. Telling the platform "nothing for four hours" is telling it
 *   not to do the one thing that would fix this. Reproduced: SIGKILL a guest
 *   mid-step, hint goes to `locked_at + 4h`, and the run sits `running` with no
 *   wake — while the very same kill a few seconds earlier (hint still on the
 *   unlocked branch) recovered within one sweep.
 *
 *   So the two cases collapse: a locked job means "a process was needed here",
 *   and on this platform the remedy for both a live one and a dead one is the
 *   same broker call. If the worker is ALIVE its sandbox is alive — a workflow
 *   callback counts as busy, so it is not idle-evicted — and `brokerSessionUrl`
 *   serves that resident rather than spawning, i.e. the wake is a no-op bounded
 *   by `WORKFLOW_WAKE_RETRY_MS` (10 min per slug). If it is DEAD, the boot runs
 *   the sweep and the step is redelivered. This is the module's own "publishing
 *   early is safe; publishing late strands a run" applied to the one case that
 *   was still publishing late;
 * - a job past `max_attempts` is permanently failed and counts for NOTHING.
 *   Left in, its `run_at` is forever in the past, so the platform would boot a
 *   sandbox for it every sweep, for the life of the agent.
 *
 * An empty queue publishes `null`, which is what stops the waking.
 *
 * ## Publishing early is safe; publishing late strands a run
 *
 * Every rounding here is toward an EARLIER `wake_at`, because the two errors
 * are not symmetric: too early costs one boot the platform skips as a no-op
 * (the sweep serves a live resident as-is), while too late is the silent
 * failure this whole path exists to remove.
 */

import type { Db } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { ensureOnce } from "./_ensure-once.ts";
import { openAppDb } from "./app-db.ts";
import type { CloseableDb } from "./postgres-db.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * The table the hint lives in — the ONE contract both ends derive from.
 *
 * The guest writes it (below) and `aai-server/workflow-wake.ts` reads it out of
 * `app_<hash>.<this table>` on the platform's admin connection. Spelling it in
 * the SDK rather than in either consumer is what keeps a rename from being two
 * edits that can disagree; the platform imports this constant.
 *
 * @internal
 */
export const WORKFLOW_WAKE_TABLE = "aai_workflow_wake";

/**
 * graphile-worker's job expiry: how long a job locked by a worker that never
 * came back stays untouchable (`get_job`'s `job_expiry` default, 0.16.6).
 *
 * Pinned as an interval literal because it is a fact about the QUEUE, not a
 * policy of ours — reading a lower number here would publish a wake the queue
 * cannot honour, and the guest would boot, find nothing claimable, and idle out
 * again on every sweep.
 *
 * @internal
 */
export const GRAPHILE_JOB_EXPIRY = "4 hours";

/**
 * Kept, though the hint no longer publishes it: it is the window a LOST step
 * stays lost for if nothing boots a guest, which is what makes the wake sweep
 * load-bearing rather than an optimization. See the locked-job case above for
 * why publishing it as `wake_at` deadlocked the recovery it describes.
 */

/** Where the DevKit's graphile-worker queue lives (its default schema). */
const QUEUE_TABLE = "graphile_worker.jobs";

/**
 * How often a guest re-publishes while it is running, on top of the per-callback
 * refresh.
 *
 * The per-callback publish is the accurate one — it runs the instant a run's
 * queue state changed. This is the backstop for the window that publish cannot
 * cover: a run parked between callbacks (a tool calling `ctx.workflows.start()`
 * mid-session) on a guest that is then SIGKILLed, whose hint would otherwise
 * stay stale until something else boots it. A minute bounds that window at one
 * minute for two small queries.
 */
const PUBLISH_INTERVAL_MS = 60_000;

/**
 * Does this database have a DevKit queue at all?
 *
 * Checked rather than assumed because the publisher runs in three worlds: the
 * Postgres world (yes), the Local World under `aai dev` (no — its queue is in
 * memory), and a guest whose world failed to start (no). A statement naming a
 * non-existent relation fails at PARSE time, so it cannot be made conditional
 * inside the upsert; this is the guard.
 */
const QUEUE_EXISTS_SQL = `select to_regclass('${QUEUE_TABLE}') is not null as present`;

/**
 * The whole publish, as one statement: reduce the queue to its earliest
 * claimable moment and upsert it.
 *
 * Computed in SQL rather than read-then-write so the value is the database's own
 * answer at one instant, and so `now()` is the DATABASE's clock — the platform
 * compares against the same clock when it reads (`wake_at <= now()`), which is
 * what keeps a replica's clock skew out of a scheduling decision.
 */
const PUBLISH_SQL = `insert into ${WORKFLOW_WAKE_TABLE} (id, wake_at, updated_at)
select true,
       (select min(case
                     when j.locked_at is null then j.run_at
                     else j.locked_at
                   end)
        from ${QUEUE_TABLE} j
        where j.attempts < j.max_attempts),
       now()
on conflict (id) do update set wake_at = excluded.wake_at, updated_at = now()`;

/**
 * One row, by construction: `id` is a boolean primary key with a `check` that
 * only the `true` row can exist, so the platform's read is O(1) whatever else
 * happens to this schema, and a second writer cannot grow the table.
 *
 * `wake_at` is nullable and null MEANS something — "nothing pending" — which is
 * why the row is upserted rather than deleted when the queue drains: a deleted
 * row and an unwritten one are indistinguishable, and the platform would have
 * to guess which.
 */
const CREATE_TABLE_SQL = `create table if not exists ${WORKFLOW_WAKE_TABLE} (
  id boolean primary key default true check (id),
  wake_at timestamptz,
  updated_at timestamptz not null default now()
)`;

/**
 * Publishes this guest's wake hint. Inert when the agent has no database.
 *
 * @internal
 */
export type WakeHintPublisher = {
  /**
   * Publish the current hint. Coalesced (see {@link createWakeHintPublisher}),
   * never rejects, and safe to call fire-and-forget from a request path.
   */
  publish(): Promise<void>;
  /** Stop the periodic republish and release the database lease this module took. */
  close(): Promise<void>;
};

/**
 * What {@link createWakeHintPublisher} needs. Every field is optional: an agent
 * with no database gets an inert publisher rather than a branch at the call site.
 *
 * @internal
 */
export type WakeHintOptions = {
  /**
   * The app's own database (`DATABASE_URL` — the same scoped role `ctx.db`
   * uses). Absent means the agent has no storage, so there is no Postgres world
   * and nothing to publish: the publisher is a no-op.
   */
  databaseUrl?: string | undefined;
  /** Pre-built handle, for tests. Wins over `databaseUrl`; never closed here. */
  db?: Db | undefined;
  logger?: Logger | undefined;
  /** Periodic republish interval; 0 disables it (tests, and `aai dev`). */
  intervalMs?: number | undefined;
};

/**
 * Build the publisher for one guest.
 *
 * `publish()` is COALESCED (`createCoalescingRunner`): the queue callbacks that
 * trigger it can arrive several at a time and the answer is a read of latest
 * state, so N triggers during one in-flight publish share one trailing run
 * instead of queueing N round trips behind each other.
 *
 * A failure WARNS and resolves. Publishing is bookkeeping about a queue, not
 * part of serving the callback that triggered it: a broken hint costs a run its
 * automatic wake, while a rejection thrown into a queue callback costs the run
 * its STEP — the DevKit retries a 5xx, so it would turn a bookkeeping fault into
 * a replay. The warn is per publisher-lifetime rather than per call, because the
 * usual cause (no privilege, no world) repeats every minute for the life of the
 * sandbox.
 *
 * @internal
 */
export function createWakeHintPublisher(opts: WakeHintOptions = {}): WakeHintPublisher {
  const owned: CloseableDb | undefined =
    opts.db || !opts.databaseUrl
      ? undefined
      : // A LEASE on the process's one pool for this URL, never a pool of its own.
        // This writes two small statements a minute at most, so a pool sized for it
        // was a pool of one — and one connection is 10% of what the whole app role
        // may hold (`sdk/app-db-budget.ts`), spent on the least important writer in
        // the process. It was also the consumer that FAILED when the budget was
        // over-subscribed, since it is usually the last to ask.
        openAppDb(opts.databaseUrl);
  const db = opts.db ?? owned;
  const logger = opts.logger;

  if (!db) {
    return { publish: () => Promise.resolve(), close: () => Promise.resolve() };
  }

  let warned = false;

  /**
   * Create the table once per publisher.
   *
   * `ensureOnce` owns the memo and the clear-on-rejection that the retry below
   * depends on — a failed DDL must not be remembered as done, so that a
   * transient privilege or connection fault is recoverable without a redeploy.
   * That used to be a `created = undefined` in the runner's catch, i.e. the
   * memo's own invariant maintained from outside it.
   */
  const ensureTable = ensureOnce(() => db.query(CREATE_TABLE_SQL).then(() => undefined));

  const runner = createCoalescingRunner(async (): Promise<void> => {
    try {
      const rows = await db.query<{ present: boolean }>(QUEUE_EXISTS_SQL);
      // No queue: the Local World, or a world that never started. Writing a
      // null hint here would be a claim we cannot make — this guest does not
      // know whether some other process's world holds pending work — so leave
      // whatever is there alone.
      if (rows[0]?.present !== true) return;
      await ensureTable();
      await db.query(PUBLISH_SQL);
    } catch (err: unknown) {
      // Re-armed on success below, so a transient failure is reported again
      // once it stops being transient... and a permanent one is reported once.
      if (!warned) {
        warned = true;
        logger?.warn?.("Workflow wake hint not published", { error: errorMessage(err) });
      }
      return;
    }
    warned = false;
  });

  const timer =
    (opts.intervalMs ?? PUBLISH_INTERVAL_MS) > 0
      ? setInterval(() => void runner.trigger(), opts.intervalMs ?? PUBLISH_INTERVAL_MS)
      : undefined;
  // Never hold the process open for a hint: the guest's own idle controller
  // decides when this sandbox dies, and a ref'd timer would outvote it.
  timer?.unref?.();

  return {
    publish: () => runner.trigger(),
    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      await owned?.close();
    },
  };
}
