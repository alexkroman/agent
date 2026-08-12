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

/** The journal table the SDK creates in an app's own schema. */
const RUNS_TABLE = "aai_workflow_runs";

/** Uploads awaiting a run, in the same schema. */
const BLOBS_TABLE = "aai_workflow_blobs";

/**
 * Schemas on this cluster that carry a journal at all.
 *
 * Asked of the catalog rather than of each app, so an app with no storage — or
 * storage and no workflows — costs nothing: it simply is not in the answer. This
 * is also what makes the union query below safe to build, since every schema it
 * names is known to have the table (a missing one would abort the whole
 * statement, not just its own branch).
 */
const SCHEMAS_WITH_JOURNAL = `select n.nspname as schema
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
  where c.relname = $1 and c.relkind = 'r' and n.nspname = any($2::text[])`;

/** What one tick decided, for the log and for tests. */
export type WakeSweepResult = {
  /** Slugs brokered this tick. */
  woken: string[];
  /** Slugs found to have work but left for a later tick by `MAX_WAKE_PER_TICK`. */
  deferred: number;
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
  const present = (await target.sql(SCHEMAS_WITH_JOURNAL, [RUNS_TABLE, schemas as string[]])).map(
    (row) => String(row.schema),
  );
  if (present.length === 0) return [];

  // `$1` is the blob cutoff in seconds; the schema names are literals (see above).
  const branches = present.map(
    (schema) => `select '${schema}' as schema where exists (
        select 1 from ${schema}.${RUNS_TABLE}
         where (status in ('pending', 'sleeping') and (wake_at is null or wake_at <= now()))
            or (status = 'running' and lease_until is not null and lease_until < now())
      ) or exists (
        select 1 from ${schema}.${BLOBS_TABLE}
         where created_at < now() - make_interval(secs => $1::float8)
      )`,
  );
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
): Promise<WakeSweepResult> {
  const slugs = await opts.agents.listSlugs(MAX_WAKE_CANDIDATE_SLUGS);
  if (slugs.length === 0) return { woken: [], deferred: 0 };

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
  return { woken, deferred };
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
  const tick = async (): Promise<void> => {
    // Guarded in-process: a tick that outlasts the interval (a slow cluster, a
    // cold sandbox boot) must not overlap ITSELF. Cross-replica overlap is fine
    // and deliberately unguarded — see the module doc.
    if (running) return;
    running = true;
    try {
      await sweepWorkflowWakes(opts);
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
 * taxonomy, instead of assembling broker options here and drifting from it. Two
 * consequences worth knowing: the response is DISCARDED, because the boot is the
 * whole point and a `401` from an app that sets `AAI_WORKFLOW_API_TOKEN` still
 * means the sandbox came up; and it is `127.0.0.1`, so the hop never leaves the
 * container and needs no public origin, TLS, or credential.
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
      });
      // Read to completion so the socket is released rather than left for the
      // agent to abandon; the body itself is of no interest.
      await res.arrayBuffer().catch(() => undefined);
    },
    logger: {
      info: (m, meta) => console.info(m, meta),
      error: (m, meta) => console.error(m, meta),
    },
    ...(service.pollMs === undefined ? {} : { pollMs: service.pollMs }),
  });
}
