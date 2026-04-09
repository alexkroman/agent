// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot lifecycle — lazy-loading, RSS-based eviction, and slot registry.
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
import type { IsolateConfig } from "./rpc-schemas.ts";
import type { Sandbox, SandboxOptions } from "./sandbox.ts";
import type { AgentMetadata } from "./schemas.ts";
import type { BundleStore } from "./store-types.ts";

/** Thrown when the server's RSS exceeds the memory limit and no slots can be evicted. */
export class MemoryPressureError extends Error {
  constructor(rssMb: number, maxMb: number) {
    super(`Memory pressure: RSS ${rssMb.toFixed(0)}MB exceeds ${maxMb}MB`);
    this.name = "MemoryPressureError";
  }
}

// ── LRU slot cache ─────────────────────────────────────────────────────

export type SlotCache = LRUCache<string, AgentSlot>;

/**
 * High watermark for the LRU cache. Not a capacity constraint — RSS
 * pressure is the real admission gate. This just prevents unbounded
 * Map growth.
 */
const LRU_MAX = 500;

/**
 * Create an LRU cache for agent slots.
 *
 * The `dispose` callback shuts down evicted slots' sandboxes.
 *
 * We only shut down on `"evict"` (LRU capacity eviction). On `"set"` the
 * caller manages the lifecycle (e.g., redeploy terminates old sandbox
 * explicitly). On `"delete"` the caller also handles it (e.g., delete endpoint).
 */
export function createSlotCache(): SlotCache {
  return new LRUCache<string, AgentSlot>({
    max: LRU_MAX,
    dispose: (slot, _key, reason) => {
      if (reason !== "evict") return;
      const sb = slot.sandbox;
      if (!sb) return;
      delete slot.sandbox;
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

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: Sandbox;
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
  /** Pre-extracted agent config from build time. */
  getAgentConfig: () => Promise<IsolateConfig | null>;
};

async function spawnAgent(slot: AgentSlot, opts: EnsureOpts): Promise<Sandbox> {
  const { slug } = slot;
  console.info("Loading agent sandbox", { slug });

  const [code, apiKey, agentEnv, agentConfig] = await Promise.all([
    opts.getWorkerCode(slug),
    opts.getApiKey(),
    opts.getAgentEnv(),
    opts.getAgentConfig(),
  ]);
  if (!code) throw new Error(`Worker code not found for ${slug}`);
  if (!agentConfig) throw new Error(`Agent config not found for ${slug}`);
  const sandbox = await opts.createSandbox({
    workerCode: code,
    apiKey,
    agentEnv,
    storage: opts.storage,
    slug: opts.slug,
    agentConfig,
  });
  slot.sandbox = sandbox;
  return sandbox;
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

/**
 * Evict the coldest slot to relieve memory pressure.
 * `slots.pop()` removes the LRU entry and fires the dispose callback
 * which shuts down the sandbox.
 */
function evictColdest(slots: SlotCache): boolean {
  const evicted = slots.pop();
  if (!evicted) return false;
  console.info("Evicted coldest slot for memory pressure", { slug: evicted.slug });
  return true;
}

export async function ensureAgent(
  slot: AgentSlot,
  opts: EnsureOpts,
  slots?: SlotCache,
): Promise<Sandbox> {
  const release = await slotLock(slot.slug);
  try {
    if (slot.sandbox) {
      return slot.sandbox;
    }

    // RSS-based admission: evict coldest slots until under the limit
    // TODO: remove with secure-exec (Task 7 rewrites this file)
    const maxRssMb = Number(process.env.MAX_RSS_MB) || 1740;
    while (rssMb() > maxRssMb) {
      if (!(slots && slots.size > 0 && evictColdest(slots))) {
        throw new MemoryPressureError(rssMb(), maxRssMb);
      }
    }

    const t0 = performance.now();
    const sandbox = await spawnAgent(slot, opts);
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
      getAgentConfig: () => opts.store.getAgentConfig(slug),
    },
    opts.slots,
  );
}
