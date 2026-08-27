// Copyright 2026 the AAI authors. MIT license.
/**
 * Choosing and starting the Workflow DevKit's "world" — the storage + queue a
 * run actually lives in.
 *
 * Two of them, and the split is the same one `ctx.db` already makes:
 *
 * - **Postgres** when the agent has a database. Runs, events and the job queue
 *   live in the app's own database, which is why creating a workflow app switches
 *   storage on. This is production.
 * - **Local** otherwise — `aai dev` against a project with no `DATABASE_URL`,
 *   and any deployed agent whose database is off (the studio's default). State
 *   goes in a directory ({@link defaultLocalDataDir}) and the queue is in
 *   memory, so a restart forgets in-flight runs and a redeploy forgets them all.
 *   That is the honest tradeoff, and it is what lets an author try a workflow
 *   before provisioning anything — which is the whole first experience of a
 *   workflow app in the studio, where a database is opt-in.
 *
 * ## The world is chosen by ENVIRONMENT, and it is cached on first read
 *
 * `getWorld()` resolves `WORKFLOW_TARGET_WORLD` once and memoizes. So
 * {@link configureWorkflowWorld} has to run before ANYTHING imports
 * `workflow/runtime` — including `createWorkflowSurface`, which does. Configure
 * first, load the bundle second; getting that backwards produces a guest that
 * silently uses the local world in production, writing runs to a
 * `.workflow-data/` directory inside a container that is about to be destroyed.
 *
 * ## Why the local world needs to be told our port
 *
 * It enqueues by calling BACK over HTTP — that is how a step gets dispatched —
 * so it has to know where this server is listening. Its default is `PORT` or an
 * auto-detect, and the guest binds a port it was handed rather than one it
 * announces, so the auto-detect finds nothing and every enqueue quietly fails
 * to reach us.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_DB_WORLD_POOL_MAX,
  APP_DB_WORLD_WORKER_CONCURRENCY,
  sleep,
} from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { claimPoolPresenceAndSweep } from "./workflow-lock-sweep.ts";
import { installPlatformWorld, resolvePlatformQueue } from "./workflow-platform-world.ts";
import { resolveWorldSpecifier } from "./workflow-resolve.ts";
import type { WorldKind } from "./workflow-world-kind.ts";
import { classifySuppliedWorld, migratePostgresWorld } from "./workflow-world-migrate.ts";

/** What the DevKit reads to pick a world. */
const TARGET_WORLD_ENV = "WORKFLOW_TARGET_WORLD";
/** The Postgres world's connection string. */
const POSTGRES_URL_ENV = "WORKFLOW_POSTGRES_URL";
const POSTGRES_POOL_ENV = "WORKFLOW_POSTGRES_MAX_POOL_SIZE";
const POSTGRES_CONCURRENCY_ENV = "WORKFLOW_POSTGRES_WORKER_CONCURRENCY";

/**
 * How many connections the DevKit's world may hold, and how many steps it runs
 * at once — both read from the one table that counts every consumer in the guest
 * (`sdk/app-db-budget.ts`), never spelled here.
 *
 * **Both are PINNED because the world's defaults do not fit a tenant role.** Left
 * alone, `@workflow/world-postgres` builds its `pg.Pool` with no `max`, so
 * node-postgres defaults to **10**, and `queueConcurrency` defaults to **10** —
 * then `listenChannel` opens a DEDICATED `pg.Client` on top (`+1`, outside the
 * pool). Against a role with `connection limit 4` beside `ctx.db`'s own pool of
 * 4, that is up to 15 connections asking for 4: every workflow request failed
 * `too many connections for role "app_…"`.
 *
 * It could not have surfaced earlier. Under the per-schema model the DevKit's
 * migration could not run at all (`aai-server/CLAUDE.md` has the measurement), so
 * nothing but `ctx.db` ever used that role — making workflows work is what made
 * the tenant's connection footprint real.
 *
 * the app role's WORKFLOW-tier limit on the platform side is sized against the budget
 * module's sum, so the two move together. **Concurrency is one BELOW the pool**,
 * which is a correction: it used to be kept AT the pool size on the argument that
 * "a worker that cannot get a connection is a step waiting on a pool timeout,
 * which reads as a hung run" — and that was a description of what was happening,
 * because graphile-worker takes one of these connections and holds it for the
 * life of the process to `LISTEN` (see the budget module).
 */
