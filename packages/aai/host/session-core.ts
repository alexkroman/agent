// Copyright 2026 the AAI authors. MIT license.
// Unified session — owns reply lifecycle, conversation history, idle timeout,
// and tool-step enforcement, bridging a Transport to the client protocol.

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import { serializeToolFailure } from "../sdk/_tool-failure-wire.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ClientEvent, ClientSink, SessionErrorCode } from "../sdk/protocol.ts";
import type { Message } from "../sdk/types.ts";
import { capToolResult, errorMessage } from "../sdk/utils.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import { createIdleWatchdog } from "./session-idle.ts";
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
  /**
   * The client reports how much forwarded agent audio it still holds unplayed
   * — the protocol's one closed-loop signal. Forwarded to the transport, which
   * is where the playback estimate lives; a transport that keeps no such
   * estimate (S2S, where the service owns turn-taking) simply omits the hook.
   */
  onPlaybackProgress(bufferedMs: number): void;
  onHistory(messages: readonly Message[]): void;
  /**
   * Make the agent SPEAK about something the caller did not just say.
   *
   * The instruction reaches the model as a synthetic user message and the reply
   * is an ordinary, interruptible turn. What it exists for is the shape a voice
   * agent otherwise cannot do: a durable run started minutes ago finishes, the
   * caller is still on the line, and the agent has the answer with no way to
   * offer it — so the caller has to think to ask.
   *
   * Reports FALSE rather than throwing when the transport has no such verb
   * (S2S has none) or the session is stopped, because the caller is a run
   * completing in the background: there is nobody to raise to, and the answer
   * "this session cannot be spoken to" is what a notifier needs to stop trying.
   */
  announce(instruction: string): boolean;
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
  onUserTranscriptPartial(text: string, eotConfidence?: number): void;
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
  // Has this client ever sent `playback_progress`? Gates the one-time log in
  // onPlaybackProgress — see there for why the distinction is worth a line.
  let sawPlaybackReport = false;
  function emit(event: ClientEvent): void {
    opts.client.event(event);
  }

  // The idle deadline and everything it means — see `session-idle.ts`, which is
  // where the "measure SPEECH, not bytes" argument lives.
  const idle = createIdleWatchdog({
    sid: opts.id,
    idleMs: rawIdleMs,
    logger: log,
    notify: () => emit({ type: "idle_timeout" }),
    close: () => opts.client.close?.("idle timeout"),
  });

  /** Re-arm the idle deadline. Transport-observed conversation only. */
  function resetIdle(): void {
    if (stopped) return;
    idle.reset();
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
      idle.clear();
      // Cancel in-flight tools so the drain below settles promptly instead
      // of holding the session (and provider sockets) open for up to the
      // full tool timeout after a disconnect.
      reply.abort.abort();
      if (turnPromise !== null) await turnPromise;
      await opts.transport.stop();
    },

    // ─── Inbound from client ──────────────────────────────────────────────
    onAudio(bytes) {
      // Deliberately does NOT re-arm the idle timer — see `resetIdle`.
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
    onPlaybackProgress(bufferedMs) {
      // Logged ONCE per session, because "is this client closed-loop?" changes
      // how every playback-derived number in the session should be read — the
      // barge-in floor, the heard cursor, the speaking-edge gate. A session
      // with no such line ran on the open-loop estimate, and the absence is
      // indistinguishable from a client that simply never buffers unless it is
      // stated somewhere. Once, not per report: these arrive every few hundred
      // ms for the whole of every reply.
      if (!sawPlaybackReport) {
        sawPlaybackReport = true;
        log.info("Client reports playback progress", { sid: opts.id, bufferedMs });
      }
      // Deliberately does NOT re-arm the idle timer: this frame reports the
      // agent's own audio playing back, which is not evidence the caller is
      // still there — `resetIdle` measures silence from the user.
      opts.transport.onPlaybackProgress?.(bufferedMs);
    },
    onReset() {
      cancelReply();
      history = [];
      // Clear conversation state the transport owns (pipeline LLM history);
      // without this the "forgotten" dialogue keeps feeding the next turn.
      opts.transport.reset?.();
      emit({ type: "reset" });
    },
    announce(instruction) {
      // A stopped session's transport may still hold sockets mid-teardown, so
      // the check is the session's own flag rather than the transport's.
      if (stopped || !opts.transport.injectTurn) return false;
      log.info("Session announcement", { sid: opts.id });
      opts.transport.injectTurn(instruction);
      return true;
    },

    onHistory(messages) {
      pushMessages(...messages);
      // Forward to the transport so pipeline mode's LLM sees the restored
      // context on reconnect (S2S restores context service-side via resume).
      opts.transport.seedHistory?.(messages);
    },
    onToolResult(toolCallId, result, error) {
      opts.onToolResult?.({ toolCallId, result, ...omitUndefined({ error }) });
    },

    // ─── Inbound from transport ───────────────────────────────────────────
    onReplyStarted(replyId) {
      // A turn beginning is progress, and a tool-chaining turn can run for a
      // while before any audio: without this the agent could be reaped
      // mid-work when the dead-air cover is disabled (`deadAirCoverMs: 0`).
      resetIdle();
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
      // The agent is speaking — a long reply must not be reaped mid-sentence.
      resetIdle();
      reply.flushedAwaitingContinuation = false;
      opts.client.playAudioChunk(bytes);
    },
    onAudioDone() {
      opts.client.playAudioDone();
    },

    onUserTranscript(text) {
      resetIdle();
      emit({ type: "user_transcript", text });
      pushMessages({ role: "user", content: text });
    },
    onUserTranscriptPartial(text, eotConfidence) {
      // Partials too, not just the committed turn: one long utterance would
      // otherwise only count at its `speech_started`, and could be reaped
      // mid-sentence.
      resetIdle();
      emit({
        type: "user_transcript_partial",
        text,
        ...(eotConfidence === undefined ? {} : { eotConfidence }),
      });
    },
    onAgentTranscript(text, interrupted) {
      resetIdle();
      reply.flushedAwaitingContinuation = false;
      emit({ type: "agent_transcript", text });
      if (!interrupted) pushMessages({ role: "assistant", content: text });
    },
    onAgentTranscriptPartial(text) {
      resetIdle();
      // Same event type as the final transcript: `agent_transcript` carries the
      // reply's text so far and the last one within a reply wins, so a client
      // needs no new case to render it. History is untouched — the final call
      // above pushes the assistant turn exactly once.
      reply.flushedAwaitingContinuation = false;
      emit({ type: "agent_transcript", text });
    },

    onToolCall(callId, name, args) {
      resetIdle();
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
          result: serializeToolFailure(
            "Maximum tool steps reached. Please respond to the user now.",
          ),
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
          activeReply.pendingTools.push({ callId, result: serializeToolFailure(message) });
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
      resetIdle();
      emit({ type: "speech_started" });
    },
    onSpeechStopped() {
      emit({ type: "speech_stopped" });
    },
  };
}
