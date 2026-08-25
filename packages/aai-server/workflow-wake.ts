// Copyright 2026 the AAI authors. MIT license.
/**
 * Waking a durable run whose sandbox is gone.
 *
 * ## The failure
 *
 * A durable workflow's whole point is surviving the call that started it, and on
 * this platform the SANDBOX does not: an agent guest self-exits after
 * `AGENT_IDLE_EXIT_MS` with zero sessions. The Postgres world's queue is
 * graphile-worker POLLING the app's database, so a run that is asleep until
 * tomorrow has no process polling for it and never resumes. Nothing errors,
 * nothing logs, and `ctx.workflows.get(runId)` goes on reporting `running`
 * forever — the worst shape this failure could take, which is why it gets a
 * mechanism rather than a caveat.
 *
 * The webhook proxy (`workflow-webhook-handler.ts`) solved the neighbouring
 * problem — a delivery arriving for a parked run boots a sandbox — and left this
 * one open in writing. This is the other half: nobody is delivering anything, so
 * the platform has to notice the TIME.
 *
 * ## The design question, answered
 *
 * Two shapes were available (see the module docs referenced below for the third
 * option's death):
 *
 * 1. **The replica polls the queue on the tenant's behalf** — i.e. the platform
 *    process runs the DevKit's worker. REJECTED, and not on cost: it would
 *    execute tenant workflow code (every step body, every tool the step calls)
 *    in the platform process, which holds the service-role Postgres credential,
 *    Vault, and Modal's tokens. The Modal container is the security boundary
 *    (`CLAUDE.md`, "Security architecture"), and this would run tenant code on
 *    the wrong side of it. No amount of in-process sandboxing buys that back.
 * 2. **The platform detects due work and SPAWNS the sandbox**, which then polls
 *    its own queue with its own credentials, exactly as it does when a browser
 *    calls. CHOSEN.
 *
 * ### What (2) costs, stated plainly
 *
 * - **One sandbox per wake, billed for at least one idle window.** A run that
 *   sleeps 24 times pays 24 boots (~2-4s of Modal scheduling each) and 24 × 5
 *   minutes of guest lifetime, because the guest cannot exit before its idle
 *   window and has no way to know it will get nothing else to do. For a
 *   workflow that sleeps between steps this is the dominant cost of the whole
 *   feature, and it is inherent to "durable runs on ephemeral sandboxes" rather
 *   than to this implementation. The lever, if it ever matters, is the guest's
 *   `AAI_GUEST_IDLE_EXIT_MS`, not this sweep.
 * - **A wake LOOP is the way it could get expensive**, so it is bounded twice:
 *   {@link WORKFLOW_WAKE_RETRY_MS} per slug and
 *   {@link WORKFLOW_WAKE_MAX_PER_TICK} per tick.
 * - **Latency is one interval plus a boot** ({@link WORKFLOW_WAKE_INTERVAL_MS}).
 *   A `sleep()`-scale workflow does not notice; a workflow that wants
 *   sub-second resumption is not a workflow.
 * - **One reserved admin connection for the read phase of a tick, plus one POOLED
 *   connection per candidate app.** The reservation comes out of the existing
 *   admin pool, so the fleet-wide DIRECT budget
 *   (`MAX_PLATFORM_DB_CONNECTIONS`) is unchanged; the per-app reads go through
 *   Supavisor under a semaphore, so a pass costs at most
 *   {@link WORKFLOW_WAKE_READ_CONCURRENCY} pooled connections at a time however
 *   many apps exist — a constant, which is the property the budget needs. See
 *   `_workflow-wake-read.ts` for why the width is a constant and not the app
 *   count, and for what the serial version it replaced cost.
 *
 * ## How "due" is known without reading tenant queue state
 *
 * The platform cannot ask the queue: the DevKit's `graphile_worker` schema is
 * per-DATABASE and its rows carry no tenant column, so "which of these jobs is
 * agent X's" is answerable only inside the process whose world it is. So the
 * guest answers it, reducing its whole queue to one timestamp and writing it
 * into a table in the app's own database (`aai/host/workflow-wake-hint.ts`, which
 * owns that contract). This sweep reads that one column.
 *
 * The hint is tenant-writable, and the platform treats it as a HINT: the only
 * thing it can cause is a boot of the tenant's OWN agent, which the tenant can
 * already cause by fetching its own public `/client-config`. Forging another
 * tenant's wake is impossible by construction rather than by check — the DATABASE
 * is `appDbIdentifier(slug)` and the slug comes from the agents table, so a hint
 * is only ever read as belonging to the app whose database it sits in.
 *
 * ## The three things a wake must not do
 *
 * - **It must not resurrect a deleted agent.** Two independent guards, and the
 *   first is structural: candidates come from the agents TABLE, so an agent
 *   deleted between ticks is not in the list at all (its database may briefly
 *   outlive the row — the orphan sweep is asynchronous — and is skipped for
 *   having no slug). Behind that, `brokerSessionUrl` answers 404 for a slug with
 *   no bundle, so a row deleted mid-tick still boots nothing.
 * - **It must not fight the blue-green handover.** It touches no slot itself:
 *   waking IS `brokerSessionUrl`, the platform's one routing point, which serves
 *   a live resident as-is, joins a boot already in flight, routes to a live PEER
 *   replica instead of spawning a duplicate (`sandbox-directory.ts`), and
 *   refuses to boot while draining. A redeploy's `handoverSlot` holds the slug
 *   lock; a wake landing mid-handover queues behind it and then finds the new
 *   resident live.
 * - **It must not multiply by the replica count.** The read phase takes a
 *   transaction-scoped advisory lock, so one replica sweeps per tick. That is an
 *   efficiency measure, not a correctness one — `brokerSessionUrl` is already
 *   idempotent fleet-wide — which is why a lost lock is a silent skip rather
 *   than an error.
 *
 * ## Known gaps, both inherited rather than introduced
 *
 * - **Apps placed on an extra `APP_DB_URLS` cluster are not swept**, and boot
 *   says so out loud. Those clusters have their own pools, which the connection
 *   budget cannot currently afford (`platform-db-budget.test.ts` fails for one
 *   extra target), so there are none in production; supporting them means
 *   another target's executor here and is a few lines when a cluster exists.
 * - **A step lost with its container stays lost for graphile-worker's 4-hour job
 *   expiry** — the guest's hint says so (`GRAPHILE_JOB_EXPIRY`), because no
 *   other worker may claim a locked job before then. Any boot for another reason
 *   repairs it sooner: the Postgres world re-enqueues active runs on `start()`.
 */

