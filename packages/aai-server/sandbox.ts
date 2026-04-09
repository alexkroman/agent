// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox backed by Firecracker microVMs (Linux) or child processes
 * (macOS dev mode).
 *
 * The host runs `createRuntime()` with VM-backed `executeTool` and `hooks`
 * overrides, giving it the same session/S2S/WebSocket handling as self-hosted
 * mode without duplicating any of that logic.
 *
 * Communication with the guest uses the newline-delimited JSON RPC channel
 * from `vsock.ts`, mediated by the `SandboxHandle` from `sandbox-vm.ts`.
 */

import {
  type AgentHookMap,
  type AgentHooks,
  type AgentRuntime,
  createRuntime,
  type ExecuteTool,
  HOOK_TIMEOUT_MS,
  resolveAllBuiltins,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "@alexkroman1/aai/host";
import { createHooks } from "hookable";
import type { Storage } from "unstorage";
import { agentKvPrefix } from "./constants.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { TurnConfigResultSchema } from "./rpc-schemas.ts";
import { type AgentMap, isAtCapacity } from "./sandbox-slots.ts";
import { createSandboxVm, type SandboxHandle } from "./sandbox-vm.ts";
import { resolveSnapshotPaths } from "./snapshot.ts";
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

// ── Bindings: KV (isolate → host) ──────────────────────────────────────

function buildKvBindings(kv: import("@alexkroman1/aai/kv").Kv): BindingTree {
  return {
    get: (key: unknown) => kv.get(key as string),
    set: (key: unknown, value: unknown, expireIn?: unknown) =>
      kv.set(key as string, value, expireIn ? { expireIn: expireIn as number } : undefined),
    del: (key: unknown) => kv.delete(key as string),
  };
}

// ── Bindings: RPC (host → isolate via pull-based work queue) ────────────

type RpcChannel = {
  call<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T>;
  shutdown(): void;
};

function buildRpcChannel(): { bindings: BindingTree; channel: RpcChannel } {
  let pendingRecv: ((req: unknown) => void) | null = null;
  const requestQueue: unknown[] = [];
  const responses = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextId = 0;

  const bindings: BindingTree = {
    recv: () =>
      new Promise((resolve) => {
        if (requestQueue.length > 0) {
          resolve(requestQueue.shift());
        } else {
          pendingRecv = resolve;
        }
      }),
    send: (id: unknown, result: unknown, errorMsg?: unknown) => {
      const entry = responses.get(id as string);
      if (!entry) return;
      responses.delete(id as string);
      if (errorMsg) entry.reject(new Error(errorMsg as string));
      else entry.resolve(result);
    },
  };

  const channel: RpcChannel = {
    call<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T> {
      const id = String(nextId++);
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      responses.set(id, { resolve: resolve as (v: unknown) => void, reject });

      const request = { ...message, id };
      if (pendingRecv) {
        const recv = pendingRecv;
        pendingRecv = null;
        recv(request);
      } else {
        requestQueue.push(request);
      }

      const timer = setTimeout(() => {
        if (responses.delete(id)) {
          reject(new Error(`RPC timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      return promise.finally(() => clearTimeout(timer));
    },

    shutdown() {
      if (pendingRecv) {
        pendingRecv(null);
        pendingRecv = null;
      }
      for (const [, { reject }] of responses) {
        reject(new Error("Sandbox shutting down"));
      }
      responses.clear();
    },
  };

  return { bindings, channel };
}

// ── Isolate lifecycle ───────────────────────────────────────────────────

type IsolateHandle = { runtime: NodeRuntime; channel: RpcChannel };

async function startIsolate(
  workerCode: string,
  kv: import("@alexkroman1/aai/kv").Kv,
  agentEnv: Record<string, string>,
): Promise<IsolateHandle> {
  const harnessFiles = await getHarnessFiles();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  for (const file of harnessFiles) {
    await fs.writeFile(`/app/${file.name}`, file.content);
  }

  const kvBindings = buildKvBindings(kv);
  const { bindings: rpcBindings, channel } = buildRpcChannel();
  const allBindings: BindingTree = { kv: kvBindings, rpc: rpcBindings };

  const prefixedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));

  if (!jailInitialized) {
    jailInitialized = true;
    if (isJailAvailable()) {
      const { createRequire } = await import("node:module");
      const { dirname, join } = await import("node:path");
      const req = createRequire(import.meta.url);
      const platformPkg = `@secure-exec/v8-${process.platform}-${process.arch === "x64" ? "x64-gnu" : "arm64-gnu"}`;
      try {
        const pkgDir = dirname(req.resolve(`${platformPkg}/package.json`));
        const binaryPath = join(pkgDir, "secure-exec-v8");
        jailLauncher = await initProcessJail({ binaryPath, memoryLimitMb: JAIL_MEMORY_LIMIT_MB });
        if (jailLauncher) {
          process.once("beforeExit", () => {
            jailLauncher?.cleanup().catch(() => {
              /* ignore cleanup errors during shutdown */
            });
          });
        }
      } catch (err) {
        console.warn("Failed to initialize process jail:", err);
      }
    }
  }

  const driverFactory: NodeRuntimeDriverFactory = {
    createRuntimeDriver(options: Parameters<NodeRuntimeDriverFactory["createRuntimeDriver"]>[0]) {
      return new NodeExecutionDriver(
        Object.assign({}, options, { bindings: allBindings }) as ConstructorParameters<
          typeof NodeExecutionDriver
        >[0],
      );
    },
  };

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req: { op: string; path: string }) =>
          READ_ONLY_FS_OPS.has(req.op)
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: () => ({ allow: false, reason: "Network disabled — use bindings" }),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: (req: { op: string; key: string }) =>
          req.op === "read" && allowedKeys.has(req.key ?? "")
            ? { allow: true }
            : { allow: false, reason: "Env access restricted" },
      },
      processConfig: { env: prefixedEnv, timingMitigation: "freeze" },
    }),
    runtimeDriverFactory: driverFactory,
    memoryLimit: SANDBOX_MEMORY_LIMIT_MB,
    onStdio(event: StdioEvent) {
      if (event.channel === "stderr") {
        console.error("[isolate stderr]", event.message);
      }
    },
  });

  // Bridge: convert the single-bundle AgentDef format into the
  // file-per-tool ToolHandler/HookHandler maps that startDispatcher expects.
  // This shim will be removed when the deploy pipeline ships per-file bundles.
  const entryScript = [
    'import agent from "/app/agent_bundle.js";',
    'import { startDispatcher } from "/app/harness-runtime.mjs";',
    "const tools = {};",
    "for (const [name, def] of Object.entries(agent.tools || {})) {",
    "  tools[name] = { default: def.execute };",
    "}",
    "const hooks = {};",
    "if (agent.onConnect) hooks.onConnect = { default: agent.onConnect };",
    "if (agent.onDisconnect) hooks.onDisconnect = { default: agent.onDisconnect };",
    "if (agent.onUserTranscript) hooks.onUserTranscript = { default: agent.onUserTranscript };",
    "if (agent.onError) hooks.onError = { default: agent.onError };",
    "startDispatcher(tools, hooks);",
  ].join("\n");

  runtime.exec(entryScript, { cwd: "/app" }).catch((err: unknown) => {
    const msg = errorMessage(err);
    if (!msg.includes("disposed")) {
      console.warn("Isolate exited unexpectedly:", msg);
    }
  });

  return { runtime, channel };
}

// ── Hook invoker ────────────────────────────────────────────────────────

/**
 * Build a VM-backed hook invoker. Only hooks the agent actually defines
 * are registered, avoiding unnecessary VM calls.
 */
function buildHookInvoker(handle: SandboxHandle, hookFlags: IsolateConfig["hooks"]): AgentHooks {
  const rpc = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await handle.request(
      { type: "hook", hook: name, ...extra },
      { timeout: HOOK_TIMEOUT_MS },
    );
    return response.result;
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
  const snapshotDir = process.env.FIRECRACKER_SNAPSHOT_DIR ?? "/opt/firecracker";
  const snapshotPaths = resolveSnapshotPaths(snapshotDir);

  const sandboxHandle = await createSandboxVm({
    slug,
    workerCode,
    agentEnv,
    kvStorage: storage,
    kvPrefix: agentKvPrefix(slug),
    // Firecracker snapshot paths (used on Linux; ignored in dev mode)
    vmlinuxPath: snapshotPaths.vmlinuxPath,
    initrdPath: snapshotPaths.initrdPath,
    snapshotStatePath: snapshotPaths.snapshotStatePath,
    snapshotMemPath: snapshotPaths.snapshotMemPath,
    // Dev mode uses a harness path; Firecracker uses snapshots.
    // The sandbox-vm factory selects the right backend automatically.
    ...(process.env.GUEST_HARNESS_PATH ? { harnessPath: process.env.GUEST_HARNESS_PATH } : {}),
  });

  // ── Build tool executor + hooks from sandbox handle ──────────────
  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const response = await sandboxHandle.request(
      {
        type: "tool",
        name,
        args,
        sessionId: sessionId ?? "",
        messages: [...(messages ?? [])],
      },
      { timeout: TOOL_EXECUTION_TIMEOUT_MS },
    );
    return response.result as string;
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
