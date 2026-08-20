// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-sandbox bearer that gates a guest's `/manage/*` surface, DERIVED from
 * the sandbox's fleet-wide name rather than drawn at random.
 *
 * ## What random cost, and it was not obvious
 *
 * `randomBytes(32)` at each spawn site put the token in one replica's closure
 * and nowhere else. That is fine for the two things the manage surface was
 * built for — `drain` is called by the retirement that owns the resident, and
 * `activeSessions` is a diagnostic — and it quietly made the surface
 * REPLICA-LOCAL, which nothing said out loud. A sandbox is resident on one
 * replica, and the others reach it by dialling its tunnel rather than proxying
 * through its owner (`sandbox-peers.ts`), so any manage call landing on a peer
 * had a URL it could reach and no credential to present. With five containers
 * behind Modal's per-request load balancing, that is four requests in five.
 *
 * It surfaced when the studio's Logs pane needed to read `/manage/logs`: a pane
 * that works on one replica in five is worse than no pane, because the empty
 * answer is indistinguishable from an agent that printed nothing.
 *
 * ## Why the NAME is the right input
 *
 * `agentSandboxName(slug, version)` is already the fleet-wide identity — it is
 * what `sandboxes.create` races on and what `fromName` resolves — so every
 * replica can compute it from a slug and a version it reads out of the agents
 * row. HMAC over that name with a platform secret therefore gives every replica
 * the same answer and gives nobody outside the platform any answer at all.
 *
 * Three properties are preserved from the random version, and they are the ones
 * that matter: the token is unguessable without the secret; it is distinct per
 * sandbox, so learning one guest's token opens no other guest; and it ROTATES
 * on redeploy, because the version is in the name. What is given up is rotation
 * on RESPAWN of the same version — a guest that self-exits and is rebuilt gets
 * the token its predecessor had. That is a real reduction and a small one: the
 * token never leaves the platform and the tunnel it opens serves only that
 * sandbox, which is gone.
 *
 * ## An unset secret DEGRADES, and says so
 *
 * `AAI_GUEST_TOKEN_SECRET` unset falls back to a per-process random key, which
 * reproduces the old behaviour exactly — every guest still gets an unguessable
 * token, and manage calls still work on the replica that spawned it. Boot
 * announces it (`assertGuestTokenSecret`), for the same reason an unset
 * `PLATFORM_POOLER_URL` is announced: the deployment is not broken, it is
 * costing something a reader of the logs should be able to see.
 *
 * A single-replica deployment (`aai dev`, the subprocess backend, every test)
 * is unaffected either way.
 *
 * @module
 */

import { createHmac, randomBytes } from "node:crypto";
import { createLogger } from "./logger.ts";

const log = createLogger("guest.token");

/** The env var naming the HMAC key. */
export const GUEST_TOKEN_SECRET_ENV = "AAI_GUEST_TOKEN_SECRET";

/**
 * The fallback key, drawn once per process.
 *
 * Lazy rather than module-level so that a process which never spawns a guest
 * never draws one, and so a test can observe that the configured path was taken
 * without the fallback having run.
 */
let processKey: string | undefined;

function resolveKey(env: NodeJS.ProcessEnv): string {
  const configured = env[GUEST_TOKEN_SECRET_ENV];
  if (configured !== undefined && configured !== "") return configured;
  processKey ??= randomBytes(32).toString("hex");
  return processKey;
}

/**
 * This sandbox's manage bearer. Same name, same secret, same token — on every
 * replica.
 *
 * The name is the whole message: it already carries the slug's hash and the
 * deploy version, so nothing else needs mixing in, and adding a field later
 * would rotate every live token at once.
 */
export function guestTokenFor(
  sandboxName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // A sandbox with no NAME has no fleet-wide identity to derive from, so there
  // is nothing for a peer to recompute and a random token loses nothing. That
  // is the studio warm harness spawned outside the naming path, and only there;
  // an agent guest always has one (`agentSandboxName`, passed by the dispatch in
  // `sandbox-vm.ts`).
  if (sandboxName === undefined) return randomBytes(32).toString("hex");
  return createHmac("sha256", resolveKey(env)).update(sandboxName).digest("hex");
}

/**
 * Announce at boot whether manage calls are fleet-wide.
 *
 * A WARNING, never a refusal: an existing deployment that upgrades into this
 * has no such secret, and taking it down over a degradation it has been living
 * with since the beginning would be the strictly worse trade — the same
 * judgement `announcePlatformDbCapacity` makes about its own projection.
 *
 * It only warns where it could matter. A deployment with no platform database
 * is a single process by construction, so there is no peer for a token to be
 * unreachable from.
 */
export function assertGuestTokenSecret(env: NodeJS.ProcessEnv, hasPlatformDb: boolean): void {
  if (env[GUEST_TOKEN_SECRET_ENV]) return;
  if (!hasPlatformDb) return;
  log.warn(
    `no ${GUEST_TOKEN_SECRET_ENV}: guest manage tokens are per-process, so a ` +
      "/manage read (agent logs, session counts, drain) only works on the replica that " +
      "spawned the sandbox. Set it to a shared random secret to make them fleet-wide.",
  );
}

/** Reset the process fallback. Tests only. */
export function resetGuestTokenKey(): void {
  processKey = undefined;
}
