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
  runOutputFilters,
  runToolCallInterceptors,
  type ToolInterceptResult,
} from "./middleware-core.ts";

/** Generic interface for invoking agent lifecycle hooks, including middleware. */
export type HookInvoker = {
  onConnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onDisconnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onTurn(sessionId: string, text: string, timeoutMs?: number): Promise<void>;
  onError(sessionId: string, error: { message: string }, timeoutMs?: number): Promise<void>;
  onStep(sessionId: string, step: StepInfo, timeoutMs?: number): Promise<void>;
  resolveTurnConfig(
    sessionId: string,
    step: number,
    timeoutMs?: number,
  ): Promise<{ maxSteps?: number; activeTools?: string[] } | null>;
  beforeTurn?(sessionId: string, text: string, timeoutMs?: number): Promise<string | undefined>;
  afterTurn?(sessionId: string, text: string, timeoutMs?: number): Promise<void>;
  interceptToolCall?(
    sessionId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<
    | { type: "block"; reason: string }
    | { type: "result"; result: string }
    | { type: "args"; args: Record<string, unknown> }
    | undefined
  >;
  afterToolCall?(
    sessionId: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: string,
    timeoutMs?: number,
  ): Promise<void>;
  filterOutput?(sessionId: string, text: string, timeoutMs?: number): Promise<string>;
};
