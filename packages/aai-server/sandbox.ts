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
import { errorMessage, toolError } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import {
  type AgentRuntime,
  createRuntime,
  type ExecuteTool,
  resolveAllBuiltins,
} from "@alexkroman1/aai/runtime";
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

  const harnessPath =
    process.env.GUEST_HARNESS_PATH ??
    path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");

  const vmReady = createSandboxVm({
    slug,
    workerCode,
    env,
    kvStorage: storage,
    kvPrefix: agentKvPrefix(slug),
    harnessPath,
    allowedHosts: config.allowedHosts ?? [],
  });

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

  const builtins = resolveAllBuiltins(config.builtinTools ?? [], { fetch: safeFetch });
  // run_code executes inside the gVisor guest (see guest/deno-harness.ts).
  // Drop its host-side def so the runtime routes the call through rpcExecuteTool
  // to the sandbox instead of evaluating attacker-supplied code in node:vm here.
  const hostBuiltinDefs = { ...builtins.defs };
  delete hostBuiltinDefs.run_code;

  const agentRuntime = createRuntime({
    agent: {
      name: config.name,
      systemPrompt: config.systemPrompt,
      greeting: config.greeting ?? "",
      maxSteps: config.maxSteps ?? 5,
      tools: {},
      ...(config.sttPrompt ? { sttPrompt: config.sttPrompt } : {}),
      ...(config.toolChoice
        ? { toolChoice: config.toolChoice as import("@alexkroman1/aai").ToolChoice }
        : {}),
      ...(config.builtinTools
        ? { builtinTools: config.builtinTools as import("@alexkroman1/aai").BuiltinTool[] }
        : {}),
    },
    env,
    fetch: safeFetch,
    executeTool,
    toolSchemas: [...config.toolSchemas, ...builtins.schemas],
    toolGuidance: builtins.guidance,
    builtinDefs: hostBuiltinDefs,
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
        if (params.event.length > 256) return;
        // Cap data payload at 64 KB to prevent memory abuse via WebSocket relay
        if (JSON.stringify(params.data).length > 65_536) return;
        const sink = sessionSinks.get(params.sessionId);
        if (sink?.open) {
          sink.event({ type: "custom_event", event: params.event, data: params.data });
        }
      });
      console.info("Sandbox ready", { slug, agent: config.name });
    })
    .catch((err: unknown) => {
      console.error("Sandbox VM failed to start", { slug, error: errorMessage(err) });
    });

  console.info("Sandbox initializing", { slug, agent: config.name });

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

  // Wrap startSession to notify guest of session cleanup and capture sinks
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
  });

  slot.sandbox = sandbox;
  return sandbox;
}
