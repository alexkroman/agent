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

// Re-import the MiddlewareRunner type from middleware.ts would create a circular
// dependency. Define the return type inline instead — this is the source of truth
// for what buildMiddlewareRunner produces.

/**
 * Called when a middleware hook throws. Receives the middleware name, the hook
 * that failed, and the original error. The runner always continues (fail-open)
 * regardless of what this callback does.
 */
export type MiddlewareErrorHandler = (info: {
  middleware: string;
  hook: string;
  error: unknown;
}) => void;

const defaultOnError: MiddlewareErrorHandler = ({ middleware, hook, error }) => {
  console.warn(`Middleware ${middleware} ${hook} failed:`, error);
};

/**
 * Build a MiddlewareRunner from an array of middleware and a context factory.
 * Returns `undefined` when the middleware array is empty (no-op optimization).
 *
 * Shared by both self-hosted (direct-executor) and platform (_harness-runtime)
 * to avoid duplicating the adapter logic.
 *
 * @param onError - Optional error handler. Defaults to `console.warn`. Called
 *   when any middleware hook throws. The runner always continues (fail-open).
 */
export function buildMiddlewareRunner(
  middleware: readonly Middleware[],
  makeCtx: (sid: string) => HookContext,
  onError?: MiddlewareErrorHandler,
) {
  if (middleware.length === 0) return;
  const handler = onError ?? defaultOnError;
  return {
    async filterInput(sessionId: string, text: string) {
      return runInputFilters(middleware, text, makeCtx(sessionId), handler);
    },
    async beforeTurn(sessionId: string, text: string) {
      const result = await runBeforeTurnMiddleware(middleware, text, makeCtx(sessionId), handler);
      return result?.reason;
    },
    async afterTurn(sessionId: string, text: string) {
      await runAfterTurnMiddleware(middleware, text, makeCtx(sessionId), handler);
    },
    async interceptToolCall(
      sessionId: string,
      toolName: string,
      args: Readonly<Record<string, unknown>>,
    ) {
      return runToolCallInterceptors(middleware, toolName, args, makeCtx(sessionId), handler);
    },
    async afterToolCall(
      sessionId: string,
      toolName: string,
      args: Readonly<Record<string, unknown>>,
      result: string,
    ) {
      await runAfterToolCallMiddleware(
        middleware,
        toolName,
        args,
        result,
        makeCtx(sessionId),
        handler,
      );
    },
    async filterOutput(sessionId: string, text: string) {
      return runOutputFilters(middleware, text, makeCtx(sessionId), handler);
    },
  };
}

/** Result from a middleware tool call interceptor. */
export type ToolInterceptResult =
  | { type: "block"; reason: string }
  | { type: "result"; result: string }
  | { type: "args"; args: Record<string, unknown> }
  | undefined;

/**
 * Run all `beforeInput` middleware in order, piping the text through each.
 * Symmetric to {@link runOutputFilters} but for user input.
 */
export async function runInputFilters(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<string> {
  let filtered = text;
  for (const mw of middleware) {
    if (!mw.beforeInput) continue;
    try {
      filtered = await mw.beforeInput(filtered, ctx);
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeInput", error });
    }
  }
  return filtered;
}

/**
 * Run all `beforeTurn` middleware in order. Returns a block result if any
 * middleware blocks the turn, or `undefined` to proceed.
 */
export async function runBeforeTurnMiddleware(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<MiddlewareBlockResult | undefined> {
  for (const mw of middleware) {
    if (!mw.beforeTurn) continue;
    try {
      const result = await mw.beforeTurn(text, ctx);
      if (result && "block" in result && result.block) {
        return result;
      }
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeTurn", error });
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
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.afterTurn) continue;
    try {
      await mw.afterTurn(text, ctx);
    } catch (error) {
      onError({ middleware: mw.name, hook: "afterTurn", error });
    }
  }
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
  onError: MiddlewareErrorHandler = defaultOnError,
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
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeToolCall", error });
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
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.afterToolCall) continue;
    try {
      await mw.afterToolCall(toolName, args, result, ctx);
    } catch (error) {
      onError({ middleware: mw.name, hook: "afterToolCall", error });
    }
  }
}

/**
 * Run all `beforeOutput` middleware in order, piping the text through each.
 */
export async function runOutputFilters(
  middleware: readonly Middleware[],
  text: string,
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<string> {
  let filtered = text;
  for (const mw of middleware) {
    if (!mw.beforeOutput) continue;
    try {
      filtered = await mw.beforeOutput(filtered, ctx);
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeOutput", error });
    }
  }
  return filtered;
}
