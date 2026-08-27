// Copyright 2026 the AAI authors. MIT license.
/**
 * The composition: the DevKit's Postgres world with its QUEUE replaced, and
 * graphile-worker never started.
 *
 * ## Composing, not reimplementing
 *
 * The first estimate for this was "reimplement a World" — sixteen event types, a
 * storage layer, a streamer, and the replay semantics that make a durable run
 * durable. That was wrong, and the reason it was wrong is worth stating because it
 * shaped every increment since: `World = Queue & Storage & Streamer`, and only the
 * QUEUE was the problem. Storage and the streamer are reads and writes against the
 * tenant's own database, which is where they belong.
 *
 * So this takes `createWorld()`'s world whole and overrides one method. What that
 * leaves untouched is the entire durable-execution engine — replay, step
 * memoization, hook parking, event ordering — none of which this platform has any
 * business owning.
 *
 * ## `start()` is the whole point of the override
 *
 * `world.start()` is what subscribes graphile-worker: it takes a connection out of
 * the world's pool and holds it for the life of the process to `LISTEN` for
 * `jobs:insert`, then runs a worker pool beside it. Not calling it is what gives
 * those connections back, and it is why this is an override of `start` as well as
 * of `queue` — a spread alone would inherit the base world's `start` and undo the
 * entire change silently, with the only symptom being connection pressure nobody
 * connects to this file.
 *
 * `reenqueueActiveRuns`, the other half of the base `start()`, is deliberately NOT
 * reproduced. It exists because graphile-worker's jobs live in the same database as
 * the run state and can be lost independently of it, so a boot has to look for runs
 * that are active with nothing queued. The platform's queue is at-least-once by
 * construction: a delivery is acked only when the guest answers 200, and a claim
 * left stale by a crashed guest is reclaimed after `QUEUE_CLAIM_STALE_MS`. So the
 * message is still there, and re-enqueueing would DUPLICATE it.
 *
 * ## What this does NOT save, stated plainly
 *
 * It does not take a workflow guest's app-database cost to zero, and earlier
 * framing of this work implied it would. Storage and the streamer still live in the
 * tenant's database and still need connections: `APP_DB_WORLD_LISTEN` is the
 * streamer's dedicated `pg.Client` and the world pool still serves storage reads.
 * What goes is graphile-worker's held `LISTEN` connection, its worker concurrency,
 * and the queue-lock sweep's presence connection — which exists only to clear
 * graphile's own orphaned job locks. Taking the rest would mean moving the DevKit's
 * storage off the tenant's database, which is a different and much larger change.
 */

import { createPlatformQueueSend, type PlatformQueueOptions } from "./workflow-platform-queue.ts";
import {
  createPlatformStorage,
  createPlatformStreamer,
  createPlatformStreamReader,
} from "./workflow-platform-storage.ts";

/** The guest's own public base URL, slug included — what the platform bakes in. */
const PUBLIC_BASE_URL_ENV = "AAI_PUBLIC_BASE_URL";
/** This sandbox's bearer, which the platform also gave it. */
const GUEST_TOKEN_ENV = "AAI_GUEST_TOKEN";

/**
 * The platform queue's configuration, or undefined when there is no platform.
 *
 * BOTH or neither, and the pairing is the whole check: `aai dev`, host mode and a
 * self-hosted `createServer` have neither, and a deployed guest has both. A guest
 * holding one and not the other is a platform that changed how it spawns, and
 * falling back silently to the in-guest queue would hide that behind a connection
 * bill nobody reads. So a HALF-configured environment is reported by the caller
 * rather than resolved here.
 *
 * @internal
 */
export function resolvePlatformQueue(
  env: NodeJS.ProcessEnv = process.env,
): PlatformQueueOptions | undefined {
  const base = env[PUBLIC_BASE_URL_ENV]?.trim();
  const token = env[GUEST_TOKEN_ENV]?.trim();
  if (!(base && token)) return undefined;
  return { base, token };
}

/**
 * Names the half-configured case, or undefined when the environment is coherent.
 *
 * Its own function because the caller reports it and this decides it: one of the
 * two present means the platform spawned this guest differently than this code
 * expects, which is a deployment fault worth a line rather than a silent fallback.
 *
 * @internal
 */
export function describePlatformQueueGap(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = env[PUBLIC_BASE_URL_ENV]?.trim();
  const token = env[GUEST_TOKEN_ENV]?.trim();
  if (Boolean(base) === Boolean(token)) return undefined;
  return base
    ? `${PUBLIC_BASE_URL_ENV} is set but ${GUEST_TOKEN_ENV} is not`
    : `${GUEST_TOKEN_ENV} is set but ${PUBLIC_BASE_URL_ENV} is not`;
}

/**
 * What the composition keeps from the base world.
 *
 * Structural rather than imported: `@workflow/world` is a transitive dependency
 * this package does not declare, and what is needed here is "an object with a
 * `createQueueHandler`" — a smaller claim than the whole interface, and one that
 * cannot go stale against it in a way that matters.
 */
