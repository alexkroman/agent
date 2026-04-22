// Copyright 2025 the AAI authors. MIT license.
/** Session context builder — extracted from session.ts. */

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import { DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import { toolError } from "../sdk/utils.ts";
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
  readonly log: Logger;
  readonly maxHistory: number;
};

/**
 * Transport-agnostic session context shared by S2S and pipeline sessions.
 *
 * Owns reply lifecycle, conversation history (with sliding-window truncation),
 * and per-turn tool-call step enforcement. Transport-specific fields (e.g.
 * `s2s` for S2S, `stt`/`tts` for the pipeline) live on the extending types.
 *
 * Split into three layers:
 * - {@link SessionDeps} — immutable dependencies (set once)
 * - {@link ReplyState} via `reply` — per-reply mutable state (reset on beginReply/cancelReply)
 * - Remaining fields — conversation and lifecycle methods
 */
export type BaseSessionCtx = SessionDeps & {
  reply: ReplyState;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];

  consumeToolCallStep(name: string, replyId: string | null): string | null;
  pushMessages(...msgs: Message[]): void;
  beginReply(replyId: string): void;
  cancelReply(): void;
  chainTurn(p: Promise<void>): void;
};

/**
 * S2S session context — {@link BaseSessionCtx} plus the S2S WebSocket handle.
 */
export type S2sSessionCtx = BaseSessionCtx & {
  s2s: S2sHandle | null;
};

export function buildBaseCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  log: Logger;
  maxHistory?: number | undefined;
}): BaseSessionCtx {
  const { agentConfig, log } = opts;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  const ctx: BaseSessionCtx = {
    ...opts,
    reply: { pendingTools: [], toolCallCount: 0, currentReplyId: null },
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    consumeToolCallStep(_name, replyId) {
      // Guard 1: reject tool calls from interrupted/stale replies
      if (replyId === null || replyId !== ctx.reply.currentReplyId) {
        return toolError("Reply was interrupted. Discarding stale tool call.");
      }
      // Guard 2: enforce maxSteps (default 5, set in manifest.ts) to prevent
      // runaway tool-call loops within a single LLM reply
      const maxSteps = agentConfig.maxSteps;
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

export function buildCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  log: Logger;
  maxHistory?: number | undefined;
}): S2sSessionCtx {
  // Mutate the base ctx in place rather than spreading into a new object —
  // the helper methods close over the base ctx reference, so spreading would
  // leave them writing to an orphan object (e.g. `beginReply` would mutate
  // the base `reply`, not the spread copy's `reply`).
  const base = buildBaseCtx(opts) as S2sSessionCtx;
  base.s2s = null;
  return base;
}
