// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
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
} from "../isolate/_internal-types.ts";
import { errorDetail, errorMessage, toolError } from "../isolate/_utils.ts";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, TOOL_EXECUTION_TIMEOUT_MS } from "../isolate/constants.ts";
import { type AgentHooks, createAgentHooks } from "../isolate/hooks.ts";
import type { Kv } from "../isolate/kv.ts";
import type { ClientSink } from "../isolate/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../isolate/protocol.ts";
import type { AgentDef, HookContext, Message, ToolContext, ToolDef } from "../isolate/types.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin-tools.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type Session } from "./session.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

export type { ExecuteTool } from "../isolate/_internal-types.ts";

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
 * Implemented by {@link createRuntime} and the platform sandbox.
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
 * Configuration for {@link createRuntime}.
 *
 * Configures the agent, environment, KV store, logging, and S2S connection.
 *
 * @public
 */
export type RuntimeOptions = {
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
  /**
   * Override tool execution. When provided, `createRuntime` skips building
   * in-process tool definitions and uses this function instead. Used by the
   * platform sandbox to RPC tool calls to the isolate.
   */
  executeTool?: ExecuteTool | undefined;
  /**
   * Override lifecycle hooks. When provided, `createRuntime` skips building
   * in-process hooks and uses these instead. Used by the platform sandbox
   * to RPC hook calls to the isolate.
   */
  hooks?: AgentHooks | undefined;
  /**
   * Override tool schemas sent to the S2S API. Required when `executeTool`
   * is provided (the host doesn't have the tool definitions to derive schemas).
   */
  toolSchemas?: ToolSchema[] | undefined;
};

/**
 * The agent runtime returned by {@link createRuntime}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code, and also exposes
 * lower-level helpers (`executeTool`, `hooks`, `toolSchemas`,
 * `createSession`) for testing and advanced usage.
 *
 * @public
 */
export type Runtime = AgentRuntime & {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Hookable instance wired to the agent's lifecycle hooks. */
  hooks: AgentHooks;
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
 * Create an agent runtime — the execution engine for a voice agent.
 *
 * Merges built-in and custom tool definitions, builds tool schemas for the
 * S2S API, and wires up lifecycle hooks.
 *
 * @param opts - Runtime configuration. See {@link RuntimeOptions}.
 * @returns A {@link Runtime} with tool execution, hook invocation,
 *   schemas, and session management.
 *
 * @public
 */
export function createRuntime(opts: RuntimeOptions): Runtime {
  const {
    agent,
    env,
    kv = createLocalKv(),
    createWebSocket,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
    sessionStartTimeoutMs,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = opts;
  const agentConfig = toAgentConfig(agent);
  const sessions = new Map<string, Session>();
  const readyConfig: ReadyConfig = buildReadyConfig(s2sConfig);

  // When overrides are provided (sandbox mode), skip in-process tool/hook setup
  let executeTool: ExecuteTool;
  let hooks: AgentHooks;
  let toolSchemas: ToolSchema[];

  if (opts.executeTool && opts.hooks && opts.toolSchemas) {
    // Sandbox mode — tools/hooks are RPC-backed
    executeTool = opts.executeTool;
    hooks = opts.hooks;
    toolSchemas = opts.toolSchemas;
  } else {
    // Self-hosted mode — in-process tool execution
    const builtinDefs = getBuiltinToolDefs(agent.builtinTools ?? []);
    const allTools: Record<string, AgentDef["tools"][string]> = {
      ...builtinDefs,
      ...agent.tools,
    };
    const customSchemas = agentToolsToSchemas(agent.tools ?? {});
    const builtinSchemas = getBuiltinToolSchemas(agent.builtinTools ?? []);
    toolSchemas = [...customSchemas, ...builtinSchemas];

    const stateMap = new Map<string, Record<string, unknown>>();
    const getState = (sid: string) => {
      if (!stateMap.has(sid) && agent.state) stateMap.set(sid, agent.state());
      return stateMap.get(sid) ?? {};
    };
    const frozenEnv = Object.freeze({ ...env });

    function makeHookContext(sessionId: string): HookContext {
      return {
        env: frozenEnv,
        state: getState(sessionId),
        sessionId,
        get kv() {
          return kv;
        },
        fetch: globalThis.fetch,
      };
    }

    executeTool = async (name, args, sessionId, messages) => {
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
        fetch: globalThis.fetch,
      });
    };

    hooks = createAgentHooks({ agent, makeCtx: makeHookContext });
    hooks.hook("disconnect", async (sessionId) => {
      stateMap.delete(sessionId);
    });
  }

  function createSession(sessionOpts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
    resumeFrom?: string;
  }): Session {
    const apiKey = env.ASSEMBLYAI_API_KEY ?? "";
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
      hooks,
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
    hooks,
    toolSchemas,
    createSession,
    startSession,
    shutdown,
    readyConfig,
  };
}
