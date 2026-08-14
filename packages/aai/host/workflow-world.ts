// Copyright 2026 the AAI authors. MIT license.
/**
 * Choosing and starting the Workflow DevKit's "world" — the storage + queue a
 * run actually lives in.
 *
 * Two of them, and the split is the same one `ctx.db` already makes:
 *
 * - **Postgres** when the agent has a database. Runs, events and the job queue
 *   live in the app's own schema, which is why creating a workflow app switches
 *   storage on. This is production.
 * - **Local** otherwise — `aai dev` against a project with no `DATABASE_URL`.
 *   State goes in `.workflow-data/` and the queue is in memory, so a restart
 *   forgets in-flight runs. That is the honest dev tradeoff, and it is what lets
 *   an author try a workflow before provisioning anything.
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

import { errorMessage } from "../sdk/utils.ts";
import { claimPoolPresenceAndSweep } from "./workflow-lock-sweep.ts";

/** What the DevKit reads to pick a world. */
const TARGET_WORLD_ENV = "WORKFLOW_TARGET_WORLD";
/** The Postgres world's connection string. */
const POSTGRES_URL_ENV = "WORKFLOW_POSTGRES_URL";
/** Full base URL override for the local world's callbacks. */
const LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
/** Where the local world keeps its run state. */
const LOCAL_DATA_DIR_ENV = "WORKFLOW_LOCAL_DATA_DIR";

/** The package name the DevKit resolves for the Postgres world. */
const POSTGRES_WORLD = "@workflow/world-postgres";

/**
 * Which world this guest is configured for.
 *
 * @internal
 */
export type WorldKind = "postgres" | "local";

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
   * Where the local world keeps its run state. Defaults to the DevKit's own
   * `.workflow-data` relative to `process.cwd()`.
   *
   * `aai dev` passes the project directory, because the two are not the same
   * thing there: `--cwd` (and any wrapper script) leaves the shell's directory
   * as the process cwd, so a project's durable runs would land wherever the
   * developer happened to be standing and a second `aai dev` from elsewhere
   * would silently see none of them. The guest passes nothing — its cwd is its
   * own and the container is discarded either way.
   */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}): WorldKind {
  const env = opts.env ?? process.env;
  const supplied = env[TARGET_WORLD_ENV];
  if (supplied) return classifySuppliedWorld(supplied);

  if (opts.databaseUrl) {
    env[TARGET_WORLD_ENV] = POSTGRES_WORLD;
    // Set explicitly rather than relying on the world's `DATABASE_URL`
    // fallback: that fallback is a convenience for a standalone app, and here
    // the two happening to be equal would be a coincidence the next change
    // breaks.
    env[POSTGRES_URL_ENV] = opts.databaseUrl;
    return "postgres";
  }

  env[TARGET_WORLD_ENV] = "local";
  // Loopback, not the bind host: this URL is only ever dialled by this process.
  env[LOCAL_BASE_URL_ENV] ??= `http://127.0.0.1:${opts.port}`;
  if (opts.dataDir !== undefined) env[LOCAL_DATA_DIR_ENV] ??= opts.dataDir;
  return "local";
}

/**
 * Prepare the configured world to run: migrate it, then subscribe to its queue.
 *
 * Both halves are expensive and neither means anything for an agent that
 * declares no workflows, which is why the only caller is behind that gate.
 */
