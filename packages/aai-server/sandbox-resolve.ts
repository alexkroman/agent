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
};

/**
 * Build the slot's sandbox from its loaded bundle parts, wiring the
 * poisoned-sandbox detach: a rejected vmReady leaves the sandbox permanently
 * broken (every tool call fails) while live traffic keeps clearing its idle
 * timer, so it would never self-heal. Detach it so the next connection
 * rebuilds — identity-checked and under the slug lock so a deploy/delete
 * that already replaced the slot is never raced. (createSandbox returns
 * synchronously and the caller's attachSandbox runs in the same task, so the
 * async failure callback can only fire after the attach.)
 */
function buildSlotSandbox(
  slug: string,
  parts: {
    workerCode: string;
    env: Record<string, string>;
    agentConfig: IsolateConfig;
    appDbMeta: AppDbMeta | null;
  },
  opts: ResolveSandboxOpts,
): Sandbox {
  // Open the app db here — cheap, postgres connects on first query; the
  // sandbox owns the handle and closes it on shutdown.
  const db: CloseableDb | undefined =
    parts.appDbMeta && opts.appDb ? opts.appDb.open(parts.appDbMeta) : undefined;
  const sandbox = createSandbox({
    workerCode: parts.workerCode,
    env: parts.env,
    slug,
    agentConfig: parts.agentConfig,
    ...(db && { db }),
    ...(opts.pool && { pool: opts.pool }),
    onVmFailed: () => {
      void withSlugLock(slug, async () => {
        const current = opts.slots.get(slug);
        if (current?.sandbox === sandbox) await terminateSlot(current);
      });
    },
  });
  return sandbox;
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
  // first-session-per-slug-per-replica). Each gets a no-op rejection
  // handler immediately: on a manifest miss the trio is discarded while
  // possibly still in flight, and a late rejection must not surface as an
  // unhandled rejection. `Promise.all` below still observes the originals.
  const workerCodeP = store.getWorkerCode(slug);
  const agentConfigP = store.getAgentConfig(slug);
  const envP = store.getEnv(slug).then((e) => e ?? {});
  // Storage ("app db") credentials, when the platform can open them.
  const appDbMetaP = readAppDbMeta(slug, opts);
  for (const p of [workerCodeP, agentConfigP, envP, appDbMetaP]) p.catch(() => undefined);

  let slot = existingSlot;
  if (!slot) {
    const manifest = await store.getManifest(slug);
    if (!manifest) return null;
    slot = { slug: manifest.slug };
    setSlot(slots, slot);
    debug("Lazy-discovered agent from store", { slug });
  }

  const [workerCode, agentConfig, env, appDbMeta] = await Promise.all([
    workerCodeP,
    agentConfigP,
    envP,
    appDbMetaP,
  ]);

  if (!(workerCode && agentConfig)) {
    return null;
  }

  const sandbox = buildSlotSandbox(slug, { workerCode, env, agentConfig, appDbMeta }, opts);

  slot.epoch = builtAtEpoch;
  attachSandbox(slots, slot, sandbox);
  return sandbox;
}

export async function resolveSandbox(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<Sandbox | null> {
  const { slots, store } = opts;

  // Fast path: a current resident sandbox needs no locking.
  const resident = slots.get(slug);
  if (resident?.sandbox && (await residentIsCurrent(resident, opts))) {
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
      if (await residentIsCurrent(slot, opts)) return slot.sandbox as Sandbox;
      // Stale: a mutation landed elsewhere. Tear down the old sandbox and
      // drop this replica's bundle caches so the rebuild below reads the
      // freshly stored artifacts, not cached pre-mutation ones. Sessions
      // still live on the old sandbox get their sockets closed by the
      // teardown; clients re-broker via client-config and reconnect onto
      // the rebuilt sandbox's tunnel.
      debug("Resident sandbox stale (slug epoch advanced); rebuilding", { slug });
      await terminateSlot(slot);
      store.invalidate?.(slug);
    }
    return rebuildSlot(slug, slot, opts);
  });
}
