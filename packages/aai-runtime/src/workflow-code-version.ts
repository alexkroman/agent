// Copyright 2026 the AAI authors. MIT license.
/**
 * Which CODE a durable run was started against.
 *
 * A run outlives the process that started it — that is what durable means — so
 * it also outlives the BUNDLE. A `ctx.sleep("nextDigest", DAY_MS)` parks for a
 * day, three deploys land, and the delivery that wakes it replays the body from
 * whatever bundle the sandbox is running now. The engine has always been honest
 * that resuming a run against a changed body is unsupported
 * (`workflow-replay-divergence.ts`: "runs started against the old body cannot be
 * resumed against the new one"), and until this module it had no way to SAY
 * whether that is what happened.
 *
 * ## It buys a diagnosis, not an enforcement
 *
 * The sharpest error this engine produces is the divergence message, and its
 * whole shape is a fork the engine could not resolve: a walk reached a key no
 * earlier walk did, which is EITHER a redeploy mid-flight or a non-deterministic
 * body, and the two want opposite fixes. The message states the pair and hands
 * the reader a test to run against their own source, because a journal holds
 * what a value WAS and never how it was produced.
 *
 * One version on the run record settles half of it. Recorded at `start` and
 * compared at each walk, an inequality states the redeploy as a fact and names
 * both versions; an equality ELIMINATES it, so the reader is told the body is
 * non-deterministic rather than asked to check. {@link describeCodeChange} is
 * that verdict, and it is a string rather than a boolean so the unknown case is
 * representable — see below.
 *
 * **It deliberately does not REFUSE a run whose code changed.** Almost every
 * such run resumes correctly: a deploy that touched a page, a tool, a prompt or
 * an unrelated workflow leaves this body's step sequence identical, and there is
 * no cheaper signal than the bundle hash — which changes on every deploy. So
 * refusing on inequality would fail nearly all of them to catch the few that
 * really diverged, and the divergence check already catches those precisely, at
 * the step that proves it. What the version adds is that the message no longer
 * guesses.
 *
 * ## It comes from THIS PROCESS's environment, never the agent's
 *
 * Same rule and same reason as `platformGuestOptions`: `agentServerEnv` strips
 * only `AAI_ALLOW_HOST`, so an agent may set any other `AAI_*` key as a secret.
 * Read from a tenant env, an agent could pin its own `AAI_BUNDLE_SHA256` — and
 * then every walk of every run would report the code unchanged, which is worse
 * than no version at all: the divergence message would state as a fact the one
 * cause it had eliminated. This is the platform's statement about the sandbox it
 * spawned, and nothing inside the sandbox may make it.
 *
 * Which also bounds what it covers: only a DEPLOYED guest has the key. `aai dev`
 * and a self-hosted `createServer` have none, so their runs record no version
 * and the divergence message keeps its original two-cause fork. That is the
 * honest answer there — a dev server's code changes on every file save.
 *
 * @module
 */

/**
 * The bundle hash the platform bakes into a guest's exec env.
 *
 * The same key `harness-agent-mode.ts` verifies the downloaded bundle against,
 * which is what makes it a code IDENTITY rather than a label: the guest refuses
 * to boot a bundle whose bytes do not hash to it, so a recorded version names
 * exactly one program.
 */
const BUNDLE_SHA_ENV = "AAI_BUNDLE_SHA256";

/**
 * The code this process is running, or `undefined` off the platform.
 *
 * @internal
 */
export function resolveCodeVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[BUNDLE_SHA_ENV]?.trim() || undefined;
}

/**
 * The same read, from THIS PROCESS's environment — never from the agent's.
 *
 * A separate name for the same reason `platformGuestOptions` is one: omitting the
 * argument is the mistake, and it is invisible from either end. The module doc
 * carries what a forgeable version would cost.
 *
 * @internal
 */
export function guestCodeVersion(): string | undefined {
  return resolveCodeVersion(process.env);
}

/**
 * What to say about the code, for a run started under `startedUnder` and walked
 * by a process running `current`.
 *
 * Three states, and the third is why this answers a string rather than a
 * boolean. Either version missing means UNKNOWN — a run started before this
 * field existed, or a walk on a server with no bundle hash — and an unknown
 * dressed as "unchanged" is the one failure mode that matters here, since the
 * divergence message would then rule out the cause that actually happened.
 *
 * @internal
 */
export function describeCodeChange(
  startedUnder: string | undefined,
  current: string | undefined = guestCodeVersion(),
): CodeChange {
  if (startedUnder === undefined || current === undefined) return { kind: "unknown" };
  if (startedUnder === current) return { kind: "same", version: current };
  return { kind: "changed", startedUnder, current };
}

/** The verdict {@link describeCodeChange} answers. @internal */
export type CodeChange =
  | { kind: "unknown" }
  | { kind: "same"; version: string }
  | { kind: "changed"; startedUnder: string; current: string };
