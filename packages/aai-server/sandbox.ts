// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox using secure-exec V8 isolates.
 *
 * The isolate runs agent code (tools + hooks) via an RPC server. The host
 * runs `createRuntime()` with RPC-backed `executeTool` and `hooks` overrides,
 * giving it the same session/S2S/WebSocket handling as self-hosted mode
 * without duplicating any of that logic.
 */

import { randomBytes } from "node:crypto";

import {
  type AgentHookMap,
  type AgentHooks,
  type AgentRuntime,
  createRuntime,
  createUnstorageKv,
  type ExecuteTool,
  errorMessage,
  getBuiltinToolGuidance,
  getBuiltinToolSchemas,
  HOOK_TIMEOUT_MS,
  TOOL_EXECUTION_TIMEOUT_MS,
} from "@alexkroman1/aai/host";
import { createHooks } from "hookable";
import pTimeout from "p-timeout";
import type { StdioEvent } from "secure-exec";
import {
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeRuntime,
} from "secure-exec";
import type { Storage } from "unstorage";
import { z } from "zod";
import {
  JAIL_MEMORY_LIMIT_MB,
  PORT_ANNOUNCE_TIMEOUT_MS,
  SANDBOX_MEMORY_LIMIT_MB,
} from "./constants.ts";
import { initProcessJail, isJailAvailable, type JailedLauncher } from "./process-jail.ts";
import {
  HookResponseSchema,
  type IsolateConfig,
  IsolateConfigSchema,
  ToolCallResponseSchema,
  TurnConfigResultSchema,
} from "./rpc-schemas.ts";
import { getHarnessFiles } from "./sandbox-harness.ts";
import { createSidecar, type Sidecar } from "./sandbox-sidecar.ts";
import {
  resolveSandbox as _resolveSandboxCore,
  _slotInternals,
  type AgentSlot,
} from "./sandbox-slots.ts";
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

export { type AgentSlot, ensureAgent, registerSlot } from "./sandbox-slots.ts";
export type { AgentMetadata } from "./schemas.ts";

export type SandboxOptions = {
  workerCode: string;
  apiKey: string;
  agentEnv: Record<string, string>;
  storage: Storage;
  slug: string;
};

export type Sandbox = AgentRuntime & {
  /** @deprecated Use {@link AgentRuntime.shutdown} instead. */
  terminate(): Promise<void>;
};

// ── Isolate lifecycle ───────────────────────────────────────────────────

async function startIsolate(
  workerCode: string,
  kv: import("@alexkroman1/aai/kv").Kv,
  agentEnv: Record<string, string>,
  authToken: string,
): Promise<{ port: number; runtime: NodeRuntime; crashed: AbortSignal; sidecar: Sidecar }> {
  const harnessFiles = await getHarnessFiles();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  for (const file of harnessFiles) {
    await fs.writeFile(`/app/${file.name}`, file.content);
  }

  // Start a real HTTP sidecar for KV bridge before booting the isolate
  const sidecar = await createSidecar(kv, authToken);

  const prefixedEnv: Record<string, string> = {
    HARNESS_AUTH_TOKEN: authToken,
    SIDECAR_URL: sidecar.url,
  };
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));
  const crashController = new AbortController();

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

  let portResolved = false;
  const {
    promise: portPromise,
    resolve: resolvePort,
    reject: rejectPort,
  } = Promise.withResolvers<number>();

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req: { op: string; path: string }) =>
          isReadOnlyFsOp(req.op)
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: () => ({ allow: true as const }),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: (req: { op: string; key: string }) =>
          req.op === "read" && allowedKeys.has(req.key ?? "")
            ? { allow: true }
            : { allow: false, reason: "Env access restricted" },
      },
      useDefaultNetwork: true,
      loopbackExemptPorts: [sidecar.port],
      processConfig: { env: prefixedEnv, timingMitigation: "freeze" },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: SANDBOX_MEMORY_LIMIT_MB,
    onStdio(event: StdioEvent) {
      if (event.channel === "stdout") {
        try {
          const parsed = z.object({ port: z.number() }).safeParse(JSON.parse(event.message));
          if (parsed.success && !portResolved) {
            portResolved = true;
            resolvePort(parsed.data.port);
          }
        } catch {
          /* not the port announcement */
        }
      }
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
    .then(
      () => {
        /* normal exit — nothing to do */
      },
      (err: unknown) => {
        // Before port: propagate as boot failure. After port: swallow
        // (expected during shutdown when isolate is disposed).
        if (!portResolved) {
          rejectPort(new Error(`Isolate exited before announcing port: ${err}`));
        }
      },
    );

  const port = await pTimeout(portPromise, {
    milliseconds: PORT_ANNOUNCE_TIMEOUT_MS,
    message: `Isolate failed to announce port within ${PORT_ANNOUNCE_TIMEOUT_MS}ms`,
  });

  runtime.exec("").catch((err) => {
    if (!crashController.signal.aborted) {
      crashController.abort(new Error(`Isolate crashed: ${errorMessage(err)}`));
    }
  });

  return { port, runtime, crashed: crashController.signal, sidecar };
}

