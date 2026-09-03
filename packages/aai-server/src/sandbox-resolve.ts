// Copyright 2026 the AAI authors. MIT license.
/**
 * Slot-based sandbox resolution: map a slug to its (possibly freshly built)
 * resident sandbox. Split from sandbox.ts, which owns one sandbox's
 * lifecycle; this module owns the replica's slug→sandbox map and the reads
 * that populate it.
 *
 * Reacting to the map going STALE is sandbox-invalidate.ts
 * (`watchAgentInvalidation`, driven by the agents row's change stream). It
 * imports `loadBundleParts` / `buildSlotSandbox` / `DrainingError` from here,
 * which is why those are exported rather than module-private — they are the
 * seam between resolving a slug and replacing what it resolved to, and both
 * sides must build a sandbox identically.
 */

import type { AgentRecord } from "./agent-store.ts";
import { BROKER_READY_TIMEOUT_MS } from "./constants.ts";
import { createLogger } from "./logger.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import type { SandboxDirectory } from "./sandbox-directory.ts";
import {
  type AgentSlot,
  deleteSlot,
  isLive,
  type SlotCache,
  setSlot,
  terminateSlot,
  withSlugLock,
} from "./sandbox-slots.ts";
import type { WorkerSource } from "./sandbox-vm.ts";
import type { SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("sandbox.resolve");

export type ResolveSandboxOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Named secret storage — read for the agent's own env secrets. */
  secrets?: SecretStore;
  /**
   * How long a broker call waits on a booting sandbox before answering 503.
   * Defaults to {@link BROKER_READY_TIMEOUT_MS}; injectable for tests, which
   * must not spend the real budget to observe the cap.
   */
  readyTimeoutMs?: number;
  /**
   * Fleet-wide sandbox directory (see sandbox-directory.ts): the broker's cold
   * path asks Modal whether some replica is already serving this deploy, and
   * routes there instead of spawning a duplicate. Absent (the subprocess
   * backend, tests) leaves every replica independent — correct for a single
   * process, which has no peers.
   */
  directory?: SandboxDirectory;
  /**
   * True once this replica is shutting down. The broker then refuses to boot
   * a NEW sandbox, answering a retryable 503 instead.
   *
   * Without it, a request landing between "draining flipped" and "process
   * exits" — the window before the platform's proxy has observed the
   * `/health` 503 and stopped routing here — takes the cold path, finds an
   * emptied slot, and spawns a sandbox seconds before the process dies. That
   * guest is then ORPHANED: nothing holds it, no slot references it, and it
   * bills until Modal's idle timeout reclaims it. Rare at
   * `MIN_CONTAINERS=1`, where only a redeploy shuts a replica down; routine
   * at 0, where every quiet stretch does.
   *
   * A LIVE resident is still served while draining — handing back a URL for
   * a guest that already exists orphans nothing, and refusing would break
   * sessions that are about to be perfectly fine (the guests outlive this
   * process by design; see teardown-sandboxes.ts).
   */
  isDraining?: () => boolean;
};

export type BundleParts = {
  worker: WorkerSource;
  env: Record<string, string>;
  /** Harness image the agent was deployed against (per-deploy pinning). */
  imageTag: string | null;
  /** Deploy version off the same row read — what the slot is stamped with. */
  version: number;
};

/**
 * How long a guest has to fetch its own bundle before the signed URL lapses.
 *
 * Sized against the BOOT budget, not the URL's usefulness: the guest fetches
 * within a second of exec, but exec is preceded by sandbox creation and
 * scheduling, and the host waits up to `AGENT_HEALTH_TIMEOUT_MS` (120s) for
 * readiness. A URL that expires inside that window turns a slow SCHEDULE into
 * a boot failure — a failure mode that only appears under Modal capacity
 * pressure, i.e. exactly when it is hardest to read. Five minutes clears it
 * with margin and is still short enough that a leaked URL is worthless by the
 * time anyone could use it; the blob behind it is one immutable, already-
 * public-to-its-own-agent bundle either way.
 */
const WORKER_URL_TTL_SECONDS = 300;

/**
 * Where the guest gets its bundle from: a signed Storage URL it fetches
 * itself, or the bytes read here and shipped into the sandbox.
 *
 * The URL is the production path and the reason this function exists — it
 * takes ~8 MB out of BOTH directions of a cold spawn (Storage → this process,
 * this process → sandbox). The byte path remains for the one case that cannot
 * use it, and it is not a fallback for a failure: the memory blob store (local
 * dev, tests) has no URL to hand out.
 *
 * A signing FAILURE is not caught here: it fails the spawn, like any other.
 */
async function loadWorkerSource(
  slug: string,
  agent: AgentRecord,
  store: BundleStore,
): Promise<WorkerSource | null> {
  const sha256 = agent.worker_hash;
  const url = await store.getWorkerUrl(slug, WORKER_URL_TTL_SECONDS);
  if (url !== null) return { kind: "url", url, sha256 };
  const code = await store.getWorkerCode(slug);
  return code === null ? null : { kind: "inline", code, sha256 };
}