import { errorMessage } from "@alexkroman1/aai";
import {
  type DueRead,
  NOT_LOCKED,
  readDueWork,
  WORKFLOW_WAKE_READ_CONCURRENCY,
} from "./_workflow-wake-read.ts";
import type { AppDatabases } from "./app-database.ts";
import {
  WORKFLOW_WAKE_INTERVAL_MS,
  WORKFLOW_WAKE_MAX_PER_TICK,
  WORKFLOW_WAKE_READ_TIMEOUT_MS,
  WORKFLOW_WAKE_READY_MS,
  WORKFLOW_WAKE_RETRY_MS,
} from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import { type BrokeredSession, brokerSessionUrl } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("workflow.wake");

export type WorkflowWakeOptions = {
  /**
   * The platform admin connection. The read phase runs on ONE reserved
   * connection from its pool — the advisory lock needs connection affinity and
   * `set local statement_timeout` needs a transaction, and both are the same
   * reservation.
   *
   * Absent means no platform database (local dev, tests), where there are no
   * per-app databases to read and nothing to sweep.
   */
  adminDb: AdminDb;
  /**
   * Opens a connection into one app's OWN database — where its hint now lives.
   *
   * Required alongside `adminDb` rather than optional: the two arrive together
   * (both come from a configured `SUPABASE_DB_URL`), and a sweep holding an admin
   * connection with no way to reach a tenant's database can read nothing at all,
   * so making it optional would only buy a pass that silently finds no work.
   */
  appDb: AppDatabases;
  /** Slug enumeration (`listSlugs`) — see the doc there for why it is uncached. */
  store: BundleStore;
  /** What `brokerSessionUrl` needs to boot a sandbox. */
  broker: ResolveSandboxOpts;
  /** True while this replica is shutting down; the pass then does nothing. */
  isDraining?: (() => boolean) | undefined;
  retryMs?: number | undefined;
  maxPerTick?: number | undefined;
  readTimeoutMs?: number | undefined;
  /**
   * How many app databases the read phase may open at once. Defaults to
   * `WORKFLOW_WAKE_READ_CONCURRENCY`; a spec pins it to assert the width.
   */
  readConcurrency?: number | undefined;
  /** Injectable clock for the backoff (tests). */
  now?: (() => number) | undefined;
  /**
   * How a due slug is woken. Defaults to `brokerSessionUrl` against `broker`;
   * a seam for the same reason the webhook proxy's guest `fetch` is one — a spec
   * can assert WHICH slugs a pass wakes without standing up a sandbox.
   */
  wake?: ((slug: string) => Promise<BrokeredSession>) | undefined;
};

