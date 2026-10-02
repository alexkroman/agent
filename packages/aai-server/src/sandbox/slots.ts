// Copyright 2025 the AAI authors. MIT license.
/**
 * The replica's slug → resident-sandbox map.
 *
 * A slot is deliberately tiny — a slug plus one of two named states (see
 * {@link SlotState}) — and the host runs NO idle machinery: idleness is the
 * GUEST'S job (agent-mode guests self-exit after `AGENT_IDLE_EXIT_MS` with
 * zero sessions — see aai-guest/harness-agent-mode.ts), and the exit surfaces
 * here through `onSandboxLost`, which detaches the slot. Per-slug horizontal
 * scaling (session caps, overflow replicas, least-connections routing) was
 * deleted for simplicity: one sandbox per slug per replica.
 *
 * **Every state change goes through a transition function in this file**, so
 * the legal moves live in one place rather than at each call site in
 * resolve.ts and invalidate.ts:
 *
 * ```text
 *   (absent) --claimSlot-----------------> empty
 *   empty    --attachSandbox-------------> ready
 *   ready    --terminateSlot / retireSlot-> empty
 *   empty | ready --deleteSlot-----------> (absent)
 * ```
 *
 * All of them run under `withSlugLock` except replica shutdown's
 * `retireSlot` (teardown-sandboxes.ts), which only ever empties a slot.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { LogPage } from "@alexkroman1/aai/host-internal";
import { createKeyedLock, type KeyedLockOptions, withLock } from "../_keyed-lock.ts";
import { createLogger } from "../logger.ts";
import { type RetirableSandbox, retireSandbox } from "./retire.ts";

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

/**
 * What a slot holds. Two states, because every reader of a slot asks exactly
 * one question of it — is there a resident to serve, and from which deploy?
 *
 * - `empty`: in the map, no sandbox. Two ways to be here, which no reader tells
 *   apart: a rebuild CLAIMED the slug (`rebuildSlot`, before its bundle read
 *   lands — the change-event handler pre-filters on slot EXISTENCE, so the
 *   claim is what queues a concurrent deploy's event behind the rebuild), or a
 *   resident was DETACHED and nothing replaced it yet (a blue-green handover
 *   whose replacement failed to boot, a dead guest awaiting its rebuild under
 *   the same lock, replica shutdown). An empty slot carries no version:
 *   nothing ever read one — `reconcileSlug` skips a slot with no sandbox, and
 *   a rebuild reads the row fresh and stamps its own.
 * - `ready`: a resident sandbox and the deploy `version` it was built from
 *   (the agents row's counter — see agent-store.ts). The change-event handler
 *   hands over to a replacement when the current version differs: a deploy on
 *   another replica or service, or a delete (version reads null). "Ready" is
 *   the SLOT's state, not the guest's: a resident may still be booting, or
 *   already dead with its async detach queued — `isLive` answers for the guest.
 */
export type SlotState =
  | { kind: "empty" }
  | { kind: "ready"; sandbox: SlotSandbox; version: number };

/**
 * One slug's entry in the map: a stable cell whose `state` only the
 * transitions below replace. The map holds the cell rather than the state
 * because a slot legitimately outlives the sandbox in it — a handover swaps
 * the resident in place — and replica shutdown retires the cells it
 * snapshotted, outside any lock.
 */
export type AgentSlot = { readonly slug: string; state: SlotState };

/**
 * A plain `Map`, and the SLUG LOCK is the exclusion.
 *
 * It was an `OwnedMap`, justified as "a redeploy replaces the slot object under
 * the same slug: mutations driven by a pre-replacement handle must no-op, which
 * is the map's `owns` check" — and nothing here ever made that check. `setSlot`
 * (since replaced by `claimSlot`) discarded the release `claim` returns, `owns()` had no production caller, and
 * every removal went through `delete(key)`, which is unconditional and therefore
 * identical to `Map.delete`. So the ownership machinery was inert: the type
 * described a guarantee no call site asked for.
 *
 * The guarantee the call sites really rest on is `withSlugLock`. Every write and
 * every delete runs inside it, reads the entry under the same lock, and the
 * lost-sandbox detach additionally identity-checks the SANDBOX
 * (`holdsSandbox`) — which is the check that matters and one an owned map
 * cannot express, since a slot object legitimately outlives the sandbox in it.
 * Naming that here is worth more than a mechanism that looked like it was doing
 * it.
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

/**
 * (absent) → empty: put a fresh, empty slot under `slug` and return it. The
 * rebuild's CLAIM — see `rebuildSlot` for why it lands before any read.
 */
