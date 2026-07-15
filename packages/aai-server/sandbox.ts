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

import type { BuiltinTool, Kv, ToolChoice } from "@alexkroman1/aai";
import { DEFAULT_MAX_STEPS, errorMessage, toolError } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import {
  type AgentRuntime,
  createMemoryVector,
  createRuntime,
  createUnstorageKv,
  type ExecuteTool,
  resolveAllBuiltins,
  resolveKv,
  resolveVector,
  type Vector,
} from "@alexkroman1/aai/runtime";
import type { Storage } from "unstorage";
import { debug } from "./_debug-log.ts";
import {
  agentKvPrefix,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  resolveHarnessPath,
} from "./constants.ts";
import { type IsolateConfig, ToolCallResponseSchema } from "./rpc-schemas.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { attachSandbox, setSlot, withSlugLock } from "./sandbox-slots.ts";
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
  /** Optional pre-warmed harness pool for faster cold starts. */
  pool?: SandboxPool;
  /**
   * Factory that creates the platform-default Vector for a given agent slug.
   * Used when the agent config does not declare a `vector` provider.
   * If omitted, falls back to an in-memory vector store.
   */
  defaultVector?: (slug: string) => Vector;
};

export type Sandbox = AgentRuntime;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Resolve the KV store an agent gets: its declared `kv:` provider (BYO,
 * resolved with the agent's env) or the platform default (unstorage,
 * prefixed per slug). Single source of truth for the sandbox and the
 * owner HTTP KV routes.
 */
export function resolveAgentKv(
  storage: Storage,
  slug: string,
  config: Pick<IsolateConfig, "kv"> | null,
  env: Record<string, string>,
): Kv {
  return config?.kv
    ? resolveKv(config.kv, env, agentKvPrefix(slug))
    : createUnstorageKv({ storage, prefix: agentKvPrefix(slug) });
}

/**
 * Resolve the Vector store an agent gets: its declared `vector:` provider
 * or the platform default factory (in-memory when none is supplied).
 */
export function resolveAgentVector(
  slug: string,
  config: Pick<IsolateConfig, "vector"> | null,
  env: Record<string, string>,
  defaultVector?: (slug: string) => Vector,
): Vector {
  if (config?.vector) return resolveVector(config.vector, env, slug);
  return defaultVector ? defaultVector(slug) : createMemoryVector({ namespace: slug });
}

