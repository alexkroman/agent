// Copyright 2025 the AAI authors. MIT license.
/**
 * Core harness logic — session state management, tool execution, hook invocation.
 *
 * Extracted from harness-runtime.ts for use in the guest Firecracker harness.
 * Unlike harness-runtime.ts, this module:
 * - Has no SecureExec references — KV is passed as a parameter
 * - Can import Zod schemas directly (no `import type` restriction)
 * - Exports all functions for direct use by the guest entrypoint
 * - Treats KV as async (passed in, not via synchronous SecureExec bindings)
 */

import { type AgentHooks, callResolveTurnConfig, createAgentHooks } from "@alexkroman1/aai/hooks";
import type { AgentDef, ToolContext } from "@alexkroman1/aai/types";
import type {
  HookRequest,
  HookResponse,
  ToolCallRequest,
  ToolCallResponse,
} from "../rpc-schemas.ts";

// ── KV interface ─────────────────────────────────────────────────────────────

/**
 * Async key-value store interface passed to the harness.
 *
 * In the guest harness, KV operations are forwarded to the host over vsock.
 * This interface mirrors the relevant subset of `Kv` from `@alexkroman1/aai/kv`
 * but uses `del` instead of `delete` to match the vsock KV request schema.
 */
export type KvInterface = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>;
  del(key: string): Promise<void>;
};

// ── Session state map ─────────────────────────────────────────────────────────

/**
 * Lazily initialized per-session state manager.
 *
 * Clones the default state factory result for each new session.
 * If no `initState` factory is provided, sessions start with an empty object.
 */
export function createSessionStateMap(initState?: () => Record<string, unknown>): {
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

// ── Tool execution ────────────────────────────────────────────────────────────

/** Must match HARNESS_TOOL_TIMEOUT_MS in constants.ts (30s). */
const TOOL_TIMEOUT_MS = 30_000;

/** Lightweight error for RPC-level failures. */
export class HarnessError extends Error {}

/**
 * Execute a tool call request.
 *
 * Looks up the named tool on the agent, parses args via its Zod schema (if
 * present), builds a ToolContext, and races the execute call against a timeout.
 *
 * @param agent - The agent definition containing tool implementations.
 * @param req - The tool call request (name, args, sessionId, messages).
 * @param sessionState - The session state map for this harness instance.
 * @param kv - Async KV interface, forwarded to ToolContext.
 * @returns The serialized tool result and current session state.
 * @throws HarnessError if the tool is unknown or times out.
 */
export async function executeTool(
  agent: AgentDef,
  req: ToolCallRequest,
  sessionState: ReturnType<typeof createSessionStateMap>,
  kv: KvInterface,
): Promise<ToolCallResponse> {
  const tool = agent.tools[req.name];
  if (!tool) throw new HarnessError(`Unknown tool: ${req.name}`);

  // Adapt KvInterface to the Kv shape expected by ToolContext.
  // The SDK Kv.delete() accepts string | string[]; wrap del() to match.
  const kvAdapter = {
    get: <T = unknown>(key: string) => kv.get(key) as Promise<T | null>,
    set: (key: string, value: unknown, options?: { expireIn?: number }) =>
      kv.set(key, value, options),
    delete: (key: string | string[]) => {
      if (Array.isArray(key)) {
        return Promise.all(key.map((k) => kv.del(k))).then(() => undefined);
      }
      return kv.del(key);
    },
  };

  const ctx: ToolContext = {
    env: getAgentEnv(),
    state: sessionState.get(req.sessionId),
    sessionId: req.sessionId,
    kv: kvAdapter,
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
          () => reject(new HarnessError(`Tool "${req.name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
          TOOL_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
      state: ctx.state as Record<string, unknown>,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Hook invocation ───────────────────────────────────────────────────────────

/**
 * Invoke a lifecycle hook.
 *
 * Dispatches to the appropriate hookable hook based on `req.hook`.
 * Returns the current session state and an optional hook result value.
 *
 * No KV is needed here — hooks access KV via the `makeCtx` closure passed
 * to `createAgentHooks` when the harness is initialized.
 *
 * @param hooks - The AgentHooks instance for this harness.
 * @param req - The hook request (hook name, sessionId, optional text/error).
 * @param sessionState - The session state map for this harness instance.
 * @returns The current session state and optional hook result.
 */
export async function invokeHook(
  hooks: AgentHooks,
  req: HookRequest,
  sessionState: ReturnType<typeof createSessionStateMap>,
): Promise<HookResponse> {
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

// ── Agent env ─────────────────────────────────────────────────────────────────

const AAI_ENV_PREFIX = "AAI_ENV_";

/**
 * Agent environment variables, filtered from process.env by the AAI_ENV_ prefix.
 * The prefix is stripped before the map is frozen and exposed to tools/hooks.
 */
/**
 * Agent environment variables, filtered from process.env by the AAI_ENV_ prefix.
 * Computed lazily on first access so that env vars set after module load
 * (e.g. from bundle injection) are included.
 */
let _agentEnv: Readonly<Record<string, string>> | null = null;

export function getAgentEnv(): Readonly<Record<string, string>> {
  if (!_agentEnv) {
    _agentEnv = Object.freeze(
      Object.fromEntries(
        Object.entries(process.env)
          .filter(([k]) => k.startsWith(AAI_ENV_PREFIX))
          .map(([k, v]) => [k.slice(AAI_ENV_PREFIX.length), v ?? ""]),
      ),
    );
  }
  return _agentEnv;
}

/** Reset cached env (call after setting new AAI_ENV_ vars). */
export function resetAgentEnv(): void {
  _agentEnv = null;
}

// ── Harness initializer ───────────────────────────────────────────────────────

/**
 * Initialize the harness state for an agent.
 *
 * Creates the session state map and the hookable hooks instance bound to the
 * agent. Returns both for use by the RPC dispatch loop.
 *
 * @param agent - The agent definition.
 * @param kv - Async KV interface, forwarded into hook contexts.
 * @returns The initialized session state map and hooks.
 */
export function initHarness(
  agent: AgentDef,
  kv: KvInterface,
): {
  sessionState: ReturnType<typeof createSessionStateMap>;
  hooks: AgentHooks;
} {
  if (!agent || typeof agent !== "object" || !agent.name) {
    throw new Error("Agent bundle must export a default agent definition");
  }

  const sessionState = createSessionStateMap(agent.state);

  const kvAdapter = {
    get: <T = unknown>(key: string) => kv.get(key) as Promise<T | null>,
    set: (key: string, value: unknown, options?: { expireIn?: number }) =>
      kv.set(key, value, options),
    delete: (key: string | string[]) => {
      if (Array.isArray(key)) {
        return Promise.all(key.map((k) => kv.del(k))).then(() => undefined);
      }
      return kv.del(key);
    },
  };

  const hooks = createAgentHooks({
    agent,
    makeCtx: (sid) => ({
      env: getAgentEnv(),
      state: sessionState.get(sid),
      sessionId: sid,
      kv: kvAdapter,
    }),
  });

  return { sessionState, hooks };
}