const POSTGRES_MAX_POOL = APP_DB_WORLD_POOL_MAX;
const POSTGRES_WORKER_CONCURRENCY = APP_DB_WORLD_WORKER_CONCURRENCY;
/** Full base URL override for the local world's callbacks. */
const LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
/** Where the local world keeps its run state. */
const LOCAL_DATA_DIR_ENV = "WORKFLOW_LOCAL_DATA_DIR";

/** The package name the DevKit resolves for the Postgres world. */
const POSTGRES_WORLD = "@workflow/world-postgres";

export type { WorldKind } from "./workflow-world-kind.ts";

/**
 * Point the DevKit at a world, WITHOUT resolving one.
 *
 * Deliberately only sets environment variables: resolving here would cache a
 * world for a guest that may serve an agent with no workflows at all, and paying
 * a Postgres connection for that is the common case.
 *
 * Respects an operator-supplied `WORKFLOW_TARGET_WORLD` — a self-hosted
 * deployment pointing at a world of its own is a legitimate thing to do, and
 * silently overriding it would be the platform reaching past the operator. What
 * that value MEANS for migration is {@link classifySuppliedWorld}'s job, and it
 * is not an equality check: any spelling of the Postgres world has to be
 * recognized as one, or it is loaded and never migrated.
 *
 * @internal
 */
export function configureWorkflowWorld(opts: {
  /** The app's database, when it has one — the same `DATABASE_URL` `ctx.db` uses. */
  databaseUrl: string | undefined;
  /** The port this guest listens on, for the local world's callbacks. */
  port: number;
  /**
   * Where the local world keeps its run state. Defaults to a per-process
   * directory under `tmpdir()` — see {@link defaultLocalDataDir}.
   *
   * `aai dev` passes the project directory, because the two are not the same
   * thing there: `--cwd` (and any wrapper script) leaves the shell's directory
   * as the process cwd, so a project's durable runs would land wherever the
   * developer happened to be standing and a second `aai dev` from elsewhere
   * would silently see none of them. A guest passes nothing and takes the
   * default, which is the one it wants: its runs die with it either way.
   */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}): WorldKind {
  const env = opts.env ?? process.env;
  const supplied = env[TARGET_WORLD_ENV];
  if (supplied) return classifySuppliedWorld(supplied);

  // BOTH worlds, and the name is the trap: `WORKFLOW_LOCAL_BASE_URL` reads like
  // a local-world setting and is the first branch of world-postgres's own
  // `getExecutionBaseUrl()` — the origin its queue dispatches `flow` and `step`
  // callbacks to. Unset, that function falls through to `getWorkflowPort()`,
  // which AUTO-DETECTS the port by health-probing, on EVERY dispatch.
  //
  // Measured: ~45ms per dispatch, rock-steady (41-52ms across a run), against
  // ~7ms of actual step work and ~1ms for graphile-worker's whole
  // enqueue->handler path. A step->step hop is two dispatches, so this was ~90ms
  // of a ~120ms hop — roughly 40% of a durable workflow's entire latency, spent
  // rediscovering a constant. A six-step run went 1.3-1.7s to ~0.4s.
  //
  // Loopback, not the bind host: this URL is only ever dialled by this process
  // (the `flow`/`step` routes are `guest-internal` — see
  // `aai-server/guest-routes.ts`). `??=` so an operator can still override.
  env[LOCAL_BASE_URL_ENV] ??= `http://127.0.0.1:${opts.port}`;

  // THE PLATFORM's world wins over a `DATABASE_URL`, and the order is the whole
  // change: a deployed guest keeps its durable runs on the platform whether or not
  // it happens to have a database of its own. The base world is `local`, because
  // `createQueueHandler` is the one member the composition keeps — see
  // `workflow-platform-world.ts`.
  //
  // No `WORKFLOW_POSTGRES_URL`, no pool size, no worker concurrency: this guest
  // opens no database for workflows at all, so the three constants that used to
  // size a tenant's connection footprint have nothing to size.
  if (resolvePlatformQueue(env)) {
    env[TARGET_WORLD_ENV] = "local";
    env[LOCAL_DATA_DIR_ENV] ??= opts.dataDir ?? defaultLocalDataDir();
    return "platform";
  }

  if (opts.databaseUrl) {
    // RESOLVED, never the bare name: the DevKit `require`s this value from its own
    // compiled artifact in `tmpdir()`, where nothing resolves — see
    // `workflow-resolve.ts` for the failure and why every fix for it is this move.
    env[TARGET_WORLD_ENV] = resolveWorldSpecifier(POSTGRES_WORLD);
    // Set explicitly rather than relying on the world's `DATABASE_URL`
    // fallback: that fallback is a convenience for a standalone app, and here
    // the two happening to be equal would be a coincidence the next change
    // breaks.
    env[POSTGRES_URL_ENV] = opts.databaseUrl;
    // `??=`, so an operator running their own Postgres can still tune these; what
    // must not happen is INHERITING the world's defaults, which do not fit a
    // per-app role (see the constants).
    env[POSTGRES_POOL_ENV] ??= String(POSTGRES_MAX_POOL);
    env[POSTGRES_CONCURRENCY_ENV] ??= String(POSTGRES_WORKER_CONCURRENCY);
    return "postgres";
  }

  env[TARGET_WORLD_ENV] = "local";
  env[LOCAL_DATA_DIR_ENV] ??= opts.dataDir ?? defaultLocalDataDir();
  return "local";
}

