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
 * tenant's database and still need connections: the streamer holds a dedicated
 * `pg.Client` of its own and the world pool still serves storage reads.
 * What goes is graphile-worker's held `LISTEN` connection, its worker concurrency,
 * and the queue-lock sweep's presence connection — which exists only to clear
 * graphile's own orphaned job locks. Taking the rest would mean moving the DevKit's
 * storage off the tenant's database, which is a different and much larger change.
 */

import type { PlatformQueueOptions } from "./workflow-platform-queue.ts";

/**
 * Where the platform is DIALABLE, slug included — what the platform bakes in for
 * exactly this purpose.
 *
 * Its own key rather than {@link PUBLIC_BASE_URL_ENV}, which used to serve both,
 * because the two claims can require OPPOSITE values. The public one is what a
 * third party is handed by `ctx.workflows.publicWebhookUrl`, so it must resolve
 * from the internet; this one is dialled from inside the sandbox, so it must
 * resolve from there. Under a microVM backend those are different strings — the
 * VM's own `127.0.0.1` is the guest, and the guest's port is the platform's port,
 * so a guest handed the public value POSTed every platform call to itself and its
 * own 404 handler answered. `aai-server/public-origin.ts`'s
 * `agentPlatformBaseUrl` has the log lines and the fix.
 */
const PLATFORM_BASE_URL_ENV = "AAI_PLATFORM_BASE_URL";
/** The guest's own public base URL, slug included — what a third party is handed. */
const PUBLIC_BASE_URL_ENV = "AAI_PUBLIC_BASE_URL";
/** This sandbox's bearer, which the platform also gave it. */
const GUEST_TOKEN_ENV = "AAI_GUEST_TOKEN";

/**
 * The base to dial, preferring the key that MEANS that.
 *
 * The fallback is not politeness — an agent sandbox runs the harness image
 * PINNED at deploy time, so a guest booted before this key existed receives only
 * the public one and would otherwise lose its platform world entirely (durable
 * runs silently onto the DevKit's local world, session state silently onto
 * memory — the two failures `platformGuestOptions` was written to stop being
 * silent). On every backend but microsandbox the two values are identical, which
 * is what makes the fallback safe rather than merely quiet: it restores the exact
 * behaviour that guest already had.
 */
function dialBase(env: NodeJS.ProcessEnv): string | undefined {
  return env[PLATFORM_BASE_URL_ENV]?.trim() || env[PUBLIC_BASE_URL_ENV]?.trim();
}

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
  const base = dialBase(env);
  const token = env[GUEST_TOKEN_ENV]?.trim();
  if (!(base && token)) return undefined;
  return { base, token };
}

/**
 * The same pair, from THIS PROCESS's environment — never from the agent's.
 *
 * A separate name rather than "remember to omit the argument", because omitting
 * it is what two callers did not do and the cost was invisible from either end.
 * `runtime.ts` read the pair out of `providerEnv` and `workflow-install.ts` out
 * of `opts.env`, both of which are the TENANT's environment: the secrets file at
 * `AAI_AGENT_ENV_PATH`, which is the one place these two keys never appear. The
 * platform puts them in the sandbox's process env, which is why the WORLD —
 * `configureWorkflowWorld`, passing nothing — resolved while the other two did
 * not.
 *
 * **What that cost, measured on a deployed agent:** its session state fell to
 * the MEMORY backend, so `aai_platform.session_events` and `session_slots` stayed
 * empty across 25 sessions and a resume after the sandbox restarted re-greeted
 * instead of restoring history — while the same guest logged `harness starting
 * platform workflow world` one line earlier. Its uploads fell to the LOCAL
 * directory for the same reason, one release after they became the platform's.
 * The comment above the session-state call already claimed the invariant this
 * function now enforces: "read from the same pair the platform world uses, so a
 * deployment cannot end up with durable runs and memory-only turns".
 *
 * **It is also the safer read**, which is the reason to prefer it even where a
 * tenant env would happen to work. `agentServerEnv` strips only `AAI_ALLOW_HOST`,
 * so an agent may set any other `AAI_*` key as a secret — and under the old
 * spelling an agent that set these two chose the base URL its own session state
 * and upload records were sent to, with a bearer of its choosing. Reading the
 * process env takes that away: these are the platform's statements about the
 * sandbox it spawned, and nothing inside the sandbox may make them.
 *
 * @internal
 */
export function platformGuestOptions(): PlatformQueueOptions | undefined {
  return resolvePlatformQueue(process.env);
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
  const base = dialBase(env);
  const token = env[GUEST_TOKEN_ENV]?.trim();
  if (Boolean(base) === Boolean(token)) return undefined;
  return base
    ? `${PLATFORM_BASE_URL_ENV} is set but ${GUEST_TOKEN_ENV} is not`
    : `${GUEST_TOKEN_ENV} is set but ${PLATFORM_BASE_URL_ENV} is not`;
}
