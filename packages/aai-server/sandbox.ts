// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox backed by gVisor OCI containers (Linux) or child processes
 * (macOS dev mode).
 *
 * The host runs `createRuntime()` with VM-backed `executeTool`, giving it
 * the same session/S2S/WebSocket handling as self-hosted mode without
 * duplicating any of that logic.
 *
 * Communication with the guest uses NDJSON over stdio pipes,
 * mediated by the `SandboxHandle` from `sandbox-vm.ts`.
 */

import path from "node:path";
import {
  type AgentRuntime,
  createRuntime,
  type ExecuteTool,
  resolveAllBuiltins,
} from "aai/runtime";
import type { Storage } from "unstorage";
import { agentKvPrefix } from "./constants.ts";
import { type IsolateConfig, ToolCallResponseSchema } from "./rpc-schemas.ts";
import { createSandboxVm } from "./sandbox-vm.ts";
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
  env: Record<string, string>;
  storage: Storage;
  slug: string;
  /** Pre-extracted agent config from CLI build. */
  agentConfig: IsolateConfig;
};

export type Sandbox = AgentRuntime;

// ── Public API ──────────────────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  createSandbox,
};

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, env, storage, slug } = opts;

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
    process.env.GUEST_HARNESS_PATH ??
    path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");

  const sandboxHandle = await createSandboxVm({
    slug,
    workerCode,
    env,
    kvStorage: storage,
    kvPrefix: agentKvPrefix(slug),
    harnessPath,
  });

  // ── Build tool executor from sandbox handle ─────────────────────
  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const raw = await sandboxHandle.conn.sendRequest("tool/execute", {
      name,
      args,
      sessionId: sessionId ?? "",
      messages: messages ?? [],
    });
    // Guest returns { result, state } on success or { error } on failure.
    // Validate the success shape; treat anything else as an error string.
    const parsed = ToolCallResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.result;
    }
    // Guest returned an error object or unexpected shape
    const errMsg =
      typeof raw === "object" && raw !== null && "error" in raw
        ? String((raw as { error: unknown }).error)
        : "Tool execution failed: invalid response from sandbox";
    return errMsg;
  };

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
      ...(config.toolChoice ? { toolChoice: config.toolChoice as import("aai").ToolChoice } : {}),
      ...(config.builtinTools
        ? { builtinTools: config.builtinTools as import("aai").BuiltinTool[] }
        : {}),
    },
    env,
    fetch: safeFetch,
    executeTool,
    toolSchemas: [...config.toolSchemas, ...builtins.schemas],
    toolGuidance: builtins.guidance,
    builtinDefs: builtins.defs,
  });

  console.info("Sandbox initialized", { slug, agent: config.name });

  async function shutdownSandbox(): Promise<void> {
    await sandboxHandle.shutdown();
    await agentRuntime.shutdown();
  }

  // Wrap startSession to notify guest of session cleanup
  const originalStartSession = agentRuntime.startSession.bind(agentRuntime);
  function startSessionWithCleanup(
    ws: Parameters<typeof originalStartSession>[0],
    opts?: Parameters<typeof originalStartSession>[1],
  ): void {
    originalStartSession(ws, {
      ...opts,
      onSessionEnd(sessionId) {
        sandboxHandle.conn.sendNotification("session/end", { sessionId });
        opts?.onSessionEnd?.(sessionId);
      },
    });
  }

  return {
    readyConfig: agentRuntime.readyConfig,
    startSession: startSessionWithCleanup,
    shutdown: shutdownSandbox,
  };
}

// ── Resolve sandbox (slot-based) ────────────────────────────────────────

export async function resolveSandbox(
  slug: string,
  opts: {
    slots: import("./sandbox-slots.ts").SlotCache;
    store: BundleStore;
    storage: Storage;
  },
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

  // Fetch worker code, config, and env in parallel
  const [workerCode, agentConfig, env] = await Promise.all([
    store.getWorkerCode(slug),
    store.getAgentConfig(slug),
    store.getEnv(slug).then((e) => e ?? {}),
  ]);

  if (!(workerCode && agentConfig)) {
    return null;
  }

  const sandbox = await createSandbox({
    workerCode,
    env,
    storage,
    slug,
    agentConfig,
  });

  slot.sandbox = sandbox;
  return sandbox;
}
