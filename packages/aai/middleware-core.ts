// Copyright 2025 the AAI authors. MIT license.
/**
 * Pure middleware runner functions — zero runtime dependencies.
 *
 * This module is intentionally dependency-free so it can be bundled into
 * the secure-exec isolate harness (which has no access to node_modules).
 * Only `import type` statements are allowed here.
 */

import type {
  HookContext,
  Middleware,
  MiddlewareBlockResult,
  ToolCallInterceptResult,
} from "./types.ts";

/** Run middleware in reverse array order, skipping entries without the given hook. */
async function reverseMiddleware(
  middleware: readonly Middleware[],
  key: keyof Middleware,
  fn: (mw: Middleware) => Promise<void> | void,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.[key]) continue;
    try {
      await fn(mw);
    } catch (err) {
      console.warn(`Middleware ${key} failed:`, err);
    }
  }
}

/** Result from a middleware tool call interceptor. */
export type ToolInterceptResult =
  | { type: "block"; reason: string }
  | { type: "result"; result: string }
  | { type: "args"; args: Record<string, unknown> }
  | undefined;

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
    try {
      const result = await mw.beforeTurn(text, ctx);
      if (result && "block" in result && result.block) {
        return result;
      }
    } catch (err) {
      console.warn("Middleware beforeTurn failed:", err);
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
  await reverseMiddleware(middleware, "afterTurn", async (mw) => {
    await mw.afterTurn?.(text, ctx);
  });
}

/**
 * Run all `beforeToolCall` middleware in order. Returns a result that
 * may block execution, provide a cached result, or transform args.
 * Returns `undefined` to proceed with normal execution.
 */
export async function runToolCallInterceptors(
  middleware: readonly Middleware[],
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx: HookContext,
): Promise<ToolInterceptResult> {
  let currentArgs = args;
  for (const mw of middleware) {
    if (!mw.beforeToolCall) continue;
    try {
      const result: ToolCallInterceptResult = await mw.beforeToolCall(toolName, currentArgs, ctx);
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
    } catch (err) {
      console.warn("Middleware beforeToolCall failed:", err);
    }
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
  await reverseMiddleware(middleware, "afterToolCall", async (mw) => {
    await mw.afterToolCall?.(toolName, args, result, ctx);
  });
}

/**
 * Run all `beforeOutput` middleware in order, piping the text through each.
 */
export async function runOutputFilters(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
): Promise<string> {
  let filtered = text;
  for (const mw of middleware) {
    if (!mw.beforeOutput) continue;
    try {
      filtered = await mw.beforeOutput(filtered, ctx);
    } catch (err) {
      console.warn("Middleware beforeOutput failed:", err);
    }
  }
  return filtered;
}
