// Copyright 2026 the AAI authors. MIT license.
// Unified session — owns reply lifecycle, conversation history, idle timeout,
// and tool-step enforcement. Replaces session.ts + pipeline-session.ts.

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_HISTORY,
  MAX_TOOL_RESULT_CHARS,
} from "../sdk/constants.ts";
import type { ClientEvent, ClientSink, SessionErrorCode } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import { errorMessage, toolError } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { Transport } from "./transports/types.ts";

const REPLY_DONE_SLOW_THRESHOLD_MS = 50;

/** Cap a tool result to the client wire limit (the provider still gets the full value). */
function capResult(result: string): string {
  return result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
}

type PendingTool = { callId: string; result: string };

type ReplyState = {
  currentReplyId: string | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
};

export type SessionCoreOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  transport: Transport;
  logger?: Logger;
  maxHistory?: number;
  /**
   * Host/relay mode hook. When set, tool calls are relayed to the client for
   * out-of-process execution: `onToolCall` skips its own `tool_call` emit (the
   * relay `executeTool` emits it, keyed by `toolCallId`) and inbound
   * `tool_result` frames are routed here to settle the pending call.
   */
  onToolResult?: (msg: { toolCallId: string; result: string; error?: string }) => void;
};

export type SessionCore = {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Inbound from client (decoded by ws-handler)
  onAudio(bytes: Uint8Array): void;
  onAudioReady(): void;
  onCancel(): void;
  onReset(): void;
  onHistory(messages: readonly Message[]): void;
  /** Inbound relayed tool result (host mode): settles the pending relay call. */
  onToolResult(toolCallId: string, result: string, error?: string): void;
  // Inbound from transport (spec §4.2)
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudioChunk(bytes: Uint8Array): void;
  onAudioDone(): void;
  onUserTranscript(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onError(code: SessionErrorCode, message: string): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
};

export function createSessionCore(opts: SessionCoreOptions): SessionCore {
  const log = opts.logger ?? consoleLogger;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  const rawIdleMs = opts.agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleMs = rawIdleMs === 0 || !Number.isFinite(rawIdleMs) ? 0 : rawIdleMs;

  function emptyReply(): ReplyState {
    return { currentReplyId: null, pendingTools: [], toolCallCount: 0 };
  }

  let reply: ReplyState = emptyReply();
  let history: Message[] = [];
  let turnPromise: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  function emit(event: ClientEvent): void {
    opts.client.event(event);
  }

  function resetIdle(): void {
    if (stopped || idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.info("session idle timeout", { sid: opts.id });
      emit({ type: "idle_timeout" });
    }, idleMs);
  }

  function pushMessages(...msgs: Message[]): void {
    history.push(...msgs);
    if (maxHistory > 0 && history.length > maxHistory) {
      history.splice(0, history.length - maxHistory);
    }
  }

  function beginReply(replyId: string): void {
    reply = { ...emptyReply(), currentReplyId: replyId };
    turnPromise = null;
  }

  function cancelReply(): void {
    reply = emptyReply();
  }

  function flushReply(startMs: number, hadTurnPromise: boolean): void {
    const stepsUsed = reply.toolCallCount;
    if (stepsUsed > 0) log.info("Turn complete", { steps: stepsUsed, agent: opts.agent });
    opts.client.playAudioDone();
    emit({ type: "reply_done" });
    reply.currentReplyId = null;
    const durationMs = Date.now() - startMs;
    if (durationMs >= REPLY_DONE_SLOW_THRESHOLD_MS) {
      log.warn("slow reply_done dispatch", {
        sid: opts.id,
        agent: opts.agent,
        durationMs,
        hadTurnPromise,
      });
    }
  }

  return {
    id: opts.id,

    async start() {
      resetIdle();
      await opts.transport.start();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    // ─── Inbound from client ──────────────────────────────────────────────
    onAudio(bytes) {
      resetIdle();
      opts.transport.sendUserAudio(bytes);
    },
    onAudioReady() {
      // S2S greeting is automatic; pipeline transports may override via callbacks.
    },
    onCancel() {
      opts.transport.cancelReply();
      emit({ type: "cancelled" });
    },
    onReset() {
      cancelReply();
      history = [];
      // Clear conversation state the transport owns (pipeline LLM history);
      // without this the "forgotten" dialogue keeps feeding the next turn.
      opts.transport.reset?.();
      emit({ type: "reset" });
    },
    onHistory(messages) {
      pushMessages(...messages);
      // Forward to the transport so pipeline mode's LLM sees the restored
      // context on reconnect (S2S restores context service-side via resume).
      opts.transport.seedHistory?.(messages);
    },
    onToolResult(toolCallId, result, error) {
      opts.onToolResult?.({ toolCallId, result, ...(error !== undefined ? { error } : {}) });
    },

    // ─── Inbound from transport ───────────────────────────────────────────
    onReplyStarted(replyId) {
      beginReply(replyId);
    },

    onReplyDone() {
      const startMs = Date.now();
      // Capture the reply object, not just its id: barge-in/reset swap in a
      // fresh reply object (beginReply/cancelReply), and sendPending runs later
      // (after turnPromise). Comparing by identity keeps a stale reply.done
      // from mutating the current reply.
      const doneReply = reply;
      // Dedup duplicate reply.done events — once the reply is fully dispatched
      // (or was never started) currentReplyId is null.
      if (doneReply.currentReplyId === null) {
        log.debug("Dropping duplicate reply.done (no active reply)");
        return;
      }
      const hadTurnPromise = turnPromise !== null;
      const sendPending = () => {
        // A newer reply replaced this one → it's stale. Drop its orphaned
        // pending tools; never touch the current reply.
        if (reply !== doneReply) {
          doneReply.pendingTools = [];
          return;
        }
        if (doneReply.pendingTools.length > 0) {
          for (const tool of doneReply.pendingTools)
            opts.transport.sendToolResult(tool.callId, tool.result);
          doneReply.pendingTools = [];
        } else {
          flushReply(startMs, hadTurnPromise);
        }
      };
      if (hadTurnPromise) void turnPromise?.then(sendPending);
      else sendPending();
    },

    onCancelled() {
      cancelReply();
      emit({ type: "cancelled" });
    },

    onAudioChunk(bytes) {
      opts.client.playAudioChunk(bytes);
    },
    onAudioDone() {
      opts.client.playAudioDone();
    },

    onUserTranscript(text) {
      emit({ type: "user_transcript", text });
      pushMessages({ role: "user", content: text });
    },
    onAgentTranscript(text, interrupted) {
      emit({ type: "agent_transcript", text });
      if (!interrupted) pushMessages({ role: "assistant", content: text });
    },

    onToolCall(callId, name, args) {
      // In relay/host mode the relay `executeTool` emits the `tool_call` frame
      // itself (keyed by callId), so emitting here too would duplicate it.
      if (!opts.onToolResult) emit({ type: "tool_call", toolCallId: callId, toolName: name, args });
      if (reply.currentReplyId === null) {
        log.warn("tool_call with no active reply", { sid: opts.id, name });
        return;
      }
      // Bind results to the reply that issued the call. If a barge-in/reset
      // swaps in a new reply before this tool completes, the result lands in
      // this (now orphaned) object instead of corrupting the new reply's
      // pendingTools (which would hang or mis-route the turn).
      const activeReply = reply;
      activeReply.toolCallCount++;
      const maxSteps = opts.agentConfig.maxSteps;
      if (maxSteps !== undefined && activeReply.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded; refusing tool call", {
          toolCallCount: activeReply.toolCallCount,
          maxSteps,
        });
        activeReply.pendingTools.push({
          callId,
          result: toolError("Maximum tool steps reached. Please respond to the user now."),
        });
        emit({ type: "tool_call_done", toolCallId: callId, result: "{}" });
        return;
      }
      const p = (async () => {
        try {
          const result = await opts.executeTool(name, args, opts.id, history, {
            toolCallId: callId,
          });
          // Full result goes to the provider; the client `tool_call_done`
          // event is capped by the wire schema (MAX_TOOL_RESULT_CHARS), so
          // truncate it or the client silently drops the whole message and the
          // UI tool-call block stays "pending" forever.
          activeReply.pendingTools.push({ callId, result });
          emit({ type: "tool_call_done", toolCallId: callId, result: capResult(result) });
        } catch (err) {
          const message = errorMessage(err);
          activeReply.pendingTools.push({ callId, result: toolError(message) });
          emit({ type: "tool_call_done", toolCallId: callId, result: capResult(message) });
        }
      })();
      turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
    },

    onError(code, message) {
      emit({ type: "error", code, message });
    },
    onSpeechStarted() {
      emit({ type: "speech_started" });
    },
    onSpeechStopped() {
      emit({ type: "speech_stopped" });
    },
  };
}
