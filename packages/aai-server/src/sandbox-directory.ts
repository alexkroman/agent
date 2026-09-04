// Copyright 2026 the AAI authors. MIT license.
/**
 * Which live guest sandbox is already serving a slug, platform-wide —
 * answered by MODAL, not by a lease table we maintain.
 *
 * The slot cache is per-replica and the web service autoscales, so without a
 * fleet-wide answer two replicas serving the same slug each spawn their own
 * guest. That is not an edge case: Modal load-balances every request
 * independently, so a page load and the project switch a minute later
 * routinely land on different replicas.
 *
 * ## Why this is a NAME and not a lease row
 *
 * This was `aai_platform.sandbox_registry`: the owning replica registered its
 * resident and heartbeated a lease every 10s, and a cold broker read the
 * table. Modal's own API expresses the same thing directly — a sandbox may
 * carry a `name` unique within its App, `sandboxes.create` throws
 * `AlreadyExistsError` when the name is taken, and `sandboxes.fromName`
 * returns only a RUNNING sandbox. So Modal's control plane becomes the
 * arbiter, and what goes away is not just the table:
 *
 * - **The heartbeat**, and with it a timer per resident plus the
 *   ownership re-check every tick that kept every detach path (retire,
 *   terminate, idle self-exit, lost guest, blue-green handover) converging on
 *   an unregister.
 * - **The pg_cron sweep** for rows whose owning replica died.
 * - **The stale-lease window.** The old design accepted handing out a dead
 *   peer URL for up to one lease after a crash, and a retired sandbox's URL
 *   for up to one heartbeat. A name is released when the sandbox stops, so
 *   `fromName` cannot return something that is not running.
 * - **`replicaId` on the agent path.** A name needs no owner: the lookup
 *   asks whether a sandbox EXISTS, not who made it.
 *
 * ## The name carries the deploy VERSION, deliberately
 *
 * `agent-<hash(slug)>-v<version>`, not `agent-<slug>`. A blue-green handover
 * (`handoverSlot`) boots the replacement while the old resident still drains,
 * so a slug legitimately has two live sandboxes for a few minutes and a
 * version-less name would collide. Including the version also makes the peer
 * lookup version-EXACT, which the lease table could not be: it could hand out
 * a sandbox running superseded code until the owner's heartbeat stopped.
 *
 * The slug is hashed rather than embedded: slugs run to 64 characters and
 * Modal's name length is its own business, so a bounded, charset-safe name is
 * one less thing to be surprised by. Readability is not lost — every sandbox
 * already carries `slug` and `role` TAGS for the dashboard (sandbox-role.ts).
 */

import { hash } from "node:crypto";

/**
 * A live sandbox as another replica's broker sees it. Both URLs are public
 * (the Modal tunnel); the per-sandbox bearer that gates `/manage/*` is
 * deliberately absent — a peer routes clients to the guest, it does not manage
 * it, and the token stays with whoever spawned it.
 */
export type RegisteredSandbox = {
  /** The guest's public session endpoint — what the broker hands clients. */
  sessionUrl: string;
  /** The guest's origin, for the broker's `/client-config` proxy. */
  guestOrigin: string;
};

/**
 * Fleet-wide sandbox lookup. One method: the name IS the registration, taken
 * at create time, so there is nothing to register, renew, or release.
 */
export type SandboxDirectory = {
  /**
   * The live sandbox serving this (slug, version), or null. Never throws —
   * a lookup failure reads as "no sandbox", and the caller spawns.
   */
  find(slug: string, version: number): Promise<RegisteredSandbox | null>;
};

/**
 * Thrown when creating a named sandbox lost the race — another replica got
 * there first, so Modal refused the duplicate.
 *
 * It lives here, beside the naming functions, rather than in the Modal
 * backend: the name is this module's mechanism, and the class needs nothing
 * from the SDK. That is what lets callers use `instanceof` instead of
 * comparing `err.name` to a string — a taxonomy any rename, subclass, or
 * rewrap would silently defeat.
 */
export class SandboxNameTakenError extends Error {
  readonly sandboxName: string;
  constructor(sandboxName: string, options?: ErrorOptions) {
    super(`a sandbox named ${sandboxName} is already running`, options);
    this.name = "SandboxNameTakenError";
    this.sandboxName = sandboxName;
  }
}

/**
 * The Modal sandbox name for one deploy of one slug.
 *
 * Pure and stable: every replica computes the same name for the same
 * (slug, version), which is the whole mechanism.
 */
export function agentSandboxName(slug: string, version: number): string {
  return `agent-${hash("sha256", slug).slice(0, 16)}-v${version}`;
}

/**
 * The Modal sandbox name for one studio project's coding-agent sandbox.
 *
 * The studio keeps a lease row of its own (studio-session-registry.ts) and
 * cannot stop: a name answers "does this exist", and the studio also needs
 * "has any replica used this recently", which a name cannot express — a peer's
 * chat turns go browser→guest directly, so the OWNER (whose sweeper decides
 * eviction) sees no activity at all. What the name does add is the property
 * the lease could not guarantee: Modal refuses a duplicate, so two replicas
 * racing `ensureSession` cannot both cold-spawn even if the lease read misses.
 *
 * Both inputs are hashed: the scope is already an opaque digest and the pair
 * has no length bound worth reasoning about.
 */
export function studioSandboxName(scope: string, project: string): string {
  return `studio-${hash("sha256", `${scope}\u0000${project}`).slice(0, 16)}`;
}

/**
 * The memory arm's shape: the CONTRACT, plus the one test seam.
 *
 * Declared rather than written inline as `SandboxDirectory & { setPeer }` for
 * the reason `MemoryPreviewQueue` is (aai-studio-server): an inline
 * intersection is a shape no structural rule can read, so `konsistent.json`'s
 * `platform-store-arms` can pin this interface as extending `SandboxDirectory`
 * and pin the factory as returning it, where the intersection would have had
 * to be pinned by NAME alone.
 */
export interface MemorySandboxDirectory extends SandboxDirectory {
  /** Test seam: pretend a peer replica is running this deploy. */
  setPeer(slug: string, version: number, entry: RegisteredSandbox): void;
}

/**
 * Test-only directory: every lookup is a miss until a test injects a peer.
 *
 * Note that dev and the subprocess backend get NO directory at all
 * (service-config wires one only for the Modal backend) — a single process has
 * no peers, so there is nothing to look up.
 */
export function createMemorySandboxDirectory(): MemorySandboxDirectory {
  const peers = new Map<string, RegisteredSandbox>();
  return {
    find: (slug, version) => Promise.resolve(peers.get(agentSandboxName(slug, version)) ?? null),
    setPeer: (slug, version, entry) => peers.set(agentSandboxName(slug, version), entry),
  };
}
