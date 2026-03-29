// Copyright 2025 the AAI authors. MIT license.
/**
 * Hookable-based lifecycle and middleware hook system.
 *
 * Provides a unified hook registry built on {@link https://github.com/unjs/hookable | hookable}.
 * Lifecycle hooks (connect, disconnect, turn, error) and middleware pipeline
 * hooks (filterInput, beforeTurn, interceptToolCall, etc.) are all registered
 * on a single `Hookable<AgentHookMap>` instance.
 *
 * The low-level middleware pipeline functions in `middleware.ts` remain
 * dependency-free for use inside the secure-exec V8 isolate. This module
 * wraps them for host-side code (self-hosted runtime, platform sandbox).
 */

import { createHooks, type Hookable } from "hookable";
import {
  type MiddlewareErrorHandler,
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
  runInputFilters,
  runOutputFilters,
  runToolCallInterceptors,
} from "./middleware.ts";
import type { AgentDef, HookContext, Middleware, ToolCallInterceptResult } from "./types.ts";

// ─── Hook map ───────────────────────────────────────────────────────────────

/**
 * Map of all agent hook names to their function signatures.
 *
 * All hooks are typed as void-returning for hookable compatibility.
 * Value-returning hooks (filterInput, beforeTurn, interceptToolCall, etc.)
 * are invoked via {@link callHookWith} with custom callers that extract
 * the return value from the underlying handler.
 */
