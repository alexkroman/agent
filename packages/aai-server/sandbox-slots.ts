// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";
import { createOwnedMap, type OwnedMap } from "@alexkroman1/aai/internal";
import { debug } from "./_debug-log.ts";
import { createKeyedLock, withLock } from "./_keyed-lock.ts";
import { IDLE_SANDBOX_MS } from "./constants.ts";
import { bumpSlugEpoch, type SlugEpochs } from "./platform-epoch.ts";
import { retireSandbox } from "./sandbox-retire.ts";

export type SlotSandbox = {
  shutdown(): Promise<void>;
  /**
   * Live client sessions in the guest. Sessions connect DIRECTLY to the
   * sandbox's tunnel, so the host cannot count them — idle eviction asks
   * the guest before killing (see evictIdleSandbox).
   */
  activeSessions?: () => Promise<number>;
  /**
   * False once the sandbox's guest is gone (see `Sandbox.alive`). Optional so
   * test doubles and non-guest-backed stand-ins stay assignable; absent is
   * read as alive.
   */
  alive?: () => boolean;
};

export type AgentSlot = {
  slug: string;
  sandbox?: SlotSandbox;
  /**
   * Overflow sandbox replicas beyond `sandbox` (the primary), spawned by the
   * broker's scale-out when every resident sandbox is at session capacity
   * (see sandbox-scale.ts). Torn down with the slot (terminateSlot) and
   * reclaimed individually by idle eviction once their sessions end.
   */
  replicas?: SlotSandbox[];
  idleTimer?: NodeJS.Timeout;
  /**
   * Slug epoch the resident sandbox was built at (see platform-epoch.ts).
   * resolveSandbox terminates and rebuilds when the current epoch differs —
   * a deploy/secret/storage mutation on another replica or service.
   */
  epoch?: number;
};

// An OwnedMap because a redeploy replaces the slot object under the same
// slug: mutations driven by a pre-replacement handle must no-op (see the
// identity re-check in evictIdleSandbox), which is the map's `owns` check.
export type SlotCache = OwnedMap<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return createOwnedMap<string, AgentSlot>();
}

// Internal keyed lock (not p-lock): entries are deleted when released, so the
// pre-auth WS-upgrade path can't grow the map one entry per distinct slug.
const apiLock = createKeyedLock();

/** Serialize deploy/delete API calls for the same slug. */
export const withSlugLock = <T>(slug: string, fn: () => Promise<T>): Promise<T> =>
  withLock(apiLock, slug, fn);

function clearIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer);
    delete slot.idleTimer;
  }
}

async function detachAndShutdown(slot: AgentSlot, errorLabel: string): Promise<void> {
  const sb = slot.sandbox;
  if (!sb) return;
  delete slot.sandbox;
  try {
    await sb.shutdown();
  } catch (err: unknown) {
    console.warn(errorLabel, { slug: slot.slug, error: errorMessage(err) });
  }
}

/** Best-effort terminate a slot's sandboxes (primary + replicas). Errors are logged, never thrown. */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  clearIdleTimer(slot);
  const replicas = slot.replicas ?? [];
  delete slot.replicas;
  await Promise.all([
    detachAndShutdown(slot, "Failed to shut down sandbox"),
    ...replicas.map((sb) =>
      sb.shutdown().catch((err: unknown) => {
        console.warn("Failed to shut down sandbox replica", {
          slug: slot.slug,
          error: errorMessage(err),
        });
      }),
    ),
  ]);
}

/**
 * Detach a slot's sandboxes and retire them gracefully (see
 * sandbox-retire.ts): the slug is free for a rebuild the moment this returns,
 * while the calls already in flight finish on the old code.
 *
 * The detach is synchronous — no await between reading the sandboxes and
 * clearing the fields — so there is no window in which the broker could hand
 * a superseded sandbox to a new client. The drains are deliberately NOT
 * awaited: a deploy must not block for the length of someone else's call.
 *
 * For a sandbox that is gone rather than superseded (failed VM, exited guest,
 * deleted agent) use `terminateSlot` — there is nothing to drain.
 */
