// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";
import { createOwnedMap, type OwnedMap } from "@alexkroman1/aai/internal";
import { debug } from "./_debug-log.ts";
import { createKeyedLock, withLock } from "./_keyed-lock.ts";
import { IDLE_SANDBOX_MS } from "./constants.ts";
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
   * Deploy version the resident sandbox was built from (the agents row's
   * counter — see agent-store.ts). resolveSandbox retires and rebuilds when
   * the current version differs: a deploy on another replica or service, or
   * a delete (version reads null).
   */
  version?: number;
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

export function setSlot(slots: SlotCache, slot: AgentSlot): void {
  slots.claim(slot.slug, slot);
}

export function deleteSlot(slots: SlotCache, slug: string): boolean {
  const slot = slots.get(slug);
  if (slot) clearIdleTimer(slot);
  return slots.delete(slug);
}

export function attachSandbox(
  slots: SlotCache,
  slot: AgentSlot,
  sandbox: NonNullable<AgentSlot["sandbox"]>,
): void {
  slot.sandbox = sandbox;
  resetIdleTimer(slots, slot);
}

function resetIdleTimer(slots: SlotCache, slot: AgentSlot): void {
  clearIdleTimer(slot);
  const { slug } = slot;
  const timer = setTimeout(() => {
    void evictIdleSandbox(slots, slug);
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

async function evictIdleSandbox(slots: SlotCache, slug: string): Promise<void> {
  const slot = slots.get(slug);
  if (!slot) return;
  // The fired timer was ours; drop the field so a later attach can rearm.
  delete slot.idleTimer;
  const primary = slot.sandbox;
  if (!primary) return;
  // Sessions connect directly to the sandboxes, so the host must ASK whether
  // any are live before killing one mid-call. A dead/unreachable guest
  // answers 0 (see Sandbox.activeSessions) — eviction proceeds. (Superseded
  // residents are not this sweep's job: the agents row's change stream
  // retires them the moment the row moves — see watchAgentInvalidation.)
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
    resetIdleTimer(slots, slot);
    return;
  }
  debug("Evicting idle sandbox", { slug });
  await detachAndShutdown(slot, "Failed to shut down idle sandbox");
}
