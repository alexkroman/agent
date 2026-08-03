// Copyright 2026 the AAI authors. MIT license.
// Unified session — owns reply lifecycle, conversation history, idle timeout,
// and tool-step enforcement, bridging a Transport to the client protocol.

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import type { ClientEvent, ClientSink, SessionErrorCode } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import { capToolResult, errorMessage, toolError } from "../sdk/utils.ts";
import { createCoalescingTimer } from "./_timer.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { Transport } from "./transports/types.ts";

const REPLY_DONE_SLOW_THRESHOLD_MS = 50;

type PendingTool = { callId: string; result: string };

type ReplyState = {
  currentReplyId: string | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
  /** Aborts this reply's in-flight tool executions on barge-in/reset/stop. */
  abort: AbortController;
  /**
   * True after a `reply.done` flushed this reply's tool results to the
   * transport and the turn is waiting on the provider's continuation.
   * Cleared by any sign of continuation progress (tool call, transcript,
   * audio). While set, a `reply.done` with no new pending tools is a
   * duplicate frame — flushing it would emit a premature client
   * `reply_done`/`audio_done` mid-turn.
   */
  flushedAwaitingContinuation: boolean;
};

/**
 * Configuration for {@link createSessionCore}.
 *
 * @internal
 */
export type SessionCoreOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  transport: Transport;
  logger?: Logger;
  /**
   * Host/relay mode hook. When set, tool calls are relayed to the client for
   * out-of-process execution: `onToolCall` skips its own `tool_call` emit (the
   * relay `executeTool` emits it, keyed by `toolCallId`) and inbound
   * `tool_result` frames are routed here to settle the pending call.
   */
  onToolResult?: (msg: { toolCallId: string; result: string; error?: string }) => void;
};

/**
 * One live server-side session: the runtime's bridge between a transport
 * (S2S, pipeline, or OpenAI Realtime) and the connected client. Distinct from
 * aai-ui's browser-side `SessionCore`.
 *
 * @internal
 */
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
  // Inbound from transport (reply lifecycle, transcripts, audio, tool calls)
  onReplyStarted(replyId: string): void;
  onReplyDone(): void;
  onCancelled(): void;
  onAudioChunk(bytes: Uint8Array): void;
  onAudioDone(): void;
  onUserTranscript(text: string): void;
  /** Interim user transcript — forwarded to the client, never added to history. */
  onUserTranscriptPartial(text: string): void;
  onAgentTranscript(text: string, interrupted: boolean): void;
  /**
   * The in-progress reply transcript — forwarded to the client so its captions
   * track the audio, never added to history (the final
   * {@link SessionCore.onAgentTranscript} owns that).
   */
  onAgentTranscriptPartial(text: string): void;
  onToolCall(callId: string, name: string, args: Record<string, unknown>): void;
  onError(code: SessionErrorCode, message: string, opts?: { fatal?: boolean }): void;
  onSpeechStarted(): void;
  onSpeechStopped(): void;
};

/**
 * Create the server-side session core for one connected client.
 *
 * @internal
 */
