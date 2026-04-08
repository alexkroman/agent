// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox using secure-exec V8 isolates.
 *
 * Communication between host and isolate uses secure-exec bindings (V8 bridge
 * IPC) in both directions — no HTTP servers, no loopback ports, no auth tokens:
 *
 * - **Isolate → Host (KV)**: The isolate calls `SecureExec.bindings.kv.*`
 *   which invoke host-side KV functions directly through the bridge.
 * - **Host → Isolate (RPC)**: The isolate runs a pull-based work loop calling
 *   `SecureExec.bindings.rpc.recv()` (which blocks until the host enqueues a
 *   request). Results are returned via `SecureExec.bindings.rpc.send()`.
 *
 * The host runs `createRuntime()` with RPC-backed `executeTool` and `hooks`
 * overrides, giving it the same session/S2S/WebSocket handling as self-hosted
 * mode without duplicating any of that logic.
 */

import {
  type AgentHookMap,
  type AgentHooks,
  type AgentRuntime,
  createRuntime,
  createUnstorageKv,
  type ExecuteTool,
  errorMessage,
  HOOK_TIMEOUT_MS,
  resolveAllBuiltins,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "@alexkroman1/aai/host";
import { createHooks } from "hookable";
import type { BindingTree, NodeRuntimeDriverFactory, StdioEvent } from "secure-exec";
import {
  createInMemoryFileSystem,
  createNodeDriver,
  NodeExecutionDriver,
  NodeRuntime,
} from "secure-exec";
import type { Storage } from "unstorage";
import { agentKvPrefix, JAIL_MEMORY_LIMIT_MB, SANDBOX_MEMORY_LIMIT_MB } from "./constants.ts";
import { initProcessJail, isJailAvailable, type JailedLauncher } from "./process-jail.ts";
import { type IsolateConfig, IsolateConfigSchema, TurnConfigResultSchema } from "./rpc-schemas.ts";
import { getHarnessFiles } from "./sandbox-harness.ts";
import {
  resolveSandbox as _resolveSandboxCore,
  _slotInternals,
  type SlotCache,
} from "./sandbox-slots.ts";
import { ssrfSafeFetch } from "./ssrf.ts";
import type { BundleStore } from "./store-types.ts";

let jailLauncher: JailedLauncher | null = null;
let jailInitialized = false;

/** Set of filesystem operations that are safe for read-only access. */
const READ_ONLY_FS_OPS = new Set(["read", "stat", "readdir", "exists"]);

function isReadOnlyFsOp(op: string): boolean {
  return READ_ONLY_FS_OPS.has(op);
}

// Suppress "Isolate is disposed" rejections from secure-exec internals.
// These fire asynchronously when an isolate is terminated while its ESM
// compiler has pending promises. They're harmless and expected during
// sandbox shutdown/eviction.
process.on("unhandledRejection", (reason: unknown) => {
  if (reason instanceof Error && reason.message.includes("disposed")) return;
  // Re-throw non-disposal rejections so they're not silently swallowed
  throw reason;
});

export {
  type AgentSlot,
  createSlotCache,
  ensureAgent,
  registerSlot,
  type SlotCache,
} from "./sandbox-slots.ts";
export type { AgentMetadata } from "./schemas.ts";

export type SandboxOptions = {
  workerCode: string;
  apiKey: string;
  agentEnv: Record<string, string>;
  storage: Storage;
  slug: string;
  /** Pre-extracted agent config. When provided, skips V8 isolate boot for config extraction. */
  agentConfig?: IsolateConfig;
};

export type Sandbox = AgentRuntime;

// ── Bindings: KV (isolate → host) ──────────────────────────────────────

function buildKvBindings(kv: import("@alexkroman1/aai/kv").Kv): BindingTree {
  return {
    get: (key: unknown) => kv.get(key as string),
    set: (key: unknown, value: unknown, expireIn?: unknown) =>
      kv.set(key as string, value, expireIn ? { expireIn: expireIn as number } : undefined),
    del: (key: unknown) => kv.delete(key as string),
    list: (prefix: unknown, limit?: unknown, reverse?: unknown) => {
      const opts: { limit?: number; reverse?: boolean } = {};
      if (limit != null) opts.limit = limit as number;
      if (reverse != null) opts.reverse = reverse as boolean;
      return kv.list(prefix as string, opts);
    },
    keys: (pattern?: unknown) => kv.keys(pattern as string | undefined),
  };
}

// ── Bindings: RPC (host → isolate via pull-based work queue) ────────────

type RpcChannel = {
  /** Send a request to the isolate and wait for the response. */
  call<T>(message: Record<string, unknown>, timeoutMs: number): Promise<T>;
  /** Break the isolate's RPC loop and reject all pending requests. */
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

// ── Driver factory with bindings ────────────────────────────────────────

function createBindingDriverFactory(bindings: BindingTree): NodeRuntimeDriverFactory {
  return {
    createRuntimeDriver(options: Parameters<NodeRuntimeDriverFactory["createRuntimeDriver"]>[0]) {
      return new NodeExecutionDriver(
        Object.assign({}, options, { bindings }) as ConstructorParameters<
          typeof NodeExecutionDriver
        >[0],
      );
    },
  };
}

// ── Isolate lifecycle ───────────────────────────────────────────────────

type IsolateHandle = {
  runtime: NodeRuntime;
  channel: RpcChannel;
};

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

  // Build bindings for KV and RPC — no HTTP servers needed
  const kvBindings = buildKvBindings(kv);
  const { bindings: rpcBindings, channel } = buildRpcChannel();
  const allBindings: BindingTree = { kv: kvBindings, rpc: rpcBindings };

  const prefixedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));

  // Initialize process jail on first isolate boot (Linux only).
  // Must run before NodeRuntime construction triggers secure-exec binary resolution.
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

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req: { op: string; path: string }) =>
          isReadOnlyFsOp(req.op)
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
    runtimeDriverFactory: createBindingDriverFactory(allBindings),
    memoryLimit: SANDBOX_MEMORY_LIMIT_MB,
    onStdio(event: StdioEvent) {
      if (event.channel === "stderr") {
        console.error("[isolate stderr]", event.message);
      }
    },
  });

  // Boot the harness — it will start the RPC loop and call rpc.recv()
  runtime
    .exec(
      'import agent from "/app/agent_bundle.js";\nimport { startHarness } from "/app/harness-runtime.mjs";\nstartHarness(agent);',
      { cwd: "/app" },
    )
    .catch((err: unknown) => {
      const msg = errorMessage(err);
      if (!msg.includes("disposed")) {
        console.warn("Isolate exited unexpectedly:", msg);
      }
    });

  return { runtime, channel };
}

