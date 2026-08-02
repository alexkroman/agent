// Copyright 2026 the AAI authors. MIT license.
/**
 * Slot-based sandbox resolution: map a slug to its (possibly freshly built)
 * resident sandbox. Split from sandbox.ts, which owns one sandbox's
 * lifecycle; this module owns the replica's slug→sandbox map and its
 * cross-replica invalidation (slug epochs — see platform-epoch.ts).
 */

import type { CloseableDb } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import { type AppDatabases, type AppDbMeta, parseAppDbMeta } from "./app-database.ts";
import { readSlugEpoch, type SlugEpochs } from "./platform-epoch.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { defaultScaleOptions, routeSession, type ScaleOptions } from "./sandbox-scale.ts";
import {
  type AgentSlot,
  attachSandbox,
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
  pool?: SandboxPool;
  /**
   * Cross-replica invalidation epochs (see platform-epoch.ts). Absent means
   * resident sandboxes are only invalidated by this replica's own mutations
   * — the pre-split, pre-multi-replica behavior.
   */
  slugEpochs?: SlugEpochs;
  /**
   * Horizontal scaling policy (see sandbox-scale.ts). Defaults from
   * SANDBOX_MAX_SESSIONS / SANDBOX_MAX_REPLICAS; scaling is off when the
   * env leaves those unset.
   */
  scale?: ScaleOptions;
};

type BundleParts = {
  workerCode: string;
  env: Record<string, string>;
  agentConfig: IsolateConfig;
  appDbMeta: AppDbMeta | null;
};

/**
 * Read the slug's stored bundle artifacts, all reads in flight at once.
 * Resolves null when the bundle is incomplete (deleted mid-read). Each read
 * gets a no-op rejection handler immediately: a caller that discards the
 * whole promise while reads are still in flight (manifest miss) must not
 * surface a late rejection as unhandled — `Promise.all` still observes the
 * originals.
 */
function loadBundleParts(slug: string, opts: ResolveSandboxOpts): Promise<BundleParts | null> {
  const { store } = opts;
  const workerCodeP = store.getWorkerCode(slug);
  const agentConfigP = store.getAgentConfig(slug);
  const envP = store.getEnv(slug).then((e) => e ?? {});
  // Storage ("app db") credentials, when the platform can open them.
  const appDbMetaP = readAppDbMeta(slug, opts);
  for (const p of [workerCodeP, agentConfigP, envP, appDbMetaP]) p.catch(() => undefined);
  return Promise.all([workerCodeP, agentConfigP, envP, appDbMetaP]).then(
    ([workerCode, agentConfig, env, appDbMeta]) =>
      workerCode && agentConfig ? { workerCode, env, agentConfig, appDbMeta } : null,
  );
}

/**
 * Build one sandbox from loaded bundle parts. `onVmFailed` is the caller's
 * poisoned-sandbox detach: a rejected vmReady leaves the sandbox permanently
 * broken (every tool call fails) while live traffic keeps clearing its idle
 * timer, so it would never self-heal — the callback must detach it from
 * wherever it was installed so the next connection rebuilds. (createSandbox
 * returns synchronously and the caller installs the sandbox in the same
 * task, so the async failure callback can only fire after the install.)
 */
