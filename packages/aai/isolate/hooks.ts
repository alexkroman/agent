// Copyright 2025 the AAI authors. MIT license.
/**
 * Hookable-based lifecycle hook system.
 *
 * Provides a unified hook registry built on {@link https://github.com/unjs/hookable | hookable}.
 * Lifecycle hooks (connect, disconnect, userTranscript, error, resolveTurnConfig) are
 * registered on a single `Hookable<AgentHookMap>` instance.
 */

import { createHooks, type Hookable } from "hookable";
import type { AgentDef, HookContext } from "./types.ts";

// ─── Hook map ───────────────────────────────────────────────────────────────

/**
 * Map of all agent hook names to their function signatures.
 *
 * All hooks are typed as void-returning for hookable compatibility.
 * Value-returning hooks (resolveTurnConfig) are invoked via
 * {@link callHookWith} with a custom caller that extracts the return value.
 */
export interface AgentHookMap {
  connect: (sessionId: string, timeoutMs?: number) => void | Promise<void>;
  disconnect: (sessionId: string, timeoutMs?: number) => void | Promise<void>;
  userTranscript: (sessionId: string, text: string, timeoutMs?: number) => void | Promise<void>;
  error: (
    sessionId: string,
    error: { message: string },
    timeoutMs?: number,
  ) => void | Promise<void>;
  resolveTurnConfig: (sessionId: string, timeoutMs?: number) => void | Promise<void>;
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

// ─── Convenience wrappers ───────────────────────────────────────────────────

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

/**
 * Create an {@link AgentHooks} instance from an agent definition.
 *
 * Registers lifecycle hooks from the agent's `onConnect`, `onDisconnect`,
 * `onUserTranscript`, `onError` callbacks.
 */
export function createAgentHooks(opts: {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  makeCtx: (sessionId: string) => HookContext;
}): AgentHooks {
  const { agent, makeCtx } = opts;
  const hooks = createHooks<AgentHookMap>();

  // ── Lifecycle hooks ─────────────────────────────────────────────────
  hooks.hook("connect", async (sessionId) => {
    await agent.onConnect?.(makeCtx(sessionId));
  });
  hooks.hook("disconnect", async (sessionId) => {
    await agent.onDisconnect?.(makeCtx(sessionId));
  });
  hooks.hook("userTranscript", async (sessionId, text) => {
    await agent.onUserTranscript?.(text, makeCtx(sessionId));
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

  return hooks;
}
