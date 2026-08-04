// Copyright 2026 the AAI authors. MIT license.
/**
 * Slot-based sandbox resolution: map a slug to its (possibly freshly built)
 * resident sandbox. Split from sandbox.ts, which owns one sandbox's
 * lifecycle; this module owns the replica's slug→sandbox map and its
 * invalidation — `watchAgentInvalidation`, driven by the agents row's
 * change stream (Supabase Realtime in production; see platform-events.ts
 * and agent-store.ts).
 */

import { errorMessage } from "@alexkroman1/aai";
import pTimeout from "p-timeout";
import { debug } from "./_debug-log.ts";
import { type AppDatabases, type AppDbMeta, parseAppDbMeta } from "./app-database.ts";
import { BROKER_READY_TIMEOUT_MS } from "./constants.ts";
import type { PlatformEvents, Unwatch } from "./platform-events.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import {
  type AgentSlot,
  deleteSlot,
  retireSlot,
  type SlotCache,
  setSlot,
  terminateSlot,
  withSlugLock,
} from "./sandbox-slots.ts";
import { appDbSecretName, type SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

type ResolveAppDbOpts = {
  secrets?: SecretStore | undefined;
  appDb?: AppDatabases | undefined;
};

/**
 * Read the app's stored `app-db:` credentials (when the platform can open
 * them). Resolves null when storage is not enabled or unconfigured.
 */
function readAppDbMeta(slug: string, opts: ResolveAppDbOpts) {
  return opts.secrets && opts.appDb
    ? opts.secrets.get(appDbSecretName(slug)).then(parseAppDbMeta)
    : Promise.resolve(null);
}

export type ResolveSandboxOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Named secret storage — read for the app's `app-db:` credentials. */
  secrets?: SecretStore;
  /** Per-app database opener; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  /**
   * How long a broker call waits on a booting sandbox before answering 503.
   * Defaults to {@link BROKER_READY_TIMEOUT_MS}; injectable for tests, which
   * must not spend the real budget to observe the cap.
   */
  readyTimeoutMs?: number;
};

type BundleParts = {
  workerCode: string;
  env: Record<string, string>;
  appDbMeta: AppDbMeta | null;
  /** Harness image the agent was deployed against (per-deploy pinning). */
  imageTag: string | null;
  /** Deploy version off the same row read — what the slot is stamped with. */
  version: number;
};

/**
 * Read the slug's stored bundle artifacts, all reads in flight at once.
 * Resolves null when the bundle is incomplete (deleted mid-read). Each read
 * gets a no-op rejection handler immediately so one rejecting early doesn't
 * surface as unhandled while its siblings are still in flight —
 * `Promise.all` still observes the originals.
 */
function loadBundleParts(slug: string, opts: ResolveSandboxOpts): Promise<BundleParts | null> {
  const { store } = opts;
  const workerCodeP = store.getWorkerCode(slug);
  // The full row — for the pinned harness image tag and the deploy version.
  // The stored config is NOT read: it is opaque to the host (agent-store.ts).
  const agentP = store.getAgent(slug);
  const envP = store.getEnv(slug).then((e) => e ?? {});
  // Storage ("app db") credentials, when the platform can open them.
  const appDbMetaP = readAppDbMeta(slug, opts);
  for (const p of [workerCodeP, agentP, envP, appDbMetaP]) p.catch(() => undefined);
  return Promise.all([workerCodeP, agentP, envP, appDbMetaP]).then(
    ([workerCode, agent, env, appDbMeta]) =>
      workerCode && agent
        ? {
            workerCode,
            env,
            appDbMeta,
            imageTag: agent.harness_image_tag ?? null,
            version: agent.version,
          }
        : null,
  );
}

/**
 * Build one sandbox from loaded bundle parts. `onSandboxLost` is the caller's
 * dead-sandbox detach, for both ways a sandbox becomes unusable: a rejected
 * vmReady leaves it permanently broken (every tool call fails), and a guest
 * that exits later leaves its sessionUrl pointing at nothing. Either way live
 * traffic keeps clearing the idle timer, so it would never self-heal — the
 * callback must detach it from wherever it was installed so the next
 * connection rebuilds. (createSandbox returns synchronously and the caller
 * installs the sandbox in the same task, so the async callback can only fire
 * after the install.)
 */
