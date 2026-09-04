// Copyright 2026 the AAI authors. MIT license.
/**
 * Whether this process is a DEPLOYED guest, and the pair it dials the platform
 * with.
 *
 * There is no "world" left to compose — the file is named for one it used to
 * build. It wrapped the DevKit's Postgres world to override `queue` and `start`
 * so graphile-worker never subscribed; the replay engine replaced all of it, and
 * what survived is the ENVIRONMENT read that decided whether to build one at all.
 * That read now answers a broader question, and four clients ask it: the journal
 * (`workflow-journal-platform.ts`), the queue (`workflow-platform-queue.ts`),
 * session state, and upload records.
 *
 * ## Both keys or neither, and a HALF-configured environment is reported
 *
 * `aai dev`, host mode and a self-hosted `createRuntimeServer` have neither; a deployed
 * guest has both. One without the other is a platform that changed how it spawns,
 * and resolving it here — falling silently back to the in-process engine and the
 * memory journal — is precisely the durability failure
 * `workflow-journal-platform.ts` exists to end. So {@link resolvePlatformQueue}
 * answers `undefined` and {@link describePlatformQueueGap} NAMES the gap for the
 * caller to log.
 *
 * ## The pair is read from THIS PROCESS's environment
 *
 * {@link platformGuestOptions} is the spelling to reach for; its own doc carries
 * what reading the tenant's environment instead cost, and why the process env is
 * the safer read besides.
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
 * self-hosted `createRuntimeServer` have neither, and a deployed guest has both. A guest
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