export function claimSlot(slots: SlotCache, slug: string): AgentSlot {
  const slot: AgentSlot = { slug, state: { kind: "empty" } };
  slots.set(slug, slot);
  return slot;
}

/**
 * empty → ready: install `sandbox`, built from deploy `version`. Both callers
 * reach it from `empty` in the same task that built (or readied) the sandbox
 * — a rebuild from its claim, a handover straight after `retireSlot` detached
 * the old resident — so there is never a resident here to overwrite.
 */
export function attachSandbox(slot: AgentSlot, sandbox: SlotSandbox, version: number): void {
  slot.state = { kind: "ready", sandbox, version };
}

/**
 * ready → empty, synchronously, returning what was detached (undefined when
 * the slot was already empty). The one place a resident leaves its slot; the
 * two teardowns below are this plus what each does with the sandbox after.
 */
function detachSandbox(slot: AgentSlot): SlotSandbox | undefined {
  if (slot.state.kind !== "ready") return undefined;
  const { sandbox } = slot.state;
  slot.state = { kind: "empty" };
  return sandbox;
}

/** Best-effort terminate a slot's sandbox. Errors are logged, never thrown. */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  const sb = detachSandbox(slot);
  if (!sb) return;
  try {
    await sb.shutdown();
  } catch (err: unknown) {
    log.warn("failed to shut down sandbox", { slug: slot.slug, error: errorMessage(err) });
  }
}

/**
 * Detach a slot's sandbox and retire it gracefully (see sandbox/retire.ts):
 * the slug is free for a rebuild the moment the detach lands, while the
 * calls already in flight finish on the old code in the guest.
 *
 * The detach is synchronous — no await between reading the sandbox and
 * clearing the field — so there is no window in which the broker could hand
 * a superseded sandbox to a new client. The returned promise (never
 * rejects) settles once the drain request was DELIVERED: request-path
 * callers `void` it, process shutdown awaits it (see sandbox/retire.ts).
 *
 * For a sandbox that is gone rather than superseded (failed VM, exited guest,
 * deleted agent) use `terminateSlot` — there is nothing to drain.
 */
export function retireSlot(slot: AgentSlot, reason: string): Promise<void> {
  const sb = detachSandbox(slot);
  return sb ? retireSandbox(sb, { slug: slot.slug, reason }) : Promise.resolve();
}

/** empty | ready → (absent). Callers detach a resident first; this only unmaps. */
export function deleteSlot(slots: SlotCache, slug: string): boolean {
  return slots.delete(slug);
}

/** The slot's resident sandbox when it is `ready`; undefined otherwise. */
export function slotSandbox(slot: AgentSlot | undefined): SlotSandbox | undefined {
  return slot?.state.kind === "ready" ? slot.state.sandbox : undefined;
}

/**
 * Is `sandbox` still the resident of `slot`? The stale-callback guard, and
 * still needed with the slug lock: a sandbox's `onSandboxLost` fires
 * asynchronously, and by the time it holds the lock the slot may have moved on
 * — a handover swapped in a replacement, a dead resident was terminated and
 * rebuilt, or the sandbox was a handover's replacement that failed to boot and
 * was never attached at all. The lock serializes the callback against those
 * transitions but cannot tell it which already ran; only the sandbox can.
 */
export function holdsSandbox(slot: AgentSlot | undefined, sandbox: SlotSandbox): slot is AgentSlot {
  return slotSandbox(slot) === sandbox;
}

/**
 * Is this sandbox still usable? A sandbox whose guest exited keeps a
 * `sessionUrl` pointing at a dead endpoint, so serving it would hand every
 * new client a corpse. `onSandboxLost` detaches it too, but asynchronously
 * and under the slug lock — this is the synchronous guard that makes the
 * window unobservable. A stand-in without `alive` reads as live.
 */
export function isLive(sandbox: SlotSandbox): boolean {
  return sandbox.alive?.() !== false;
}
