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
import { createKeyedLock, withLock } from "./_keyed-lock.ts";
import { retireSandbox } from "./sandbox-retire.ts";

export type SlotSandbox = {
  shutdown(): Promise<void>;
  /**
   * Ask the guest to refuse new sessions and self-exit when empty (see
   * `Sandbox.drain`). Optional so test doubles stay assignable.
   */
  drain?: (deadlineMs?: number) => Promise<void>;
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

/** Serialize deploy/delete API calls for the same slug. */
export const withSlugLock = <T>(slug: string, fn: () => Promise<T>): Promise<T> =>
  withLock(apiLock, slug, fn);

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
 * the slug is free for a rebuild the moment this returns, while the calls
 * already in flight finish on the old code in the guest.
 *
 * The detach is synchronous — no await between reading the sandbox and
 * clearing the field — so there is no window in which the broker could hand
 * a superseded sandbox to a new client.
 *
 * For a sandbox that is gone rather than superseded (failed VM, exited guest,
 * deleted agent) use `terminateSlot` — there is nothing to drain.
 */
export function retireSlot(slot: AgentSlot, reason: string): void {
  const sb = slot.sandbox;
  delete slot.sandbox;
  if (sb) void retireSandbox(sb, { slug: slot.slug, reason });
}

export function setSlot(slots: SlotCache, slot: AgentSlot): void {
  slots.claim(slot.slug, slot);
}

export function deleteSlot(slots: SlotCache, slug: string): boolean {
  return slots.delete(slug);
}

export function attachSandbox(
  slots: SlotCache,
  slot: AgentSlot,
  sandbox: NonNullable<AgentSlot["sandbox"]>,
): void {
  // The slots handle is unused since the host's idle machinery was deleted,
  // but the signature keeps attach sites honest about which cache they
  // mutate.
  void slots;
  slot.sandbox = sandbox;
}