/** What one pass did, for the caller's log and for specs to assert on. */
export type WorkflowWakeResult = {
  /** False when another replica held the lock, or this one is draining. */
  swept: boolean;
  /** Agents with a hint table (i.e. that run workflows). */
  candidates: number;
  /** Of those, hints that were due. */
  due: number;
  /** Slugs a sandbox was brokered for. */
  woken: string[];
  /** Due slugs left for a later tick: backoff, the per-tick cap, or a 404. */
  skipped: number;
};

const EMPTY_PASS: WorkflowWakeResult = {
  swept: false,
  candidates: 0,
  due: 0,
  woken: [],
  skipped: 0,
};

/**
 * The sweep as a long-lived object: one pass is `sweepOnce`, and `start` runs
 * them on an interval until the returned stop function is called.
 *
 * @internal
 */
export type WorkflowWakeSweep = {
  /** Run one pass now. Never rejects — a pass failure is logged and dropped. */
  sweepOnce(): Promise<WorkflowWakeResult>;
  /** Begin ticking; returns the stop. Idempotent. */
  start(intervalMs?: number): () => void;
};

/**
 * Build the sweep.
 *
 * The per-slug backoff lives HERE rather than in the database, and per replica
 * rather than fleet-wide, which is a deliberate weakening: the leader can change
 * between ticks, so a slug could in principle be woken by two replicas inside
 * one backoff window. That costs a broker call that finds a live resident and
 * returns it — the same no-op a session lands on — and buying strictness would
 * mean a table, a writer, and a sweep for its dead rows. The map is pruned every
 * pass, because a long-lived process must not grow one entry per key forever.
 *
 * @internal
 */