function buildSandboxFromParts(
  slug: string,
  parts: BundleParts,
  opts: ResolveSandboxOpts,
  onSandboxLost: (sandbox: Sandbox) => void,
): Sandbox {
  // Open the app db here — cheap, postgres connects on first query; the
  // sandbox owns the handle and closes it on shutdown.
  const db: CloseableDb | undefined =
    parts.appDbMeta && opts.appDb ? opts.appDb.open(parts.appDbMeta) : undefined;
  const sandbox: Sandbox = createSandbox({
    workerCode: parts.workerCode,
    env: parts.env,
    slug,
    agentConfig: parts.agentConfig,
    ...(db && { db }),
    ...(opts.pool && { pool: opts.pool }),
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
 * Build one overflow replica for the broker's scale-out (sandbox-scale.ts).
 * A failed replica VM detaches only itself — the primary and its siblings
 * keep serving.
 */
async function spawnReplicaSandbox(
  slug: string,
  slot: AgentSlot,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const parts = await loadBundleParts(slug, opts);
  if (!parts) return null;
  return buildSandboxFromParts(slug, parts, opts, (sandbox) => {
    void withSlugLock(slug, async () => {
      if (opts.slots.get(slug) !== slot) return;
      const idx = slot.replicas?.indexOf(sandbox) ?? -1;
      if (idx === -1) return;
      slot.replicas?.splice(idx, 1);
      await sandbox.shutdown().catch(() => undefined);
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
 * Is the resident sandbox still current? A deploy/secret/storage mutation
 * on another replica — or the studio service — bumps the slug's epoch; a
 * resident built at an older epoch must be torn down and rebuilt from the
 * freshly stored bundle. Degrades to "current" when the epoch store is
 * absent (dev) or unreadable (a session start must not die on the
 * invalidation check).
 */
async function residentIsCurrent(slot: AgentSlot, opts: ResolveSandboxOpts): Promise<boolean> {
  if (!opts.slugEpochs) return true;
  const built = slot.epoch ?? 0;
  return (await readSlugEpoch(opts.slugEpochs, slot.slug, built)) === built;
}

/** Build (and attach) a fresh sandbox for `slot`; null when the slug has no bundle. */
async function rebuildSlot(
  slug: string,
  existingSlot: AgentSlot | undefined,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const { slots, store } = opts;

  // Record the epoch BEFORE reading artifacts: a mutation landing between
  // this read and the artifact reads bumps the epoch past what we store on
  // the slot, so the next session start sees the mismatch and rebuilds —
  // the race can only cause one extra rebuild, never a stale sandbox that
  // reads as current.
  const builtAtEpoch = opts.slugEpochs ? await readSlugEpoch(opts.slugEpochs, slug, 0) : 0;

  // Kick off the bundle reads now so a cold miss doesn't serialize the
  // manifest read ahead of them (one extra storage RTT per
  // first-session-per-slug-per-replica). The no-op rejection handler covers
  // the manifest-miss path discarding it while reads are still in flight.
  const partsP = loadBundleParts(slug, opts);
  partsP.catch(() => undefined);

  let slot = existingSlot;
  if (!slot) {
    const manifest = await store.getManifest(slug);
    if (!manifest) return null;
    slot = { slug: manifest.slug };
    setSlot(slots, slot);
    debug("Lazy-discovered agent from store", { slug });
  }

  const parts = await partsP;
  if (!parts) {
    return null;
  }

  const sandbox = buildSlotSandbox(slug, parts, opts);

  slot.epoch = builtAtEpoch;
  attachSandbox(slots, slot, sandbox);
  return sandbox;
}

/** Map a slug to its (possibly freshly built) primary resident sandbox. */
async function resolvePrimary(slug: string, opts: ResolveSandboxOpts): Promise<Sandbox | null> {
  const { slots, store } = opts;

  // Fast path: a current, live resident sandbox needs no locking.
  const resident = slots.get(slug);
  if (resident?.sandbox && isLive(resident.sandbox) && (await residentIsCurrent(resident, opts))) {
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
      const live = isLive(slot.sandbox);
      if (live && (await residentIsCurrent(slot, opts))) return slot.sandbox as Sandbox;
      if (live) {
        // Stale: a mutation landed elsewhere. Tear down the old sandbox and
        // drop this replica's bundle caches so the rebuild below reads the
        // freshly stored artifacts, not cached pre-mutation ones. Sessions
        // still live on the old sandbox get their sockets closed by the
        // teardown; clients re-broker via client-config and reconnect onto
        // the rebuilt sandbox's tunnel.
        debug("Resident sandbox stale (slug epoch advanced); rebuilding", { slug });
        store.invalidate?.(slug);
      } else {
        // Dead guest: the bundle is unchanged, so the caches stay warm —
        // only the sandbox is replaced. Reached when the guest died between
        // the exit notification and its asynchronous detach.
        debug("Resident sandbox lost (guest exited); rebuilding", { slug });
      }
      await terminateSlot(slot);
    }
    return rebuildSlot(slug, slot, opts);
  });
}

/**
 * Resolve the sandbox this session should connect to. Without a scaling
 * policy that is the slug's one resident sandbox; with one (see
 * sandbox-scale.ts) it is the least-loaded of the slug's replicas, scaling
 * out when all are at session capacity.
 */
export async function resolveSandbox(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const sandbox = await resolvePrimary(slug, opts);
  if (!sandbox) return null;
  const scale = opts.scale ?? defaultScaleOptions();
  if (!scale) return sandbox;
  const slot = opts.slots.get(slug);
  // Route only when the resolved sandbox is still the slot's primary — a
  // mutation racing this resolve heals via the client's next re-broker.
  if (!slot || slot.sandbox !== sandbox) return sandbox;
  return routeSession({
    slug,
    slots: opts.slots,
    slot,
    primary: sandbox,
    scale,
    spawnReplica: () => spawnReplicaSandbox(slug, slot, opts),
  });
}