export function retireSlot(slot: AgentSlot, reason: string): void {
  clearIdleTimer(slot);
  const sandboxes = [...(slot.sandbox ? [slot.sandbox] : []), ...(slot.replicas ?? [])];
  delete slot.sandbox;
  delete slot.replicas;
  for (const sb of sandboxes) {
    void retireSandbox(sb, { slug: slot.slug, reason });
  }
}

/**
 * Retire `slug`'s sandbox (if resident) so the next session picks up new
 * config — used by the secret and storage handlers after a mutation.
 */
export function restartSlotSandbox(slots: SlotCache, slug: string, reason: string): void {
  const slot = slots.get(slug);
  if (slot?.sandbox) {
    console.info(`Retiring sandbox for ${reason}`, { slug });
    retireSlot(slot, reason);
  }
}

/**
 * Invalidate a slug everywhere after a mutation to it has landed.
 *
 * Two halves that must always travel together: this replica tears down its own
 * resident sandbox, and the slug's epoch bump tells every OTHER replica — and
 * the sibling service — to do the same on their next session start. Each
 * mutation route used to spell both out, and they had already diverged on
 * whether the bump was conditional; a route that pairs only the first half
 * produces no error anywhere, it just leaves other replicas serving the
 * previous version of the agent until idle eviction.
 *
 * Call AFTER the store write. An early bump makes peers rebuild from
 * pre-mutation artifacts. The local half is now synchronous (it hands the
 * sandbox to a background drain rather than awaiting a Modal terminate), so
 * only the bump is awaited; callers hold the cross-replica slug lease while
 * this runs.
 */
export async function invalidateSlug(
  deps: { slots: SlotCache; slugEpochs: SlugEpochs },
  slug: string,
  reason: string,
): Promise<void> {
  restartSlotSandbox(deps.slots, slug, reason);
  await bumpSlugEpoch(deps.slugEpochs, slug);
}

export function setSlot(slots: SlotCache, slot: AgentSlot): void {
  slots.claim(slot.slug, slot);
}

export function deleteSlot(slots: SlotCache, slug: string): boolean {
  const slot = slots.get(slug);
  if (slot) clearIdleTimer(slot);
  return slots.delete(slug);
}

/**
 * Was the slot's resident sandbox built from artifacts a later mutation has
 * superseded (see platform-epoch.ts)? Injected by sandbox-resolve.ts, which
 * owns both the epoch store and the bundle caches this module knows nothing
 * about; absent — dev, tests, any caller without epochs — means "never
 * superseded", i.e. the pre-epoch behavior.
 *
 * An implementation MUST also drop whatever caches the rebuild would
 * otherwise reuse. The worker-code cache lives 10 minutes and the idle window
 * is 5, so an eviction that skipped that would rebuild the SAME pre-mutation
 * bundle and stamp it with the current epoch — pinning the old code instead of
 * clearing it, which is worse than leaving the stale sandbox up.
 */
export type SupersededCheck = (slot: AgentSlot) => Promise<boolean>;

export function attachSandbox(
  slots: SlotCache,
  slot: AgentSlot,
  sandbox: NonNullable<AgentSlot["sandbox"]>,
  isSuperseded?: SupersededCheck,
): void {
  slot.sandbox = sandbox;
  resetIdleTimer(slots, slot, isSuperseded);
}

function resetIdleTimer(slots: SlotCache, slot: AgentSlot, isSuperseded?: SupersededCheck): void {
  clearIdleTimer(slot);
  const { slug } = slot;
  const timer = setTimeout(() => {
    void evictIdleSandbox(slots, slug, isSuperseded);
  }, IDLE_SANDBOX_MS);
  timer.unref?.();
  slot.idleTimer = timer;
}

const probeSessions = (sb: SlotSandbox): Promise<number> =>
  sb.activeSessions?.().catch(() => 0) ?? Promise.resolve(0);

