// Copyright 2025 the AAI authors. MIT license.
/**
 * Middleware runner — executes middleware chains for turns, tool calls,
 * and output filtering.
 */

import type {
  HookContext,
  Middleware,
  MiddlewareBlockResult,
  StepInfo,
  ToolCallInterceptResult,
} from "./types.ts";

/** Result from a middleware tool call interceptor. */
export type ToolInterceptResult =
  | { type: "block"; reason: string }
  | { type: "result"; result: string }
  | { type: "args"; args: Record<string, unknown> }
  | undefined;

/** Generic interface for invoking agent lifecycle hooks, including middleware. */
export type HookInvoker = {
  onConnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onDisconnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onTurn(sessionId: string, text: string, timeoutMs?: number): Promise<void>;
  onError(sessionId: string, error: { message: string }, timeoutMs?: number): Promise<void>;
  onStep(sessionId: string, step: StepInfo, timeoutMs?: number): Promise<void>;
  resolveTurnConfig(
    sid: string,
    step: number,
    ms?: number,
  ): Promise<{ maxSteps?: number; activeTools?: string[] } | null>;
  beforeTurn?(sid: string, text: string, ms?: number): Promise<string | undefined>;
  afterTurn?(sid: string, text: string, ms?: number): Promise<void>;
  interceptToolCall?(
    sid: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    ms?: number,
  ): Promise<ToolInterceptResult>;
  afterToolCall?(
    sid: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: string,
    ms?: number,
  ): Promise<void>;
  filterOutput?(sid: string, text: string, ms?: number): Promise<string>;
};

/**
 * Run all `beforeTurn` middleware in order. Returns a block result if any
 * middleware blocks the turn, or `undefined` to proceed.
 */
export async function runBeforeTurnMiddleware(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<MiddlewareBlockResult | undefined> {
  for (const mw of middleware) {
    if (!mw.beforeTurn) continue;
    const result = await mw.beforeTurn(text, ctx);
    if (result && "block" in result && result.block) {
      return result;
    }
  }
}

/**
 * Run all `afterTurn` middleware in reverse order.
 */
export async function runAfterTurnMiddleware(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.afterTurn) continue;
    await mw.afterTurn(text, ctx);
  }
}

/**
 * Run all `toolCallInterceptor` middleware in order. Returns a result that
 * may block execution, provide a cached result, or transform args.
 * Returns `undefined` to proceed with normal execution.
 */
export async function runToolCallInterceptors(
  middleware: readonly Middleware[],
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx: HookContext,
): Promise<
  | { type: "block"; reason: string }
  | { type: "result"; result: string }
  | { type: "args"; args: Record<string, unknown> }
  | undefined
> {
  let currentArgs = args;
  for (const mw of middleware) {
    if (!mw.toolCallInterceptor) continue;
    const result: ToolCallInterceptResult = await mw.toolCallInterceptor(
      toolName,
      currentArgs,
      ctx,
    );
    if (!result) continue;
    if ("block" in result && result.block) {
      return { type: "block", reason: result.reason };
    }
    if ("result" in result) {
      return { type: "result", result: result.result };
    }
    if ("args" in result) {
      currentArgs = result.args;
    }
  }
  // If any middleware transformed args, return the final transformed version
  if (currentArgs !== args) {
    return { type: "args", args: currentArgs as Record<string, unknown> };
  }
}

/**
 * Run all `afterToolCall` middleware in reverse order.
 */
export async function runAfterToolCallMiddleware(
  middleware: readonly Middleware[],
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  result: string,
  ctx: HookContext,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.afterToolCall) continue;
    await mw.afterToolCall(toolName, args, result, ctx);
  }
}

/**
 * Run all `outputFilter` middleware in order, piping the text through each.
 */
export async function runOutputFilters(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<string> {
  let filtered = text;
  for (const mw of middleware) {
    if (!mw.outputFilter) continue;
    filtered = await mw.outputFilter(filtered, ctx);
  }
  return filtered;
}
