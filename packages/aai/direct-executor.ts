// Copyright 2025 the AAI authors. MIT license.
/**
 * Direct tool execution for self-hosted mode.
 *
 * In self-hosted mode, agent code is trusted (you're running your own code).
 * Tools execute directly in-process — no sandbox, no RPC.
 */

import pTimeout from "p-timeout";
import { createStorage } from "unstorage";
import type { z } from "zod";
import {
  agentToolsToSchemas,
  EMPTY_PARAMS,
  type ExecuteTool,
  type ToolSchema,
  toAgentConfig,
} from "./_internal-types.ts";
import { ssrfSafeFetch } from "./_ssrf.ts";
import { errorDetail, errorMessage, toolError } from "./_utils.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin-tools.ts";
import { TOOL_EXECUTION_TIMEOUT_MS } from "./constants.ts";
import type { Kv } from "./kv.ts";
import { buildMiddlewareRunner, type HookInvoker, type LifecycleHooks } from "./middleware.ts";
import type { ClientSink } from "./protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type Session } from "./session.ts";
import type { AgentDef, HookContext, Message, ToolContext, ToolDef } from "./types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

export type { ExecuteTool } from "./_internal-types.ts";

// ─── Tool execution (formerly worker-entry.ts) ─────────────────────────────

const yieldTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  state?: Record<string, unknown>;
  sessionId?: string | undefined;
  kv?: Kv | undefined;
  messages?: readonly Message[] | undefined;
  logger?: Logger | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

function buildToolContext(opts: ExecuteToolCallOptions): ToolContext {
  const { env, state, kv, messages, fetch: fetchFn, sessionId } = opts;
  return {
    env: { ...env },
    state: state ?? {},
    get kv(): Kv {
      if (!kv) throw new Error("KV not available");
      return kv;
    },
    messages: messages ?? [],
    fetch: fetchFn ?? globalThis.fetch,
    sessionId: sessionId ?? "",
  };
}

export async function executeToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { tool } = options;
  const schema = tool.parameters ?? EMPTY_PARAMS;
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? [])
      .map((i: z.ZodIssue) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join(", ");
    return toolError(`Invalid arguments for tool "${name}": ${issues}`);
  }

  try {
    const ctx = buildToolContext(options);
    await yieldTick();
    const result = await pTimeout(Promise.resolve(tool.execute(parsed.data, ctx)), {
      milliseconds: TOOL_EXECUTION_TIMEOUT_MS,
      message: `Tool "${name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`,
    });
    await yieldTick();
    if (result == null) return "null";
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err: unknown) {
    const log = options.logger;
    if (log) {
      log.warn("Tool execution failed", { tool: name, error: errorDetail(err) });
    } else {
      console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
    }
    return toolError(errorMessage(err));
  }
}

// ─── Runtime adapter (formerly adapter.ts) ──────────────────────────────────

/** Per-session options passed to {@link AgentRuntime.startSession}. */
export type SessionStartOptions = {
  skipGreeting?: boolean;
  resumeFrom?: string;
  logContext?: Record<string, string>;
  onOpen?: () => void;
  onClose?: () => void;
};

/**
 * Common interface for agent runtimes.
 *
 * Implemented by the self-hosted direct executor and the platform sandbox.
 */
export type AgentRuntime = {
  startSession(ws: SessionWebSocket, opts?: SessionStartOptions): void;
  shutdown(): Promise<void>;
  readonly readyConfig: ReadyConfig;
};

// ─── Direct executor ────────────────────────────────────────────────────────

/** Create an in-memory KV store (default for self-hosted). */
function createLocalKv(): Kv {
  return createUnstorageKv({ storage: createStorage() });
}

/**
 * Configuration for creating a direct (in-process) tool executor for self-hosted mode.
 *
 * In self-hosted mode, agent tools run directly in the Node process — no sandbox or
 * RPC layer. This type configures the agent, environment, stores, and logging.
 */
export type DirectExecutorOptions = {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  env: Record<string, string>;
  kv?: Kv | undefined;
  /** Custom WebSocket factory for the S2S connection (useful for testing). */
  createWebSocket?: CreateS2sWebSocket | undefined;
  logger?: Logger | undefined;
  s2sConfig?: S2SConfig | undefined;
  /**
   * Timeout in ms for `session.start()` (S2S connection setup).
   * Defaults to 10 000 (10 s).
   */
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Maximum time in milliseconds to wait for sessions to stop during
   * {@link AgentRuntime.shutdown | shutdown()}. Defaults to `30_000` (30 s).
   */
  shutdownTimeoutMs?: number | undefined;
};

/**
 * The direct (in-process) executor returned by {@link createDirectExecutor}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code, and also exposes
 * lower-level helpers (`executeTool`, `hookInvoker`, `toolSchemas`,
 * `createSession`) for testing and advanced usage.
 */
export type DirectExecutor = AgentRuntime & {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Hook invoker wired to the agent's lifecycle hooks and middleware. */
  hookInvoker: HookInvoker;
  /** Tool schemas registered with the S2S API (custom + built-in). */
  toolSchemas: ToolSchema[];
  /** Create a new voice session for a connected client (lower-level than startSession). */
  createSession(opts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
    resumeFrom?: string;
  }): Session;
};

/**
 * Create a direct (in-process) tool executor and hook invoker for an agent.
 *
 * Merges built-in and custom tool definitions, builds tool schemas for the
 * S2S API, and wires up middleware and lifecycle hooks.
 *
 * @param opts - Executor configuration. See {@link DirectExecutorOptions}.
 * @returns A {@link DirectExecutor} with tool execution, hook invocation,
 *   schemas, and session creation.
 */