/**
 * Scale-in: reclaim the probed-idle overflow replicas individually, even
 * while the primary stays busy. A replica the broker added while the probes
 * were in flight is not in `replicas`, so it survives untouched.
 */
function evictIdleReplicas(slot: AgentSlot, replicas: SlotSandbox[], replicaLive: number[]): void {
  for (const [i, replica] of replicas.entries()) {
    if ((replicaLive[i] ?? 0) > 0) continue;
    const idx = slot.replicas?.indexOf(replica) ?? -1;
    if (idx === -1) continue;
    slot.replicas?.splice(idx, 1);
    debug("Evicting idle sandbox replica", { slug: slot.slug });
    void replica.shutdown().catch((err: unknown) => {
      console.warn("Failed to shut down idle sandbox replica", {
        slug: slot.slug,
        error: errorMessage(err),
      });
    });
  }
  if (slot.replicas?.length === 0) delete slot.replicas;
}

/**
 * Retire a resident whose bundle a mutation elsewhere has superseded.
 *
 * Deliberately ahead of the session probe below, and deliberately blind to
 * live session counts. A deploy retires the resident sandbox only on the
 * replica that served the deploy request; every other replica learns through
 * the slug epoch, which `resolveSandbox` reads LAZILY — at session start. With
 * `buffer_containers` keeping a warm spare, the deploy and the replica holding
 * the sandbox are routinely different containers, so a slug nobody re-brokers
 * here keeps serving pre-deploy code. The probe path cannot be the backstop:
 * it re-arms on any live count, and those sessions are ON the superseded
 * sandbox, so gating on them means never retiring it.
 *
 * Retiring rather than terminating is what makes ignoring the count safe —
 * the calls in flight finish on the old code (see sandbox-retire.ts), only
 * new ones are barred.
 *
 * Returns true when it retired the slot (the caller must not also re-arm).
 */
async function retireSuperseded(
  slots: SlotCache,
  slot: AgentSlot,
  primary: SlotSandbox,
  isSuperseded: SupersededCheck,
): Promise<boolean> {
  if (!(await isSuperseded(slot))) return false;
  // The check awaited; only the slot's CURRENT sandbox may be retired.
  if (!slots.owns(slot.slug, slot) || slot.sandbox !== primary) return true;
  console.info("Retiring superseded sandbox (slug epoch advanced)", { slug: slot.slug });
  retireSlot(slot, "superseded");
  return true;
}

async function evictIdleSandbox(
  slots: SlotCache,
  slug: string,
  isSuperseded?: SupersededCheck,
): Promise<void> {
  const slot = slots.get(slug);
  if (!slot) return;
  // The fired timer was ours; drop the field so a later attach can rearm.
  delete slot.idleTimer;
  const primary = slot.sandbox;
  if (!primary) return;
  if (isSuperseded && (await retireSuperseded(slots, slot, primary, isSuperseded))) return;
  // Sessions connect directly to the sandboxes, so the host must ASK whether
  // any are live before killing one mid-call. A dead/unreachable guest
  // answers 0 (see Sandbox.activeSessions) — eviction proceeds.
  const replicas = [...(slot.replicas ?? [])];
  const [primaryLive, ...replicaLive] = await Promise.all([
    probeSessions(primary),
    ...replicas.map(probeSessions),
  ]);
  // The probes awaited; only the slot's CURRENT sandboxes may be evicted (a
  // deploy may have replaced them while we asked).
  if (!slots.owns(slug, slot) || slot.sandbox !== primary) return;
  evictIdleReplicas(slot, replicas, replicaLive);
  if (primaryLive > 0 || (slot.replicas?.length ?? 0) > 0) {
    // Carry the check forward: a busy slug re-arms indefinitely, and a
    // re-arm that dropped it would leave exactly the sandboxes the sweep
    // exists for — long-lived, never re-brokered — unchecked forever.
    resetIdleTimer(slots, slot, isSuperseded);
    return;
  }
  debug("Evicting idle sandbox", { slug });
  await detachAndShutdown(slot, "Failed to shut down idle sandbox");
}