/**
 * Where the local world's run state goes when the caller names nowhere.
 *
 * The DevKit's own default is `.workflow-data` relative to `process.cwd()`, and
 * a cwd is not something every host PICKS. A deployed guest's is whatever its
 * image left it (`/` on the platform's snapshot image, which sets no `WORKDIR`),
 * and under the subprocess backend `aai-server/subprocess-sandbox.ts`
 * deliberately hands every guest the same neutral one — `tmpdir()`. That second
 * case is the bug this default closes: two databaseless agents beside each other
 * shared ONE `.workflow-data`, and the local world lists a directory rather than
 * a namespace, so each saw the other's runs and `start()` re-enqueued them.
 *
 * Per PROCESS, which is the honest scope for this world: its queue is in memory,
 * so a run is exactly as durable as the process holding it, and a successor
 * inheriting the directory would recover runs whose queue entries died with
 * their predecessor. A host that wants better says so — `aai dev` passes the
 * project directory, where a restart is a save rather than a new deployment.
 *
 * `tmpdir()`, never a literal `/tmp` (`guard-invariants` rule 11): that string
 * is drive-relative on Windows, and `aai dev` runs on the developer's machine.
 */
function defaultLocalDataDir(): string {
  return join(tmpdir(), `aai-workflow-data-${process.pid}`);
}

/**
 * The directory the LOCAL world keeps its run state in — the one every host has
 * already agreed on by the time anything asks.
 *
 * Read from the env rather than recomputed, because {@link configureWorkflowWorld}
 * has already written it there (`??=`, so an operator's own value wins) and the
 * DevKit reads the same key. Two callers deriving it independently is how they come
 * to disagree, and a disagreement here is silent: uploads under one directory, runs
 * under another, and no error anywhere.
 *
 * The fallback is for a `createServer` that never called `configureWorkflowWorld` —
 * a self-hosted embedder — where nothing has been agreed and a per-process
 * directory is the honest answer, since that host's runs are per-process too.
 *
 * @internal
 */
export function localWorkflowDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[LOCAL_DATA_DIR_ENV] ?? defaultLocalDataDir();
}

