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
 * ## Placement clusters ARE swept, and the claim is tested
 *
 * This section used to record the opposite as a known gap — "apps placed on an
 * extra `APP_DB_URLS` cluster are not swept" — and boot warned about it. Neither
 * was true, and nothing in the sweep ever had to change for it to be true: every
 * step of the pass is either cluster-INDEPENDENT or follows the app's own
 * locator. The candidate set comes from `vault.decrypted_secrets` and the agents
 * table, both on the platform database, so a sharded app is enumerated like any
 * other; and the per-app read goes through `AppDatabases.withAppDb`, which
 * composes its URL from `meta.url` — the cluster the app was provisioned on —
 * and that cluster's own pooler. `workflow-wake.scenario.test.ts` drives a
 * second target end to end so the claim cannot rot back into a warning.
 *
 * What WAS broken, and is fixed, is a layer down: one fleet-wide
 * `APP_DB_POOLER_URL` meant a sharded app's URL was rewritten onto the primary's
 * Supavisor while carrying the extra project's tenant suffix, so every
 * connection to it failed — the guest's own `DATABASE_URL` included. See
 * `AppDbTarget.poolerUrl`. The budget's half of the story is in
 * `platformDbConnectionsPerReplica`: an extra cluster's pool was charged to the
 * primary instance, which is what made sharding look unaffordable.
 *
 * ## Known gap, inherited rather than introduced
 *
 * - **A step lost with its container stays lost for graphile-worker's 4-hour job
 *   expiry** — the guest's hint says so (`GRAPHILE_JOB_EXPIRY`), because no
 *   other worker may claim a locked job before then. Any boot for another reason
 *   repairs it sooner: the Postgres world re-enqueues active runs on `start()`.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createIntervalSweep } from "./_interval-sweep.ts";
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
  /**
   * Slugs an ATTEMPT was made for, which is not the same as slugs now running:
   * a 503 counts (see {@link wakeOne}). {@link failed} is how many of these the
   * broker refused.
   */
  woken: string[];
  /** Due slugs left for a later tick: backoff, the per-tick cap, or a 404. */
  skipped: number;
  /**
   * Of {@link woken}, how many the broker did NOT serve.
   *
   * Reported because the summary line is the only thing an operator reads, and
   * without this it said `woken: 1, skipped: 0` over a spawn that failed
   * DETERMINISTICALLY and would keep failing — the backoff then suppressing the
   * retry, so a permanently unreachable agent looked like a working sweep. (The
   * case was a microVM name left claimed by a SIGKILLed guest; see
   * `createReclaimingName` in microsandbox-sandbox.ts.) A non-zero count here is
   * not itself an error — a booting sandbox is a 503 — but a count that stays
   * non-zero tick after tick is the shape of one.
   */
  failed: number;
};

const EMPTY_PASS: WorkflowWakeResult = {
  swept: false,
  candidates: 0,
  due: 0,
  woken: [],
  skipped: 0,
  failed: 0,
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
  async function wakeOne(slug: string, at: number): Promise<"served" | "failed" | "skip"> {
    const brokered = await wake(slug).catch((err: unknown) => {
      log.warn("wake failed", { slug, error: errorMessage(err) });
      return { ok: false, status: 503 } as BrokeredSession;
    });
    if (!brokered.ok && brokered.status === 404) {
      log.debug("Due workflow hint for an agent with no bundle; not waking", { slug });
      return "skip";
    }
    lastWoken.set(slug, at);
    log.debug("Woke a sandbox for due workflow work", { slug, ok: brokered.ok });
    return brokered.ok ? "served" : "failed";
  }

  /**
   * Wake every due slug this tick will reach, and account for the rest.
   *
   * Extracted from `sweepOnce` so each has one job — that function reads, this
   * one decides per slug — which also keeps `sweepOnce` under the complexity
   * limit rather than growing a third counter into it.
   */
  async function wakeDue(
    due: readonly string[],
    at: number,
  ): Promise<{ woken: string[]; skipped: number; failed: number }> {
    const woken: string[] = [];
    let skipped = 0;
    let failed = 0;
    for (const slug of due) {
      if (woken.length >= maxPerTick || suppressed(slug, at)) {
        skipped += 1;
        continue;
      }
      // The cap counts ATTEMPTS, so a refused broker still consumes one: it
      // spent the same work, and retrying it inside this tick is what the
      // per-slug backoff exists to prevent.
      const outcome = await wakeOne(slug, at);
      if (outcome === "skip") skipped += 1;
      else {
        woken.push(slug);
        if (outcome === "failed") failed += 1;
      }
    }
    return { woken, skipped, failed };
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
    const { woken, skipped, failed } = await wakeDue(read.due, at);

    if (read.due.length > 0) {
      log.debug("Workflow wake sweep", {
        candidates: read.candidates,
        due: read.due.length,
        woken: woken.length,
        skipped,
        failed,
      });
    }
    return {
      swept: true,
      candidates: read.candidates,
      due: read.due.length,
      woken,
      skipped,
      failed,
    };
  }

  // Serialized rather than overlapped, and unref'd — `_interval-sweep.ts` owns
  // both properties and the argument for each. A pass that outruns the interval
  // would queue reservations behind each other, and the next pass re-reads the
  // same due set anyway.
  const ticker = createIntervalSweep(sweepOnce);

  return {
    sweepOnce,
    start: (intervalMs = WORKFLOW_WAKE_INTERVAL_MS) => ticker.start(intervalMs),
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
  // event. Absent together is the normal state of local dev and of every spec,
  // and says so at `debug`. Exactly ONE of them is a MISWIRING — a composition
  // that HAS a platform database and did not hand the sweep all of it — and is
  // reported out loud, naming the binding that is missing.
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
  //
  // `warn` rather than `error`, which is a correction to the commit that split
  // these. In PRODUCTION the state is unreachable in either direction: both
  // bindings are built from one `SUPABASE_DB_URL` in `service-config.ts` and
  // reach `createOrchestrator` together in one `...base` spread. What IS
  // reachable is a narrow SPEC composition — `storage-handler.test.ts` and eight
  // others pass `appDb` alone, having no use for an admin connection — so
  // `error` labelled twelve unrelated specs as failures and spent the level that
  // should mean "something is broken" on the shape a test legitimately builds.
  // `warn` still prints on every boot, still names the binding, and would still
  // have caught #1259; it just does not cry wolf.
  if (!(adminDb && appDb)) {
    if (!(adminDb || appDb)) {
      log.debug("Workflow wake sweep not started", { reason: "no platform database" });
    } else {
      log.warn(
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
  const extraClusters = opts.extraAppDbClusters ?? 0;
  if (extraClusters > 0) {
    // Announced rather than warned. This was a WARNING saying runs on these
    // clusters are never woken, which was never true — the pass follows each
    // app's own locator (see the module doc). An operator reading a warning
    // they cannot clear learns to skip the ones they can, and this file's
    // warnings guard a parked run that resumes silently or not at all.
    log.info(
      `sweeping ${extraClusters + 1} placement cluster(s): an app is read on the ` +
        "cluster its own locator names",
    );
  }
  const sweep = createWorkflowWakeSweep({ ...opts, adminDb, appDb });
  log.info(`sweeping for due durable runs every ${intervalMs}ms`);
  return sweep.start(intervalMs);
}
