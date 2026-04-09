// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox backed by gVisor OCI containers (Linux) or child processes
 * (macOS dev mode).
 *
 * The host runs `createRuntime()` with VM-backed `executeTool` and `hooks`
 * overrides, giving it the same session/S2S/WebSocket handling as self-hosted
 * mode without duplicating any of that logic.
 *
 * Communication with the guest uses NDJSON over stdio pipes,
 * mediated by the `SandboxHandle` from `sandbox-vm.ts`.
 */

import path from "node:path";
import {
  type AgentHookMap,
  type AgentHooks,
  type AgentRuntime,
  createRuntime,
  type ExecuteTool,
  resolveAllBuiltins,
} from "@alexkroman1/aai/host";
import { createHooks } from "hookable";
import type { Storage } from "unstorage";
import { agentKvPrefix } from "./constants.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { TurnConfigResultSchema } from "./rpc-schemas.ts";
import { type AgentMap, isAtCapacity } from "./sandbox-slots.ts";
import { createSandboxVm, type SandboxHandle } from "./sandbox-vm.ts";
import { ssrfSafeFetch } from "./ssrf.ts";
import type { BundleStore } from "./store-types.ts";

// ── Re-exports consumed by orchestrator / handlers / tests ──────────────

export {
  type AgentSlot,
  createSlotCache,
  type SlotCache,
  terminateSlot,
  withSlugLock,
} from "./sandbox-slots.ts";
export type { AgentMetadata } from "./schemas.ts";

// ── Types ───────────────────────────────────────────────────────────────

export type SandboxOptions = {
  workerCode: string;
  apiKey: string;
  agentEnv: Record<string, string>;
  storage: Storage;
  slug: string;
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfig;
};

export type Sandbox = AgentRuntime;

// ── Hook invoker ────────────────────────────────────────────────────────

/**
 * Build a VM-backed hook invoker. Only hooks the agent actually defines
 * are registered, avoiding unnecessary VM calls.
 */
function buildHookInvoker(handle: SandboxHandle, hookFlags: IsolateConfig["hooks"]): AgentHooks {
  const rpc = async (hook: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await handle.conn.sendRequest<{ result?: unknown }>("hook/invoke", {
      hook,
      ...extra,
    });
    return response?.result;
  };

  const hooks = createHooks<AgentHookMap>();
  if (hookFlags.onConnect) {
    hooks.hook("connect", async (sessionId) => {
      await rpc("onConnect", { sessionId });
    });
  }
  if (hookFlags.onDisconnect) {
    hooks.hook("disconnect", async (sessionId) => {
      await rpc("onDisconnect", { sessionId });
    });
  }
  if (hookFlags.onUserTranscript) {
    hooks.hook("userTranscript", async (sessionId, text) => {
      await rpc("onUserTranscript", { sessionId, text });
    });
  }
  if (hookFlags.maxStepsIsFn) {
    hooks.hook("resolveTurnConfig", (async (sessionId: string) => {
      const parsed = TurnConfigResultSchema.parse(await rpc("resolveTurnConfig", { sessionId }));
      if (parsed == null) return null;
      const config: { maxSteps?: number } = {};
      if (parsed.maxSteps != null) config.maxSteps = parsed.maxSteps;
      return config;
      // biome-ignore lint/suspicious/noExplicitAny: hookable void-return constraint requires cast
    }) as any);
  }
  return hooks;
}

// ── Public API ──────────────────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  createSandbox,
};

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, apiKey, agentEnv, storage, slug } = opts;

  const safeFetch: typeof globalThis.fetch = (input, init?) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    return ssrfSafeFetch(url, init ?? {}, globalThis.fetch);
  };

  // ── Resolve config ───────────────────────────────────────────────
  const config = opts.agentConfig;

  // ── Create sandbox VM handle ─────────────────────────────────────
  const harnessPath =
    process.env.GUEST_HARNESS_PATH ?? path.resolve(import.meta.dirname, "dist/guest/harness.mjs");

  const sandboxHandle = await createSandboxVm({
    slug,
    workerCode,
    agentEnv,
    kvStorage: storage,
    kvPrefix: agentKvPrefix(slug),
    harnessPath,
  });

  // ── Build tool executor + hooks from sandbox handle ──────────────
  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const response = await sandboxHandle.conn.sendRequest<{ result?: string }>("tool/execute", {
      name,
      args,
      sessionId: sessionId ?? "",
      messages: [...(messages ?? [])],
    });
    return (response?.result ?? "") as string;
  };

  const hooks = buildHookInvoker(sandboxHandle, config.hooks);

  // ── Assemble runtime ─────────────────────────────────────────────
  const builtins = resolveAllBuiltins(config.builtinTools ?? []);
  const agentRuntime = createRuntime({
    agent: {
      name: config.name,
      systemPrompt: config.systemPrompt,
      greeting: config.greeting ?? "",
      maxSteps: config.maxSteps ?? 5,
      tools: {},
      ...(config.sttPrompt ? { sttPrompt: config.sttPrompt } : {}),
      ...(config.toolChoice
        ? { toolChoice: config.toolChoice as import("@alexkroman1/aai/types").ToolChoice }
        : {}),
      ...(config.builtinTools
        ? { builtinTools: config.builtinTools as import("@alexkroman1/aai/types").BuiltinTool[] }
        : {}),
    },
    env: { ...agentEnv, ASSEMBLYAI_API_KEY: apiKey },
    fetch: safeFetch,
    executeTool,
    hooks,
    toolSchemas: [...config.toolSchemas, ...builtins.schemas],
    toolGuidance: builtins.guidance,
  });

  console.info("Sandbox initialized", { slug, agent: config.name });

  async function shutdownSandbox(): Promise<void> {
    hooks.removeAllHooks();
    await sandboxHandle.shutdown();
    await agentRuntime.shutdown();
  }

  return {
    readyConfig: agentRuntime.readyConfig,
    startSession: agentRuntime.startSession.bind(agentRuntime),
    shutdown: shutdownSandbox,
  };
}

