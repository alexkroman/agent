// Copyright 2025 the AAI authors. MIT license.
/** Agent sandbox using secure-exec V8 isolates. */

import { randomBytes } from "node:crypto";
import { toAgentConfig } from "@alexkroman1/aai/internal-types";
import { buildReadyConfig } from "@alexkroman1/aai/protocol";
import { DEFAULT_S2S_CONFIG } from "@alexkroman1/aai/runtime";
import { createS2sSession, type HookInvoker, type Session } from "@alexkroman1/aai/session";
import { isReadOnlyFsOp } from "@alexkroman1/aai/utils";
import type { ExecuteTool } from "@alexkroman1/aai/worker-entry";
import { type SessionWebSocket, wireSessionSocket } from "@alexkroman1/aai/ws-handler";
import {
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeRuntime,
} from "secure-exec";
import { z } from "zod";
import {
  BeforeTurnResultSchema,
  FilterInputResultSchema,
  FilterOutputResultSchema,
  HookResponseSchema,
  type IsolateConfig,
  IsolateConfigSchema,
  ToolCallResponseSchema,
  ToolInterceptResultSchema,
  TurnConfigResultSchema,
  VoidHookResultSchema,
} from "./_harness-protocol.ts";
import type { KvStore } from "./kv.ts";
import { getHarnessRuntimeJs } from "./sandbox-harness.ts";
import { buildNetworkAdapter, buildNetworkPolicy } from "./sandbox-network.ts";
import { scopedKv, scopedVector, startSidecarServer } from "./sandbox-sidecar.ts";
// biome-ignore lint/suspicious/noImportCycles: sandbox ↔ sandbox-slots cycle is architectural (lazy import on the other side)
import { _slotInternals } from "./sandbox-slots.ts";
import type { AgentScope } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

export type { AgentMetadata } from "./_schemas.ts";
// biome-ignore lint/suspicious/noImportCycles: re-export from sandbox-slots (cycle broken by lazy import)
export { type AgentSlot, ensureAgent, registerSlot, resolveSandbox } from "./sandbox-slots.ts";

export type SandboxOptions = {
  workerCode: string;
  /** Platform API key (e.g. AssemblyAI) — used by the host only, never sent to the isolate. */
  apiKey: string;
  /** Agent-defined secrets — forwarded to the isolate via AAI_ENV_ prefixed process env. */
  agentEnv: Record<string, string>;
  kvStore: KvStore;
  scope: AgentScope;
  vectorStore?: ServerVectorStore | undefined;
};

export type Sandbox = {
  startSession(socket: SessionWebSocket, skipGreeting?: boolean): void;
  terminate(): Promise<void>;
};

// ── Isolate lifecycle ────────────────────────────────────────────────────

