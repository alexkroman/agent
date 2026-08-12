// Copyright 2026 the AAI authors. MIT license.
/**
 * Waking an agent whose workflow run has come due.
 *
 * This closes the hole the engine's own module doc names: "a wake timer only
 * fires while this host lives … Waking an idle sandbox to serve a due run is the
 * platform's job and is not wired yet." Until it was, `durable` meant NOT LOST
 * rather than RUNS ON TIME. `ctx.sleep` under `MAX_WAKE_TIMER_MS` (60s) is held by
 * an in-process timer and the guest's `busy()` keeps the sandbox alive across it;
 * anything longer released the run to a `runDue()` that only ever runs at BOOT, so
 * a six-hour sleep resumed whenever someone next happened to phone the agent or
 * load its page. For a workflow app that is the whole promise.
 *
 * **The sweep reads the SDK's own journal table, in the tenant's schema, and
 * nothing else.** That is the one deliberate exception to "the platform stores no
 * agent config" (see that section in this package's guide), and it is narrow in
 * three ways worth stating because each was the alternative:
 *
 * - **It cannot be a pg_cron job**, which is where every other platform sweep
 *   lives. Those run inside the platform database; app databases are placed
 *   across `APP_DB_URLS` by `hash(slug) % targets.length`, so SQL running on the
 *   platform cluster cannot see a journal on another one.
 * - **It cannot ask the guest**, because answering would require the guest to be
 *   running, which is the condition being detected. Agent guests have no host
 *   channel by design.
 * - **It cannot enumerate tenant schemas and work backwards.** `appDbIdentifier`
 *   is `app_<sha256(slug)[0:16]>` — one-way — so the candidate set has to come
 *   from `aai_platform.agents`, the platform's own record, and the schema name is
 *   derived forwards from each slug.
 *
 * So the shape is: enumerate slugs, derive their schemas, ask each CLUSTER once
 * which of those schemas has work, and broker the winners. Brokering is the whole
 * action — it boots the sandbox, and the runtime calls `runDue()` on the way up
 * (`runtime.ts`), so this module never executes a run itself and holds no
 * workflow logic that could drift from the engine's.
 *
 * **Two reasons count as work, through one predicate.** A due run is the obvious
 * one. Expired BLOBS are the other, and folding them in here rather than giving
 * them their own mechanism is deliberate: `runDue()` prunes them, and it only runs
 * at boot, so an app that never boots again leaks its abandoned uploads forever.
 * Waking such an app is rare (it needs an upload whose run was never started) and
 * once a day at most, against bytes that would otherwise sit in the tenant's
 * schema permanently.
 *
 * **Every replica sweeps, and that needs no lock.** The web service autoscales, so
 * ten containers may tick at once — and the action is idempotent by construction:
 * `resolveSandbox` serves a live resident or boots one, and a guest's fleet-wide
 * identity is its Modal NAME, so a create that loses the race comes back as
 * `SandboxNameTakenError` and routes to the winner (see "No horizontal sandbox
 * scaling" in this package's guide). A lease table or advisory lock here would be
 * a second mechanism answering a question Modal already answers — the same
 * reasoning that deleted `sandbox_registry`. The cost of not having one is N cheap
 * indexed reads per tick instead of one.
 */

import type { AgentRows } from "./agent-store.ts";
import { type AppDbTarget, appDbIdentifier } from "./app-database.ts";
import {
  MAX_WAKE_CANDIDATE_SLUGS,
  MAX_WAKE_PER_TICK,
  WAKE_REQUEST_TIMEOUT_MS,
  WORKFLOW_BLOB_TTL_MS,
  WORKFLOW_WAKE_POLL_MS,
} from "./constants.ts";

/**
 * Header marking the sweep's own loopback request, so the workflow API's per-IP
 * rate limiter does not meter this process against itself — see
 * {@link startWorkflowWake} for why a loopback hop otherwise shares one bucket.
 */
export const WAKE_INTERNAL_HEADER = "x-aai-internal-wake";

/**
 * The per-process value of that header.
 *
 * Minted once, lazily, and never sent anywhere but `127.0.0.1` in this same
 * container, so it cannot be replayed by anything outside the process. A shared
 * constant would be guessable from the source; an env-configured secret would be
 * one more thing to set correctly for a hop that never leaves the machine.
 */
let internalToken: string | undefined;
export function wakeInternalToken(): string {
  internalToken ??= crypto.randomUUID();
  return internalToken;
}

