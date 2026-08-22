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
import type { LogPage } from "@alexkroman1/aai-runtime";
import { createKeyedLock, type KeyedLockOptions, withLock } from "./_keyed-lock.ts";
import { createLogger } from "./logger.ts";
import { type RetirableSandbox, retireSandbox } from "./sandbox-retire.ts";

const log = createLogger("sandbox.slots");

export type SlotSandbox = RetirableSandbox & {
  /**
   * False once the sandbox's guest is gone (see `Sandbox.alive`). Optional so
   * test doubles and non-guest-backed stand-ins stay assignable; absent is
   * read as alive.
   */
  alive?: () => boolean;
  /**
   * This guest's buffered stdout/stderr (see `Sandbox.logs`). Optional for the
   * same reason `alive` is — a stand-in that is not a real guest has none — and
   * absent reads as "no logs", never as an error.
   */
  logs?: (opts?: { after?: number; limit?: number }) => Promise<LogPage>;
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

/**
 * A plain `Map`, and the SLUG LOCK is the exclusion.
 *
 * It was an `OwnedMap`, justified as "a redeploy replaces the slot object under
 * the same slug: mutations driven by a pre-replacement handle must no-op, which
 * is the map's `owns` check" — and nothing here ever made that check. `setSlot`
 * discarded the release `claim` returns, `owns()` had no production caller, and
 * every removal went through `delete(key)`, which is unconditional and therefore
 * identical to `Map.delete`. So the ownership machinery was inert: the type
 * described a guarantee no call site asked for.
 *
 * The guarantee the call sites really rest on is `withSlugLock`. Every write and
 * every delete runs inside it, reads the entry under the same lock, and the two
 * teardown paths additionally identity-check the SANDBOX (`current?.sandbox !==
 * sandbox`) — which is the check that matters and one an owned map cannot
 * express, since a slot object legitimately outlives the sandbox in it. Naming
 * that here is worth more than a mechanism that looked like it was doing it.
 *
 * If a future mutation lands OUTSIDE the slug lock, this is the note to revisit:
 * the answer then is the lock, not a map that dedupes by identity.
 */
export type SlotCache = Map<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return new Map<string, AgentSlot>();
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
    log.warn("failed to shut down sandbox", { slug: slot.slug, error: errorMessage(err) });
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
  slots.set(slot.slug, slot);
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
