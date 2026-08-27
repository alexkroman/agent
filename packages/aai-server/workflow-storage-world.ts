// Copyright 2026 the AAI authors. MIT license.
/**
 * The DevKit's world, running on the PLATFORM's database instead of in each guest.
 *
 * ## Why this shape, and not a reimplementation
 *
 * `World = Queue & Storage & Streamer`. The queue moved to the platform as a table
 * and a sweep, because a queue is scheduling and the platform is what schedules.
 * Storage looked like it could follow the same way — its interface has exactly ONE
 * mutation, `events.create`, with runs, steps and hooks as reads over it.
 *
 * That reading was wrong, and the correction is the reason this module exists.
 * `events.create` is a thousand lines of transactional dispatch over sixteen event
 * types: it maintains five tables, and its `step_started` path takes a row lock so
 * that a guarded UPDATE cannot slip past a concurrent start. That is not a
 * projection — it IS the durable-execution state machine, and reimplementing it
 * would mean owning replay semantics this platform has no business owning.
 *
 * So their implementation is reused, unchanged, and simply RELOCATED: `createWorld`
 * accepts an injected `pool`, so it is constructed here against the platform's own
 * database. What the guest gets is an HTTP client. What the fleet gets is ONE
 * shared pool instead of six connections per workflow agent, which is the ceiling
 * this whole arc was about.
 *
 * ## What is deliberately not used
 *
 * `start()` — it subscribes graphile-worker, and the platform's queue is
 * `workflow-queue-store.ts`. Not calling it is the same decision the guest-side
 * composition makes, for the same reason, and it is why this module hands back the
 * storage and streamer members rather than the world: a caller holding a `World`
 * can call `start()`, and nothing but a comment would stop them.
 *
 * `queue` — same reason, one layer down.
 *
 * ## Tenancy is NOT in here
 *
 * Their schema has no tenant column and their SQL is schema-qualified, so every
 * agent's runs share one `workflow.workflow_runs`. Scoping is
 * `workflow-run-owner.ts`, checked on the way IN by the HTTP layer above this.
 * Nothing in this module is safe to expose to a tenant directly, which is why it
 * exports a storage handle rather than routes.
 */

import { createLogger } from "./logger.ts";
import { PLATFORM_WORLD_POOL_MAX } from "./platform-db-limits.ts";

const log = createLogger("workflow.world");

/**
 * The members of the DevKit's world this platform serves.
 *
 * Structurally typed rather than `Pick<World, …>`: naming their type would make
 * `@workflow/world` a declared dependency of this package for a shape that is
 * four properties wide, and the import would drag its zod schemas into the
 * server bundle. A mismatch surfaces at the call sites in the HTTP layer, which
 * is where it should.
 */
export type PlatformWorldStorage = {
  runs: unknown;
  steps: unknown;
  events: unknown;
  hooks: unknown;
  /** Their streamer's members, spread onto the world alongside storage. */
  streamer: Record<string, unknown>;
  /** The world's own `close`, so a shutdown ends the pool. */
  close: () => Promise<void>;
};

/**
 * Everything on the world that is NOT the streamer.
 *
 * A DENY list, and the direction matters. `createWorld` spreads storage, the
 * streamer and the queue onto one object, so the streamer's members are "the rest"
 * — and naming the rest means a method their next version adds to the streamer
 * arrives here on its own, where an allow list would silently drop it and fail at
 * whichever route needed it. Same reasoning as `NON_AUTHORING_SUBPATHS`: default
 * IN, exempt by name.
 *
 * Every entry is a member this module either serves directly (`runs`, `steps`,
 * `events`, `hooks`) or deliberately does not use (`queue`, `start`, and the two
 * queue helpers — the platform has its own queue).
 */
const NOT_STREAMER: ReadonlySet<string> = new Set([
  "specVersion",
  "runs",
  "steps",
  "events",
  "hooks",
  "queue",
  "createQueueHandler",
  "getDeploymentId",
  "start",
  "close",
]);

/**
 * Build the platform's run storage, or undefined when there is no platform
 * database to build it against.
 *
 * Undefined rather than a throw: a composition with no platform database is the
 * ordinary shape of a unit test and of `aai dev`, and the HTTP layer answers 501
 * for it — the same answer the enqueue route gives, and for the same reason (a
 * retry will not conjure a database).
 *
 * @internal
 */
export async function createPlatformWorldStorage(opts: {
  /** The platform's own connection string. Session mode, like every other one. */
  url: string | undefined;
}): Promise<PlatformWorldStorage | undefined> {
  if (!opts.url) {
    log.debug("no platform world: no connection string");
    return undefined;
  }
  // Imported lazily for the reason the guest imports `workflow/api` lazily: this
  // pulls drizzle and their zod schemas, and a replica serving no workflow agent
  // should not pay for it at boot.
  const { createWorld } = await import("@workflow/world-postgres");
  // `maxPoolSize` rather than an injected `pg.Pool`, which is what an earlier
  // draft did: passing a pool would make node-postgres a declared dependency of
  // this package for one `new Pool(...)`, and a SECOND Postgres driver beside
  // `postgres.js` is a thing a reader has to notice and account for. Their own
  // config takes the size, so nothing here has to hold the driver.
  const world = createWorld({
    connectionString: opts.url,
    // PINNED, because their default is node-postgres's 10 and this pool is
    // per-replica and fleet-wide — see `PLATFORM_WORLD_POOL_MAX`, and
    // `platform-db-budget.test.ts`, which is what holds the sum honest.
    maxPoolSize: PLATFORM_WORLD_POOL_MAX,
  });

  // SPREAD rather than cast. The members this serves are read off a `World`, whose
  // type has no index signature, so reaching them by string key needs either a
  // double cast (a counted escape hatch, and one that stops reporting when their
  // shape moves) or this — a copy whose keys are strings by construction.
  const members: Record<string, unknown> = { ...world };

  // The streamer is whatever the world has that is not storage or queue — see
  // `NOT_STREAMER` for why that direction.
  const streamer = Object.fromEntries(
    Object.entries(members).filter(([key]) => !NOT_STREAMER.has(key)),
  );

  return {
    runs: members.runs,
    steps: members.steps,
    events: members.events,
    hooks: members.hooks,
    streamer,
    // Their `close` ends the streamer's dedicated `LISTEN` client and the pool it
    // built. `start()` is never called, so there is no worker to stop. `?.` because
    // the World interface declares `close` optional, and a version without one has
    // nothing to release.
    close: async () => {
      await world.close?.();
    },
  };
}