type ComposableWorld = {
  /** The request→handler adapter. The ONE member kept, and the reason for the base. */
  createQueueHandler: unknown;
  specVersion?: unknown;
};

/**
 * The DevKit's world with EVERY backend replaced by the platform.
 *
 * ## What is kept, and it is one method
 *
 * `createQueueHandler` — a pure adapter that turns an incoming HTTP request into a
 * call on the handler the generated route module registered. It reads the three
 * `x-vqs-*` headers, deserializes the body with `TypedJsonTransport`, and reports
 * the run's answer. It touches no database, no worker and no state, so there is
 * nothing about it to relocate; reimplementing it would mean owning the
 * queue↔executor contract on both sides of one wire.
 *
 * `specVersion` comes along for the same reason: it is a number the base world
 * knows and this one has no opinion about.
 *
 * ## What is replaced, and why each one had to be
 *
 * - **queue** — the platform owns the queue table, the claim and the delivery
 *   sweep. Keeping a local queue would mean a run's next step was scheduled inside
 *   a sandbox that self-exits on idle.
 * - **storage** (`runs`, `steps`, `events`, `hooks`) — the run journal is the
 *   platform's now, so a durable run survives with no tenant database at all.
 * - **streamer** (seven members) — same database, same reason, and its names are
 *   qualified per tenant on the platform side.
 *
 * ## `start` and `close` are EXPLICIT, and that is the load-bearing part
 *
 * A spread alone inherits the base world's `start`. On the postgres world that
 * subscribes graphile-worker; on the local world it initializes a data directory
 * and RE-ENQUEUES whatever runs it finds there — which, against a platform queue
 * that already holds those messages, would duplicate every one of them. Neither
 * failure says anything at the time.
 *
 * `close` is likewise nothing: there is no pool to end and no `LISTEN` to release,
 * because this guest opens neither.
 *
 * @internal
 */
export function composePlatformWorld<T extends ComposableWorld>(
  base: T,
  opts: PlatformQueueOptions,
): T & Record<string, unknown> {
  const storage = createPlatformStorage(opts);
  const streamer = createPlatformStreamer(opts);
  return {
    // The base FIRST, so everything below deliberately shadows it. Reversing this
    // would silently keep whichever backend the base happened to have.
    ...base,
    ...storage,
    ...streamer,
    readFromStream: createPlatformStreamReader(opts),
    queue: createPlatformQueueSend(opts),
    // See the block above: a spread would inherit a `start` that either subscribes
    // graphile-worker or re-enqueues runs the platform already holds.
    start: async () => undefined,
    close: async () => undefined,
  };
}

/**
 * Install the platform-owned world, and answer whether it took.
 *
 * True means this guest's durable runs live entirely on the platform — journal,
 * streams and queue — and it opens no database of its own for any of them. False
 * means there is no platform (`aai dev`, host mode, a self-hosted server), and the
 * caller carries on to whichever world the environment named.
 *
 * ## Here, and not in `configureWorkflowWorld`
 *
 * `setWorld` has to run before anything reads `getWorld()`, which argues for as
 * early as possible; `configureWorkflowWorld` argues the opposite, because it runs
 * for every guest and resolving a world there would build one for an agent that
 * declares no workflows. This function is behind the declares-workflows gate AND
 * before the `getWorld().start?.()` that follows it, which is the first read that
 * MATTERS: the route modules loaded earlier take `createQueueHandler` off
 * `getWorldHandlers()`, and that method is the one the composition deliberately
 * keeps, so a handler already bound to it is bound to the right thing. `setWorld`
 * overwrites both caches, so every later read is ours.
 *
 * ## No migration, which is the point
 *
 * The postgres path runs `setupDatabase` on every boot because the tenant's
 * database may never have seen the DevKit's schema. Here the schema belongs to the
 * platform, which migrated it once — so a guest has nothing to migrate, nothing to
 * be refused a connection for, and no reason to retry a world start at all. The
 * whole `WORLD_START_BACKOFF_MS` ladder exists for a failure mode this path does
 * not have.
 *
 * A half-configured environment is REPORTED rather than resolved: one of the two
 * env vars present means the platform spawns guests differently than this expects,
 * and falling back silently would hide that behind a connection bill.
 *
 * @internal
 */
export async function installPlatformWorld(): Promise<boolean> {
  const gap = describePlatformQueueGap();
  if (gap !== undefined) {
    console.error(
      `workflow world: NOT using the platform world — ${gap}. Falling back to a ` +
        "world of this guest's own, which holds database connections this deployment " +
        "did not budget.",
    );
    return false;
  }
  const platform = resolvePlatformQueue();
  if (!platform) return false;
  const { createWorld, setWorld } = await import("workflow/runtime");
  // The DevKit's `createWorld`, not a world package's: it resolves
  // `WORKFLOW_TARGET_WORLD` — which `configureWorkflowWorld` has set to `local` for
  // this path — and does NOT cache, so this builds the base exactly once and
  // `setWorld` is what publishes the composed one.
  setWorld(composePlatformWorld(createWorld(), platform));
  return true;
}