export function createWorkflowWakeSweep(opts: WorkflowWakeOptions): WorkflowWakeSweep {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? WORKFLOW_WAKE_RETRY_MS;
  const maxPerTick = opts.maxPerTick ?? WORKFLOW_WAKE_MAX_PER_TICK;
  const readTimeoutMs = Math.max(
    1,
    Math.round(opts.readTimeoutMs ?? WORKFLOW_WAKE_READ_TIMEOUT_MS),
  );
  const readConcurrency = Math.max(
    1,
    Math.round(opts.readConcurrency ?? WORKFLOW_WAKE_READ_CONCURRENCY),
  );
  // Waking is `brokerSessionUrl` with the READINESS WAIT cut short, because this
  // caller is not a client: nobody is holding a request open for the answer, and
  // the sweep only needs the boot STARTED. Left at `BROKER_READY_TIMEOUT_MS`
  // (20s) a tick with `maxPerTick` cold slugs would spend minutes waiting out
  // boots it does not read, serially, and overrun its own interval. Timing out
  // cancels nothing — the sandbox is attached to its slot and keeps booting, and
  // the next tick's read is what says whether the run advanced. A live resident
  // still answers `ok` inside this window, since its URL is already resolved.
  const wake =
    opts.wake ??
    ((slug: string) =>
      brokerSessionUrl(slug, { ...opts.broker, readyTimeoutMs: WORKFLOW_WAKE_READY_MS }));
  /** slug → when it was last woken, for the backoff. */
  const lastWoken = new Map<string, number>();

  /** Drop backoff entries that can no longer suppress anything. */
  function pruneBackoff(at: number): void {
    for (const [slug, woken] of lastWoken) {
      if (at - woken >= retryMs) lastWoken.delete(slug);
    }
  }

  /** Is this slug still inside the backoff window from its last wake? */
  function suppressed(slug: string, at: number): boolean {
    const last = lastWoken.get(slug);
    return last !== undefined && at - last < retryMs;
  }

  /**
   * Broker a sandbox for one due slug, and say whether it counted as an attempt.
   *
   * A 503 counts: it means "booting, or this replica is going away", and the boot
   * continues server-side, so hammering it every interval would spawn nothing.
   * A 404 does NOT: the agent is gone, there is nothing to back off from, and its
   * schema goes with the orphan sweep.
   */
  async function wakeOne(slug: string, at: number): Promise<boolean> {
    const brokered = await wake(slug).catch((err: unknown) => {
      log.warn("wake failed", { slug, error: errorMessage(err) });
      return { ok: false, status: 503 } as BrokeredSession;
    });
    if (!brokered.ok && brokered.status === 404) {
      log.debug("Due workflow hint for an agent with no bundle; not waking", { slug });
      return false;
    }
    lastWoken.set(slug, at);
    log.debug("Woke a sandbox for due workflow work", { slug, ok: brokered.ok });
    return true;
  }

  async function sweepOnce(): Promise<WorkflowWakeResult> {
    // A draining replica must not boot sandboxes (they would outlive it with
    // nothing holding them — see `isDraining` in sandbox-resolve.ts). The broker
    // refuses too; this just saves the pass.
    if (opts.isDraining?.()) return EMPTY_PASS;

    const read: DueRead = await readDueWork({
      adminDb: opts.adminDb,
      store: opts.store,
      appDb: opts.appDb,
      readTimeoutMs,
      readConcurrency,
    }).catch((err: unknown) => {
      // The pass, not the sweep: the interval keeps ticking. Warn rather than
      // debug — a sweep that cannot read is a feature that has silently stopped
      // working, which is the failure this module exists to remove.
      log.warn("sweep failed to read due runs", { error: errorMessage(err) });
      return NOT_LOCKED;
    });
    if (!read.locked) return EMPTY_PASS;

    const at = now();
    pruneBackoff(at);
    const woken: string[] = [];
    let skipped = 0;

    for (const slug of read.due) {
      if (woken.length >= maxPerTick || suppressed(slug, at)) {
        skipped += 1;
      } else if (await wakeOne(slug, at)) {
        woken.push(slug);
      } else {
        skipped += 1;
      }
    }

    if (read.due.length > 0) {
      log.debug("Workflow wake sweep", {
        candidates: read.candidates,
        due: read.due.length,
        woken: woken.length,
        skipped,
      });
    }
    return { swept: true, candidates: read.candidates, due: read.due.length, woken, skipped };
  }

  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return {
    sweepOnce,
    start(intervalMs = WORKFLOW_WAKE_INTERVAL_MS): () => void {
      if (timer || intervalMs <= 0) return stop;
      // Serialized rather than overlapped: a pass that outruns the interval
      // would queue reservations behind each other, and the next pass would
      // re-read the same due set anyway.
      let running = false;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void sweepOnce().finally(() => {
          running = false;
        });
      }, intervalMs);
      // The sweep must never be the reason the process stays up.
      timer.unref?.();
      return stop;
    },
  };
}