/**
 * Did this response come from the guest (or from the broker having reached it)?
 *
 * `503` is the broker declining to boot and `429` is our own limiter refusing
 * before the handler runs — neither started a sandbox. Every other status did:
 * `401`/`404`/`500` are all answers a LIVE guest (or its own token gate) produced.
 */
export function wakeReachedGuest(status: number): boolean {
  return status !== 503 && status !== 429;
}

/** The journal table the SDK creates in an app's own schema. */
const RUNS_TABLE = "aai_workflow_runs";

/** Uploads awaiting a run, in the same schema. */
const BLOBS_TABLE = "aai_workflow_blobs";

/**
 * Which of the two journal tables each schema on this cluster actually has.
 *
 * Asked of the catalog rather than of each app, so an app with no storage — or
 * storage and no workflows — costs nothing: it simply is not in the answer. This
 * is also what makes the union query below safe to build: a name that schema does
 * not have would abort the WHOLE statement rather than just its own branch, since
 * Postgres resolves every relation in a query at parse time.
 *
 * **Both tables are asked for, and that is the fix rather than a nicety.** It
 * checked only `aai_workflow_runs` while every branch also probed
 * `aai_workflow_blobs`, so one schema missing the blobs table — a journal created
 * before migration `0007-blobs`, or an `init()` that applied partway — failed the
 * union for the entire CLUSTER. The `catch` in `sweepWorkflowWakes` swallows that,
 * so the symptom was no agent on that cluster ever being woken again, including
 * the very agent whose boot would have applied the missing migration.
 */
const JOURNAL_TABLES_PRESENT = `select n.nspname as schema, c.relname as table_name
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
  where c.relname = any($1::text[]) and c.relkind = 'r' and n.nspname = any($2::text[])`;

/** What one tick decided, for the log and for tests. */
export type WakeSweepResult = {
  /** Slugs brokered this tick. */
  woken: string[];
  /** Slugs found to have work but left for a later tick by `MAX_WAKE_PER_TICK`. */
  deferred: number;
  /**
   * Where the NEXT tick should resume enumerating, or `undefined` to start over.
   *
   * The candidate enumeration is capped at `MAX_WAKE_CANDIDATE_SLUGS`, so a fleet
   * larger than that is only fully covered if successive ticks advance — see
   * `AgentRows.listSlugs`. `undefined` means this tick reached the end of the
   * fleet (a short page), which is also the correct answer for a fleet that fits
   * in one page: every tick then re-reads the same complete set.
   */
  nextCursor: string | undefined;
};

export type WorkflowWakeOptions = {
  agents: AgentRows;
  /** Every configured app-database cluster — a journal can live on any of them. */
  targets: readonly AppDbTarget[];
  /**
   * Boot the agent, or resolve its live sandbox. `brokerSessionUrl`'s job; the
   * sweep only needs it to have HAPPENED, so the result is discarded.
   */
  wake(slug: string): Promise<void>;
  logger: {
    info(message: string, meta?: object): void;
    error(message: string, meta?: object): void;
  };
};

/**
 * Which of `schemas` has a due run or a prunable blob, on one cluster.
 *
 * ONE round trip rather than a query per schema: a `union all` of cheap
 * `exists` probes, each hitting the partial index the SDK creates for exactly
 * this predicate (`aai_workflow_runs_due`). Identifiers are interpolated because
 * DDL-position names cannot be bound — every one comes from `appDbIdentifier`
 * and is re-checked against its own shape first, which is the same guard
 * `app-database.ts` applies before its DDL.
 */