async function startIsolate(
  workerCode: string,
  sidecarUrl: string,
  agentEnv: Record<string, string>,
  authToken: string,
): Promise<{ port: number; runtime: NodeRuntime; crashed: AbortSignal }> {
  const harnessJs = await getHarnessRuntimeJs();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  await fs.writeFile("/app/_harness-runtime.js", harnessJs);

  // Prefix agent env vars with AAI_ENV_ so the harness can identify them.
  const prefixedEnv: Record<string, string> = {
    SIDECAR_URL: sidecarUrl,
    HARNESS_AUTH_TOKEN: authToken,
  };
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));

  const crashController = new AbortController();

  let resolvePort: (port: number) => void;
  let rejectPort: (err: Error) => void;
  let portResolved = false;
  const portPromise = new Promise<number>((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req) =>
          isReadOnlyFsOp(req.op)
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: buildNetworkPolicy(sidecarUrl),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: (req) =>
          req.op === "read" && allowedKeys.has(req.key ?? "")
            ? { allow: true }
            : { allow: false, reason: "Env access restricted" },
      },
      networkAdapter: buildNetworkAdapter(sidecarUrl),
      processConfig: {
        env: prefixedEnv,
        timingMitigation: "freeze",
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    onStdio(event) {
      if (event.channel === "stdout") {
        try {
          const parsed = z.object({ port: z.number() }).safeParse(JSON.parse(event.message));
          // Guard: only resolve once. Subsequent port announcements are ignored.
          if (parsed.success && !portResolved) {
            portResolved = true;
            resolvePort(parsed.data.port);
          }
        } catch {
          // Not the port announcement, ignore
        }
      }
      if (event.channel === "stderr") {
        console.error("[isolate stderr]", event.message);
      }
    },
  });

  // Exec lives as long as the isolate. Pre-port rejections propagate as boot failures.
  const execPromise = runtime
    .exec(
      'import agent from "/app/agent_bundle.js";\nimport { startHarness } from "/app/_harness-runtime.js";\nstartHarness(agent);',
      { cwd: "/app" },
    )
    .catch((err: unknown) => {
      rejectPort(new Error(`Isolate exited before announcing port: ${err}`));
    });

  const timeoutId = setTimeout(() => {
    rejectPort(new Error(`Isolate failed to announce port within ${PORT_ANNOUNCE_TIMEOUT_MS}ms`));
  }, PORT_ANNOUNCE_TIMEOUT_MS);

  let port: number;
  try {
    port = await portPromise;
  } finally {
    clearTimeout(timeoutId);
  }

  // After port is resolved, let exec run in background. If it rejects
  // unexpectedly (crash), abort the crash signal so in-flight calls fail fast.
  execPromise.catch((err) => {
    if (!crashController.signal.aborted) {
      crashController.abort(
        new Error(`Isolate crashed: ${err instanceof Error ? err.message : err}`),
      );
    }
  });

  return { port, runtime, crashed: crashController.signal };
}

// ── Isolate RPC ──────────────────────────────────────────────────────────

const PORT_ANNOUNCE_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
/** Host-side tool timeout (isolate-side is 25s — 5s shorter for clean errors). */
const TOOL_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 10_000;

