// Copyright 2026 the AAI authors. MIT license.
/**
 * The cross-replica half of sandbox resolution: finding a peer's resident
 * before spawning a duplicate.
 *
 * Split from sandbox-resolve.ts, which owns this replica's slug→sandbox map
 * and its invalidation. The concerns differ in blast radius: everything here
 * is best-effort and must never affect the sandbox it describes, whereas a
 * mistake in the slot map costs a live session.
 *
 * This module used to have a second half — `startRegistryHeartbeat`, which
 * announced a resident to a lease table every 10 seconds and re-checked
 * ownership on every tick so that every detach path converged on an
 * unregister. All of it is gone: a sandbox's fleet-wide identity is now its
 * Modal NAME, taken at create time and released when it stops, so there is
 * nothing to announce, renew, or retract (see sandbox-directory.ts).
 */

import { errorMessage } from "@alexkroman1/aai";
import { createLogger } from "./logger.ts";
// Type-only, so the broker→peers→broker cycle is erased at compile time.
import type { BrokeredSession } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";

const log = createLogger("sandbox.peers");

/**
 * The broker's cross-replica route: a live peer sandbox for `slug`.
 *
 * Consulted only on the cold path (no local resident), where the duplicate
 * spawn it prevents is about to happen. Never fails a broker request — any
 * trouble reads as "no peer" and the local spawn proceeds.
 *
 * The version read serves two purposes at once, which is why they share a
 * call. It is the EXISTENCE gate: a deleted agent's sandbox can still be
 * running (retirement drains it for minutes), and routing to it would
 * resurrect a 404. And it is half the sandbox NAME, so the lookup is
 * version-exact — a peer can never hand out a guest running superseded code,
 * which the lease table it replaced could do until the owner's heartbeat
 * stopped.
 */
export async function findPeerSession(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<BrokeredSession | null> {
  const directory = opts.directory;
  if (!directory) return null;
  try {
    const version = await opts.store.getAgentVersion(slug);
    if (version === null) return null;
    const peer = await directory.find(slug, version);
    if (!peer) return null;
    return { ok: true, sessionUrl: peer.sessionUrl, guestOrigin: peer.guestOrigin };
  } catch (err) {
    log.warn("directory lookup failed", { slug, error: errorMessage(err) });
    return null;
  }
}
