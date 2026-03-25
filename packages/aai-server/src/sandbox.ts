// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent sandbox using secure-exec V8 isolates.
 *
 * Each deployed agent runs inside a secure-exec isolate. The isolate loads
 * the agent bundle and exposes tool execution + lifecycle hooks over HTTP
 * on loopback. The host calls `createS2sSession` + `wireSessionSocket`
 * directly — no WintercServer or proxy AgentDef needed.
 *
 * A per-sandbox sidecar server on the host provides scoped KV and
 * vector access — the isolate calls it without authentication (loopback only).
 */

import type { AgentConfig } from "@alexkroman1/aai/internal-types";
import { buildReadyConfig } from "@alexkroman1/aai/protocol";
import { DEFAULT_S2S_CONFIG } from "@alexkroman1/aai/runtime";
import { createS2sSession, type HookInvoker, type Session } from "@alexkroman1/aai/session";
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
  HookResponseSchema,
  type IsolateConfig,
  IsolateConfigSchema,
  ToolCallResponseSchema,
  TurnConfigResultSchema,
} from "./_harness-protocol.ts";
import type { KvStore } from "./kv.ts";
import { getHarnessRuntimeJs } from "./sandbox-harness.ts";
import { buildNetworkAdapter, buildNetworkPolicy } from "./sandbox-network.ts";
import { scopedKv, scopedVector, startSidecarServer } from "./sandbox-sidecar.ts";
import type { AgentScope } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

export type { AgentMetadata } from "./_schemas.ts";
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
  terminate(): void;
};

// ── Isolate lifecycle ────────────────────────────────────────────────────

async function startIsolate(
  workerCode: string,
  sidecarUrl: string,
  agentEnv: Record<string, string>,
): Promise<{ port: number; runtime: NodeRuntime }> {
  const harnessJs = await getHarnessRuntimeJs();
  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/agent_bundle.js", workerCode);
  await fs.writeFile("/app/_harness-runtime.js", harnessJs);

  // Prefix agent env vars so they can be distinguished from system vars.
  // The harness reads AAI_ENV_* and strips the prefix to build ctx.env.
  const prefixedEnv: Record<string, string> = { SIDECAR_URL: sidecarUrl };
  for (const [k, v] of Object.entries(agentEnv)) {
    prefixedEnv[`AAI_ENV_${k}`] = v;
  }
  const allowedKeys = new Set(Object.keys(prefixedEnv));

  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req) =>
          req.op === "read" || req.op === "stat" || req.op === "readdir" || req.op === "exists"
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
          if (parsed.success) resolvePort(parsed.data.port);
        } catch {
          // Not the port announcement, ignore
        }
      }
      if (event.channel === "stderr") {
        console.error("[isolate stderr]", event.message);
      }
    },
  });

  runtime.exec(
    'import agent from "/app/agent_bundle.js";\nimport { startHarness } from "/app/_harness-runtime.js";\nstartHarness(agent);',
    { cwd: "/app" },
  );

  const port = await portPromise;
  return { port, runtime };
}

// ── Isolate RPC ──────────────────────────────────────────────────────────

/** Timeout for initial config fetch (isolate boot). */
const CONFIG_TIMEOUT_MS = 10_000;
/** Timeout for tool execution calls. */
const TOOL_TIMEOUT_MS = 30_000;
/** Timeout for lifecycle hook calls. */
const HOOK_TIMEOUT_MS = 10_000;

async function getIsolateConfig(port: number): Promise<IsolateConfig> {
  const res = await fetch(`http://127.0.0.1:${port}/config`, {
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Isolate /config failed: ${res.status}`);
  return IsolateConfigSchema.parse(await res.json()) as IsolateConfig;
}

async function callIsolate<T>(
  isolateUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await fetch(`${isolateUrl}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status}`);
  return schema.parse(await res.json());
}

function buildExecuteTool(isolateUrl: string): ExecuteTool {
  return async (name, args, sessionId, messages) => {
    const { result } = await callIsolate(
      isolateUrl,
      "tool",
      { name, args, sessionId, messages },
      TOOL_TIMEOUT_MS,
      ToolCallResponseSchema,
    );
    return result;
  };
}

function buildHookInvoker(isolateUrl: string): HookInvoker {
  const hook = async (name: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    (
      await callIsolate(
        isolateUrl,
        "hook",
        { hook: name, ...extra },
        HOOK_TIMEOUT_MS,
        HookResponseSchema,
      )
    ).result;

  return {
    onConnect: (sessionId) => hook("onConnect", { sessionId }) as Promise<void>,
    onDisconnect: (sessionId) => hook("onDisconnect", { sessionId }) as Promise<void>,
    onTurn: (sessionId, text) => hook("onTurn", { sessionId, text }) as Promise<void>,
    onError: (sessionId, error) => hook("onError", { sessionId, error }) as Promise<void>,
    onStep: (sessionId, step) => hook("onStep", { sessionId, step }) as Promise<void>,
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
  };
}

function toAgentConfig(config: IsolateConfig): AgentConfig {
  const ac: AgentConfig = {
    name: config.name,
    instructions: config.instructions,
    greeting: config.greeting,
  };
  if (config.sttPrompt !== undefined) ac.sttPrompt = config.sttPrompt;
  if (config.maxSteps !== undefined) ac.maxSteps = config.maxSteps;
  if (config.toolChoice !== undefined) ac.toolChoice = config.toolChoice;
  if (config.builtinTools) ac.builtinTools = config.builtinTools as AgentConfig["builtinTools"];
  if (config.activeTools) ac.activeTools = config.activeTools;
  return ac;
}

// ── Test internals ───────────────────────────────────────────────────────

import { _slotInternals } from "./sandbox-slots.ts";

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

  // 1. Start the per-sandbox sidecar server (KV/vector on loopback)
  const sidecar = await startSidecarServer(kv, vector);

  // 2. Start the isolate with the agent bundle
  //    Only agent-defined secrets enter the isolate; apiKey stays host-side.
  const { port: isolatePort, runtime } = await startIsolate(workerCode, sidecar.url, agentEnv);

  // 3. Get the agent config from the isolate
  const config = await getIsolateConfig(isolatePort);
  const isolateUrl = `http://127.0.0.1:${isolatePort}`;

  // 4. Build executeTool + hookInvoker that proxy to the isolate
  //    env is no longer sent per-request — it lives inside the isolate
  const agentConfig = toAgentConfig(config);
  const executeTool = buildExecuteTool(isolateUrl);
  const hookInvoker = buildHookInvoker(isolateUrl);
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
    terminate(): void {
      for (const session of sessions.values()) {
        void session.stop();
      }
      sessions.clear();
      runtime.dispose();
      sidecar.close();
    },
  };
}
