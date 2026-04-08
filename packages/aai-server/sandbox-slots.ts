// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot lifecycle — lazy-loading, idle eviction, and slot registry.
 *
 * Two per-slug lock layers, both backed by p-lock:
 *
 * - `slotLock` serializes sandbox spawn / eviction / terminate so a single
 *   slot never has two sandboxes alive at the same time.
 * - `apiLock` serializes deploy / delete API calls so concurrent requests
 *   for the same slug don't corrupt bundle state.
 *
 * These are separate instances because deploy acquires `apiLock` and then
 * calls `terminateSlot` (which acquires `slotLock`). A single instance
 * would deadlock.
 */

import { LRUCache } from "lru-cache";
import { getLock } from "p-lock";
import type { Storage } from "unstorage";
import { DEFAULT_SLOT_IDLE_MS, MAX_RSS_MB, MAX_SLOTS } from "./constants.ts";
import type { Sandbox, SandboxOptions } from "./sandbox.ts";
import type { AgentMetadata } from "./schemas.ts";
import type { BundleStore } from "./store-types.ts";

/** Thrown when the active sandbox slot count has reached MAX_SLOTS. */
export class SlotCapacityError extends Error {
  constructor(activeCount: number, max: number) {
    super(`Slot capacity reached: ${activeCount}/${max} active slots`);
    this.name = "SlotCapacityError";
  }
}

/** Thrown when the server's RSS exceeds MAX_RSS_MB. */
export class MemoryPressureError extends Error {
  constructor(rssMb: number, maxMb: number) {
    super(`Memory pressure: RSS ${rssMb.toFixed(0)}MB exceeds ${maxMb}MB`);
    this.name = "MemoryPressureError";
  }
}

// ── LRU slot cache ─────────────────────────────────────────────────────

export type SlotCache = LRUCache<string, AgentSlot>;

/**
 * Create an LRU cache for agent slots.
 *
 * When the cache reaches `MAX_SLOTS`, the least-recently-used slot is evicted
 * automatically. The `dispose` callback shuts down the evicted slot's sandbox.
 *
 * We only shut down on `"evict"` (LRU capacity eviction). On `"set"` the
 * caller manages the lifecycle (e.g., redeploy terminates old sandbox
 * explicitly). On `"delete"` the caller also handles it (e.g., delete endpoint).
 */
export function createSlotCache(): SlotCache {
  return new LRUCache<string, AgentSlot>({
    max: MAX_SLOTS,
    dispose: (slot, _key, reason) => {
      if (reason !== "evict") return;
      const sb = slot.sandbox;
      if (!sb) return;
      delete slot.sandbox;
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer);
        delete slot.idleTimer;
      }
      slot._idleAc?.abort();
      delete slot._idleAc;
      sb.shutdown().catch((err) => {
        console.warn("LRU eviction sandbox shutdown failed:", {
          slug: slot.slug,
          error: err,
        });
      });
    },
  });
}

// ── Locks ───────────────────────────────────────────────────────────────

const slotLock = getLock();
const apiLock = getLock();

/** Serialize deploy/delete API calls for the same slug. */
export const withSlugLock = <T>(slug: string, fn: () => Promise<T>): Promise<T> =>
  apiLock(slug).then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });

// ── Agent slot lifecycle ─────────────────────────────────────────────────

let IDLE_MS = DEFAULT_SLOT_IDLE_MS;

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: Sandbox;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Aborted when the idle timer is reset, cancelling any in-flight eviction. */
  _idleAc?: AbortController;
};

type EnsureOpts = {
  createSandbox: (opts: SandboxOptions) => Promise<Sandbox>;
  getWorkerCode: (slug: string) => Promise<string | null>;
  storage: Storage;
  slug: string;
  /** Platform API key (e.g. AssemblyAI) — host-only, never enters the isolate. */
  getApiKey: () => Promise<string>;
  /** Agent-defined secrets — forwarded to the isolate. */
  getAgentEnv: () => Promise<Record<string, string>>;
};

async function spawnAgent(slot: AgentSlot, opts: EnsureOpts): Promise<Sandbox> {
  const { slug } = slot;
  console.info("Loading agent sandbox", { slug });

  const code = await opts.getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);

  const [apiKey, agentEnv] = await Promise.all([opts.getApiKey(), opts.getAgentEnv()]);
  const sandbox = await opts.createSandbox({
    workerCode: code,
    apiKey,
    agentEnv,
    storage: opts.storage,
    slug: opts.slug,
  });
  slot.sandbox = sandbox;
  return sandbox;
}

function resetIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot._idleAc?.abort();
  slot._idleAc = new AbortController();
  const ac = slot._idleAc;
  slot.idleTimer = setTimeout(() => {
    void evictSlot(slot, ac.signal);
  }, IDLE_MS);
}

async function evictSlot(slot: AgentSlot, signal: AbortSignal): Promise<void> {
  const release = await slotLock(slot.slug);
  try {
    if (signal.aborted || !slot.sandbox) return;
    console.info("Evicting idle sandbox", { slug: slot.slug });
    const sb = slot.sandbox;
    delete slot.sandbox;
    delete slot.idleTimer;
    delete slot._idleAc;
    await sb.shutdown().catch((err) => {
      console.warn("Idle sandbox shutdown failed:", { slug: slot.slug, error: err });
    });
  } finally {
    release();
  }
}

export async function ensureAgent(
  slot: AgentSlot,
  opts: EnsureOpts,
  _slots?: SlotCache,
): Promise<Sandbox> {
  const release = await slotLock(slot.slug);
  try {
    if (slot.sandbox) {
      resetIdleTimer(slot);
      return slot.sandbox;
    }

    // Capacity is handled by the LRU cache — it auto-evicts the
    // least-recently-used slot when `max` is reached on `set()`.

    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    if (rssMb > MAX_RSS_MB) {
      throw new MemoryPressureError(rssMb, MAX_RSS_MB);
    }

    const t0 = performance.now();
    const sandbox = await spawnAgent(slot, opts);
    resetIdleTimer(slot);
    console.info("Agent sandbox ready", {
      slug: slot.slug,
      durationMs: Math.round(performance.now() - t0),
    });
    return sandbox;
  } finally {
    release();
  }
}

/**
 * Best-effort terminate a slot's sandbox and clear sandbox state.
 * Acquires the per-slug slot lock so it never races with ensureAgent.
 * Errors are logged but never thrown.
 */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  const release = await slotLock(slot.slug);
  try {
    const { slug } = slot;
    if (slot.sandbox) {
      const sb = slot.sandbox;
      delete slot.sandbox;
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer);
        delete slot.idleTimer;
      }
      slot._idleAc?.abort();
      delete slot._idleAc;
      await sb.shutdown().catch((err: unknown) => {
        console.warn("Failed to shut down sandbox", { slug, error: String(err) });
      });
    }
  } finally {
    release();
  }
}

export function registerSlot(slots: SlotCache, metadata: AgentMetadata): void {
  slots.set(metadata.slug, {
    slug: metadata.slug,
    keyHash: metadata.credential_hashes[0] ?? "",
  });
}

export async function resolveSandbox(
  slug: string,
  opts: {
    createSandbox: (opts: SandboxOptions) => Promise<Sandbox>;
    slots: SlotCache;
    store: BundleStore;
    storage: Storage;
  },
): Promise<Sandbox | null> {
  let slot = opts.slots.get(slug);

  if (!slot) {
    const manifest = await opts.store.getManifest(slug);
    if (!manifest) return null;
    registerSlot(opts.slots, manifest);
    // biome-ignore lint/style/noNonNullAssertion: just registered above
    slot = opts.slots.get(slug)!;
    console.info("Lazy-discovered agent from store", { slug });
  }

  const envPromise = opts.store.getEnv(slug);

  return await ensureAgent(
    slot,
    {
      createSandbox: opts.createSandbox,
      getWorkerCode: (s: string) => opts.store.getWorkerCode(s),
      storage: opts.storage,
      slug,
      getApiKey: async () => {
        const env = await envPromise;
        return env?.ASSEMBLYAI_API_KEY ?? "";
      },
      getAgentEnv: async () => {
        const env = await envPromise;
        if (!env) return {};
        // Only forward agent-defined secrets; platform keys stay host-side
        const { ASSEMBLYAI_API_KEY: _, ...agentEnv } = env;
        return agentEnv;
      },
    },
    opts.slots,
  );
}

/**
 * Pre-boot a sandbox for the given slug so it's ready for the first connection.
 * Best-effort — logs warning and returns if slug doesn't exist or creation fails.
 */
export async function warmAgent(
  slug: string,
  opts: {
    createSandbox: (o: SandboxOptions) => Promise<Sandbox>;
    slots: SlotCache;
    store: BundleStore;
    storage: Storage;
  },
): Promise<void> {
  try {
    await resolveSandbox(slug, opts);
  } catch (err) {
    console.warn("Warm-up failed:", { slug, error: String(err) });
  }
}

/** @internal Exposed for tests. */
export const _slotInternals = {
  get IDLE_MS() {
    return IDLE_MS;
  },
  set IDLE_MS(ms: number) {
    IDLE_MS = ms;
  },
  resetIdleTimer,
};
