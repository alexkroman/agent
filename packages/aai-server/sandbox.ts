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
import { type IsolateConfig, TurnConfigResultSchema } from "./rpc-schemas.ts";
import { getHarnessFiles } from "./sandbox-harness.ts";
import { resolveSandbox as _resolveSandboxCore, type SlotCache } from "./sandbox-slots.ts";
import { ssrfSafeFetch } from "./ssrf.ts";
import type { BundleStore } from "./store-types.ts";

let jailLauncher: JailedLauncher | null = null;
let jailInitialized = false;

/**
 * IMPORTANT: Do NOT call `runtime.terminate()` or `runtime.dispose()` during
 * normal sandbox shutdown.
 *
 * secure-exec's NodeExecutionDriver uses reference counting — when all drivers
 * are terminated/disposed, `releaseSharedV8Runtime()` kills the shared Rust V8
 * process. In a long-lived server this is catastrophic: terminating the last
 * active isolate kills the Rust process, causing "broken pipe" errors for
 * subsequent boots.
 *
 * Instead, `channel.shutdown()` stops the RPC loop and the V8 session is
 * cleaned up when the Rust process eventually reclaims it. The memory cost
 * is negligible (~1MB per session per our load tests).
 *
 * `runtime.terminate()` should ONLY be called during full server shutdown
 * (process exit) when we want to clean up the Rust process.
 */

const READ_ONLY_FS_OPS = new Set(["read", "stat", "readdir", "exists"]);

// Suppress "Isolate is disposed" rejections from secure-exec internals.
// These fire asynchronously when an isolate is terminated while its ESM
// compiler has pending promises. They're harmless and expected during
// sandbox shutdown/eviction.
process.on("unhandledRejection", (reason: unknown) => {
  if (reason instanceof Error && reason.message.includes("disposed")) return;
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

// ── Hook invoker ────────────────────────────────────────────────────────

/**
 * Build an RPC-backed hook invoker. Only hooks the agent actually defines
 * are registered, avoiding unnecessary isolate boot.
 */
function buildHookInvoker(
  getChannel: () => Promise<RpcChannel>,
  hookFlags: IsolateConfig["hooks"],
): AgentHooks {
  const rpc = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    (
      await (
        await getChannel()
      ).call<{ result?: unknown }>({ type: "hook", hook: name, ...extra }, HOOK_TIMEOUT_MS)
    ).result;

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

// ── Public API ───────────────────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  startIsolate,
  createSandbox,
};

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, apiKey, agentEnv, storage, slug } = opts;
  const kv = createUnstorageKv({ storage, prefix: agentKvPrefix(slug) });

  const safeFetch: typeof globalThis.fetch = (input, init?) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    return ssrfSafeFetch(url, init ?? {}, globalThis.fetch);
  };

  // ── Resolve config + channel provider ─────────────────────────────
  const config = opts.agentConfig;
  let isolate: IsolateHandle | null = null;
  let isolatePromise: Promise<IsolateHandle> | null = null;

  const ensureIsolate = async (): Promise<IsolateHandle> => {
    if (isolate) return isolate;
    if (!isolatePromise) {
      isolatePromise = startIsolate(workerCode, kv, agentEnv).then(
        (result) => {
          isolate = result;
          return result;
        },
        (err) => {
          isolatePromise = null;
          throw err;
        },
      );
    }
    return await isolatePromise;
  };

  const getChannel = async () => (await ensureIsolate()).channel;

  // ── Build tool executor + hooks from channel ──────────────────────
  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const ch = await getChannel();
    const { result } = await ch.call<{ result: string }>(
      { type: "tool", name, args, sessionId: sessionId ?? "", messages: [...(messages ?? [])] },
      TOOL_EXECUTION_TIMEOUT_MS,
    );
    return result;
  };

  const hooks = buildHookInvoker(getChannel, config.hooks);

  // ── Assemble runtime ──────────────────────────────────────────────
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
    isolate?.channel.shutdown();
    await agentRuntime.shutdown();
    // Note: we intentionally do NOT call runtime.terminate() here.
    // See the comment above startIsolate for why.
  }

  return {
    readyConfig: agentRuntime.readyConfig,
    startSession: agentRuntime.startSession.bind(agentRuntime),
    shutdown: shutdownSandbox,
  };
}

export async function resolveSandbox(
  slug: string,
  opts: { slots: SlotCache; store: BundleStore; storage: Storage },
): Promise<Sandbox | null> {
  return _resolveSandboxCore(slug, { ...opts, createSandbox });
}