/**
 * Backoff between world-start attempts, and therefore the whole retry budget
 * (~62s across five retries).
 *
 * **The start's commonest failure is TRANSIENT BY CONSTRUCTION, and one attempt
 * made it permanent.** A blue-green handover boots the replacement while the old
 * guest drains, so for a few seconds two guests share the app role's
 * its role's workflow-tier limit — a boundary `aai/sdk/app-db-budget.ts` states
 * outright ("two guests both at peak can still be refused"). What it does not
 * say, because it is this function's business, is what being refused COST:
 * `migrateAndSubscribe` ran once, the catch below logged, and the replacement
 * then served its entire life with NO QUEUE WORKER — while answering
 * `/client-config` and voice sessions normally, so nothing looked wrong and
 * every durable run for that agent was stranded until some other boot happened.
 *
 * Measured on a redeploy during a run: the replacement logged `too many
 * connections for role "app_…"` 300ms after listening, the old guest exited 24s
 * later, and a flow job that came due 15s after THAT sat unlocked, `attempts
 * 0/3`, claimable, with a live guest that was not polling — for as long as the
 * agent stayed up.
 *
 * So the budget is left alone and the LOSER retries instead. The window covers
 * a draining predecessor's exit (24s in that trace) with room to spare, and the
 * doubling keeps a genuinely broken world from hammering a saturated role.
 *
 * **Exhausting it logs and returns for a VOICE agent, and THROWS for a workflow
 * app**, which is the same argument applied to both front doors rather than to
 * one. "An agent whose workflows are broken should still answer the phone" is
 * right when there is a phone: a voice session does not touch the world, so
 * taking the whole agent down over it trades a partial outage for a total one.
 * A `workflowApp` (`page: "static"`) has no session, no WebSocket and no
 * pipeline — the workflow API is the entire product — so the same `return`
 * leaves a guest that answers `/health` and `/client-config` with 200, is
 * ROUTED TO by the broker, and 500s every `POST /workflows/runs` for the life of
 * the sandbox, never retrying even once the pressure that caused it is gone.
 *
 * Measured on eight workflow guests booted at once against a 100-connection
 * instance: five came up (two only on attempt 5) and **three gave up and stayed
 * permanently broken** while reporting healthy, still 500ing after the instance
 * drained. A throw fails the BOOT, so nothing latches a guest that can only 500.
 */
const WORLD_START_BACKOFF_MS = [2000, 4000, 8000, 16_000, 32_000] as const;

/**
 * Prepare the configured world to run: migrate it, then subscribe to its queue.
 *
 * Both halves are expensive and neither means anything for an agent that
 * declares no workflows, which is why the only caller is behind that gate.
 */
async function migrateAndSubscribe(kind: WorldKind): Promise<void> {
  if (kind === "platform") {
    // Nothing to migrate and nothing to start: the schema is the platform's, the
    // queue is the platform's, and this guest opens no connection for either. A
    // false here means the environment went half-configured between `configure` and
    // now, which `installPlatformWorld` reports.
    await installPlatformWorld();
    return;
  }
  if (kind === "postgres") {
    // Idempotent by design (its own docs call it safe as a post-deploy step),
    // which is what lets it run on every boot instead of needing a provisioning
    // pass that nothing in this architecture has: an agent's first workflow may
    // be its first ever deploy.
    await migratePostgresWorld();
    // graphile-worker is the queue on this path, so its orphaned locks are real.
    // AFTER the migration (the tables have to exist) and BEFORE `start()` below
    // (the safety argument rests on this pool holding no locks yet). A predecessor
    // that was hard-killed left its in-flight steps locked by workers that are
    // gone, and graphile-worker would not reclaim them for four hours.
    await sweepOrphanedQueueLocks();
  }

  const { getWorld } = await import("workflow/runtime");
  // The Postgres world's queue is graphile-worker POLLING the database, so
  // nothing runs until a long-lived process subscribes — without this a run sits
  // `pending` forever with no error anywhere.
  //
  // The LOCAL world has a `start` too, and it is not a no-op: it initializes the
  // data directory (see `defaultLocalDataDir`) and re-enqueues runs it finds
  // there. `?.` is kept because the World interface declares it optional — an
  // operator-supplied world may genuinely have none.
  await getWorld().start?.();
}