/**
 * Wire the sweep into a composition, or say why it is not wired.
 *
 * Every branch speaks, because a durable-workflow feature that silently never
 * wakes anything is exactly what this module exists to prevent — and it speaks
 * at a level matched to WHO can act on it, which is the correction: "no platform
 * database" is the normal state of local dev, where a developer's runs live in
 * the local world and need no waking at all, while half a platform database is a
 * miswiring nobody asked for. See the branch itself for the bug that taught the
 * difference.
 *
 * @internal
 */
export function startWorkflowWakeSweep(
  opts: Omit<WorkflowWakeOptions, "adminDb" | "appDb"> & {
    adminDb?: AdminDb | undefined;
    appDb?: AppDatabases | undefined;
    intervalMs?: number | undefined;
    extraAppDbClusters?: number | undefined;
  },
): () => void {
  const intervalMs = opts.intervalMs ?? WORKFLOW_WAKE_INTERVAL_MS;
  const { adminDb, appDb } = opts;
  // Both bindings come from a configured `SUPABASE_DB_URL`, so in practice they
  // are present or absent together — but the sweep needs BOTH to do anything
  // (the admin connection elects a leader, the app connections hold the hints),
  // and a pass with one of them reads nothing while looking healthy.
  //
  // So the three ways not to start are THREE branches, because they are not one
  // event. Absent together is the normal state of local dev and of every spec.
  // Exactly ONE of them is a MISWIRING — a composition that HAS a platform
  // database and did not hand the sweep all of it — and there is no operator
  // action that produces it, so it is an `error` naming what is missing.
  //
  // They had to be split, because the merged branch is what hid the real one:
  // `orchestrator.ts` passed `adminDb` and not `appDb` from #1130, the commit
  // that moved each hint into its app's own database, and this reported it as
  // "no platform database" at a level `consoleLogger` DROPS unless `AAI_DEBUG=1`
  // (see `logger.ts`). The one line that would have contradicted it — the
  // `log.info` below — never printed either, so the only evidence was an
  // absence. A mechanism whose entire purpose is to remove a silent failure
  // announced its own absence silently, and every parked durable run on the
  // platform stayed parked.
  if (!(adminDb && appDb)) {
    if (!(adminDb || appDb)) {
      log.debug("Workflow wake sweep not started", { reason: "no platform database" });
    } else {
      log.error(
        `Workflow wake sweep NOT started: no ${adminDb ? "appDb" : "adminDb"}, though ` +
          "this composition has a platform database. No durable run whose sandbox " +
          "has exited will ever resume (see workflow-wake.ts).",
      );
    }
    return () => undefined;
  }
  if (intervalMs <= 0) {
    // `info` rather than `debug`: this is the documented kill switch, and an
    // operator who set it is reading this log to confirm the sweep's state.
    log.info("Workflow wake sweep not started: interval is 0");
    return () => undefined;
  }
  if ((opts.extraAppDbClusters ?? 0) > 0) {
    // Loud, because the gap is per-AGENT and invisible from the outside: an app
    // placed on an extra cluster would look identical to one on the primary
    // right up until a run failed to wake.
    log.warn(
      "APP_DB_URLS names extra clusters; durable runs for apps placed " +
        "there are NOT woken (see workflow-wake.ts, Known gaps).",
    );
  }
  const sweep = createWorkflowWakeSweep({ ...opts, adminDb, appDb });
  log.info(`sweeping for due durable runs every ${intervalMs}ms`);
  return sweep.start(intervalMs);
}
