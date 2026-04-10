// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
 */

import { createStorage } from "unstorage";
import { agentToolsToSchemas, type ToolSchema, toAgentConfig } from "../sdk/_internal-types.ts";
import { toolError } from "../sdk/_utils.ts";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../sdk/protocol.ts";
import type { AgentDef } from "../sdk/types.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type Session } from "./session.ts";
import { type ExecuteTool, executeToolCall } from "./tool-executor.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

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

// ─── Runtime implementation ──────────────────────────────────────────────────

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
   * Override tool schemas sent to the S2S API. Required when `executeTool`
   * is provided (the host doesn't have the tool definitions to derive schemas).
   */
  toolSchemas?: ToolSchema[] | undefined;
  /** System prompt guidance for builtin tools. Passed through in sandbox mode. */
  toolGuidance?: string[] | undefined;
  /**
   * Pre-resolved builtin tool definitions. When provided alongside `executeTool`
   * and `toolSchemas`, skips calling `resolveAllBuiltins` on the host.
   */
  builtinDefs?: Record<string, import("../sdk/types.ts").ToolDef> | undefined;
  /**
   * Override the fetch implementation used by built-in tools (web_search,
   * visit_webpage, fetch_json). Defaults to `globalThis.fetch`.
   *
   * In platform mode, pass an SSRF-safe fetch to prevent requests to
   * private/internal networks. In self-hosted mode, users may provide
   * their own fetch wrapper.
   */
  fetch?: typeof globalThis.fetch | undefined;
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

  // When overrides are provided (sandbox mode), skip in-process tool setup
  let executeTool: ExecuteTool;
  let toolSchemas: ToolSchema[];
  let toolGuidance: string[] = [];

  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;

  if (opts.executeTool && opts.toolSchemas) {
    // Sandbox mode — custom tools are RPC-backed; builtins run host-side
    const builtinDefs =
      opts.builtinDefs ?? resolveAllBuiltins(agent.builtinTools ?? [], builtinFetchOpt).defs;
    const rpcExecuteTool = opts.executeTool;
    const frozenEnv = Object.freeze({ ...env });

    executeTool = async (name, args, sessionId, messages) => {
      // Handle builtins on the host (where SSRF-safe fetch lives)
      if (builtinDefs[name]) {
        const tool = builtinDefs[name];
        return executeToolCall(name, args, {
          tool,
          env: frozenEnv,
          sessionId: sessionId ?? "",
          kv,
          messages,
          logger,
        });
      }
      // Delegate custom tools to the isolate via RPC
      return rpcExecuteTool(name, args, sessionId, messages);
    };

    toolSchemas = opts.toolSchemas;
    toolGuidance = opts.toolGuidance ?? [];
  } else {
    // Self-hosted mode — in-process tool execution
    const builtins = resolveAllBuiltins(agent.builtinTools ?? [], builtinFetchOpt);
    const allTools: Record<string, AgentDef["tools"][string]> = {
      ...builtins.defs,
      ...agent.tools,
    };
    const customSchemas = agentToolsToSchemas(agent.tools ?? {});
    toolSchemas = [...customSchemas, ...builtins.schemas];
    toolGuidance = builtins.guidance;

    const stateMap = new Map<string, Record<string, unknown>>();
    const getState = (sid: string) => {
      if (!stateMap.has(sid) && agent.state) stateMap.set(sid, agent.state());
      return stateMap.get(sid) ?? {};
    };
    const frozenEnv = Object.freeze({ ...env });

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
      });
    };
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
      toolGuidance,
      apiKey,
      s2sConfig,
      executeTool,
      ...(createWebSocket ? { createWebSocket } : {}),
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
    let outcome: "done" | "timeout";
    try {
      outcome = await Promise.race([graceful, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome === "timeout") {
      logger.warn(
        `Shutdown timeout (${shutdownTimeoutMs}ms) exceeded — force-closing ${sessions.size} remaining session(s)`,
      );
    }
    sessions.clear();
  }

  return {
    executeTool,
    toolSchemas,
    createSession,
    startSession,
    shutdown,
    readyConfig,
  };
}
