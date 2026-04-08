// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness runtime — runs inside the secure-exec V8 isolate.
 *
 * Communicates with the host via secure-exec bindings (V8 bridge IPC):
 * - KV operations: `SecureExec.bindings.kv.*` (get, set, del)
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
};

let sessionState: ReturnType<typeof createSessionStateMap>;
let hooks: AgentHooks;

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

type RpcRequest = ({ type: "tool" } & ToolCallRequest) | ({ type: "hook" } & HookRequest);

async function dispatch(agent: AgentDef, msg: RpcRequest): Promise<unknown> {
  switch (msg.type) {
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
