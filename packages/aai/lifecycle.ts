// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent lifecycle types — callbacks and combined hook invoker.
 *
 * Lifecycle hooks are agent callbacks (onConnect, onDisconnect, etc.).
 * Middleware is a separate concern (see middleware.ts).
 * HookInvoker combines both into a single dispatch interface.
 */

import type { MiddlewareRunner } from "./middleware.ts";

/** Agent lifecycle hooks — direct pass-throughs to agent callbacks. */
export type LifecycleHooks = {
  onConnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onDisconnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onTurn(sessionId: string, text: string, timeoutMs?: number): Promise<void>;
  onError(sessionId: string, error: { message: string }, timeoutMs?: number): Promise<void>;
  resolveTurnConfig(sid: string, ms?: number): Promise<{ maxSteps?: number } | null>;
};

/**
 * Combined interface for invoking agent lifecycle hooks and middleware.
 *
 * Lifecycle methods are always present. Middleware methods (filterInput,
 * beforeTurn, etc.) are only present when middleware is configured.
 * Callers should use optional chaining for middleware methods.
 */
export type HookInvoker = LifecycleHooks & Partial<MiddlewareRunner>;
