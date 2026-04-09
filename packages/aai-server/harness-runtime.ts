// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox harness runtime — runs inside the secure-exec V8 isolate.
 *
 * Implements a file-per-tool RPC dispatcher. Each tool and hook is a separate
 * handler module with a `default` export, rather than a single AgentDef bundle.
 *
 * Communicates with the host via secure-exec bindings (V8 bridge IPC):
 * - KV operations: `SecureExec.bindings.kv.*` (get, set, del)
 * - RPC work queue: `SecureExec.bindings.rpc.recv()` blocks until the host
 *   enqueues a tool/hook request, then `.rpc.send()` returns the result.
 *
 * No HTTP servers, no auth tokens, no network access required.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type ToolHandler = {
  default: (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type HookHandler = {
  default: (...args: unknown[]) => Promise<void> | void;
};

type ToolContext = {
  env: Readonly<Record<string, string>>;
  kv: Kv;
  messages: readonly { role: string; content: string }[];
  sessionId: string;
};

type HookContext = {
  env: Readonly<Record<string, string>>;
  kv: Kv;
  sessionId: string;
};

type Kv = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>;
  delete(key: string | string[]): Promise<void>;
};

type ToolRpcMessage = {
  type: "tool";
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  messages: { role: string; content: string }[];
};

type HookRpcMessage = {
  type: "hook";
  hook: string;
  sessionId: string;
  text?: string;
  error?: { message: string };
};

type RpcMessage = ToolRpcMessage | HookRpcMessage;

type DispatchResult = { result?: string; error?: boolean };

// ── Null KV (used when no KV bindings provided) ───────────────────────

const nullKv: Kv = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
};

// ── Tool dispatch ──────────────────────────────────────────────────────

async function dispatchTool(
  tools: Record<string, ToolHandler>,
  msg: ToolRpcMessage,
  env: Readonly<Record<string, string>>,
  kv: Kv,
): Promise<DispatchResult> {
  const tool = tools[msg.name];
  if (!tool) {
    return {
      result: JSON.stringify({ error: `Unknown tool: ${msg.name}` }),
      error: true,
    };
  }

  const ctx: ToolContext = { env, kv, messages: msg.messages, sessionId: msg.sessionId };
  const result = await tool.default(msg.args, ctx);
  return { result: typeof result === "string" ? result : JSON.stringify(result) };
}

// ── Hook dispatch ──────────────────────────────────────────────────────

async function dispatchHook(
  hooks: Record<string, HookHandler>,
  msg: HookRpcMessage,
  env: Readonly<Record<string, string>>,
  kv: Kv,
): Promise<DispatchResult> {
  const hook = hooks[msg.hook];
  if (!hook) return {};

  const ctx: HookContext = { env, kv, sessionId: msg.sessionId };

  if (msg.hook === "onUserTranscript" && msg.text !== undefined) {
    await hook.default(msg.text, ctx);
  } else if (msg.hook === "onError" && msg.error) {
    await hook.default(msg.error, ctx);
  } else {
    await hook.default(ctx);
  }

  return {};
}

// ── Dispatcher factory ─────────────────────────────────────────────────

export function createDispatcher(opts: {
  tools: Record<string, ToolHandler>;
  hooks: Record<string, HookHandler>;
  env?: Record<string, string>;
  kv?: Kv;
}): (msg: RpcMessage) => Promise<DispatchResult> {
  const { tools, hooks } = opts;
  const env = Object.freeze(opts.env ?? {});
  const kv = opts.kv ?? nullKv;

  return async (msg: RpcMessage): Promise<DispatchResult> => {
    if (msg.type === "tool") return dispatchTool(tools, msg, env, kv);
    if (msg.type === "hook") return dispatchHook(hooks, msg, env, kv);
    return {};
  };
}

// ── Isolate entry point (used when running inside SecureExec) ──────────

// SecureExec type declarations for isolate environment
declare const SecureExec: {
  bindings: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown, expireIn?: number): Promise<void>;
      del(key: string): Promise<void>;
    };
    rpc: {
      recv(): Promise<(RpcMessage & { id: string }) | null>;
      send(id: string, result: unknown, errorMsg?: string): void;
    };
  };
};

export async function startDispatcher(
  tools: Record<string, ToolHandler>,
  hooks: Record<string, HookHandler>,
): Promise<void> {
  const AAI_ENV_PREFIX = "AAI_ENV_";
  const agentEnv: Record<string, string> = Object.freeze(
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
    set(key: string, value: unknown, opts?: { expireIn?: number }) {
      return SecureExec.bindings.kv.set(key, value, opts?.expireIn);
    },
    async delete(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) await SecureExec.bindings.kv.del(k);
    },
  };

  const dispatch = createDispatcher({ tools, hooks, env: agentEnv, kv });

  // Pull-based RPC loop: blocks on recv() until the host enqueues work
  let msg = await SecureExec.bindings.rpc.recv();
  while (msg) {
    const req = msg as RpcMessage & { id: string };
    try {
      const result = await dispatch(req);
      SecureExec.bindings.rpc.send(req.id, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      SecureExec.bindings.rpc.send(req.id, null, message);
    }
    msg = await SecureExec.bindings.rpc.recv();
  }
}