export function createDirectExecutor(opts: DirectExecutorOptions): DirectExecutor {
  const {
    agent,
    env,
    kv = createLocalKv(),
    createWebSocket,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
    sessionStartTimeoutMs,
    shutdownTimeoutMs = 30_000,
  } = opts;
  const agentConfig = toAgentConfig(agent);
  const sessions = new Map<string, Session>();
  const readyConfig: ReadyConfig = buildReadyConfig(s2sConfig);

  // Merge custom + builtin tool definitions
  const builtinDefs = getBuiltinToolDefs(agent.builtinTools ?? []);
  const allTools: Record<string, AgentDef["tools"][string]> = {
    ...builtinDefs,
    ...agent.tools,
  };

  // Build tool schemas for the S2S API
  const customSchemas = agentToolsToSchemas(agent.tools ?? {});
  const builtinSchemas = getBuiltinToolSchemas(agent.builtinTools ?? []);
  const toolSchemas: ToolSchema[] = [...customSchemas, ...builtinSchemas];

  // Per-session mutable state
  const stateMap = new Map<string, Record<string, unknown>>();
  const getState = (sid: string) => {
    if (!stateMap.has(sid) && agent.state) stateMap.set(sid, agent.state());
    return stateMap.get(sid) ?? {};
  };
  const frozenEnv = Object.freeze({ ...env });

  /** SSRF-safe fetch for tool/hook contexts in self-hosted mode. */
  const safeFetch: typeof globalThis.fetch = (input, init) => {
    const req = new Request(input, init);
    return ssrfSafeFetch(req.url, { ...init, method: req.method }, globalThis.fetch);
  };

  function makeHookContext(sessionId: string): HookContext {
    return {
      env: frozenEnv,
      state: getState(sessionId),
      sessionId,
      get kv() {
        return kv;
      },
      fetch: safeFetch,
    };
  }

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const tool = allTools[name];
    if (!tool) return toolError(`Unknown tool: ${name}`);

    return executeToolCall(name, args, {
      tool,
      env: frozenEnv,
      state: getState(sessionId ?? ""),
      sessionId: sessionId ?? "",
      kv,
      messages,
      logger,
      fetch: safeFetch,
    });
  };

  // ── Lifecycle hooks (always present) ─────────────────────────────────
  const lifecycleHooks: LifecycleHooks = {
    async onConnect(sessionId) {
      await agent.onConnect?.(makeHookContext(sessionId));
    },
    async onDisconnect(sessionId) {
      await agent.onDisconnect?.(makeHookContext(sessionId));
      stateMap.delete(sessionId);
    },
    async onTurn(sessionId, text) {
      await agent.onTurn?.(text, makeHookContext(sessionId));
    },
    async onError(sessionId, error) {
      await agent.onError?.(new Error(error.message), makeHookContext(sessionId));
    },
    async resolveTurnConfig(sessionId) {
      const ctx = makeHookContext(sessionId);
      const maxSteps =
        typeof agent.maxSteps === "function"
          ? ((await agent.maxSteps(ctx)) ?? undefined)
          : undefined;
      if (maxSteps === undefined) return null;
      return { maxSteps };
    },
  };

  // ── Middleware runner (only built when middleware exists) ────────────
  const middlewareRunner = buildMiddlewareRunner(agent.middleware ?? [], makeHookContext);
  const hookInvoker: HookInvoker = { ...lifecycleHooks, ...middlewareRunner };

  function createSession(sessionOpts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
    resumeFrom?: string;
  }): Session {
    const apiKey = frozenEnv.ASSEMBLYAI_API_KEY ?? "";
    return createS2sSession({
      id: sessionOpts.id,
      agent: sessionOpts.agent,
      client: sessionOpts.client,
      agentConfig,
      toolSchemas,
      apiKey,
      s2sConfig,
      executeTool,
      ...(createWebSocket ? { createWebSocket } : {}),
      hookInvoker,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      logger,
      ...(sessionOpts.resumeFrom ? { resumeFrom: sessionOpts.resumeFrom } : {}),
    });
  }

  // ── AgentRuntime methods ──────────────────────────────────────────────

  function startSession(ws: SessionWebSocket, startOpts?: SessionStartOptions): void {
    const resumeFrom = startOpts?.resumeFrom;
    wireSessionSocket(ws, {
      sessions,
      createSession: (sid, client) =>
        createSession({
          id: sid,
          agent: agent.name,
          client,
          skipGreeting: startOpts?.skipGreeting ?? false,
          ...(resumeFrom ? { resumeFrom } : {}),
        }),
      readyConfig,
      logger,
      ...(startOpts?.logContext ? { logContext: startOpts.logContext } : {}),
      ...(startOpts?.onOpen ? { onOpen: startOpts.onOpen } : {}),
      ...(startOpts?.onClose ? { onClose: startOpts.onClose } : {}),
      ...(sessionStartTimeoutMs !== undefined ? { sessionStartTimeoutMs } : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
    });
  }

  async function shutdown(): Promise<void> {
    if (sessions.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(resolve, shutdownTimeoutMs, "timeout");
    });
    const graceful = Promise.allSettled([...sessions.values()].map((s) => s.stop())).then(
      (results) => {
        for (const r of results) {
          if (r.status === "rejected")
            logger.warn(`Session stop failed during shutdown: ${r.reason}`);
        }
        return "done" as const;
      },
    );
    const outcome = await Promise.race([graceful, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      logger.warn(
        `Shutdown timeout (${shutdownTimeoutMs}ms) exceeded — force-closing ${sessions.size} remaining session(s)`,
      );
    }
    sessions.clear();
  }

  return {
    executeTool,
    hookInvoker,
    toolSchemas,
    createSession,
    startSession,
    shutdown,
    readyConfig,
  };
}