async function migrateAndSubscribe(kind: WorldKind): Promise<void> {
  if (kind === "postgres") {
    // Idempotent by design (its own docs call it safe as a post-deploy step),
    // which is what lets it run on every boot instead of needing a provisioning
    // pass that nothing in this architecture has: an agent's first workflow may
    // be its first ever deploy.
    await migratePostgresWorld();
    // AFTER the migration (the tables have to exist) and BEFORE `start()` below
    // (the safety argument rests on this pool holding no locks yet). A predecessor
    // that was hard-killed left its in-flight steps locked by workers that are
    // gone, and graphile-worker would not reclaim them for four hours.
    await sweepOrphanedQueueLocks();
  }

  const { getWorld } = await import("workflow/runtime");
  // The Postgres world's queue is graphile-worker POLLING the database, so
  // nothing runs until a long-lived process subscribes — without this a run sits
  // `pending` forever with no error anywhere. The local world has no `start`,
  // hence the optional call.
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
 * What an operator-supplied `WORKFLOW_TARGET_WORLD` is, for MIGRATION purposes.
 *
 * The DevKit loads whatever specifier it is given; this only has to answer "does
 * that thing need `setupDatabase` run against it first". It used to be
 * `supplied === POSTGRES_WORLD`, i.e. an exact match on the bare package name —
 * so every other spelling of the SAME world was classified `local` and therefore
 * never migrated, while the DevKit went on loading it. That is a Postgres world
 * pointed at an unmigrated database, and the log says `local`, which is the
 * hardest possible starting point for whoever debugs it. It is not theoretical:
 * a resolved absolute path (the ordinary way to pin a world in a pnpm workspace,
 * where the package is not visible from the project) produced exactly that —
 * `harness starting local workflow world` followed by
 * `Failed query: select … from "workflow"."workflow_runs"`.
 *
 * A substring match on the package name covers every spelling of it: the bare
 * name, a `file:`/absolute path ending in it, a version-pinned specifier, a
 * pnpm virtual-store path. A genuinely CUSTOM world still reads as `local`,
 * which is the right answer — nothing here knows how to migrate one — and it is
 * the caller's business, not a silent misreading of ours.
 */
function classifySuppliedWorld(supplied: string): WorldKind {
  return supplied.includes(POSTGRES_WORLD) ? "postgres" : "local";
}

/**
 * Thrown by the `process.exit` stand-in below, and caught by its only caller.
 *
 * A class rather than a sentinel value so an unrelated throw from inside
 * `setupDatabase` is still reported as itself.
 */
class MigrationExitedError extends Error {
  /** Declared rather than a parameter property — `erasableSyntaxOnly` bans those. */
  readonly code: number;

  constructor(code: number) {
    super(`the world migration called process.exit(${code})`);
    this.name = "MigrationExitedError";
    this.code = code;
  }
}

/**
 * Run the Postgres world's migration WITHOUT letting it end the process.
 *
 * **`setupDatabase` is `@workflow/world-postgres/cli`'s own entry point, and it
 * behaves like one: `process.exit(0)` on success, `process.exit(1)` on failure.**
 * So awaiting it from a server is not "migrate, then carry on" — it is "migrate,
 * then die", with a SUCCESS code, before anything listens. That is not a
 * hypothetical: `aai dev` against a project with a `DATABASE_URL` printed
 * `✅ Database schema created successfully!` and exited 0, and a deployed guest
 * does the same thing at `harness-agent-mode.ts`'s world start, which runs
 * BEFORE `server.listen` — so the platform's readiness poll never gets an
 * answer and the spawn fails. Every agent that declares workflows AND has
 * storage was on that path, which is the configuration
 * `transcription-desk` documents as the right one.
 *
 * `startWorkflowWorldIfDeclared`'s try/catch cannot help, either: an exit is not
 * an exception, so the "a failure must not take the guest down" rule it exists
 * to enforce was unenforceable.
 *
 * The stand-in THROWS rather than returning, so `setupDatabase`'s own await
 * chain unwinds at the call instead of running on past it. By then the function
 * has already migrated and closed its pool — the exit is the last statement in
 * both branches — so nothing is left half-done. A version that stops exiting
 * needs no change here: returning normally is read as success.
 *
 * Not a general-purpose wrapper, deliberately. It is installed for the duration
 * of ONE call at boot, where nothing else in the process is trying to exit.
 */
async function migratePostgresWorld(): Promise<void> {
  const { setupDatabase } = await import("@workflow/world-postgres/cli");
  const realExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number | string | null): never => {
    exitCode = typeof code === "number" ? code : 0;
    throw new MigrationExitedError(exitCode);
  }) as typeof process.exit;
  try {
    await setupDatabase();
  } catch (err: unknown) {
    if (!(err instanceof MigrationExitedError)) throw err;
  } finally {
    process.exit = realExit;
  }
  // `undefined` means it returned instead of exiting, which is what a fixed
  // upstream would do. A non-zero code is a real migration failure, and it has
  // to become an exception so the caller can report it.
  if (exitCode !== undefined && exitCode !== 0) {
    throw new Error(`the Postgres world migration failed (exit ${exitCode})`);
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
): Promise<void> {
  if (!hasWorkflows) return;
  console.error(`harness starting ${kind} workflow world`);
  try {
    await migrateAndSubscribe(kind);
  } catch (err: unknown) {
    console.error(`Workflow world (${kind}) failed to start:`, errorMessage(err));
  }
}
