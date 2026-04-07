// Copyright 2025 the AAI authors. MIT license.
/** Session context builder — extracted from session.ts. */

import type { AgentConfig, ExecuteTool } from "../isolate/_internal-types.ts";
import { errorMessage, toolError } from "../isolate/_utils.ts";
import { DEFAULT_MAX_HISTORY, HOOK_TIMEOUT_MS } from "../isolate/constants.ts";
import type { AgentHookMap, AgentHooks } from "../isolate/hooks.ts";
import { callResolveTurnConfig } from "../isolate/hooks.ts";
import type { ClientSink } from "../isolate/protocol.ts";
import type { Message } from "../isolate/types.ts";
import type { Logger } from "./runtime-config.ts";
import type { S2sHandle } from "./s2s.ts";

type PendingTool = { callId: string; result: string };

/** Per-reply mutable state — reset on beginReply/cancelReply. */
export type ReplyState = {
  pendingTools: PendingTool[];
  toolCallCount: number;
  currentReplyId: string | null;
};

/** Immutable dependencies injected at session creation. */
export type SessionDeps = {
  readonly id: string;
  readonly agent: string;
  readonly client: ClientSink;
  readonly agentConfig: AgentConfig;
  readonly executeTool: ExecuteTool;
  readonly hooks: AgentHooks | undefined;
  readonly log: Logger;
  readonly maxHistory: number;
};

/**
 * Session context threaded through event handlers.
 *
 * Split into three layers:
 * - {@link SessionDeps} — immutable dependencies (set once)
 * - {@link ReplyState} via `reply` — per-reply mutable state (reset on beginReply/cancelReply)
 * - Remaining fields — connection, conversation, and lifecycle methods
 */
export type S2sSessionCtx = SessionDeps & {
  s2s: S2sHandle | null;
  reply: ReplyState;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];

  resolveTurnConfig(): Promise<{ maxSteps?: number } | null>;
  consumeToolCallStep(
    turnConfig: { maxSteps?: number } | null,
    name: string,
    replyId: string | null,
  ): string | null;
  fireHook(name: keyof AgentHookMap, ...args: unknown[]): void;
  drainHooks(): Promise<void>;
  pushMessages(...msgs: Message[]): void;
  beginReply(replyId: string): void;
  cancelReply(): void;
  chainTurn(p: Promise<void>): void;
};

export function buildCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  hooks: AgentHooks | undefined;
  log: Logger;
  maxHistory?: number | undefined;
}): S2sSessionCtx {
  const { id, agentConfig, hooks, log } = opts;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  /** Track in-flight hook promises so they can be awaited during shutdown. */
  const pendingHooks = new Set<Promise<void>>();
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    reply: { pendingTools: [], toolCallCount: 0, currentReplyId: null },
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    resolveTurnConfig() {
      return callResolveTurnConfig(hooks, id, HOOK_TIMEOUT_MS);
    },
    consumeToolCallStep(turnConfig, _name, replyId) {
      if (replyId === null || replyId !== ctx.reply.currentReplyId) {
        return toolError("Reply was interrupted. Discarding stale tool call.");
      }
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.reply.toolCallCount++;
      if (maxSteps !== undefined && ctx.reply.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.reply.toolCallCount,
          maxSteps,
        });
        return toolError("Maximum tool steps reached. Please respond to the user now.");
      }
      return null;
    },
    fireHook(name, ...args) {
      if (!hooks) return;
      const notifyOnError = (err: unknown) => {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
      };
      try {
        // biome-ignore lint/suspicious/noExplicitAny: hookable callHook is generic over hook args
        const result = (hooks.callHook as any)(name, ...args);
        // hookable returns undefined when no hooks are registered for the given name
        if (result == null) return;
        const p = result.catch(notifyOnError).finally(() => pendingHooks.delete(p));
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
        ctx.conversationMessages.splice(0, ctx.conversationMessages.length - maxHistory);
      }
    },
    beginReply(replyId: string) {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: replyId };
      ctx.turnPromise = null;
    },
    cancelReply() {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: null };
    },
    chainTurn(p: Promise<void>) {
      ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
    },
  };
  return ctx;
}
