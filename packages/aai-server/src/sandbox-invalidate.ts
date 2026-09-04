// Copyright 2026 the AAI authors. MIT license.
/**
 * Event-driven invalidation of this replica's resident sandboxes.
 *
 * Split from sandbox-resolve.ts, which answers "which sandbox runs this slug"
 * and owns the slot map — this module owns the other direction: reacting when
 * the answer CHANGES underneath us. The two are separate concerns with one
 * shared seam (`loadBundleParts` + `buildSlotSandbox`), and the same cut
 * sandbox-broker.ts and sandbox-peers.ts were made along.
 *
 * The driver is the agents row's change stream (Supabase Realtime in
 * production; the memory emitter in dev/tests — see platform-events.ts).
 */

import { errorMessage } from "@alexkroman1/aai";
import { createLogger } from "./logger.ts";
import type { PlatformEvents, Unwatch } from "./platform-events.ts";
import type { Sandbox } from "./sandbox.ts";
import {
  buildSlotSandbox,
  DrainingError,
  loadBundleParts,
  type ResolveSandboxOpts,
} from "./sandbox-resolve.ts";
import {
  type AgentSlot,
  deleteSlot,
  retireSlot,
  terminateSlot,
  withSlugLock,
} from "./sandbox-slots.ts";

const log = createLogger("sandbox.invalidate");

/**
 * THE mover of resident sandboxes on mutations. The agents row's change
 * stream (Supabase Realtime in production, the memory stores' emitter in
 * dev/tests — see platform-events.ts) is the single invalidation mechanism:
 * mutation handlers only write the row, and every replica — the writer
 * included — reacts here. There is deliberately no per-broker version check
 * and no idle-sweep superseded probe anymore; those were two more
 * implementations of the same comparison, and the change stream replaced
 * them rather than accelerating them.
 *
 * The event is a signal carrying nothing but the slug: the handler drops the
 * row caches and re-reads the version fresh, so a duplicated or reordered
 * event can only cause a redundant read — the version comparison under the
 * slug lock decides. A deleted row (version null) terminates rather than
 * retires — a deleted agent must stop answering, not drain for ten more
 * minutes — and the slot is dropped so the map doesn't grow one dead entry
 * per deleted slug.
 *
 * **The stream's REJOIN is handled too, and has to be.** `subscribe()` only
 * sends the join; changes between a socket drop and the ack reach nobody, and
 * because this is the only invalidation mechanism there is no later check to
 * catch them. So a join re-runs the same reconcile over every resident this
 * replica holds — see `reconcileSlug` below, which both paths share.
 */
