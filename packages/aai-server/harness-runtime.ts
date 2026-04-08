// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness runtime — runs inside the secure-exec V8 isolate.
 *
 * Communicates with the host via secure-exec bindings (V8 bridge IPC):
 * - KV operations: `SecureExec.bindings.kv.*` (get, set, del, list, keys)
 * - RPC work queue: `SecureExec.bindings.rpc.recv()` blocks until the host
 *   enqueues a tool/hook/config request, then `.rpc.send()` returns the result.
 *
 * No HTTP servers, no auth tokens, no network access required.
 */
import { type AgentHooks, callResolveTurnConfig, createAgentHooks } from "@alexkroman1/aai/hooks";
import type { Kv } from "@alexkroman1/aai/kv";
import type { AgentDef, ToolContext } from "@alexkroman1/aai/types";

// Types duplicated from rpc-schemas.ts — the harness runs in a secure-exec
// isolate where the bundler cannot resolve ./rpc-schemas.ts (it imports zod).
// Keep these in sync with the Zod schemas in rpc-schemas.ts.
type IsolateConfig = {
  name: string;
  systemPrompt: string;
  greeting?: string;
  sttPrompt?: string;
  maxSteps?: number;
  toolChoice?: "auto" | "required";
  builtinTools?: string[];
  toolSchemas: { name: string; description: string; parameters: Record<string, unknown> }[];
  hasState: boolean;
  hooks: {
    onConnect: boolean;
    onDisconnect: boolean;
    onError: boolean;
    onUserTranscript: boolean;
    maxStepsIsFn: boolean;
  };
};
type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: { role: "user" | "assistant" | "tool"; content: string }[];
};
type ToolCallResponse = { result: string; state: Record<string, unknown> };
type HookRequest = { hook: string; sessionId: string; text?: string; error?: { message: string } };
type HookResponse = { state: Record<string, unknown>; result?: unknown };

// ── SecureExec bindings type (injected by secure-exec as a runtime global) ──

declare const SecureExec: {
  bindings: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown, expireIn?: number): Promise<void>;
      del(key: string): Promise<void>;
      list(
        prefix: string,
        limit?: number,
        reverse?: boolean,
      ): Promise<{ key: string; value: unknown }[]>;
      keys(pattern?: string): Promise<string[]>;
    };
    rpc: {
      /** Blocks until the host enqueues a request. Returns null on shutdown. */
      recv(): Promise<(RpcRequest & { id: string }) | null>;
      /** Return a result (or error) for a given request ID. */
      send(id: string, result: unknown, errorMsg?: string): void;
    };
  };
};

/** Lazily initialized per-session state manager. */
function createSessionStateMap(initState?: () => Record<string, unknown>): {
  get(sessionId: string): Record<string, unknown>;
  set(sessionId: string, state: Record<string, unknown>): void;
  delete(sessionId: string): boolean;
} {
  const map = new Map<string, Record<string, unknown>>();
  return {
    get(sessionId: string): Record<string, unknown> {
      if (!map.has(sessionId) && initState) {
        map.set(sessionId, initState());
      }
      return map.get(sessionId) ?? {};
    },
    set(sessionId: string, state: Record<string, unknown>): void {
      map.set(sessionId, state);
    },
    delete(sessionId: string): boolean {
      return map.delete(sessionId);
    },
  };
}

/** Lightweight error for RPC responses. */
class RpcError extends Error {}

const AAI_ENV_PREFIX = "AAI_ENV_";
const agentEnv: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
      .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
  ),
);

// ── KV via secure-exec bindings ─────────────────────────────────────────

const kv: Kv = {
  get<T = unknown>(key: string) {
    return SecureExec.bindings.kv.get(key) as Promise<T | null>;
  },
  set(key: string, value: unknown, options?: { expireIn?: number }) {
    return SecureExec.bindings.kv.set(key, value, options?.expireIn);
  },
  delete(key: string) {
    return SecureExec.bindings.kv.del(key);
  },
  list<T = unknown>(prefix: string, options?: { limit?: number; reverse?: boolean }) {
    return SecureExec.bindings.kv.list(prefix, options?.limit, options?.reverse) as Promise<
      { key: string; value: T }[]
    >;
  },
  keys(pattern?: string) {
    return SecureExec.bindings.kv.keys(pattern);
  },
};