function buildSandboxFromParts(
  slug: string,
  parts: BundleParts,
  opts: ResolveSandboxOpts,
  onSandboxLost: (sandbox: Sandbox) => void,
): Sandbox {
  // Storage: the app's OWN scoped Postgres credentials (role/search_path
  // pinned at provisioning — see app-database.ts) ride into the guest as
  // DATABASE_URL, and the bundle's runtime connects directly, exactly as
  // `aai dev` does with a project .env. Platform admin credentials never
  // enter the guest. Injected last so enabling storage deterministically
  // selects the provisioned database.
  const env =
    parts.appDbMeta && opts.appDb
      ? { ...parts.env, DATABASE_URL: opts.appDb.connectionUrl(parts.appDbMeta) }
      : parts.env;
  const sandbox: Sandbox = createSandbox({
    workerCode: parts.workerCode,
    env,
    slug,
    ...(parts.imageTag !== null && { imageTag: parts.imageTag }),
    onSandboxLost: () => onSandboxLost(sandbox),
  });
  return sandbox;
}

/**
 * Build the slot's primary sandbox — a lost sandbox (failed VM, or a guest
 * that exited later) tears the whole slot down (identity-checked under the
 * slug lock so a deploy/delete that already replaced the slot is never
 * raced).
 */
function buildSlotSandbox(slug: string, parts: BundleParts, opts: ResolveSandboxOpts): Sandbox {
  return buildSandboxFromParts(slug, parts, opts, (sandbox) => {
    void withSlugLock(slug, async () => {
      const current = opts.slots.get(slug);
      if (current?.sandbox === sandbox) await terminateSlot(current);
    });
  });
}

/**
 * Is this sandbox still usable? A sandbox whose guest exited keeps a
 * `sessionUrl` pointing at a dead endpoint, so serving it would hand every
 * new client a corpse. `onSandboxLost` detaches it too, but asynchronously
 * and under the slug lock — this is the synchronous guard that makes the
 * window unobservable. A stand-in without `alive` reads as live.
 */
function isLive(sandbox: NonNullable<AgentSlot["sandbox"]>): boolean {
  return sandbox.alive?.() !== false;
}

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
 */