export function createSessionCore(opts: SessionCoreOptions): SessionCore {
  const log = opts.logger ?? consoleLogger;
  const rawIdleMs = opts.agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleMs = rawIdleMs === 0 || !Number.isFinite(rawIdleMs) ? 0 : rawIdleMs;

  function emptyReply(): ReplyState {
    return {
      currentReplyId: null,
      pendingTools: [],
      toolCallCount: 0,
      abort: new AbortController(),
      flushedAwaitingContinuation: false,
    };
  }

  let reply: ReplyState = emptyReply();
  let history: Message[] = [];
  let turnPromise: Promise<void> | null = null;
  let stopped = false;
  function emit(event: ClientEvent): void {
    opts.client.event(event);
  }

  // Re-armed at audio-frame rate, so the coalescing timer matters: it records
  // the deadline and keeps one long-lived timer instead of re-arming a
  // 5-minute timeout on every chunk. (Its clear() also zeroes the deadline,
  // so a callback that already fired when stop() ran cannot re-arm and pin
  // the session for another idleMs.)
  const idleTimer = createCoalescingTimer(() => {
    log.info("session idle timeout", { sid: opts.id });
    emit({ type: "idle_timeout" });
    // The event is a notification, not a teardown: clients treat it as
    // informational and wait for the close (aai-ui routes it to its default
    // branch and transitions on the close handler). Retiring the socket here
    // is what actually reclaims the session, its provider sockets, and — on
    // the platform — the Modal input a WebSocket occupies. Closing runs the
    // normal teardown path via the socket's close listener.
    opts.client.close?.("idle timeout");
  });

  function resetIdle(): void {
    if (stopped || idleMs <= 0) return;
    idleTimer.arm(idleMs);
  }

  function pushMessages(...msgs: Message[]): void {
    history.push(...msgs);
    if (history.length > DEFAULT_MAX_HISTORY) {
      history.splice(0, history.length - DEFAULT_MAX_HISTORY);
    }
  }

  function beginReply(replyId: string): void {
    // Tools still in flight belong to the reply being replaced — they're
    // orphaned either way, so cancel them instead of letting them run on.
    reply.abort.abort();
    reply = { ...emptyReply(), currentReplyId: replyId };
    turnPromise = null;
  }

  function cancelReply(): void {
    reply.abort.abort();
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
      idleTimer.clear();
      // Cancel in-flight tools so the drain below settles promptly instead
      // of holding the session (and provider sockets) open for up to the
      // full tool timeout after a disconnect.
      reply.abort.abort();
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    // ─── Inbound from client ──────────────────────────────────────────────
    onAudio(bytes) {
      resetIdle();
      opts.transport.sendUserAudio(bytes);
    },
    onAudioReady() {
      // Intentionally inert, and there is no override mechanism: greeting
      // dispatch is the transport's own business. S2S greets automatically, and
      // the pipeline transport has an internal `onAudioReady` fired by
      // pipeline-providers.ts when the provider sockets open — unrelated to
      // this client frame. The frame is accepted (clients send it) and ignored;
      // `TransportCallbacks` deliberately has no member for it.
    },
    onCancel() {
      // Stop the in-flight tools' work promptly — the user has abandoned this
      // turn, and without the abort a tool keeps running (network calls, db
      // writes) into a turn the client already displays as cancelled. The
      // reply object is deliberately NOT swapped (unlike transport-driven
      // onCancelled): the aborted tools still settle into pendingTools, and
      // an S2S provider — which has no cancel RPC — is still awaiting
      // tool.result for the calls it issued; flushing the (error) results on
      // reply.done is what hands its turn back. Audio stays suppressed by
      // the transport until the next reply.
      reply.abort.abort();
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
      // stop() aborts the current reply and then awaits transport.stop() — an
      // async drain during which the transport can still dispatch a trailing
      // reply.started. Unguarded, beginReply would mint a fresh, un-aborted
      // controller for post-teardown tool calls to run on.
      if (stopped) return;
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
          doneReply.flushedAwaitingContinuation = true;
        } else if (doneReply.flushedAwaitingContinuation) {
          // Tool results were already flushed and no continuation progress
          // (tool call / transcript / audio) has arrived since — this
          // reply.done is a duplicate frame, not the turn's real end.
          log.debug("Dropping duplicate reply.done (awaiting tool continuation)");
        } else {
          flushReply(startMs, hadTurnPromise);
        }
      };
      // sendPending writes to the transport, which may be a dying socket — a
      // throw here must surface as a log, not an unhandled rejection (or a
      // sync throw out of the transport's event dispatch).
      const sendPendingSafely = () => {
        try {
          sendPending();
        } catch (err) {
          log.warn("reply.done dispatch failed", { sid: opts.id, error: errorMessage(err) });
        }
      };
      if (hadTurnPromise) {
        void turnPromise?.then(sendPendingSafely).catch((err: unknown) => {
          log.warn("turn promise rejected before reply.done dispatch", {
            sid: opts.id,
            error: errorMessage(err),
          });
        });
      } else sendPendingSafely();
    },

    onCancelled() {
      cancelReply();
      emit({ type: "cancelled" });
    },

    onAudioChunk(bytes) {
      if (stopped) return;
      reply.flushedAwaitingContinuation = false;
      opts.client.playAudioChunk(bytes);
    },
    onAudioDone() {
      opts.client.playAudioDone();
    },

    onUserTranscript(text) {
      emit({ type: "user_transcript", text });
      pushMessages({ role: "user", content: text });
    },
    onUserTranscriptPartial(text) {
      emit({ type: "user_transcript_partial", text });
    },
    onAgentTranscript(text, interrupted) {
      reply.flushedAwaitingContinuation = false;
      emit({ type: "agent_transcript", text });
      if (!interrupted) pushMessages({ role: "assistant", content: text });
    },
    onAgentTranscriptPartial(text) {
      // Same event type as the final transcript: `agent_transcript` carries the
      // reply's text so far and the last one within a reply wins, so a client
      // needs no new case to render it. History is untouched — the final call
      // above pushes the assistant turn exactly once.
      reply.flushedAwaitingContinuation = false;
      emit({ type: "agent_transcript", text });
    },

    onToolCall(callId, name, args) {
      // See onReplyStarted: a trailing tool.call during stop()'s transport
      // drain must not start tool work (guest RPC, ctx.db, ctx.generate)
      // against a session already torn down.
      if (stopped) return;
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
      activeReply.flushedAwaitingContinuation = false;
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
          // Snapshot history: the live array is push/spliced by transcript
          // events while the tool runs (mirrors to-vercel-tools.ts). The
          // reply's abort signal lets barge-in/reset/stop settle the call.
          const result = await opts.executeTool(name, args, opts.id, history.slice(), {
            toolCallId: callId,
            signal: activeReply.abort.signal,
          });
          // Full result goes to the provider; the client `tool_call_done`
          // event is capped by the wire schema (MAX_TOOL_RESULT_CHARS), so
          // truncate it or the client silently drops the whole message and the
          // UI tool-call block stays "pending" forever.
          activeReply.pendingTools.push({ callId, result });
          emit({ type: "tool_call_done", toolCallId: callId, result: capToolResult(result) });
        } catch (err) {
          const message = errorMessage(err);
          activeReply.pendingTools.push({ callId, result: toolError(message) });
          emit({ type: "tool_call_done", toolCallId: callId, result: capToolResult(message) });
        }
      })();
      turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
    },

    onError(code, message, errOpts) {
      // This used to emit to the client and nowhere else, so a session killed
      // by an upstream provider — an STT socket hitting a session cap or idle
      // cutoff, a provider deploy — left the server log showing only the
      // subsequent close, with the cause reachable solely by whatever the
      // client chose to do with the frame. `fatal` defaults to true: only an
      // explicit `fatal: false` is non-terminal, and a terminal error is
      // exactly the case that has to be answerable from the server's logs.
      const entry = { sid: opts.id, code, message };
      if (errOpts?.fatal === false) log.debug("session error", entry);
      else log.warn("session error (fatal)", entry);
      emit({ type: "error", code, message, ...(errOpts?.fatal === false && { fatal: false }) });
    },
    onSpeechStarted() {
      emit({ type: "speech_started" });
    },
    onSpeechStopped() {
      emit({ type: "speech_stopped" });
    },
  };
}