export function createSandbox(opts: SandboxOptions): Sandbox {
  const { workerCode, env, storage, slug } = opts;

  const safeFetch: typeof globalThis.fetch = (input, init?) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    return ssrfSafeFetch(url, init ?? {}, globalThis.fetch);
  };

  const config = opts.agentConfig;

  const harnessPath = resolveHarnessPath();

  const kv: Kv = resolveAgentKv(storage, slug, config, env);
  const vector: Vector = resolveAgentVector(slug, config, env, opts.defaultVector);

  const vmReady = createSandboxVm(
    {
      slug,
      workerCode,
      env,
      kv,
      vector,
      harnessPath,
      allowedHosts: config.allowedHosts ?? [],
    },
    opts.pool,
  );

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    let sandboxHandle: Awaited<typeof vmReady>;
    try {
      sandboxHandle = await vmReady;
    } catch (err: unknown) {
      return toolError(`Sandbox failed to start: ${errorMessage(err)}`);
    }
    const raw = await sandboxHandle.conn.sendRequest("tool/execute", {
      name,
      args,
      sessionId: sessionId ?? "",
      messages: messages ?? [],
    });
    const parsed = ToolCallResponseSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.result;
    }
    if (typeof raw === "object" && raw !== null && "error" in raw) {
      return String((raw as { error: unknown }).error);
    }
    return "Tool execution failed: invalid response from sandbox";
  };

  const builtins = resolveAllBuiltins(config.builtinTools ?? [], { fetch: safeFetch });
  const agentRuntime = createRuntime({
    agent: {
      name: config.name,
      systemPrompt: config.systemPrompt,
      greeting: config.greeting ?? "",
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
      tools: {},
      ...(config.sttPrompt ? { sttPrompt: config.sttPrompt } : {}),
      ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
      ...(config.toolChoice ? { toolChoice: config.toolChoice satisfies ToolChoice } : {}),
      ...(config.builtinTools ? { builtinTools: config.builtinTools as BuiltinTool[] } : {}),
      ...(config.s2s ? { s2s: config.s2s } : {}),
    },
    env,
    fetch: safeFetch,
    executeTool,
    toolSchemas: [...config.toolSchemas, ...builtins.schemas],
    toolGuidance: builtins.guidance,
    builtinDefs: builtins.defs,
    ...(config.mode === "pipeline" && config.stt && config.llm && config.tts
      ? { stt: config.stt, llm: config.llm, tts: config.tts }
      : {}),
  });

  const sessionSinks = new Map<string, ClientSink>();

  vmReady
    .then((handle) => {
      handle.conn.onNotification("client/send", (raw: unknown) => {
        const params = raw as { sessionId: string; event: string; data: unknown };
        if (typeof params.sessionId !== "string" || typeof params.event !== "string") return;
        if (params.event.length > MAX_CLIENT_EVENT_NAME_LENGTH) return;
        // `data` may be undefined (event sent with no payload) — JSON.stringify
        // returns undefined for it, so guard before reading `.length`.
        const serializedData = JSON.stringify(params.data ?? null);
        if (serializedData.length > MAX_CLIENT_EVENT_PAYLOAD_BYTES) return;
        const sink = sessionSinks.get(params.sessionId);
        if (sink?.open) {
          sink.event({ type: "custom_event", event: params.event, data: params.data });
        }
      });
      debug("Sandbox ready", { slug, agent: config.name });
    })
    .catch((err: unknown) => {
      console.error("Sandbox VM failed to start", { slug, error: errorMessage(err) });
    });

  debug("Sandbox initializing", { slug, agent: config.name });

  async function shutdownSandbox(): Promise<void> {
    sessionSinks.clear();
    try {
      const handle = await vmReady;
      await handle.shutdown();
    } catch {
      // VM failed to start or already shut down
    }
    await agentRuntime.shutdown();
  }

  const originalStartSession = agentRuntime.startSession.bind(agentRuntime);
  function startSessionWithCleanup(
    ws: Parameters<typeof originalStartSession>[0],
    opts?: Parameters<typeof originalStartSession>[1],
  ): void {
    originalStartSession(ws, {
      ...opts,
      onSinkCreated(sessionId, sink) {
        sessionSinks.set(sessionId, sink);
        opts?.onSinkCreated?.(sessionId, sink);
      },
      onSessionEnd(sessionId) {
        sessionSinks.delete(sessionId);
        vmReady
          .then((handle) => handle.conn.sendNotification("session/end", { sessionId }))
          .catch(() => {
            // VM failed to start — session/end notification is best-effort
          });
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
    pool?: SandboxPool;
    defaultVector?: (slug: string) => Vector;
  },
): Promise<Sandbox | null> {
  const { slots, store, storage, pool } = opts;

  // Fast path: a resident sandbox needs no locking.
  const resident = slots.get(slug);
  if (resident?.sandbox) return resident.sandbox as Sandbox;

  // Serialize per-slug so concurrent cold upgrades don't each spawn a
  // sandbox (duplicate gVisor containers, one orphaned) and so a session
  // never attaches a sandbox built from pre-deploy code while a deploy is
  // mutating the same slot (deploy/delete/secret all take this lock too).
  return withSlugLock(slug, async () => {
    let slot = slots.get(slug);
    if (slot?.sandbox) return slot.sandbox as Sandbox;

    if (!slot) {
      const manifest = await store.getManifest(slug);
      if (!manifest) return null;
      slot = {
        slug: manifest.slug,
        keyHash: manifest.credential_hashes[0] ?? "",
      };
      setSlot(slots, slot);
      debug("Lazy-discovered agent from store", { slug });
    }

    const [workerCode, agentConfig, env] = await Promise.all([
      store.getWorkerCode(slug),
      store.getAgentConfig(slug),
      store.getEnv(slug).then((e) => e ?? {}),
    ]);

    if (!(workerCode && agentConfig)) {
      return null;
    }

    const sandbox = createSandbox({
      workerCode,
      env,
      storage,
      slug,
      agentConfig,
      ...(pool && { pool }),
      ...(opts.defaultVector && { defaultVector: opts.defaultVector }),
    });

    attachSandbox(slots, slot, sandbox);
    return sandbox;
  });
}