export function watchAgentInvalidation(events: PlatformEvents, opts: ResolveSandboxOpts): Unwatch {
  return events.watchAgents((slug) => {
    // Cheap pre-filter outside the lock: most events are for slugs this
    // replica has never brokered. Existence, NOT liveness — a slot
    // mid-rebuild has no sandbox attached yet, and skipping its event
    // would drop the only invalidation a concurrent remote deploy gets
    // (there is no per-broker version check to catch it later). Queued on
    // the slug lock below, the handler runs after the rebuild attaches
    // and the version comparison reconciles.
    if (!opts.slots.get(slug)) return;
    void withSlugLock(slug, async () => {
      const slot = opts.slots.get(slug);
      if (!slot?.sandbox) return;
      opts.store.invalidate?.(slug);
      try {
        const version = await opts.store.getAgentVersion(slug);
        if (version === null) {
          // Row gone: a resident for a deleted agent always terminates —
          // never compared against the slot's stamp, which a slot built
          // before the stamp landed may not carry.
          console.info("Resident sandbox's agent deleted (change event); terminating", { slug });
          await terminateSlot(slot);
          deleteSlot(opts.slots, slug);
        } else if (version !== slot.version) {
          console.info("Resident sandbox superseded (change event); booting replacement", {
            slug,
            version,
          });
          await handoverSlot(slug, slot, version, opts);
        }
      } catch (err) {
        // An unreadable version must never take down a healthy sandbox; the
        // next change event (or a redeploy) retries.
        console.warn(`Change-event invalidation failed for ${slug}: ${errorMessage(err)}`);
      }
    });
  });
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
  const replacement = buildSlotSandbox(slug, parts, opts);
  try {
    await replacement.sessionUrl();
  } catch (err) {
    console.error("Replacement sandbox failed to boot; retiring old resident", {
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

/** Build (and attach) a fresh sandbox for `slot`; null when the slug has no bundle. */
async function rebuildSlot(
  slug: string,
  existingSlot: AgentSlot | undefined,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const { slots, store } = opts;

  // Claim the slot BEFORE any read, and read the record FRESH (row caches
  // dropped): the change-event handler pre-filters on slot EXISTENCE, so
  // from this point a deploy/delete event anywhere queues behind this
  // rebuild's slug lock and reconciles versions after the sandbox attaches
  // — the race can only cause one extra rebuild, never a stale sandbox
  // that reads as current. An event that fired before the slot existed can
  // only be for a write the fresh read below already observes. (The
  // artifact reads resolve through the same freshly cached row, and blobs
  // are content-addressed, so a torn mix of two deploys is impossible.)
  let slot = existingSlot;
  const created = !slot;
  if (!slot) {
    slot = { slug };
    setSlot(slots, slot);
  }
  try {
    store.invalidate?.(slug);
    const parts = await loadBundleParts(slug, opts);
    if (!parts) {
      // A slug with no bundle must not leave an empty slot behind — the
      // pre-auth upgrade path can't be allowed to grow the map per 404.
      if (created) deleteSlot(slots, slug);
      return null;
    }
    if (created) debug("Lazy-discovered agent from store", { slug });

    const sandbox = buildSlotSandbox(slug, parts, opts);

    slot.version = parts.version;
    slot.sandbox = sandbox;
    return sandbox;
  } catch (err) {
    if (created) deleteSlot(slots, slug);
    throw err;
  }
}

/**
 * Map a slug to its (possibly freshly built) ONE resident sandbox. A LIVE
 * resident is served as-is — whether it is still current is not this path's
 * question: mutations move sandboxes through the agents row's change stream
 * (`watchAgentInvalidation`), never through per-broker checks. (Horizontal
 * per-slug scaling — session caps, overflow replicas, least-connections
 * routing, the cross-replica registry — was deleted for simplicity; see git
 * history if load ever demands it back.)
 */
export async function resolveSandbox(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const { slots } = opts;

  // Fast path: a live resident sandbox needs no locking.
  const resident = slots.get(slug);
  if (resident?.sandbox && isLive(resident.sandbox)) {
    return resident.sandbox as Sandbox;
  }

  // Serialize per-slug so concurrent cold upgrades don't each spawn a
  // sandbox (duplicate Modal sandboxes, one orphaned) and so a session
  // never attaches a sandbox built from pre-deploy code while a deploy is
  // mutating the same slot (deploy/delete/secret all take this lock too).
  return withSlugLock(slug, async () => {
    const slot = slots.get(slug);
    if (slot?.sandbox) {
      // Re-check under the lock — another waiter may have already rebuilt.
      if (isLive(slot.sandbox)) return slot.sandbox as Sandbox;
      // Dead guest: nothing to drain, and the bundle is unchanged so the
      // caches stay warm — only the sandbox is replaced. Reached when the
      // guest died between the exit notification and its async detach.
      debug("Resident sandbox lost (guest exited); rebuilding", { slug });
      await terminateSlot(slot);
    }
    return rebuildSlot(slug, slot, opts);
  });
}

export type BrokeredSession =
  | { ok: true; sessionUrl: string; guestOrigin: string }
  | { ok: false; status: 404 | 503; cause?: unknown };

/**
 * The session-broker sequence shared by `GET /:slug/client-config` and the
 * plain `/:slug/websocket` upgrade: resolve the slug's live sandbox (booting
 * it on demand) and ask it for its public session URL. One failure taxonomy
 * for both callers — no bundle/sandbox is a 404; a sandbox VM that failed to
 * start is a retryable 503 (the failure hook detaches it, so the next
 * attempt rebuilds).
 *
 * The readiness wait is capped at {@link BROKER_READY_TIMEOUT_MS}, well under
 * the guest's own boot budget: a still-booting sandbox is a retryable 503
 * here, not a two-minute held request. Nothing is torn down on that path —
 * see the constant for why the boot continues and the next call joins it.
 */
export async function brokerSessionUrl(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<BrokeredSession> {
  const sandbox = await resolveSandbox(slug, opts);
  if (!sandbox) return { ok: false, status: 404 };
  // Both resolve off the same readiness promise — no extra wait.
  const readyTimeoutMs = opts.readyTimeoutMs ?? BROKER_READY_TIMEOUT_MS;
  const ready = Promise.all([sandbox.sessionUrl(), sandbox.guestOrigin()]);
  // Contained: on the timeout path nothing is awaiting `ready`, and a boot
  // that fails afterwards must not surface as an unhandled rejection.
  ready.catch(() => undefined);
  try {
    const [sessionUrl, guestOrigin] =
      readyTimeoutMs > 0
        ? await pTimeout(ready, {
            milliseconds: readyTimeoutMs,
            message: `sandbox not ready within ${readyTimeoutMs}ms`,
          })
        : await ready;
    return { ok: true, sessionUrl, guestOrigin };
  } catch (err) {
    // Still booting is not the same as failed to boot, and only the first is
    // worth a quiet line: the failure path already logs (and detaches) via
    // `Sandbox VM failed to start`.
    if (sandbox.alive()) {
      debug("Sandbox still booting; answering 503 while it continues", {
        slug,
        waitedMs: readyTimeoutMs,
      });
    }
    return { ok: false, status: 503, cause: err };
  }
}
