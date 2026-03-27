// Copyright 2025 the AAI authors. MIT license.
/**
 * Session context builder.
 *
 * Extracted from session.ts to keep it under the file-length lint limit.
 * Builds the shared mutable state object threaded through all session helpers.
 */

import type { AgentConfig } from "./_internal-types.ts";
import { errorMessage, toolError } from "./_utils.ts";
import type { HookInvoker } from "./middleware.ts";
import type { ClientSink } from "./protocol.ts";
import { HOOK_TIMEOUT_MS } from "./protocol.ts";
import type { Logger } from "./runtime.ts";
import type { S2sHandle } from "./s2s.ts";
import type { Message } from "./types.ts";
import type { ExecuteTool } from "./worker-entry.ts";

type PendingTool = { callId: string; result: string };

/**
 * Mutable state and dependencies shared across session helper functions.
 *
 * Created once per session by `buildCtx` and threaded through `setupListeners`,
 * `handleToolCall`, and other internal helpers. Contains both immutable
 * dependencies (logger, executor) and mutable per-turn state (pending tools,
 * generation counters).
 */
export type S2sSessionCtx = {
  readonly id: string;
  readonly agent: string;
  readonly client: ClientSink;
  readonly agentConfig: AgentConfig;
  readonly executeTool: ExecuteTool;
  readonly hookInvoker: HookInvoker | undefined;
  readonly log: Logger;
  s2s: S2sHandle | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];
  /** Maximum number of messages to retain in conversationMessages. */
  readonly maxHistory: number;
  /** Monotonically increasing counter bumped on each reply_started. Tool calls
   *  capture the generation at start; finishToolCall only pushes to pendingTools
   *  if the generation still matches, preventing stale results from interrupted
   *  replies from leaking into subsequent replies. */
  replyGeneration: number;
  /** Resolve per-turn configuration (dynamic `maxSteps` and `activeTools`). */
  resolveTurnConfig(): Promise<{ maxSteps?: number; activeTools?: string[] } | null>;
  /** Increment the tool call counter and check whether the call should be refused. */
  consumeToolCallStep(
    turnConfig: { maxSteps?: number; activeTools?: string[] } | null,
    name: string,
    generation: number,
  ): string | null;
  /** Fire a lifecycle hook asynchronously. Errors are logged but never propagated. */
  fireHook(name: string, fn: (h: HookInvoker) => Promise<void>): void;
  /** Await all in-flight hook promises. Used during shutdown. */
  drainHooks(): Promise<void>;
  /** Push one or more messages and trim to maxHistory. */
  pushMessages(...msgs: Message[]): void;
  /** Sequential promise chain for filterOutput calls, ensuring ordering. */
  filterChain: Promise<void>;
};

const DEFAULT_MAX_HISTORY = 200;

export function buildCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  hookInvoker: HookInvoker | undefined;
  log: Logger;
  maxHistory?: number | undefined;
}): S2sSessionCtx {
  const { id, agentConfig, hookInvoker, log } = opts;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  let cachedActiveTools: string[] | undefined;
  let cachedActiveSet: Set<string> | undefined;
  /** Track in-flight hook promises so they can be awaited during shutdown. */
  const pendingHooks = new Set<Promise<void>>();
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    pendingTools: [],
    toolCallCount: 0,
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    replyGeneration: 0,
    filterChain: Promise.resolve(),
    resolveTurnConfig() {
      if (!hookInvoker) return Promise.resolve(null);
      return hookInvoker.resolveTurnConfig(id, ctx.toolCallCount, HOOK_TIMEOUT_MS);
    },
    consumeToolCallStep(turnConfig, name, generation) {
      // Guard: ignore tool calls from a stale reply generation.
      if (generation !== ctx.replyGeneration) {
        return toolError("Reply was interrupted. Discarding stale tool call.");
      }
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.toolCallCount++;
      if (maxSteps !== undefined && ctx.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.toolCallCount,
          maxSteps,
        });
        return toolError("Maximum tool steps reached. Please respond to the user now.");
      }
      if (turnConfig?.activeTools) {
        if (turnConfig.activeTools !== cachedActiveTools) {
          cachedActiveTools = turnConfig.activeTools;
          cachedActiveSet = new Set(turnConfig.activeTools);
        }
        if (!cachedActiveSet?.has(name)) {
          log.info("Tool filtered by activeTools", { name });
          return toolError(`Tool "${name}" is not available at this step.`);
        }
      }
      return null;
    },
    fireHook(name, fn) {
      if (!hookInvoker) return;
      const notifyOnError = (err: unknown) => {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
        if (name !== "onError") {
          try {
            const r = hookInvoker.onError(id, { message: errorMessage(err) });
            if (r && typeof r.catch === "function") {
              r.catch((e: unknown) => {
                log.warn("onError hook failed", { err: errorMessage(e) });
              });
            }
          } catch (e: unknown) {
            log.warn("onError hook failed", { err: errorMessage(e) });
          }
        }
      };
      try {
        const p = fn(hookInvoker)
          .catch(notifyOnError)
          .finally(() => pendingHooks.delete(p));
        pendingHooks.add(p);
      } catch (err: unknown) {
        notifyOnError(err);
      }
    },
    async drainHooks() {
      if (pendingHooks.size > 0) await Promise.all([...pendingHooks]);
    },
    pushMessages(...msgs: Message[]) {
      ctx.conversationMessages.push(...msgs);
      if (maxHistory > 0 && ctx.conversationMessages.length > maxHistory) {
        ctx.conversationMessages = ctx.conversationMessages.slice(-maxHistory);
      }
    },
  };
  return ctx;
}
