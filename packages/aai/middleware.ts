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

// ─── Middleware runner ───────────────────────────────────────────────────────

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
      return runInputFilters(middleware, { ...makeCtx(sessionId), text }, handler);
    },
    async beforeTurn(sessionId: string, text: string) {
      const result = await runBeforeTurnMiddleware(
        middleware,
        { ...makeCtx(sessionId), text },
        handler,
      );
      return result?.reason;
    },
    async afterTurn(sessionId: string, text: string) {
      await runAfterTurnMiddleware(middleware, { ...makeCtx(sessionId), text }, handler);
    },
    async interceptToolCall(
      sessionId: string,
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) {
      return runToolCallInterceptors(middleware, { ...makeCtx(sessionId), tool, args }, handler);
    },
    async afterToolCall(
      sessionId: string,
      tool: string,
      args: Readonly<Record<string, unknown>>,
      result: string,
    ) {
      await runAfterToolCallMiddleware(
        middleware,
        { ...makeCtx(sessionId), tool, args, result },
        handler,
      );
    },
    async filterOutput(sessionId: string, text: string) {
      return runOutputFilters(middleware, { ...makeCtx(sessionId), text }, handler);
    },
  };
}

/**
 * Run all `beforeInput` middleware in order, piping the text through each.
 * `ctx.text` must be set.
 */
export async function runInputFilters(
  middleware: readonly Middleware[],
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<string> {
  let filtered = ctx.text ?? "";
  for (const mw of middleware) {
    if (!mw.beforeInput) continue;
    try {
      filtered = await mw.beforeInput({ ...ctx, text: filtered });
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeInput", error });
    }
  }
  return filtered;
}

/**
 * Run all `beforeTurn` middleware in order. Returns a block result if any
 * middleware blocks the turn, or `undefined` to proceed. `ctx.text` must be set.
 */
export async function runBeforeTurnMiddleware(
  middleware: readonly Middleware[],
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<MiddlewareBlockResult | undefined> {
  for (const mw of middleware) {
    if (!mw.beforeTurn) continue;
    try {
      const result = await mw.beforeTurn(ctx);
      if (result && "block" in result && result.block) {
        return result;
      }
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeTurn", error });
    }
  }
}

/**
 * Run all `afterTurn` middleware in reverse order. `ctx.text` must be set.
 */
export async function runAfterTurnMiddleware(
  middleware: readonly Middleware[],
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.afterTurn) continue;
    try {
      await mw.afterTurn(ctx);
    } catch (error) {
      onError({ middleware: mw.name, hook: "afterTurn", error });
    }
  }
}

/**
 * Run all `beforeToolCall` middleware in order. Returns a result that
 * may block execution, provide a cached result, or transform args.
 * Returns `undefined` to proceed. `ctx.tool` and `ctx.args` must be set.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: inherent to intercept logic (block/result/args branching)
export async function runToolCallInterceptors(
  middleware: readonly Middleware[],
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<ToolCallInterceptResult> {
  let currentArgs = ctx.args ?? {};
  for (const mw of middleware) {
    if (!mw.beforeToolCall) continue;
    try {
      const result = await mw.beforeToolCall({ ...ctx, args: currentArgs });
      if (!result) continue;
      if (result.type === "block" || result.type === "result") return result;
      if (result.type === "args") currentArgs = result.args;
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeToolCall", error });
    }
  }
  if (currentArgs !== (ctx.args ?? {})) {
    return { type: "args", args: currentArgs as Record<string, unknown> };
  }
}

/**
 * Run all `afterToolCall` middleware in reverse order.
 * `ctx.tool`, `ctx.args`, and `ctx.result` must be set.
 */
export async function runAfterToolCallMiddleware(
  middleware: readonly Middleware[],
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<void> {
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (!mw?.afterToolCall) continue;
    try {
      await mw.afterToolCall(ctx);
    } catch (error) {
      onError({ middleware: mw.name, hook: "afterToolCall", error });
    }
  }
}

/**
 * Run all `beforeOutput` middleware in order, piping the text through each.
 * `ctx.text` must be set.
 */
export async function runOutputFilters(
  middleware: readonly Middleware[],
  ctx: HookContext,
  onError: MiddlewareErrorHandler = defaultOnError,
): Promise<string> {
  let filtered = ctx.text ?? "";
  for (const mw of middleware) {
    if (!mw.beforeOutput) continue;
    try {
      filtered = await mw.beforeOutput({ ...ctx, text: filtered });
    } catch (error) {
      onError({ middleware: mw.name, hook: "beforeOutput", error });
    }
  }
  return filtered;
}