async function getIsolateConfig(port: number, authToken: string): Promise<IsolateConfig> {
  const res = await fetch(`http://127.0.0.1:${port}/config`, {
    headers: { "x-harness-token": authToken },
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Isolate /config failed (${res.status}): ${body}`);
  }
  return IsolateConfigSchema.parse(await res.json());
}

async function callIsolate<T>(
  isolateUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  schema: z.ZodType<T>,
  authToken: string,
  crashed?: AbortSignal,
): Promise<T> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (crashed) signals.push(crashed);
  const res = await fetch(`${isolateUrl}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-harness-token": authToken },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${endpoint} failed (${res.status}): ${body}`);
  }
  return schema.parse(await res.json());
}

function buildExecuteTool(
  isolateUrl: string,
  authToken: string,
  crashed?: AbortSignal,
): ExecuteTool {
  return async (name, args, sessionId, messages) => {
    const { result } = await callIsolate(
      isolateUrl,
      "tool",
      { name, args, sessionId, messages },
      TOOL_TIMEOUT_MS,
      ToolCallResponseSchema,
      authToken,
      crashed,
    );
    return result;
  };
}

function buildHookInvoker(
  isolateUrl: string,
  authToken: string,
  crashed?: AbortSignal,
): HookInvoker {
  const hook = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    (
      await callIsolate(
        isolateUrl,
        "hook",
        { hook: name, ...extra },
        HOOK_TIMEOUT_MS,
        HookResponseSchema,
        authToken,
        crashed,
      )
    ).result;

  return {
    async onConnect(sessionId) {
      VoidHookResultSchema.parse(await hook("onConnect", { sessionId }));
    },
    async onDisconnect(sessionId) {
      VoidHookResultSchema.parse(await hook("onDisconnect", { sessionId }));
    },
    async onTurn(sessionId, text) {
      VoidHookResultSchema.parse(await hook("onTurn", { sessionId, text }));
    },
    async onError(sessionId, error) {
      VoidHookResultSchema.parse(await hook("onError", { sessionId, error }));
    },
    async onStep(sessionId, step) {
      VoidHookResultSchema.parse(await hook("onStep", { sessionId, step }));
    },
    async resolveTurnConfig(sessionId, stepNumber) {
      const parsed = TurnConfigResultSchema.parse(
        await hook("resolveTurnConfig", { sessionId, stepNumber }),
      );
      if (parsed == null) return null;
      const config: { maxSteps?: number; activeTools?: string[] } = {};
      if (parsed.maxSteps != null) config.maxSteps = parsed.maxSteps;
      if (parsed.activeTools != null) config.activeTools = parsed.activeTools;
      return config;
    },
    async filterInput(sessionId, text) {
      const result = FilterInputResultSchema.parse(await hook("filterInput", { sessionId, text }));
      return result ?? text;
    },
    async beforeTurn(sessionId, text) {
      return BeforeTurnResultSchema.parse(await hook("beforeTurn", { sessionId, text }));
    },
    async afterTurn(sessionId, text) {
      VoidHookResultSchema.parse(await hook("afterTurn", { sessionId, text }));
    },
    async interceptToolCall(sessionId, tool, args) {
      const result = await hook("interceptToolCall", {
        sessionId,
        step: { stepNumber: 0, toolCalls: [{ toolName: tool, args }], text: "" },
      });
      return ToolInterceptResultSchema.parse(result);
    },
    async afterToolCall(sessionId, tool, args, result) {
      VoidHookResultSchema.parse(
        await hook("afterToolCall", {
          sessionId,
          step: { stepNumber: 0, toolCalls: [{ toolName: tool, args }], text: result },
        }),
      );
    },
    async filterOutput(sessionId, text) {
      const result = FilterOutputResultSchema.parse(
        await hook("filterOutput", { sessionId, text }),
      );
      return result ?? text;
    },
  };
}

/** @internal Exposed for testing only. */
export const _internals = {
  startSidecarServer,
  startIsolate,
  getIsolateConfig,
  buildNetworkPolicy,
  createSandbox,
  toAgentConfig,
  buildExecuteTool,
  buildHookInvoker,
  get IDLE_MS() {
    return _slotInternals.IDLE_MS;
  },
  set IDLE_MS(ms: number) {
    _slotInternals.IDLE_MS = ms;
  },
};

// ── Public API ───────────────────────────────────────────────────────────

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, apiKey, agentEnv, kvStore, scope, vectorStore } = opts;

  const kv = scopedKv(kvStore, scope);
  const vector = vectorStore ? scopedVector(vectorStore, scope) : undefined;
  const sidecar = await startSidecarServer(kv, vector);
  const authToken = randomBytes(32).toString("hex");
  const {
    port: isolatePort,
    runtime,
    crashed,
  } = await startIsolate(workerCode, sidecar.url, agentEnv, authToken);
  const config = await getIsolateConfig(isolatePort, authToken);
  const isolateUrl = `http://127.0.0.1:${isolatePort}`;
  const agentConfig = toAgentConfig(config);
  const executeTool = buildExecuteTool(isolateUrl, authToken, crashed);
  const hookInvoker = buildHookInvoker(isolateUrl, authToken, crashed);
  const s2sConfig = DEFAULT_S2S_CONFIG;
  const readyConfig = buildReadyConfig(s2sConfig);

  const sessions = new Map<string, Session>();

  console.info("Sandbox initialized", { slug: scope.slug, isolatePort });

  return {
    startSession(socket: SessionWebSocket, skipGreeting?: boolean): void {
      wireSessionSocket(socket, {
        sessions,
        createSession: (sid, client) =>
          createS2sSession({
            id: sid,
            agent: agentConfig.name,
            client,
            agentConfig,
            toolSchemas: config.toolSchemas,
            apiKey,
            s2sConfig,
            executeTool,
            hookInvoker,
            skipGreeting: skipGreeting ?? false,
          }),
        readyConfig,
      });
    },
    async terminate(): Promise<void> {
      // Stop all sessions before disposing runtime/sidecar.
      const stops = [...sessions.values()].map((s) =>
        s.stop().catch((err) => {
          console.warn("Session stop failed during sandbox terminate:", err);
        }),
      );
      await Promise.all(stops);
      sessions.clear();
      // Async terminate() avoids "Isolate is disposed" rejections from in-flight ops.
      await runtime.terminate().catch((err) => {
        console.warn("Runtime terminate failed:", err);
      });
      try {
        sidecar.close();
      } catch {
        /* already closed */
      }
    },
  };
}