// ── Isolate RPC helpers ─────────────────────────────────────────────────

function buildExecuteTool(channel: RpcChannel): ExecuteTool {
  return async (name, args, sessionId, messages) => {
    const { result } = await channel.call<{ result: string; state: Record<string, unknown> }>(
      { type: "tool", name, args, sessionId: sessionId ?? "", messages: [...(messages ?? [])] },
      TOOL_EXECUTION_TIMEOUT_MS,
    );
    return result;
  };
}

/**
 * Build an RPC-backed hook invoker. When `hookFlags` is provided, only hooks
 * the agent actually defines are registered (avoiding unnecessary isolate boot
 * in the lazy path). When omitted, all hooks are registered (eager path).
 */
function buildHookInvoker(
  channelProvider: () => Promise<RpcChannel>,
  hookFlags?: IsolateConfig["hooks"],
): AgentHooks {
  const rpc = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const channel = await channelProvider();
    return (
      await channel.call<{ result?: unknown; state: Record<string, unknown> }>(
        { type: "hook", hook: name, ...extra },
        HOOK_TIMEOUT_MS,
      )
    ).result;
  };

  const hooks = createHooks<AgentHookMap>();
  if (!hookFlags || hookFlags.onConnect) {
    hooks.hook("connect", async (sessionId) => {
      await rpc("onConnect", { sessionId });
    });
  }
  if (!hookFlags || hookFlags.onDisconnect) {
    hooks.hook("disconnect", async (sessionId) => {
      await rpc("onDisconnect", { sessionId });
    });
  }
  if (!hookFlags || hookFlags.onUserTranscript) {
    hooks.hook("userTranscript", async (sessionId, text) => {
      await rpc("onUserTranscript", { sessionId, text });
    });
  }
  if (!hookFlags || hookFlags.maxStepsIsFn) {
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

// ── Public API ───────────────────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  startIsolate,
  createSandbox,
  get IDLE_MS() {
    return _slotInternals.IDLE_MS;
  },
  set IDLE_MS(ms: number) {
    _slotInternals.IDLE_MS = ms;
  },
  resetIdleTimer: _slotInternals.resetIdleTimer,
};

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, apiKey, agentEnv, storage, slug } = opts;

  const kv = createUnstorageKv({ storage, prefix: agentKvPrefix(slug) });

  // SSRF-safe fetch wrapper for built-in tools (web_search, visit_webpage, fetch_json).
  // Validates each URL (and redirect target) against private/reserved IP ranges.
  const safeFetch: typeof globalThis.fetch = (input, init?) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    return ssrfSafeFetch(url, init ?? {}, globalThis.fetch);
  };

  // When pre-extracted config is available, use it directly and defer isolate boot
  // until custom tool execution or hook invocation is actually needed.
  if (opts.agentConfig) {
    return createSandboxWithPreExtractedConfig({
      config: opts.agentConfig,
      workerCode,
      kv,
      apiKey,
      agentEnv,
      slug,
      safeFetch,
    });
  }

  // Fallback: boot isolate eagerly and extract config via RPC (old deploy without agentConfig)
  return createSandboxWithIsolate({
    workerCode,
    kv,
    apiKey,
    agentEnv,
    slug,
    safeFetch,
  });
}

