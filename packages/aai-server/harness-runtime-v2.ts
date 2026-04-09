// Copyright 2025 the AAI authors. MIT license.
/**
 * File-per-tool RPC dispatcher for the isolate runtime (v2).
 *
 * Unlike harness-runtime.ts which takes a monolithic AgentDef, this dispatcher
 * works with individual tool and hook handler modules — one file per tool/hook.
 * This aligns with the directory-based agent format where tools live in
 * `tools/<name>.ts` and hooks in `hooks/<name>.ts`.
 *
 * Communicates with the host via SecureExec bindings (same V8 bridge IPC as v1).
 */
import type { Kv } from "@alexkroman1/aai/kv";
import type { Message, ToolContext } from "@alexkroman1/aai/types";

// ── Handler types ──────────────────────────────────────────────────────

/** A tool handler module (one file per tool). */
export type ToolHandler = {
  default: (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
  description?: string;
  parameters?: Record<string, unknown>;
};

/** A hook handler module (one file per hook). */
export type HookHandler = {
  default: (...args: unknown[]) => Promise<void> | void;
};

// ── RPC message types ──────────────────────────────────────────────────

type ToolCallMessage = {
  type: "tool";
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: Message[];
};

type HookMessage = {
  type: "hook";
  hook: string;
  sessionId: string;
  text?: string;
  error?: { message: string };
};

export type RpcMessage = ToolCallMessage | HookMessage;

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
      recv(): Promise<(RpcMessage & { id: string }) | null>;
      /** Return a result (or error) for a given request ID. */
      send(id: string, result: unknown, errorMsg?: string): void;
    };
  };
};

// ── Dispatcher ─────────────────────────────────────────────────────────

export type DispatcherOptions = {
  tools: Record<string, ToolHandler>;
  hooks: Record<string, HookHandler>;
  env?: Readonly<Record<string, string>>;
  kv?: Kv;
};

type DispatchResult = { result: string; error?: true } | Record<string, never>;

/**
 * Create a dispatch function that routes RPC messages to the appropriate
 * tool or hook handler.
 */
export function createDispatcher(
  opts: DispatcherOptions,
): (msg: RpcMessage) => Promise<DispatchResult> {
  const { tools, hooks, env = {}, kv } = opts;

  // Stub KV if not provided
  const kvStore: Kv = kv ?? {
    get: async () => null,
    set: async () => {
      /* noop */
    },
    delete: async () => {
      /* noop */
    },
  };

  return async (msg: RpcMessage): Promise<DispatchResult> => {
    if (msg.type === "tool") {
      return dispatchTool(msg, tools, env, kvStore);
    }
    if (msg.type === "hook") {
      return dispatchHook(msg, hooks, env, kvStore);
    }
    return { result: JSON.stringify({ error: "Unknown message type" }), error: true };
  };
}

async function dispatchTool(
  msg: ToolCallMessage,
  tools: Record<string, ToolHandler>,
  env: Readonly<Record<string, string>>,
  kv: Kv,
): Promise<DispatchResult> {
  const handler = tools[msg.name];
  if (!handler) {
    return { result: JSON.stringify({ error: `Unknown tool: ${msg.name}` }), error: true };
  }

  const ctx: ToolContext = {
    env,
    state: {},
    sessionId: msg.sessionId,
    kv,
    messages: msg.messages,
  };

  const result = await handler.default(msg.args, ctx);
  return { result: JSON.stringify(result) };
}

async function dispatchHook(
  msg: HookMessage,
  hooks: Record<string, HookHandler>,
  env: Readonly<Record<string, string>>,
  kv: Kv,
): Promise<DispatchResult> {
  const handler = hooks[msg.hook];
  if (!handler) {
    // Unknown hooks are silently ignored (forward compatibility)
    return {};
  }

  const ctx = { env, state: {}, sessionId: msg.sessionId, kv };

  switch (msg.hook) {
    case "onUserTranscript":
      await handler.default(msg.text ?? "", ctx);
      break;
    case "onError":
      await handler.default(msg.error ?? { message: "Unknown error" }, ctx);
      break;
    default:
      await handler.default(ctx);
      break;
  }

  return {};
}

// ── Entry point for SecureExec isolate ─────────────────────────────────

const AAI_ENV_PREFIX = "AAI_ENV_";

/**
 * Entry point for the isolate runtime. Sets up env filtering, KV bindings,
 * creates the dispatcher, and runs the pull-based RPC loop.
 */
export function startDispatcher(
  tools: Record<string, ToolHandler>,
  hooks: Record<string, HookHandler>,
): void {
  const agentEnv: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(
      Object.entries(process.env)
        .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
        .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
    ),
  );

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

  const dispatch = createDispatcher({ tools, hooks, env: agentEnv, kv });

  // Pull-based RPC loop: blocks on recv() until the host enqueues work
  void (async () => {
    let msg = await SecureExec.bindings.rpc.recv();
    while (msg) {
      const req = msg as RpcMessage & { id: string };
      try {
        const result = await dispatch(req);
        SecureExec.bindings.rpc.send(req.id, result);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : "Internal error";
        SecureExec.bindings.rpc.send(req.id, null, errMsg);
      }
      msg = await SecureExec.bindings.rpc.recv();
    }
  })();
}