// ── Resolve sandbox (AgentMap-based) ────────────────────────────────────

export async function resolveSandbox(
  slug: string,
  opts: {
    slots: import("./sandbox-slots.ts").SlotCache;
    store: BundleStore;
    storage: Storage;
    agents?: AgentMap;
  },
): Promise<Sandbox | null> {
  // If an AgentMap is provided, use the new VM-based flow.
  // Otherwise fall back to the legacy slot-based flow for backward compat.
  const agents = opts.agents;
  if (agents) {
    return resolveSandboxVm(slug, { agents, store: opts.store, storage: opts.storage });
  }

  // Legacy path: slot-based resolution
  return resolveSandboxLegacy(slug, opts);
}

/**
 * New VM-based sandbox resolution using AgentMap.
 *
 * - If the agent already exists in the map, return its runtime
 * - If not, fetch from bundle store, create sandbox VM, add to map
 * - Track sessions and manage idle timers
 * - Reject when at capacity
 */
async function resolveSandboxVm(
  slug: string,
  opts: { agents: AgentMap; store: BundleStore; storage: Storage },
): Promise<Sandbox | null> {
  const { agents, store, storage } = opts;

  const existing = agents.get(slug);
  if (existing) {
    agents.cancelIdleTimer(slug);
    return existing.sandbox as unknown as Sandbox;
  }

  // Check capacity before creating a new VM
  if (isAtCapacity(agents)) {
    console.warn("VM capacity reached, rejecting new sandbox", { slug });
    return null;
  }

  // Fetch manifest and worker code from bundle store
  const [manifest, workerCode, agentConfig] = await Promise.all([
    store.getManifest(slug),
    store.getWorkerCode(slug),
    store.getAgentConfig(slug),
  ]);

  if (!(manifest && workerCode && agentConfig)) {
    return null;
  }

  // Extract env: platform key stays host-side, agent secrets go to VM
  const env = (await store.getEnv(slug)) ?? {};
  const { ASSEMBLYAI_API_KEY: apiKey = "", ...agentEnv } = env;

  const sandbox = await createSandbox({
    workerCode,
    apiKey,
    agentEnv,
    storage,
    slug,
    agentConfig,
  });

  agents.set(slug, {
    slug,
    sandbox,
    sessions: new Set(),
    idleTimer: null,
  });

  // Start idle timer — will be cancelled when a session connects
  agents.startIdleTimer(slug);

  return sandbox;
}

/**
 * Legacy slot-based resolution. Used when no AgentMap is provided.
 * This preserves backward compatibility with existing orchestrator code.
 */
async function resolveSandboxLegacy(
  slug: string,
  opts: { slots: import("./sandbox-slots.ts").SlotCache; store: BundleStore; storage: Storage },
): Promise<Sandbox | null> {
  const { slots, store, storage } = opts;

  let slot = slots.get(slug);

  if (!slot) {
    const manifest = await store.getManifest(slug);
    if (!manifest) return null;
    slot = {
      slug: manifest.slug,
      keyHash: manifest.credential_hashes[0] ?? "",
    };
    slots.set(slug, slot);
    console.info("Lazy-discovered agent from store", { slug });
  }

  if (slot.sandbox) {
    return slot.sandbox as Sandbox;
  }

  // Fetch worker code and config
  const [workerCode, agentConfig] = await Promise.all([
    store.getWorkerCode(slug),
    store.getAgentConfig(slug),
  ]);

  if (!(workerCode && agentConfig)) {
    return null;
  }

  const env = (await store.getEnv(slug)) ?? {};
  const { ASSEMBLYAI_API_KEY: apiKey = "", ...agentEnv } = env;

  const sandbox = await createSandbox({
    workerCode,
    apiKey,
    agentEnv,
    storage,
    slug,
    agentConfig,
  });

  slot.sandbox = sandbox;
  return sandbox;
}