async function schemasWithWork(
  target: AppDbTarget,
  schemas: readonly string[],
  blobTtlMs: number,
): Promise<string[]> {
  if (schemas.length === 0) return [];
  // Per schema, which of the two tables exists — so each branch probes only the
  // relations that schema really has (see the query's own doc).
  const tables = new Map<string, Set<string>>();
  for (const row of await target.sql(JOURNAL_TABLES_PRESENT, [
    [RUNS_TABLE, BLOBS_TABLE],
    schemas as string[],
  ])) {
    const schema = String(row.schema);
    const set = tables.get(schema) ?? new Set<string>();
    set.add(String(row.table_name));
    tables.set(schema, set);
  }
  if (tables.size === 0) return [];

  // `$1` is the blob cutoff in seconds; the schema names are literals (see above).
  const branches: string[] = [];
  for (const [schema, has] of tables) {
    const probes: string[] = [];
    if (has.has(RUNS_TABLE)) {
      probes.push(`exists (
        select 1 from ${schema}.${RUNS_TABLE}
         where (status in ('pending', 'sleeping') and (wake_at is null or wake_at <= now()))
            or (status = 'running' and lease_until is not null and lease_until < now())
      )`);
    }
    if (has.has(BLOBS_TABLE)) {
      probes.push(`exists (
        select 1 from ${schema}.${BLOBS_TABLE}
         where created_at < now() - make_interval(secs => $1::float8)
      )`);
    }
    // Unreachable while the catalog query asks for exactly these two names, but a
    // schema with neither would emit `where` with no predicate — a syntax error
    // taking the cluster's whole union with it.
    if (probes.length === 0) continue;
    branches.push(`select '${schema}' as schema where ${probes.join(" or ")}`);
  }
  if (branches.length === 0) return [];
  const rows = await target.sql(branches.join(" union all "), [blobTtlMs / 1000]);
  return rows.map((row) => String(row.schema));
}

/**
 * Run one tick: find agents with workflow work pending and boot them.
 *
 * Exported for the tests and for a manual poke; the scheduler below is what
 * production runs.
 */
