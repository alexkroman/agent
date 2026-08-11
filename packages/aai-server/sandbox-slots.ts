// Copyright 2025 the AAI authors. MIT license.
/**
 * The replica's slug → resident-sandbox map.
 *
 * A slot is deliberately tiny — `{ slug, version?, sandbox? }` — and the
 * host runs NO idle machinery: idleness is the GUEST'S job (agent-mode
 * guests self-exit after `AGENT_IDLE_EXIT_MS` with zero sessions — see
 * aai-guest/harness-agent-mode.ts), and the exit surfaces here through
 * `onSandboxLost`, which detaches the slot. Per-slug horizontal scaling
 * (session caps, overflow replicas, least-connections routing) was deleted
 * for simplicity: one sandbox per slug per replica.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createOwnedMap, type OwnedMap } from "@alexkroman1/aai/internal";
import { createKeyedLock, type KeyedLockOptions, withLock } from "./_keyed-lock.ts";
import { type RetirableSandbox, retireSandbox } from "./sandbox-retire.ts";

export type SlotSandbox = RetirableSandbox & {
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
   * Deploy version the resident sandbox was built from (the agents row's
   * counter — see agent-store.ts). The change-event handler hands over to a
   * replacement when the current version differs: a deploy on another
   * replica or service, or a delete (version reads null).
   */
  version?: number;
  /**
   * The public origin of the REQUEST that last built this slot's sandbox
   * (`resolvePublicOrigin`), remembered for the one path that needs an origin
   * and has no request: the change stream's blue-green handover.
   *
   * Modal gives a container no way to learn its own public hostname except
   * from a request, and a handover only ever fires for a slug this replica
   * already holds a resident for — so by construction a brokered request came
   * first and stamped this. It is per SLOT rather than a module-level "last
   * origin served anywhere" for the obvious reason: the origin a guest is told
   * to call back on should be the one its own agent was brokered on, not
   * whatever request happened to land most recently.
   *
   * Absent is safe — the only consumer (`analyticsTarget`) treats it as "do
   * not configure shipping", which costs rows and never a session.
   */
  publicOrigin?: string | undefined;
};

// An OwnedMap because a redeploy replaces the slot object under the same
// slug: mutations driven by a pre-replacement handle must no-op, which is
// the map's `owns` check.
export type SlotCache = OwnedMap<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return createOwnedMap<string, AgentSlot>();
}

// Internal keyed lock (not p-lock): entries are deleted when released, so the
// pre-auth WS-upgrade path can't grow the map one entry per distinct slug.
const apiLock = createKeyedLock();

/**
 * Serialize deploy/delete API calls for the same slug.
 *
 * `opts.timeoutMs` bounds the ACQUIRE (see `_keyed-lock.ts`). The mutation
 * routes pass one so a contended slug answers 409 instead of holding the
 * request; the slot-cache callers here deliberately do not — they are
 * bookkeeping under a lock nobody is waiting on a reply from, and failing
 * them would trade a slow rebuild for a dead sandbox left installed.
 */
export const withSlugLock = <T>(
  slug: string,
  fn: () => Promise<T>,
  opts?: KeyedLockOptions,
): Promise<T> => withLock(apiLock, slug, fn, opts);

/** Best-effort terminate a slot's sandbox. Errors are logged, never thrown. */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  const sb = slot.sandbox;
  if (!sb) return;
  delete slot.sandbox;
  try {
    await sb.shutdown();
  } catch (err: unknown) {
    console.warn("Failed to shut down sandbox", { slug: slot.slug, error: errorMessage(err) });
  }
}

/**
 * Detach a slot's sandbox and retire it gracefully (see sandbox-retire.ts):
 * the slug is free for a rebuild the moment the detach lands, while the
 * calls already in flight finish on the old code in the guest.
 *
 * The detach is synchronous — no await between reading the sandbox and
 * clearing the field — so there is no window in which the broker could hand
 * a superseded sandbox to a new client. The returned promise (never
 * rejects) settles once the drain request was DELIVERED: request-path
 * callers `void` it, process shutdown awaits it (see sandbox-retire.ts).
 *
 * For a sandbox that is gone rather than superseded (failed VM, exited guest,
 * deleted agent) use `terminateSlot` — there is nothing to drain.
 */
export function retireSlot(slot: AgentSlot, reason: string): Promise<void> {
  const sb = slot.sandbox;
  delete slot.sandbox;
  return sb ? retireSandbox(sb, { slug: slot.slug, reason }) : Promise.resolve();
}

export function setSlot(slots: SlotCache, slot: AgentSlot): void {
  slots.claim(slot.slug, slot);
}

export function deleteSlot(slots: SlotCache, slug: string): boolean {
  return slots.delete(slug);
}

/**
 * Is this sandbox still usable? A sandbox whose guest exited keeps a
 * `sessionUrl` pointing at a dead endpoint, so serving it would hand every
 * new client a corpse. `onSandboxLost` detaches it too, but asynchronously
 * and under the slug lock — this is the synchronous guard that makes the
 * window unobservable. A stand-in without `alive` reads as live.
 */
export function isLive(sandbox: NonNullable<AgentSlot["sandbox"]>): boolean {
  return sandbox.alive?.() !== false;
}