/**
 * Read the slug's stored bundle artifacts, every read that CAN be in flight
 * at once in flight at once. Resolves null when the bundle is incomplete
 * (deleted mid-read). Each read gets a no-op rejection handler immediately so
 * one rejecting early doesn't surface as unhandled while its siblings are
 * still in flight — `Promise.all` still observes the originals.
 *
 * The worker source is the one read that must WAIT: it is chosen from the
 * row's `worker_hash` and `harness_image_tag`, so it cannot start until the
 * row lands. That is not a new round trip — `getWorkerCode` always read the
 * row first internally, and reading it once here means one `agents.get` on a
 * cold cache where there were two.
 */
export function loadBundleParts(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<BundleParts | null> {
  const { store } = opts;
  // The full row — for the worker blob's hash, the pinned harness image tag,
  // and the deploy version. The stored config is NOT read: it is opaque to
  // the host (agent-store.ts).
  const agentP = store.getAgent(slug);
  const workerP = agentP.then((agent) => (agent ? loadWorkerSource(slug, agent, store) : null));
  const envP = store.getEnv(slug).then((e) => e ?? {});
  for (const p of [workerP, agentP, envP]) p.catch(() => undefined);
  return Promise.all([workerP, agentP, envP]).then(([worker, agent, env]) =>
    worker && agent
      ? {
          worker,
          env,
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
  // Shutting down: a sandbox booted now outlives the process with nothing
  // holding it (see `isDraining`). The guard lives at CONSTRUCTION rather than
  // at one request path because there are two — the broker and the change
  // stream's blue-green `handoverSlot`, whose boot easily outlasts the
  // shutdown grace window.
  if (opts.isDraining?.()) throw new DrainingError(slug);
  // The agent's env, as stored, with nothing overlaid.
  //
  // A provisioned `DATABASE_URL` used to be injected LAST here, so enabling
  // storage deterministically selected the platform's database over anything the
  // author had set. The platform provisions none now — durable runs, the run
  // journal and session state are all its own, reached over HTTP — so a
  // `DATABASE_URL` in this env is the AUTHOR's, from their own secrets, and
  // overlaying it would be the platform overriding a value it did not supply.
  const sandbox: Sandbox = createSandbox({
    worker: parts.worker,
    env: parts.env,
    slug,
    // The deploy version is half the fleet-wide sandbox NAME, which is what
    // keeps one deploy to one sandbox platform-wide (sandbox-directory.ts) and
    // still lets a blue-green handover run two versions at once.
    version: parts.version,
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
 *
 * The SLOT goes too, not just its sandbox. An agent-mode guest self-exiting
 * on idle is the normal end of a sandbox's life, and `terminateSlot` only
 * clears the `sandbox` field — so every slug this replica ever brokered left
 * a `{ slug }` shell behind, and the map grew monotonically for the life of
 * the container (`MIN_CONTAINERS=1`, so the floor replica spans every
 * deploy). Deleting is the same rule `rebuildSlot` already applies to a slug
 * with no bundle ("must not leave an empty slot behind") and the reason
 * `_keyed-lock.ts` exists instead of p-lock — a long-lived process must not
 * accumulate one entry per distinct key forever. An empty slot carries no
 * state a rebuild needs: `resolveSandbox` reads the row fresh either way.
 */
export function buildSlotSandbox(
  slug: string,
  parts: BundleParts,
  opts: ResolveSandboxOpts,
): Sandbox {
  return buildSandboxFromParts(slug, parts, opts, (sandbox) => {
    void withSlugLock(slug, async () => {
      const current = opts.slots.get(slug);
      if (current?.sandbox !== sandbox) return;
      await terminateSlot(current);
      // Safe to key-delete: the identity check above ran under this lock, so
      // `current` is still the mapped slot and no successor can have claimed
      // the key. Same pairing the delete-event handler uses.
      deleteSlot(opts.slots, slug);
    });
  });
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
      //
      // NOT gated on `created`: an EXISTING slot that reaches here has no
      // sandbox either (`resolveSandbox` terminated a dead one just above, and
      // a slot mid-rebuild never had one), so the shell it leaves is the same
      // shell for the same reason. It was reachable — a rebuild for a slug
      // whose agent was deleted in the meantime — and permanent, because
      // `reconcileSlug` returns early on `!slot?.sandbox`, so nothing else ever
      // looks at it again. The claim/identity discipline still holds: this runs
      // under the slug lock, and the entry is either the one this call claimed
      // or the one it read under the same lock.
      deleteSlot(slots, slug);
      return null;
    }
    if (created) log.debug("Lazy-discovered agent from store", { slug });

    const sandbox = buildSlotSandbox(slug, parts, opts);

    slot.version = parts.version;
    slot.sandbox = sandbox;
    return sandbox;
  } catch (err) {
    // Same rule as the no-bundle branch above: the slot has no sandbox
    // attached on this path either, so leaving it is leaving a shell.
    deleteSlot(slots, slug);
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
      log.debug("Resident sandbox lost (guest exited); rebuilding", { slug });
      await terminateSlot(slot);
    }
    return rebuildSlot(slug, slot, opts);
  });
}

/**
 * Thrown instead of booting a sandbox while this replica is going away.
 *
 * Its own type so the broker can turn it into a retryable 503 while
 * `handoverSlot` can treat it as "leave the old resident alone" — the two
 * callers want opposite things from the same refusal.
 */
export class DrainingError extends Error {
  constructor(slug: string) {
    super(`replica is draining; refusing to boot a sandbox for ${slug}`);
    this.name = "DrainingError";
  }
}