/** Build the agent definition object expected by createRuntime from an IsolateConfig. */
function buildAgentFromConfig(config: IsolateConfig) {
  return {
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
  };
}

/** Shared: build runtime + shutdown from config and isolate handle. */
function finalizeSandbox(opts: {
  config: IsolateConfig;
  apiKey: string;
  agentEnv: Record<string, string>;
  slug: string;
  safeFetch: typeof globalThis.fetch;
  executeTool: ExecuteTool;
  hooks: AgentHooks;
  getIsolate: () => IsolateHandle | null;
}): Sandbox {
  const { config, apiKey, agentEnv, safeFetch, executeTool, hooks, getIsolate } = opts;

  const builtins = resolveAllBuiltins(config.builtinTools ?? []);
  const agentRuntime = createRuntime({
    agent: buildAgentFromConfig(config),
    env: { ...agentEnv, ASSEMBLYAI_API_KEY: apiKey },
    fetch: safeFetch,
    executeTool,
    hooks,
    toolSchemas: [...config.toolSchemas, ...builtins.schemas],
    toolGuidance: builtins.guidance,
  });

  async function shutdownSandbox(): Promise<void> {
    try {
      hooks.removeAllHooks();
      const iso = getIsolate();
      iso?.channel.shutdown();
      await agentRuntime.shutdown();
    } finally {
      const iso = getIsolate();
      if (iso) {
        await iso.runtime.terminate().catch((err: unknown) => {
          const msg = errorMessage(err);
          if (!msg.includes("already disposed")) console.warn("Runtime terminate failed:", err);
        });
      }
    }
  }

  return {
    readyConfig: agentRuntime.readyConfig,
    startSession: agentRuntime.startSession.bind(agentRuntime),
    shutdown: shutdownSandbox,
  };
}

type SandboxInternalOpts = {
  workerCode: string;
  kv: import("@alexkroman1/aai/kv").Kv;
  apiKey: string;
  agentEnv: Record<string, string>;
  slug: string;
  safeFetch: typeof globalThis.fetch;
};

/**
 * Create a sandbox using a pre-extracted config, deferring isolate boot
 * until custom tool/hook execution is needed (or never, for builtin-only agents).
 */
async function createSandboxWithPreExtractedConfig(
  opts: SandboxInternalOpts & { config: IsolateConfig },
): Promise<Sandbox> {
  const { config, workerCode, kv, agentEnv, slug } = opts;

  // Lazy isolate: only booted when custom tools/hooks are actually invoked
  let isolate: IsolateHandle | null = null;
  let isolatePromise: Promise<IsolateHandle> | null = null;
  let cachedExecuteTool: ExecuteTool | null = null;

  async function ensureIsolate(): Promise<IsolateHandle> {
    if (isolate) return isolate;
    if (!isolatePromise) {
      isolatePromise = startIsolate(workerCode, kv, agentEnv).then(
        (result) => {
          isolate = result;
          cachedExecuteTool = buildExecuteTool(result.channel);
          return result;
        },
        (err) => {
          isolatePromise = null;
          throw err;
        },
      );
    }
    return await isolatePromise;
  }

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    await ensureIsolate();
    // biome-ignore lint/style/noNonNullAssertion: set by ensureIsolate's then() handler
    return cachedExecuteTool!(name, args, sessionId, messages);
  };

  const channelProvider = async () => (await ensureIsolate()).channel;
  const hooks = buildHookInvoker(channelProvider, config.hooks);

  const hasCustomTools = config.toolSchemas.length > 0;
  const hasHooks =
    config.hooks.onConnect ||
    config.hooks.onDisconnect ||
    config.hooks.onUserTranscript ||
    config.hooks.maxStepsIsFn;
  console.info("Sandbox initialized", {
    slug,
    agent: config.name,
    isolateDeferred: hasCustomTools || hasHooks || config.hasState,
  });

  return finalizeSandbox({ ...opts, executeTool, hooks, getIsolate: () => isolate });
}

/** Fallback: boot isolate eagerly and extract config via RPC. */
async function createSandboxWithIsolate(opts: SandboxInternalOpts): Promise<Sandbox> {
  const { workerCode, kv, agentEnv, slug } = opts;

  const handle = await startIsolate(workerCode, kv, agentEnv);

  // Get agent config from isolate via bindings RPC
  const config: IsolateConfig = IsolateConfigSchema.parse(
    await handle.channel.call({ type: "config" }, 10_000),
  );

  const executeTool = buildExecuteTool(handle.channel);
  const fixedProvider = async () => handle.channel;
  const hooks = buildHookInvoker(fixedProvider);

  console.info("Sandbox initialized", { slug, agent: config.name });

  return finalizeSandbox({ ...opts, config, executeTool, hooks, getIsolate: () => handle });
}

export async function resolveSandbox(
  slug: string,
  opts: { slots: SlotCache; store: BundleStore; storage: Storage },
): Promise<Sandbox | null> {
  return _resolveSandboxCore(slug, { ...opts, createSandbox });
}