export async function sweepWorkflowWakes(
  opts: WorkflowWakeOptions,
  blobTtlMs: number = WORKFLOW_BLOB_TTL_MS,
  cursor?: string,
): Promise<WakeSweepResult> {
  const slugs = await opts.agents.listSlugs(MAX_WAKE_CANDIDATE_SLUGS, cursor);
  // A short page is the end of the fleet, so the next tick starts over; a full one
  // resumes after the last slug read. Restarting on an EMPTY page matters most:
  // that is what a cursor past the final slug returns, and keeping it would pin
  // the sweep past the end of the fleet forever.
  const nextCursor = slugs.length < MAX_WAKE_CANDIDATE_SLUGS ? undefined : slugs.at(-1);
  if (slugs.length === 0) return { woken: [], deferred: 0, nextCursor };

  // Derived forwards, and kept as a map because the identifier is a one-way hash
  // — the cluster answers in schema names and this is the only way back.
  const slugOf = new Map<string, string>();
  for (const slug of slugs) slugOf.set(appDbIdentifier(slug), slug);
  const schemas = [...slugOf.keys()];

  const found = new Set<string>();
  // Every cluster is asked even if an earlier one fails: one unreachable cluster
  // must not strand the runs on the others.
  await Promise.all(
    opts.targets.map(async (target) => {
      try {
        for (const schema of await schemasWithWork(target, schemas, blobTtlMs)) {
          const slug = slugOf.get(schema);
          if (slug !== undefined) found.add(slug);
        }
      } catch (err) {
        opts.logger.error("workflow wake: cluster probe failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  const due = [...found].sort();
  const take = due.slice(0, MAX_WAKE_PER_TICK);
  const woken: string[] = [];
  // Sequential: each wake may BOOT a sandbox, and a fleet-wide burst of those is
  // the one thing this sweep could do that is worse than not running at all.
  for (const slug of take) {
    try {
      await opts.wake(slug);
      woken.push(slug);
    } catch (err) {
      // A slug that cannot be brokered right now (a sandbox failing to start, a
      // deleted agent racing us) is left for the next tick rather than retried
      // here — the run is durable, so lateness is the only cost.
      opts.logger.error("workflow wake: could not wake agent", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const deferred = due.length - take.length;
  if (woken.length > 0 || deferred > 0) {
    opts.logger.info("workflow wake", { woken: woken.length, deferred });
  }
  return { woken, deferred, nextCursor };
}

/** A started scheduler, so a caller (and a test) can stop it. */
export type WorkflowWakeScheduler = { stop(): void };

/**
 * Start the periodic sweep.
 *
 * `pollMs` of 0 disables it, which is what the unit suites and `aai dev` use —
 * there is nothing to wake when every sandbox is a child process of the server
 * that is already running.
 */
export function startWorkflowWakeSweep(
  opts: WorkflowWakeOptions & { pollMs?: number },
): WorkflowWakeScheduler {
  const pollMs = opts.pollMs ?? WORKFLOW_WAKE_POLL_MS;
  if (pollMs <= 0) return { stop: () => undefined };

  let running = false;
  // Advanced per tick so a fleet larger than `MAX_WAKE_CANDIDATE_SLUGS` is really
  // swept ACROSS ticks rather than re-reading its first page forever. Held here
  // rather than in `sweepWorkflowWakes` so that function stays a pure tick a test
  // can drive one page at a time.
  let cursor: string | undefined;
  const tick = async (): Promise<void> => {
    // Guarded in-process: a tick that outlasts the interval (a slow cluster, a
    // cold sandbox boot) must not overlap ITSELF. Cross-replica overlap is fine
    // and deliberately unguarded — see the module doc.
    if (running) return;
    running = true;
    try {
      cursor = (await sweepWorkflowWakes(opts, WORKFLOW_BLOB_TTL_MS, cursor)).nextCursor;
    } catch (err) {
      opts.logger.error("workflow wake sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), pollMs);
  // Unref'd: a pending sweep must never be the reason the process stays alive.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** What {@link startWorkflowWake} needs off a `ServiceConfig`. */
export type WorkflowWakeService = {
  agents: AgentRows;
  appDbTargets?: readonly AppDbTarget[];
  /** The port this process is serving on — see the wake note below. */
  port: number;
  pollMs?: number;
};

/**
 * Start the sweep for a running service, or return an inert handle.
 *
 * Inert with no `appDbTargets`, which is the no-platform-database case: local dev
 * runs its guests as child processes of this very server, so there is no sandbox
 * to wake and nothing has idle-exited.
 *
 * **The wake is a LOOPBACK request to our own `/:slug/workflows`, not a direct
 * `brokerSessionUrl` call.** That route already brokers — it is the second routing
 * point, added so a deployed static page could reach its own workflow API — so
 * going through it reuses the exact path a page load takes, including the failure
 * taxonomy, instead of assembling broker options here and drifting from it. It is
 * `127.0.0.1`, so the hop never leaves the container and needs no public origin,
 * TLS, or credential.
 *
 * **The STATUS is read, and the response body is not** ({@link wakeReachedGuest}).
 * Most failures still mean the sandbox came up — a `401` from an app that sets
 * `AAI_WORKFLOW_API_TOKEN`, a `404` from one that declares no workflows — and
 * counting those as woken is right. Two do not, and this used to count both:
 * a `503` is the broker saying it could not boot the agent, and a `429` is OUR OWN
 * rate limiter, which is checked BEFORE the handler and so never brokers at all.
 * Recorded as woken, either one made the sweep log a success for a tick in which
 * nothing started and, because the run stays due, do the same on every tick after.
 *
 * **The `429` is also prevented rather than merely detected**, because a loopback
 * request carries no `X-Forwarded-For` and therefore lands in `clientIp`'s single
 * `UNKNOWN_CLIENT_IP` bucket — shared with every other unattributable caller and
 * with every replica's sweep. `WORKFLOW_IP_RATE_LIMIT` is sized for one polling
 * page, so a fleet sweeping `MAX_WAKE_PER_TICK` slugs each could exhaust it
 * against itself. The request therefore carries {@link WAKE_INTERNAL_HEADER} with
 * a token minted per process and never transmitted anywhere else, which the
 * limiter middleware treats as exempt; an external caller cannot guess a value
 * that exists only in this container's memory.
 */
export function startWorkflowWake(service: WorkflowWakeService): WorkflowWakeScheduler {
  const targets = service.appDbTargets;
  if (!targets || targets.length === 0) return { stop: () => undefined };
  return startWorkflowWakeSweep({
    agents: service.agents,
    targets,
    async wake(slug: string): Promise<void> {
      const res = await fetch(`http://127.0.0.1:${service.port}/${slug}/workflows`, {
        signal: AbortSignal.timeout(WAKE_REQUEST_TIMEOUT_MS),
        headers: { [WAKE_INTERNAL_HEADER]: wakeInternalToken() },
      });
      // Read to completion so the socket is released rather than left for the
      // agent to abandon; the body itself is of no interest.
      await res.arrayBuffer().catch(() => undefined);
      if (!wakeReachedGuest(res.status)) {
        // Thrown so the caller's catch logs it and leaves the slug for the next
        // tick. Resolving here would record a wake that did not happen.
        throw new Error(`wake request answered ${res.status} without reaching the guest`);
      }
    },
    logger: {
      info: (m, meta) => console.info(m, meta),
      error: (m, meta) => console.error(m, meta),
    },
    ...(service.pollMs === undefined ? {} : { pollMs: service.pollMs }),
  });
}