// ── Agent introspection ─────────────────────────────────────────────────

let sessionState: ReturnType<typeof createSessionStateMap>;
let hooks: AgentHooks;

function extractToolSchemas(agent: AgentDef): IsolateConfig["toolSchemas"] {
  return Object.entries(agent.tools).map(([name, def]) => ({
    name,
    description: def.description,
    parameters:
      def.parameters && "toJSON" in def.parameters && typeof def.parameters.toJSON === "function"
        ? (def.parameters.toJSON() as Record<string, unknown>)
        : ({ type: "object", properties: {} } as Record<string, unknown>),
  }));
}

function extractConfig(agent: AgentDef): IsolateConfig {
  const config: IsolateConfig = {
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    greeting: agent.greeting,
    toolSchemas: extractToolSchemas(agent),
    hasState: typeof agent.state === "function",
    hooks: {
      onConnect: typeof agent.onConnect === "function",
      onDisconnect: typeof agent.onDisconnect === "function",
      onError: typeof agent.onError === "function",
      onUserTranscript: typeof agent.onUserTranscript === "function",
      maxStepsIsFn: typeof agent.maxSteps === "function",
    },
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
  return config;
}

// ── Tool execution ──────────────────────────────────────────────────────

/** Must match HARNESS_TOOL_TIMEOUT_MS in constants.ts (30s). */
const TOOL_TIMEOUT_MS = 30_000;

async function executeTool(agent: AgentDef, req: ToolCallRequest): Promise<ToolCallResponse> {
  const tool = agent.tools[req.name];
  if (!tool) throw new RpcError(`Unknown tool: ${req.name}`);

  const ctx: ToolContext = {
    env: agentEnv,
    state: sessionState.get(req.sessionId),
    sessionId: req.sessionId,
    kv,
    messages: req.messages,
  };

  const parsed =
    tool.parameters && typeof tool.parameters.parse === "function"
      ? tool.parameters.parse(req.args)
      : req.args;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      tool.execute(parsed, ctx),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new RpcError(`Tool "${req.name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
          TOOL_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
      state: ctx.state,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Hook invocation ─────────────────────────────────────────────────────

async function invokeHook(req: HookRequest): Promise<HookResponse> {
  let result: unknown;
  switch (req.hook) {
    case "onConnect":
      await hooks.callHook("connect", req.sessionId);
      break;
    case "onDisconnect":
      await hooks.callHook("disconnect", req.sessionId);
      sessionState.delete(req.sessionId);
      break;
    case "onUserTranscript":
      await hooks.callHook("userTranscript", req.sessionId, req.text ?? "");
      break;
    case "resolveTurnConfig":
      result = await callResolveTurnConfig(hooks, req.sessionId);
      break;
    default:
      break;
  }
  return { state: sessionState.get(req.sessionId), result };
}

// ── RPC dispatch ────────────────────────────────────────────────────────

type RpcRequest =
  | { type: "config" }
  | ({ type: "tool" } & ToolCallRequest)
  | ({ type: "hook" } & HookRequest);

async function dispatch(agent: AgentDef, msg: RpcRequest): Promise<unknown> {
  switch (msg.type) {
    case "config":
      return extractConfig(agent);
    case "tool":
      return executeTool(agent, msg);
    case "hook":
      return invokeHook(msg);
    default:
      throw new RpcError("Unknown RPC type");
  }
}

// ── Harness entry point ─────────────────────────────────────────────────

export function startHarness(agent: AgentDef): void {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }
  sessionState = createSessionStateMap(agent.state);
  hooks = createAgentHooks({
    agent,
    makeCtx: (sid) => ({ env: agentEnv, state: sessionState.get(sid), sessionId: sid, kv }),
  });

  // Pull-based RPC loop: blocks on recv() until the host enqueues work
  void (async () => {
    let msg = await SecureExec.bindings.rpc.recv();
    while (msg) {
      const req = msg as RpcRequest & { id: string };
      try {
        const result = await dispatch(agent, req);
        SecureExec.bindings.rpc.send(req.id, result);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : "Internal error";
        SecureExec.bindings.rpc.send(req.id, null, errMsg);
      }
      msg = await SecureExec.bindings.rpc.recv();
    }
  })();
}
