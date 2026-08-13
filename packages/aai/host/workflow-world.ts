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
 * silently overriding it would be the platform reaching past the operator.
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
  if (env[TARGET_WORLD_ENV]) {
    return env[TARGET_WORLD_ENV] === POSTGRES_WORLD ? "postgres" : "local";
  }

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
    const { setupDatabase } = await import("@workflow/world-postgres/cli");
    await setupDatabase();
  }

  const { getWorld } = await import("workflow/runtime");
  // The Postgres world's queue is graphile-worker POLLING the database, so
  // nothing runs until a long-lived process subscribes — without this a run sits
  // `pending` forever with no error anywhere. The local world has no `start`,
  // hence the optional call.
  await getWorld().start?.();
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
