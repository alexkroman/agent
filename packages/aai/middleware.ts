// Copyright 2025 the AAI authors. MIT license.
/**
 * Middleware runner — executes middleware chains for turns, tool calls,
 * and output filtering.
 *
 * Pure runner logic lives in middleware-core.ts (isolate-safe, zero deps).
 * This module re-exports it and adds the HookInvoker interface.
 */

import type { StepInfo } from "./types.ts";

export {
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
  runInputFilters,
  runOutputFilters,
  runToolCallInterceptors,
  type ToolInterceptResult,
} from "./middleware-core.ts";

/** Agent lifecycle hooks — direct pass-throughs to agent callbacks. */
export type LifecycleHooks = {
  onConnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onDisconnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onTurn(sessionId: string, text: string, timeoutMs?: number): Promise<void>;
  onError(sessionId: string, error: { message: string }, timeoutMs?: number): Promise<void>;
  onStep(sessionId: string, step: StepInfo, timeoutMs?: number): Promise<void>;
  resolveTurnConfig(sid: string, ms?: number): Promise<{ maxSteps?: number } | null>;
};

/** Middleware interceptor methods — only present when middleware is configured. */
export type MiddlewareRunner = {
  filterInput(sid: string, text: string, ms?: number): Promise<string>;
  beforeTurn(sid: string, text: string, ms?: number): Promise<string | undefined>;
  afterTurn(sid: string, text: string, ms?: number): Promise<void>;
  interceptToolCall(
    sid: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    ms?: number,
  ): Promise<
    | { type: "block"; reason: string }
    | { type: "result"; result: string }
    | { type: "args"; args: Record<string, unknown> }
    | undefined
  >;
  afterToolCall(
    sid: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: string,
    ms?: number,
  ): Promise<void>;
  filterOutput(sid: string, text: string, ms?: number): Promise<string>;
};

/**
 * Generic interface for invoking agent lifecycle hooks, including middleware.
 *
 * When middleware is configured, all methods are present. When no middleware
 * exists, the middleware methods (`filterInput`, `beforeTurn`, etc.) may be
 * absent. Callers should use optional chaining for middleware methods.
 *
 * Backward-compatible alias: `LifecycleHooks & Partial<MiddlewareRunner>`.
 */
export type HookInvoker = LifecycleHooks & Partial<MiddlewareRunner>;
