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
 * The minimum of the DevKit's `World` this module touches.
 *
 * Structural rather than imported: `@workflow/world` is a transitive dependency
 * this package does not declare, and what is needed here is "an object with a
 * `queue` and maybe a `start`" — which is a smaller claim than the whole
 * interface and cannot go stale against it in a way that matters.
 */
type ComposableWorld = {
  queue: unknown;
  start?: (() => Promise<void>) | undefined;
};

/**
 * Replace a world's queue with the platform's, and its `start` with nothing.
 *
 * Takes the base world rather than creating it, so the caller owns the import
 * ordering — which is load-bearing: `setWorld` has to run before anything reads
 * `getWorld()`, and only the caller knows when that is.
 *
 * @internal
 */
export function composePlatformWorld<T extends ComposableWorld>(
  base: T,
  opts: PlatformQueueOptions,
): T {
  return {
    ...base,
    queue: createPlatformQueueSend(opts),
    // EXPLICIT, and the most important line here. `...base` would inherit the
    // base world's `start`, which subscribes graphile-worker — undoing the whole
    // change with no symptom but connection pressure.
    start: async () => undefined,
  };
}

/**
 * Install the platform-owned queue, and answer whether it took.
 *
 * True means this guest's durable runs are queued by the platform and
 * graphile-worker is never subscribed — see `workflow-platform-world.ts` for what
 * that gives back and what it does not. False means there is no platform (`aai
 * dev`, host mode, a self-hosted server), and the caller carries on to the
 * in-guest queue.
 *
 * ## Here, and not in `configureWorkflowWorld`
 *
 * `setWorld` has to run before anything reads `getWorld()`, which argues for as
 * early as possible; `configureWorkflowWorld` argues the opposite, because it runs
 * for every guest and resolving a world there would build a `pg.Pool` for an agent
 * that declares no workflows. This function is behind the declares-workflows gate
 * AND before the `getWorld().start?.()` that follows it, which is the first read of
 * the world that MATTERS: the route modules loaded earlier take
 * `createQueueHandler` off `getWorldHandlers()`, and that method is the one the
 * composition deliberately keeps, so a handler already bound to it is bound to the
 * right thing. `setWorld` overwrites both caches, so every later read is ours.
 *
 * A half-configured environment is REPORTED rather than resolved: one of the two
 * env vars present means the platform spawns guests differently than this expects,
 * and falling back silently would hide that behind a connection bill.
 */
export async function subscribeToPlatformQueue(): Promise<boolean> {
  const gap = describePlatformQueueGap();
  if (gap !== undefined) {
    console.error(
      `workflow queue: NOT using the platform queue — ${gap}. Falling back to the ` +
        "in-guest queue, which holds app-database connections this deployment did not budget.",
    );
    return false;
  }
  const platform = resolvePlatformQueue();
  if (!platform) return false;
  const { createWorld, setWorld } = await import("workflow/runtime");
  // The DevKit's `createWorld`, not the world package's: it resolves
  // `WORKFLOW_TARGET_WORLD` and does NOT cache, so this builds the base world
  // exactly once and `setWorld` is what publishes the composed one.
  setWorld(composePlatformWorld(createWorld(), platform));
  return true;
}
