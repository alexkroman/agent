// Copyright 2026 the AAI authors. MIT license.
/**
 * The broker's view of the REST of the fleet.
 *
 * `studio-session-broker.ts` owns one replica's sandboxes: spawn them, wire
 * their control channels, evict them when idle. This module owns the other
 * question — "is some other replica already running this project?" — and
 * keeps the registry read/write/adopt calls out of the broker's lifecycle
 * code, which is delicate enough on its own.
 *
 * It exists mainly so the broker has no `if (registry)` branches. Dev, tests,
 * and any deployment without a platform database get {@link soloFleet}: a
 * no-op that reports no peers and holds nothing, which is exactly right for a
 * single process. Every caller then reads as unconditional.
 */

import { errorMessage } from "@alexkroman1/aai";
import { type AdoptSessionParams, adoptPeerSession } from "./studio-session-adopt.ts";
import type { StudioSessionRecord, StudioSessionRegistry } from "./studio-session-registry.ts";

/** What a freshly spawned sandbox announces to the fleet. */
export type FleetClaim = Omit<StudioSessionRecord, "owner">;

export type SessionFleet = {
  /**
   * A peer's live sandbox for this project, with the session reinstalled and
   * ready to serve, or null when there is no live peer (none registered, the
   * row is ours, or the guest could not be reached).
   */
  adopt(
    scope: string,
    project: string,
    params: AdoptSessionParams,
  ): Promise<{ url: string; token: string } | null>;
  /** Announce a sandbox this replica just spawned. */
  claim(scope: string, project: string, claim: FleetClaim): Promise<void>;
  /** Drop our announcement. Owner-checked — never evicts a successor's. */
  release(scope: string, project: string): Promise<void>;
  /** Mark activity. Fire-and-forget: a lost touch costs at most one spawn. */
  touch(scope: string, project: string): void;
  /**
   * Has anyone in the fleet brokered this project recently enough that we
   * should NOT evict it?
   *
   * The owner's idle sweeper is blind to a peer's broker call — the peer
   * installs over HTTP and touches the lease, neither of which reaches this
   * process — and because the owner holds the control socket, evicting here
   * terminates a guest another replica is actively serving. Errors answer
   * `true`: a failed registry read is not evidence of idleness.
   */
  heldByUs(scope: string, project: string): Promise<boolean>;
};

/** The no-peer fleet: one process, nothing to coordinate with. */
export const soloFleet: SessionFleet = {
  adopt: () => Promise.resolve(null),
  claim: () => Promise.resolve(),
  release: () => Promise.resolve(),
  touch: () => undefined,
  heldByUs: () => Promise.resolve(false),
};

export type SessionFleetOptions = {
  registry: StudioSessionRegistry;
  /**
   * This replica's identity. Required: without a distinct id a replica
   * cannot tell its own rows from a peer's, so `release` could evict a live
   * peer's sandbox and `adopt` could try to adopt itself.
   */
  replicaId: string;
  /** Test seam for the peer install. */
  adopt?: typeof adoptPeerSession;
};

export function createSessionFleet(options: SessionFleetOptions): SessionFleet {
  const { registry, replicaId } = options;
  const install = options.adopt ?? adoptPeerSession;

  return {
    async adopt(scope, project, params) {
      const record = await registry.get(scope, project).catch(() => null);
      // Our own row is not a peer: the local map is the authority for
      // sandboxes we own, and it was already consulted.
      if (!record || record.owner === replicaId) return null;
      const adopted = await install(record, params);
      if (adopted) {
        await registry.touch(scope, project).catch(() => undefined);
        return adopted;
      }
      // The install doubles as the liveness probe, so a failure means the
      // guest is gone. Drop the row (owner-checked) so the next broker call
      // anywhere in the fleet spawns instead of re-probing a corpse.
      await registry.release(scope, project, record.owner).catch(() => undefined);
      return null;
    },

    async claim(scope, project, claim) {
      await registry.claim(scope, project, { ...claim, owner: replicaId }).catch((err: unknown) => {
        console.warn("Studio session: registry claim failed; peers may duplicate", {
          project,
          error: errorMessage(err),
        });
      });
    },

    async release(scope, project) {
      await registry.release(scope, project, replicaId).catch(() => undefined);
    },

    touch(scope, project) {
      void registry.touch(scope, project).catch(() => undefined);
    },

    async heldByUs(scope, project) {
      const record = await registry
        .get(scope, project)
        .catch(() => ({ owner: replicaId }) as StudioSessionRecord);
      return record?.owner === replicaId;
    },
  };
}
