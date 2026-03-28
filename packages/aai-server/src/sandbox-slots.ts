// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot lifecycle — lazy-loading, idle eviction, and slot registry.
 */

import type { Storage } from "unstorage";
import type { AgentMetadata } from "./_schemas.ts";
import type { BundleStore } from "./bundle-store.ts";
import { DEFAULT_SLOT_IDLE_MS } from "./constants.ts";
import type { Sandbox, SandboxOptions } from "./sandbox.ts";

// ── Agent slot lifecycle ─────────────────────────────────────────────────

let IDLE_MS = DEFAULT_SLOT_IDLE_MS;

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: Sandbox;
  initializing?: Promise<Sandbox>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Set while a sandbox is being terminated. Prevents ensureAgent from
   *  returning a sandbox in a half-terminated state. */
  terminating?: Promise<void>;
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
  slot.idleTimer = setTimeout(() => {
    if (!slot.sandbox) return;
    console.info("Evicting idle sandbox", { slug: slot.slug });
    // Mark as terminating before starting async cleanup to prevent
    // ensureAgent from returning a sandbox that is being torn down.
    const sb = slot.sandbox;
    delete slot.sandbox;
    delete slot.idleTimer;
    slot.terminating = sb
      .terminate()
      .catch((err) => {
        console.warn("Idle sandbox terminate failed:", { slug: slot.slug, error: err });
      })
      .finally(() => {
        delete slot.terminating;
      });
  }, IDLE_MS);
}

export async function ensureAgent(slot: AgentSlot, opts: EnsureOpts): Promise<Sandbox> {
  // If a previous sandbox is being terminated, wait for it to finish
  // before checking or creating a new one. Loop in case a new
  // termination starts between awaiting and re-checking.
  // biome-ignore lint/nursery/noMisusedPromises: checking nullability, not truthiness
  while (slot.terminating) {
    await slot.terminating;
  }

  if (slot.sandbox) {
    resetIdleTimer(slot);
    return slot.sandbox;
  }
  // biome-ignore lint/nursery/noMisusedPromises: checking nullability, not truthiness
  if (slot.initializing) return slot.initializing;

  const t0 = performance.now();
  slot.initializing = spawnAgent(slot, opts)
    .then((sandbox) => {
      delete slot.initializing;
      resetIdleTimer(slot);
      console.info("Agent sandbox ready", {
        slug: slot.slug,
        durationMs: Math.round(performance.now() - t0),
      });
      return sandbox;
    })
    .catch((err: unknown) => {
      delete slot.initializing;
      throw err;
    });

  return slot.initializing;
}

/**
 * Best-effort terminate a slot's sandbox (running or initializing) and clear
 * sandbox state. Errors are logged but never thrown.
 */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  const { slug } = slot;
  if (slot.sandbox) {
    await slot.sandbox.terminate().catch((err: unknown) => {
      console.warn("Failed to terminate sandbox", { slug, error: String(err) });
    });
    // biome-ignore lint/nursery/noMisusedPromises: checking nullability, not truthiness
  } else if (slot.initializing) {
    await slot.initializing
      .then((sb) => sb.terminate())
      .catch((err: unknown) => {
        console.warn("Failed to terminate initializing sandbox", { slug, error: String(err) });
      });
  }
  delete slot.sandbox;
  delete slot.initializing;
}

export function registerSlot(slots: Map<string, AgentSlot>, metadata: AgentMetadata): void {
  slots.set(metadata.slug, {
    slug: metadata.slug,
    keyHash: metadata.credential_hashes[0] ?? "",
  });
}

export async function resolveSandbox(
  slug: string,
  opts: {
    createSandbox: (opts: SandboxOptions) => Promise<Sandbox>;
    slots: Map<string, AgentSlot>;
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

  return await ensureAgent(slot, {
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
  });
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