/**
 * Clear queue locks left by a pool that is gone, if we are the only pool alive.
 *
 * The returned handle is deliberately NOT kept. What has to survive is the
 * advisory lock, so that a pool starting up beside us reads us as live and sweeps
 * nothing — and that is held by a connection the re-assert interval references, not
 * by anything a caller could hold. There is no shutdown release either, on purpose:
 * the connection ending is what releases presence, which is the same event whether
 * this process exits cleanly or is killed, so a release path would be dead code for
 * the case the whole mechanism exists for.
 *
 * Reported and swallowed: a sweep that cannot run leaves graphile-worker's
 * four-hour reclaim as the fallback, which is where we already were — while a throw
 * here would stop the world starting at all, taking a working agent's workflows
 * down for the sake of a recovery nicety. See `workflow-lock-sweep.ts` for why this
 * is safe, and for the Postgres-outage case it does not cover.
 */
async function sweepOrphanedQueueLocks(): Promise<void> {
  const url = process.env[POSTGRES_URL_ENV];
  if (url === undefined || url === "") {
    console.error(
      `workflow lock sweep: skipped — no ${POSTGRES_URL_ENV} to connect with (an ` +
        "operator-supplied world may read its own connection string)",
    );
    return;
  }
  try {
    await claimPoolPresenceAndSweep(url);
  } catch (err: unknown) {
    console.error("workflow lock sweep: failed:", errorMessage(err));
  }
}

/**
 * Start the world for a bundle that declares workflows, and only then.
 *
 * The `hasWorkflows` gate is a boolean rather than a harness state object so this
 * module stays free of the guest's bundle graph — `harness-bundle.ts` already imports
 * `workflow-serve.ts`, and reaching back the other way would close a cycle
 * for one field.
 *
 * **A failure is reported, not thrown.** A world that will not start is real and
 * the log says so — but it must not take the guest down, because the SESSION
 * surface is unaffected: a voice agent whose workflows are broken should still
 * answer the phone. The symptom is then a `ctx.workflows.start()` that rejects,
 * which is the caller's to see.
 *
 * This is the ONE entry point. It was three — a raw start, a catching wrapper,
 * and this gate — of which only this one had a caller outside the module, so
 * the other two were exported surface that nothing consumed and two more names
 * to pick between for one decision.
 *
 * @internal
 */
export async function startWorkflowWorldIfDeclared(
  hasWorkflows: boolean,
  kind: WorldKind,
  opts: {
    /** The agent's front door — what {@link giveUp} decides on. */
    page?: string | undefined;
    /**
     * The wait between attempts. TEST-ONLY SEAM, and it has to be one: the
     * operation being retried does real I/O (`setupDatabase` spawns, the driver
     * connects), so `vi.useFakeTimers()` freezes the very work the retry is
     * waiting on and the loop never advances — verified, both cases hung to the
     * tier timeout. Same precedent as `heardNow` and `speechIdleTimeoutMs`.
     */
    waitMs?: ((attempt: number) => Promise<void>) | undefined;
  } = {},
): Promise<void> {
  // An OPTIONS BAG, not two positional parameters: one is a real caller's and
  // one a test seam, so any ordering makes one pass `undefined`.
  const waitMs = opts.waitMs ?? ((attempt: number) => sleep(WORLD_START_BACKOFF_MS[attempt] ?? 0));
  if (!hasWorkflows) return;
  console.error(`harness starting ${kind} workflow world`);
  for (let attempt = 0; ; attempt++) {
    try {
      await migrateAndSubscribe(kind);
      if (attempt > 0) {
        console.error(`Workflow world (${kind}) started on attempt ${attempt + 1}`);
      }
      return;
    } catch (err: unknown) {
      const last = attempt >= WORLD_START_BACKOFF_MS.length;
      console.error(
        last
          ? `Workflow world (${kind}) failed to start:`
          : `Workflow world (${kind}) start attempt ${attempt + 1} failed, retrying:`,
        errorMessage(err),
      );
      if (last) return giveUp(kind, opts.page, err);
      await waitMs(attempt);
    }
  }
}

/**
 * What an exhausted retry budget means, which depends on the FRONT DOOR. The
 * loop owns the backoff; this owns the product decision.
 */
function giveUp(kind: WorldKind, page: string | undefined, err: unknown): void {
  if (page !== "static") return;
  throw new Error(
    `Workflow world (${kind}) failed to start and this agent's front door is a ` +
      `page, so it has nothing else to serve: ${errorMessage(err)}`,
  );
}