export function watchAgentInvalidation(events: PlatformEvents, opts: ResolveSandboxOpts): Unwatch {
  /**
   * Bring ONE slug's resident back in line with its row. Shared by the change
   * event and the rejoin resync, so the two can never drift on what
   * "superseded" means or on which failures are survivable.
   *
   * RETURNED, not `void`-discarded, by both callers. Nothing in production
   * awaits it — a change stream has no caller — but the memory emitter
   * collects it, which is the only way a test can know the handler has
   * finished rather than spinning microtasks and hoping. The catch is what
   * makes returning it safe: production drops the value, so a rejection
   * escaping here would be an unhandled rejection (the `void` form had the
   * same hole — the lock acquisition itself sits outside the inner try/catch).
   */
  const reconcileSlug = (slug: string, cause: string): Promise<void> =>
    withSlugLock(slug, async () => {
      const slot = opts.slots.get(slug);
      if (!slot?.sandbox) return;
      opts.store.invalidate?.(slug);
      try {
        const version = await opts.store.getAgentVersion(slug);
        if (version === null) {
          // Row gone: a resident for a deleted agent always terminates —
          // never compared against the slot's stamp, which a slot built
          // before the stamp landed may not carry.
          log.info(`resident sandbox's agent deleted (${cause}); terminating`, { slug });
          await terminateSlot(slot);
          deleteSlot(opts.slots, slug);
        } else if (version !== slot.version) {
          log.info(`resident sandbox superseded (${cause}); booting replacement`, {
            slug,
            version,
          });
          await handoverSlot(slug, slot, version, opts);
        }
      } catch (err) {
        // An unreadable version must never take down a healthy sandbox; the
        // next change event (or a redeploy) retries.
        log.warn(`invalidation (${cause}) failed`, { slug, error: errorMessage(err) });
      }
    }).catch((err: unknown) => {
      // Only reachable from the lock acquisition itself — the body above
      // catches its own. Logged rather than rethrown: see the doc comment.
      log.warn(`invalidation (${cause}) could not lock`, { slug, error: errorMessage(err) });
    });

  return events.watchAgents(
    (slug) => {
      // Cheap pre-filter outside the lock: most events are for slugs this
      // replica has never brokered. Existence, NOT liveness — a slot
      // mid-rebuild has no sandbox attached yet, and skipping its event
      // would drop the only invalidation a concurrent remote deploy gets
      // (there is no per-broker version check to catch it later). Queued on
      // the slug lock below, the handler runs after the rebuild attaches
      // and the version comparison reconciles.
      if (!opts.slots.get(slug)) return;
      return reconcileSlug(slug, "change event");
    },
    () => {
      // The stream (re)joined: anything that changed while it was down was
      // delivered to nobody, and nothing else in the platform will notice. The
      // join carries no slug — it cannot, it is not about one row — so the
      // residents ARE the query: re-check every one this replica holds.
      //
      // Bounded by the slot cache, not by the agents table, so the cost is one
      // version read per sandbox this replica is actually serving — single-
      // flighted and 1s-cached in the bundle store, and paid only on a
      // reconnect. Snapshotted first because reconciling mutates the map
      // (a deleted agent drops its slot).
      const slugs = [...opts.slots.values()].map((slot) => slot.slug);
      if (slugs.length === 0) return;
      log.debug("Agents stream (re)joined; reconciling residents", { count: slugs.length });
      // Concurrent: each takes its own slug's lock, and one slug's slow
      // handover must not hold up another slug's delete.
      return Promise.all(slugs.map((slug) => reconcileSlug(slug, "stream rejoin")));
    },
  );
}

/**
 * BLUE-GREEN handoff on a redeploy: boot the NEW deploy's sandbox and wait
 * for its readiness (`sessionUrl()` resolves once the guest's `/health`
 * answered with the bundle loaded) BEFORE detaching the old one, so a
 * redeploy never leaves the broker with an empty slot — the next caller
 * lands on a warm replacement instead of paying the cold start. Runs under
 * the caller's slug lock, which also parks concurrent broker rebuilds until
 * the swap lands. Sessions already on the old sandbox keep running: it is
 * retired (drained in the background), exactly as before.
 *
 * If the REPLACEMENT fails to boot (the new deploy crashes on start), the
 * old resident is retired anyway rather than kept: keeping it would
 * silently serve superseded code forever, while an empty slot makes the
 * failure visible on the very next broker call (503 + the guest's boot
 * error in the host log).
 */
async function handoverSlot(
  slug: string,
  slot: AgentSlot,
  version: number,
  opts: ResolveSandboxOpts,
): Promise<void> {
  const parts = await loadBundleParts(slug, opts);
  if (!parts) {
    // The row vanished between the version read and the artifact read —
    // a delete raced the deploy event. Same handling as the deleted branch.
    await terminateSlot(slot);
    deleteSlot(opts.slots, slug);
    return;
  }
  let replacement: Sandbox;
  try {
    replacement = buildSlotSandbox(slug, parts, opts);
  } catch (err) {
    // Draining: leave the old resident attached and untouched. Retiring it to
    // honour a deploy this process will not live to serve would cut its live
    // calls for nothing — every surviving replica gets the same event and does
    // the handover properly.
    if (err instanceof DrainingError) {
      log.debug("Draining; leaving the superseded resident to the surviving replicas", { slug });
      return;
    }
    throw err;
  }
  try {
    await replacement.sessionUrl();
  } catch (err) {
    log.error("replacement sandbox failed to boot; retiring old resident", {
      slug,
      error: errorMessage(err),
    });
    await replacement.shutdown().catch(() => undefined);
    void retireSlot(slot, "superseded");
    return;
  }
  // Swap: detach the old sandbox (background drain) and attach the ready
  // replacement in the same tick — no window with an empty slot.
  void retireSlot(slot, "superseded");
  slot.version = version;
  slot.sandbox = replacement;
}