// ── Isolate RPC ─────────────────────────────────────────────────────────

async function callIsolate<T>(
  port: number,
  message: Record<string, unknown>,
  timeoutMs: number,
  schema: z.ZodType<T>,
  authToken: string,
  crashed?: AbortSignal,
): Promise<T> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (crashed) signals.push(crashed);
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-harness-token": authToken },
    body: JSON.stringify(message),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`rpc (${message.type}) failed (${res.status}): ${body}`);
  }
  return schema.parse(await res.json());
}

function buildExecuteTool(port: number, authToken: string, crashed?: AbortSignal): ExecuteTool {
  return async (name, args, sessionId, messages) => {
    const { result } = await callIsolate(
      port,
      { type: "tool", name, args, sessionId: sessionId ?? "", messages: [...(messages ?? [])] },
      TOOL_EXECUTION_TIMEOUT_MS,
      ToolCallResponseSchema,
      authToken,
      crashed,
    );
    return result;
  };
}

function buildHookInvoker(port: number, authToken: string, crashed?: AbortSignal): AgentHooks {
  const rpc = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    (
      await callIsolate(
        port,
        { type: "hook", hook: name, ...extra },
        HOOK_TIMEOUT_MS,
        HookResponseSchema,
        authToken,
        crashed,
      )
    ).result;

  const hooks = createHooks<AgentHookMap>();
  hooks.hook("connect", async (sessionId) => {
    await rpc("onConnect", { sessionId });
  });
  hooks.hook("disconnect", async (sessionId) => {
    await rpc("onDisconnect", { sessionId });
  });
  hooks.hook("userTranscript", async (sessionId, text) => {
    await rpc("onUserTranscript", { sessionId, text });
  });
  hooks.hook("resolveTurnConfig", (async (sessionId: string) => {
    const parsed = TurnConfigResultSchema.parse(await rpc("resolveTurnConfig", { sessionId }));
    if (parsed == null) return null;
    const config: { maxSteps?: number } = {};
    if (parsed.maxSteps != null) config.maxSteps = parsed.maxSteps;
    return config;
    // biome-ignore lint/suspicious/noExplicitAny: hookable void-return constraint requires cast
  }) as any);
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

  const kv = createUnstorageKv({ storage, prefix: `agents/${slug}/kv` });
  const authToken = randomBytes(32).toString("hex");
  const { port, runtime, crashed, sidecar } = await startIsolate(
    workerCode,
    kv,
    agentEnv,
    authToken,
  );

  // Get agent config from isolate
  const configRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-harness-token": authToken },
    body: JSON.stringify({ type: "config" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!configRes.ok) throw new Error(`Config RPC failed: ${configRes.status}`);
  const config: IsolateConfig = IsolateConfigSchema.parse(await configRes.json());

  // Build RPC-backed tool execution and hooks
  const executeTool = buildExecuteTool(port, authToken, crashed);
  const hooks = buildHookInvoker(port, authToken, crashed);

  // Create a runtime with RPC overrides — same startSession/shutdown as self-hosted
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
    executeTool,
    hooks,
    toolSchemas: [...config.toolSchemas, ...getBuiltinToolSchemas(config.builtinTools ?? [])],
    toolGuidance: getBuiltinToolGuidance(config.builtinTools ?? []),
  });

  console.info("Sandbox initialized", { slug, isolatePort: port, agent: config.name });

  async function shutdownSandbox(): Promise<void> {
    try {
      await agentRuntime.shutdown();
    } finally {
      await sidecar.close().catch(() => {
        /* ignore */
      });
      await runtime.terminate().catch((err: unknown) => {
        const msg = errorMessage(err);
        if (!msg.includes("already disposed")) console.warn("Runtime terminate failed:", err);
      });
    }
  }

  return {
    readyConfig: agentRuntime.readyConfig,
    startSession: agentRuntime.startSession.bind(agentRuntime),
    shutdown: shutdownSandbox,
    terminate: shutdownSandbox,
  };
}

export async function resolveSandbox(
  slug: string,
  opts: { slots: Map<string, AgentSlot>; store: BundleStore; storage: Storage },
): Promise<Sandbox | null> {
  return _resolveSandboxCore(slug, { ...opts, createSandbox });
}