export interface AgentHookMap {
  connect: (sessionId: string, timeoutMs?: number) => void | Promise<void>;
  disconnect: (sessionId: string, timeoutMs?: number) => void | Promise<void>;
  turn: (sessionId: string, text: string, timeoutMs?: number) => void | Promise<void>;
  error: (
    sessionId: string,
    error: { message: string },
    timeoutMs?: number,
  ) => void | Promise<void>;
  resolveTurnConfig: (sessionId: string, timeoutMs?: number) => void | Promise<void>;
  filterInput: (sessionId: string, text: string) => void | Promise<void>;
  beforeTurn: (sessionId: string, text: string) => void | Promise<void>;
  afterTurn: (sessionId: string, text: string) => void | Promise<void>;
  interceptToolCall: (
    sessionId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>;
  afterToolCall: (
    sessionId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: string,
  ) => void | Promise<void>;
  filterOutput: (sessionId: string, text: string) => void | Promise<void>;
}

/** A hookable instance typed to the agent hook map. */
export type AgentHooks = Hookable<AgentHookMap>;

// ─── Callers for value-returning hooks ──────────────────────────────────────

/**
 * Caller that invokes the first registered handler and returns its result.
 * Returns `fallback` when no handlers are registered.
 */
// biome-ignore lint/suspicious/noExplicitAny: hookable caller signature requires generic types
function firstResultCaller<T>(fallback: T): (fns: any[], args: any[], name: string) => Promise<T> {
  return async (fns, args) => {
    if (fns.length === 0) return fallback;
    return (await fns[0](...args)) ?? fallback;
  };
}

/** Caller for text-returning hooks. Falls back to the original text (second arg). */
// biome-ignore lint/suspicious/noExplicitAny: hookable caller signature
async function textResultCaller(fns: any[], args: any[], _name: string): Promise<string> {
  if (fns.length === 0) return args[1] as string;
  return (await fns[0](...args)) ?? (args[1] as string);
}

// ─── Convenience wrappers ───────────────────────────────────────────────────

/**
 * Call a text-returning hook (filterInput, filterOutput).
 * Returns the original text when no handler is registered.
 */
export async function callTextHook(
  hooks: AgentHooks | undefined,
  name: "filterInput" | "filterOutput",
  sessionId: string,
  text: string,
): Promise<string> {
  if (!hooks) return text;
  return hooks.callHookWith(textResultCaller, name, [sessionId, text]);
}

/**
 * Call the beforeTurn hook.
 * Returns the block reason string, or undefined to proceed.
 */
export async function callBeforeTurn(
  hooks: AgentHooks | undefined,
  sessionId: string,
  text: string,
): Promise<string | undefined> {
  if (!hooks) return;
  return hooks.callHookWith(firstResultCaller(undefined), "beforeTurn", [sessionId, text]);
}

/**
 * Call the interceptToolCall hook.
 * Returns the intercept result, or undefined to proceed normally.
 */
export async function callInterceptToolCall(
  hooks: AgentHooks | undefined,
  sessionId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolCallInterceptResult> {
  if (!hooks) return;
  return hooks.callHookWith(firstResultCaller(undefined), "interceptToolCall", [
    sessionId,
    tool,
    args,
  ]);
}

/**
 * Call the resolveTurnConfig hook.
 * Returns null when no handler is registered.
 */
export async function callResolveTurnConfig(
  hooks: AgentHooks | undefined,
  sessionId: string,
  timeoutMs?: number,
): Promise<{ maxSteps?: number } | null> {
  if (!hooks) return null;
  return hooks.callHookWith(firstResultCaller(null), "resolveTurnConfig", [sessionId, timeoutMs]);
}

// ─── Factory ────────────────────────────────────────────────────────────────

const defaultOnError: MiddlewareErrorHandler = ({ middleware, hook, error }) => {
  console.warn(`Middleware ${middleware} ${hook} failed:`, error);
};

/**
 * Create an {@link AgentHooks} instance from an agent definition.
 *
 * Registers lifecycle hooks from the agent's `onConnect`, `onDisconnect`,
 * `onTurn`, `onError` callbacks, and wraps the middleware pipeline via the
 * low-level runner functions from `middleware.ts`.
 */
export function createAgentHooks(opts: {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  makeCtx: (sessionId: string) => HookContext;
  onError?: MiddlewareErrorHandler;
}): AgentHooks {
  const { agent, makeCtx, onError = defaultOnError } = opts;
  const hooks = createHooks<AgentHookMap>();
  const middleware: readonly Middleware[] = agent.middleware ?? [];

  // ── Lifecycle hooks ─────────────────────────────────────────────────
  hooks.hook("connect", async (sessionId) => {
    await agent.onConnect?.(makeCtx(sessionId));
  });
  hooks.hook("disconnect", async (sessionId) => {
    await agent.onDisconnect?.(makeCtx(sessionId));
  });
  hooks.hook("turn", async (sessionId, text) => {
    await agent.onTurn?.(text, makeCtx(sessionId));
  });
  hooks.hook("error", async (sessionId, error) => {
    await agent.onError?.(new Error(error.message), makeCtx(sessionId));
  });

  // resolveTurnConfig — returns a value but hookable types it as void.
  // The actual return value is extracted by callResolveTurnConfig via callHookWith.
  hooks.hook("resolveTurnConfig", (async (sessionId: string) => {
    const ctx = makeCtx(sessionId);
    const maxSteps =
      typeof agent.maxSteps === "function" ? ((await agent.maxSteps(ctx)) ?? undefined) : undefined;
    if (maxSteps === undefined) return null;
    return { maxSteps };
    // biome-ignore lint/suspicious/noExplicitAny: handler returns value extracted via callHookWith
  }) as any);

  // ── Middleware pipeline hooks ────────────────────────────────────────
  if (middleware.length > 0) {
    hooks.hook(
      "filterInput",
      // biome-ignore lint/suspicious/noExplicitAny: hookable types all hooks as void-returning
      ((sid: string, text: string) =>
        runInputFilters(middleware, { ...makeCtx(sid), text }, onError)) as any,
    );
    hooks.hook("beforeTurn", (async (sessionId: string, text: string) => {
      const result = await runBeforeTurnMiddleware(
        middleware,
        { ...makeCtx(sessionId), text },
        onError,
      );
      return result?.reason;
    }) as any);
    hooks.hook("afterTurn", async (sessionId, text) =>
      runAfterTurnMiddleware(middleware, { ...makeCtx(sessionId), text }, onError),
    );
    hooks.hook("interceptToolCall", (async (
      sessionId: string,
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) =>
      runToolCallInterceptors(middleware, { ...makeCtx(sessionId), tool, args }, onError)) as any);
    hooks.hook("afterToolCall", async (sessionId, tool, args, result) =>
      runAfterToolCallMiddleware(
        middleware,
        { ...makeCtx(sessionId), tool, args, result },
        onError,
      ),
    );
    hooks.hook(
      "filterOutput",
      // biome-ignore lint/suspicious/noExplicitAny: hookable types all hooks as void-returning
      ((sid: string, text: string) =>
        runOutputFilters(middleware, { ...makeCtx(sid), text }, onError)) as any,
    );
  }

  return hooks;
}
